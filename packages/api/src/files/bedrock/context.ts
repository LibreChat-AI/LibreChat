import { addAbortSignal } from 'node:stream';
import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import {
  FileSources,
  mergeFileConfig,
  getEndpointFileConfig,
  isBedrockDocumentType,
} from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { StrategyFunctions, ServerRequest } from '~/types';
import type { MissingAttachmentHandler } from '../encode/utils';
import {
  AttachmentObjectNotFoundError,
  isStorageNotFoundError,
  getConfiguredFileSizeLimit,
} from '../encode/utils';
import { BedrockDocumentError, assertBedrockSize, clampBedrockLimit } from './limits';
import { getSafeErrorMetadata, isOwnedAbortError } from '~/utils/errors';
import { configuredRequestBudget } from '~/utils/timeouts';
import { getBedrockDocumentLimit } from '../validation';
import { resolveDownloadPath } from '~/storage/path';

export interface BedrockDocumentReference {
  librechatFile: string;
}

interface DocumentPolicy {
  maxBytes: number;
  totalBytes: number;
  count: number;
  onMissingFile?: MissingAttachmentHandler;
}

interface RegisteredDocument {
  file: Pick<
    IMongoFile,
    'file_id' | 'filename' | 'type' | 'bytes' | 'source' | 'filepath' | 'storageKey'
  >;
  getStrategyFunctions: (source: string) => StrategyFunctions;
  policies: Map<string, DocumentPolicy>;
}

function policyKey(endpoint: string, model?: string, recipientId?: string): string {
  return JSON.stringify([endpoint, model, recipientId]);
}

/** Only files already hydrated and authorized by attachment processing can be resolved. */
export class BedrockDocumentContext {
  private readonly files = new Map<string, RegisteredDocument>();

  constructor(private readonly req: ServerRequest) {}

  register(
    file: IMongoFile,
    endpoint: string,
    maxBytes: number,
    getStrategyFunctions: RegisteredDocument['getStrategyFunctions'],
    onMissingFile?: MissingAttachmentHandler,
    model?: string,
    recipientId?: string,
  ): BedrockDocumentReference {
    if (!file.file_id) throw new BedrockDocumentError();
    const config = mergeFileConfig(this.req.config?.fileConfig);
    const limits = getEndpointFileConfig({ fileConfig: config, endpoint });
    const entry = this.files.get(file.file_id) ?? {
      file: {
        file_id: file.file_id,
        filename: file.filename,
        type: file.type,
        bytes: file.bytes,
        source: file.source,
        filepath: file.filepath,
        storageKey: file.storageKey,
      },
      getStrategyFunctions,
      policies: new Map<string, DocumentPolicy>(),
    };
    const key = policyKey(endpoint, model, recipientId);
    const existing = entry.policies.get(key);
    entry.policies.set(key, {
      maxBytes: Math.min(existing?.maxBytes ?? Infinity, maxBytes),
      totalBytes: Math.min(
        existing?.totalBytes ?? Infinity,
        limits.totalSizeLimit ?? Infinity,
        config.fileContextSizeLimit ?? Infinity,
      ),
      count: Math.min(existing?.count ?? Infinity, limits.fileLimit ?? Infinity),
      onMissingFile,
    });
    this.files.set(file.file_id, entry);
    return { librechatFile: file.file_id };
  }

  get(
    id: string,
    model?: string,
    endpoint: string = Providers.BEDROCK,
    recipientId?: string,
  ): RegisteredDocument & DocumentPolicy {
    const entry = this.files.get(id);
    const policy =
      entry?.policies.get(policyKey(endpoint, model, recipientId)) ??
      entry?.policies.get(policyKey(endpoint, undefined, recipientId));
    if (!entry || !policy) throw new BedrockDocumentError();
    return { ...entry, ...policy };
  }

  async read(
    id: string,
    maxBytes: number,
    signal?: AbortSignal,
    model?: string,
    endpoint: string = Providers.BEDROCK,
    recipientId?: string,
  ): Promise<Buffer | undefined> {
    const {
      file,
      getStrategyFunctions,
      onMissingFile,
      maxBytes: configured,
    } = this.get(id, model, endpoint, recipientId);
    const cap = clampBedrockLimit(maxBytes, configured);
    if (file.bytes != null) assertBedrockSize(file.bytes, cap);
    const budget = configuredRequestBudget(this.req.config, 'documentFetchMs', signal);
    budget.signal.throwIfAborted();
    let stream: Awaited<ReturnType<StrategyFunctions['getDownloadStream']>> | undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      const pending = getStrategyFunctions(file.source ?? FileSources.local).getDownloadStream(
        this.req,
        resolveDownloadPath(file),
        { signal: budget.signal },
      );
      stream = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
        const abort = (): void => reject(budget.signal.reason);
        budget.signal.addEventListener('abort', abort, { once: true });
        pending.then(
          (value) => {
            budget.signal.removeEventListener('abort', abort);
            if (budget.signal.aborted) {
              value.once('error', () => {});
              value.destroy();
              reject(budget.signal.reason);
            } else resolve(value);
          },
          (error: unknown) => {
            budget.signal.removeEventListener('abort', abort);
            reject(error);
          },
        );
        if (budget.signal.aborted) abort();
      });
      for await (const chunk of addAbortSignal(budget.signal, stream)) {
        if (!(chunk instanceof Uint8Array)) throw new BedrockDocumentError();
        assertBedrockSize(chunk.byteLength, cap - size);
        size += chunk.byteLength;
        chunks.push(
          Buffer.isBuffer(chunk) && chunk.buffer.byteLength <= Math.max(8192, chunk.byteLength * 2)
            ? chunk
            : Buffer.from(chunk),
        );
      }
      if (size === 0) throw new BedrockDocumentError();
      const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      if (file.type === 'application/pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new BedrockDocumentError();
      }
      return bytes;
    } catch (error) {
      if (isOwnedAbortError(error, budget.signal)) throw error;
      if (budget.signal.aborted) throw budget.signal.reason;
      if (error instanceof BedrockDocumentError) throw error;
      if (isStorageNotFoundError(error)) {
        if (onMissingFile) {
          onMissingFile(file);
          return undefined;
        }
        throw new AttachmentObjectNotFoundError(file.file_id);
      }
      logger.warn('[BedrockDocument] Storage read failed', getSafeErrorMetadata(error));
      throw new BedrockDocumentError();
    } finally {
      chunks.length = 0;
      stream?.destroy();
    }
  }
}

// The request owns metadata and injected storage functions, never document content.
const contexts = new WeakMap<ServerRequest, BedrockDocumentContext>();
export function getBedrockDocumentContext(req: ServerRequest): BedrockDocumentContext {
  let context = contexts.get(req);
  if (!context) {
    context = new BedrockDocumentContext(req);
    contexts.set(req, context);
  }
  return context;
}

/** Registers the shared/scoped topology before encoding or restoring checkpoint file IDs. */
export function registerBedrockResumeDocuments(
  req: ServerRequest,
  sharedFiles: IMongoFile[],
  recipients: Iterable<{
    id?: string;
    provider?: string;
    endpoint?: string | null;
    model?: string;
    model_parameters?: { model?: string };
  }>,
  getStrategyFunctions: RegisteredDocument['getStrategyFunctions'],
  scopedFiles: ReadonlyMap<string, IMongoFile[]> = new Map(),
): void {
  for (const agent of recipients) {
    if (agent.provider !== Providers.BEDROCK) continue;
    const endpoint = agent.endpoint ?? Providers.BEDROCK;
    const configured = getConfiguredFileSizeLimit(req, { provider: Providers.BEDROCK, endpoint });
    const model = agent.model_parameters?.model ?? agent.model;
    for (const files of [sharedFiles, (agent.id && scopedFiles.get(agent.id)) || []]) {
      for (const file of files) {
        if (!isBedrockDocumentType(file.type) || (!file.filepath && !file.storageKey)) continue;
        getBedrockDocumentContext(req).register(
          file,
          endpoint,
          getBedrockDocumentLimit(file.type, configured, model),
          getStrategyFunctions,
          undefined,
          model,
          agent.id,
        );
      }
    }
  }
}
