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
import type { StoredSteerOwner } from './owners';
import {
  AttachmentObjectNotFoundError,
  isStorageNotFoundError,
  getConfiguredFileSizeLimit,
} from '../encode/utils';
import { BedrockDocumentError, assertBedrockSize, clampBedrockLimit } from './limits';
import { getSafeErrorMetadata, isOwnedAbortError } from '~/utils/errors';
import { steerContentDigest, validateSteerMedia } from './owners';
import { configuredRequestBudget } from '~/utils/timeouts';
import { getBedrockDocumentLimit } from '../validation';
import { resolveDownloadPath } from '~/storage/path';

export interface BedrockDocumentReference {
  librechatFile: string;
  librechatSteer?: string;
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
  strictRecipients: Set<string>;
}

function policyKey(endpoint: string, model?: string, recipientId?: string): string {
  return JSON.stringify([endpoint, model, recipientId]);
}

function recipientKey(endpoint: string, recipientId?: string): string {
  return JSON.stringify([endpoint, recipientId]);
}

/** Only files already hydrated and authorized by attachment processing can be resolved. */
export class BedrockDocumentContext {
  private readonly files = new Map<string, RegisteredDocument>();
  private readonly admissions = new Map<string, BedrockDocumentContext>();
  private readonly steerRepairs = new Map<
    string,
    {
      context: BedrockDocumentContext;
      repair: (owner: StoredSteerOwner) => Promise<void>;
      binding?: StoredSteerOwner;
      pending?: Promise<void>;
      retry?: () => Promise<void>;
      repaired: boolean;
    }
  >();

  private readonly storedSteers = new Map<string, StoredSteerOwner>();
  private readonly references = new WeakMap<object, { fileId: string; owner?: string }>();

  constructor(private readonly req: ServerRequest) {}

  register(
    file: IMongoFile,
    endpoint: string,
    maxBytes: number,
    getStrategyFunctions: RegisteredDocument['getStrategyFunctions'],
    onMissingFile?: MissingAttachmentHandler,
    model?: string,
    recipientId?: string,
    registration: 'input' | 'topology' = 'input',
    admissionId?: string,
  ): BedrockDocumentReference {
    if (admissionId != null) {
      const admission = this.admissions.get(admissionId);
      if (!admission) throw new BedrockDocumentError();
      const reference = admission.register(
        file,
        endpoint,
        maxBytes,
        getStrategyFunctions,
        onMissingFile,
        model,
        recipientId,
        registration,
      );
      const owned = this.steerRepairs.has(admissionId)
        ? { ...reference, librechatSteer: admissionId }
        : reference;
      this.references.set(owned, {
        fileId: file.file_id,
        owner: this.steerRepairs.has(admissionId) ? admissionId : undefined,
      });
      return owned;
    }
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
      strictRecipients: new Set<string>(),
    };
    if (registration === 'input' && !onMissingFile) {
      entry.strictRecipients.add(recipientKey(endpoint, recipientId));
    }
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
      onMissingFile:
        registration === 'topology'
          ? (existing?.onMissingFile ?? onMissingFile)
          : (onMissingFile ?? existing?.onMissingFile),
    });
    this.files.set(file.file_id, entry);
    const reference = { librechatFile: file.file_id };
    this.references.set(reference, { fileId: file.file_id });
    return reference;
  }

  prepareAdmission(
    id: string,
    admission: BedrockDocumentContext,
    repair?: (owner: StoredSteerOwner) => Promise<void>,
  ): () => void {
    if (this.admissions.has(id) || this.steerRepairs.has(id)) throw new BedrockDocumentError();
    return () => {
      this.admissions.set(id, admission);
      if (repair) this.steerRepairs.set(id, { context: admission, repair, repaired: false });
    };
  }

  settleAdmission(id: string, commit: boolean): void {
    const admission = this.admissions.get(id);
    if (!admission) return;
    if (commit && this.steerRepairs.has(id)) return;
    if (commit) {
      for (const [fileId, incoming] of admission.files) {
        const existing = this.files.get(fileId);
        if (!existing) {
          this.files.set(fileId, incoming);
          continue;
        }
        for (const [key, policy] of incoming.policies) {
          const previous = existing.policies.get(key);
          existing.policies.set(key, {
            maxBytes: Math.min(previous?.maxBytes ?? Infinity, policy.maxBytes),
            totalBytes: Math.min(previous?.totalBytes ?? Infinity, policy.totalBytes),
            count: Math.min(previous?.count ?? Infinity, policy.count),
            onMissingFile: previous?.onMissingFile ?? policy.onMissingFile,
          });
        }
        for (const key of incoming.strictRecipients) existing.strictRecipients.add(key);
      }
    }
    this.admissions.delete(id);
  }

  rememberOwners(owners: readonly StoredSteerOwner[]): void {
    for (const owner of owners) this.storedSteers.set(owner.steerId, owner);
  }

  bindSteer(
    id: string,
    content: unknown,
    sourceMessageId: string,
    partIndex: number,
    files?: readonly { file_id?: string }[],
  ): StoredSteerOwner | undefined {
    const owner = this.steerRepairs.get(id);
    if (!owner) return undefined;
    if (!Array.isArray(content)) throw new BedrockDocumentError();
    for (const part of content) {
      const source = part?.document?.source;
      if (!source) continue;
      const bound = this.references.get(source);
      if (!bound || bound.owner !== id || bound.fileId !== source.librechatFile)
        throw new BedrockDocumentError();
      source.librechatSteerSource = sourceMessageId;
      source.librechatSteerPart = partIndex;
    }
    owner.binding = {
      steerId: id,
      sourceMessageId,
      partIndex,
      fileIds: files
        ? files.flatMap((file) => (file.file_id ? [file.file_id] : []))
        : [...owner.context.files.keys()],
      digest: steerContentDigest(content),
      repaired: false,
    };
    return owner.binding;
  }

  validateReference(source: object): void {
    const claim = source as Record<string, unknown>,
      bound = this.references.get(source);
    if (bound && (bound.fileId !== claim.librechatFile || bound.owner !== claim.librechatSteer))
      throw new BedrockDocumentError();
  }

  sourceOwner(source: object, content: unknown): StoredSteerOwner | undefined {
    this.validateReference(source);
    const claim = source as Record<string, unknown>;
    if (typeof claim.librechatSteer !== 'string') return undefined;
    if (Array.isArray(content))
      for (const part of content) {
        const ref = part?.document?.source;
        if (ref) this.validateReference(ref);
      }
    const live = this.steerRepairs.get(claim.librechatSteer);
    const binding = live?.binding
      ? { ...live.binding, repaired: live.repaired }
      : this.storedSteers.get(claim.librechatSteer);
    return validateSteerMedia(content, binding ? [binding] : []);
  }

  isSteerRepaired(id: string): boolean {
    return (
      this.steerRepairs.get(id)?.repaired === true || this.storedSteers.get(id)?.repaired === true
    );
  }

  ownsSteer(
    id: string,
    fileId: string,
    model?: string,
    endpoint: string = Providers.BEDROCK,
    recipientId?: string,
  ): boolean {
    const owner = this.steerRepairs.get(id);
    if (!owner) {
      if (!this.storedSteers.get(id)?.fileIds.includes(fileId)) throw new BedrockDocumentError();
      return false;
    }
    if (!owner.context.localPolicy(fileId, model, endpoint, recipientId))
      throw new BedrockDocumentError();
    return true;
  }

  async repairSteer(
    id: string,
    fileId: string,
    model?: string,
    endpoint: string = Providers.BEDROCK,
    recipientId?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const owner = this.steerRepairs.get(id);
    if (!owner) return false;
    if (!owner.context.localPolicy(fileId, model, endpoint, recipientId))
      throw new BedrockDocumentError();
    signal?.throwIfAborted();
    owner.retry ??= () => {
      owner.pending = Promise.resolve()
        .then(() => {
          if (!owner.binding) throw new BedrockDocumentError();
          return owner.repair(owner.binding);
        })
        .then(
          () => {
            owner.repaired = true;
            this.admissions.delete(id);
          },
          (error: unknown) => {
            owner.pending = undefined;
            logger.warn('[BedrockDocument] Steer repair failed', getSafeErrorMetadata(error));
            throw new Error('Steer attachment recovery failed. Please retry.');
          },
        );
      return owner.pending;
    };
    await (owner.pending ?? owner.retry());
    signal?.throwIfAborted();
    return true;
  }

  async waitForSteerRepair(id: string): Promise<boolean> {
    const owner = this.steerRepairs.get(id);
    if (owner?.retry && !owner.repaired) await (owner.pending ?? owner.retry());
    else await owner?.pending;
    return this.isSteerRepaired(id);
  }

  private localPolicy(
    id: string,
    model?: string,
    endpoint: string = Providers.BEDROCK,
    recipientId?: string,
  ): (RegisteredDocument & DocumentPolicy) | undefined {
    const entry = this.files.get(id);
    const policy =
      entry?.policies.get(policyKey(endpoint, model, recipientId)) ??
      entry?.policies.get(policyKey(endpoint, undefined, recipientId));
    if (!entry || !policy) return undefined;
    return {
      ...entry,
      ...policy,
      onMissingFile: entry.strictRecipients.has(recipientKey(endpoint, recipientId))
        ? undefined
        : policy.onMissingFile,
    };
  }

  get(
    id: string,
    model?: string,
    endpoint: string = Providers.BEDROCK,
    recipientId?: string,
  ): RegisteredDocument & DocumentPolicy {
    let result = this.localPolicy(id, model, endpoint, recipientId);
    let strict =
      this.files.get(id)?.strictRecipients.has(recipientKey(endpoint, recipientId)) === true;
    for (const admission of this.admissions.values()) {
      strict ||=
        admission.files.get(id)?.strictRecipients.has(recipientKey(endpoint, recipientId)) === true;
      const incoming = admission.localPolicy(id, model, endpoint, recipientId);
      if (!incoming) continue;
      result = result
        ? {
            ...result,
            maxBytes: Math.min(result.maxBytes, incoming.maxBytes),
            totalBytes: Math.min(result.totalBytes, incoming.totalBytes),
            count: Math.min(result.count, incoming.count),
            onMissingFile:
              result.onMissingFile && incoming.onMissingFile ? result.onMissingFile : undefined,
          }
        : incoming;
    }
    if (!result) throw new BedrockDocumentError();
    return strict ? { ...result, onMissingFile: undefined } : result;
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
      this.get(id, model, endpoint, recipientId);
      return bytes;
    } catch (error) {
      if (isOwnedAbortError(error, budget.signal)) throw error;
      if (budget.signal.aborted) throw budget.signal.reason;
      if (error instanceof BedrockDocumentError) throw error;
      if (isStorageNotFoundError(error)) {
        const onMissingFile = this.get(id, model, endpoint, recipientId).onMissingFile;
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

function omitHistoricalDocument(): void {}

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
  historicalFileIds?: ReadonlySet<string>,
  context?: BedrockDocumentContext,
): void {
  for (const agent of recipients) {
    if (agent.provider !== Providers.BEDROCK) continue;
    const endpoint = agent.endpoint ?? Providers.BEDROCK;
    const configured = getConfiguredFileSizeLimit(req, { provider: Providers.BEDROCK, endpoint });
    const model = agent.model_parameters?.model ?? agent.model;
    for (const files of [sharedFiles, (agent.id && scopedFiles.get(agent.id)) || []]) {
      for (const file of files) {
        if (!isBedrockDocumentType(file.type) || (!file.filepath && !file.storageKey)) continue;
        (context ?? getBedrockDocumentContext(req)).register(
          file,
          endpoint,
          getBedrockDocumentLimit(file.type, configured, model),
          getStrategyFunctions,
          historicalFileIds?.has(file.file_id) ? omitHistoricalDocument : undefined,
          model,
          agent.id,
          historicalFileIds != null && !historicalFileIds.has(file.file_id) ? 'input' : 'topology',
        );
      }
    }
  }
}

/** Prepare only the newly admitted IDs; publish after the synchronous admission checks commit. */
export function prepareBedrockSteerDocuments(
  req: ServerRequest,
  files: IMongoFile[],
  recipients: Parameters<typeof registerBedrockResumeDocuments>[2],
  getStrategyFunctions: RegisteredDocument['getStrategyFunctions'],
  steerId?: string,
  endpoints?: ReadonlyMap<string, { endpoint?: string | null }>,
  repair?: (owner: StoredSteerOwner) => Promise<void>,
): () => void {
  const documents = files.filter(
    (file) => isBedrockDocumentType(file.type) && (file.filepath || file.storageKey),
  );
  if (!documents.length) return () => {};
  const admittedRecipients = Array.from(recipients).filter(
    (agent) =>
      agent.provider === Providers.BEDROCK && agent.id && (!endpoints || endpoints.has(agent.id)),
  );
  if (!admittedRecipients.length) return () => {};
  if (!steerId) throw new BedrockDocumentError();
  const staged = new BedrockDocumentContext(req);
  registerBedrockResumeDocuments(
    req,
    documents,
    admittedRecipients,
    getStrategyFunctions,
    new Map(),
    new Set(),
    staged,
  );
  return getBedrockDocumentContext(req).prepareAdmission(steerId, staged, repair);
}

export function settleBedrockSteerDocuments(
  req: ServerRequest | undefined,
  steerId: string,
  commit: boolean,
): void {
  if (req) contexts.get(req)?.settleAdmission(steerId, commit);
}

export function restoreBedrockSteerOwners(
  req: ServerRequest,
  owners?: readonly StoredSteerOwner[],
): void {
  if (owners?.length) getBedrockDocumentContext(req).rememberOwners(owners);
}

export function bindBedrockSteerSource(
  req: ServerRequest,
  id: string,
  content: unknown,
  sourceMessageId: string,
  partIndex: number,
  files?: readonly { file_id?: string }[],
): StoredSteerOwner | undefined {
  return contexts.get(req)?.bindSteer(id, content, sourceMessageId, partIndex, files);
}
