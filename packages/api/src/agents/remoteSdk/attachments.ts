import { createHash } from 'node:crypto';
import { FileSources } from 'librechat-data-provider';
import { Readable, addAbortSignal } from 'node:stream';
import { HostFileAdmission, HostFileServiceError, createHostFileService } from '@librechat/agents';
import type { TAgentsEndpoint, TFile } from 'librechat-data-provider';
import type { HostFileDescriptor } from '@librechat/agents';
import type { RunArtifactDescriptor } from '~/files/code/publication';
import type { TFilterFilesByAgentAccess } from '~/agents/resources';
import type { ServerRequest, StrategyFunctions } from '~/types';
import type { RunFileSnapshot } from '~/agents/files/snapshots';
import type { RemoteSdkHostServices } from './types';
import type { SdkAgentIdentity } from './identity';
import { assertModelBoundContent } from '~/middleware/modelBoundContent';
import { createRunFileSnapshotStore } from '~/agents/files/snapshots';
import { hasActiveFilePolicy } from '~/protection/files';
import { resolveDownloadPath } from '~/storage/path';

type Limits = NonNullable<NonNullable<TAgentsEndpoint>['sdkHostFiles']>;
type Binding = NonNullable<RemoteSdkHostServices['files']>;
type NativeFile = Pick<
  TFile,
  | 'file_id'
  | 'user'
  | 'source'
  | 'filepath'
  | 'bytes'
  | 'type'
  | 'filename'
  | 'updatedAt'
  | 'storageKey'
>;
interface Inputs {
  req: ServerRequest;
  audit?: (event: { action: 'cleanup_failed' }) => void;
  /** Host-selected, already hydrated attachments; never IDs supplied by the worker. */
  getInputs: () => readonly TFile[];
  loadFiles: (ids: string[]) => Promise<TFile[]>;
  filterFiles: TFilterFilesByAgentAccess;
  getStrategyFunctions: (source: string) => StrategyFunctions;
}
export interface SdkFileSession {
  bind(identity: Readonly<SdkAgentIdentity>, signal?: AbortSignal): Binding;
  close(): Promise<void>;
}
export interface SdkFileHost {
  createSession(inputs: Inputs): SdkFileSession;
  snapshot(): {
    operations: ReturnType<HostFileAdmission['snapshot']>;
    snapshots: ReturnType<HostFileAdmission['snapshot']>;
  };
}

const nativeSources = new Set<string>([
  FileSources.local,
  FileSources.s3,
  FileSources.cloudfront,
  FileSources.azure_blob,
  FileSources.firebase,
]);
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identityKey = (identity: Readonly<SdkAgentIdentity>): string =>
  digest([
    identity.runtimeId,
    identity.agentId,
    identity.runId,
    identity.userId,
    identity.tenantId,
    identity.conversationId,
  ]);
/** Revision includes the canonical object locator, but the locator never crosses the bridge. */
function stableLocator(file: NativeFile): string {
  const locator = resolveDownloadPath(file);
  if (file.source !== FileSources.local && /^https?:\/\//.test(locator)) {
    const url = new URL(locator);
    return url.origin + url.pathname;
  }
  return locator;
}
const revision = (file: NativeFile, locator: string): string =>
  digest([
    file.file_id,
    file.user,
    file.source ?? FileSources.local,
    locator,
    file.bytes,
    file.type,
    file.filename,
    file.updatedAt,
  ]);

/** One process owner, shared across users, runtimes, and concurrent/resumed turns. */
export function createSdkFileHost(limits: Limits | undefined): SdkFileHost | undefined {
  if (!limits) return undefined;
  const operations = new HostFileAdmission({
    maxConcurrentOperations: limits.maxConcurrentOperations,
    maxBufferedBytes: limits.maxBufferedBytes,
  });
  const snapshots = new HostFileAdmission({
    maxConcurrentOperations: limits.maxSnapshotFiles,
    maxBufferedBytes: limits.maxSnapshotBytes,
  });
  return {
    snapshot: () => ({ operations: operations.snapshot(), snapshots: snapshots.snapshot() }),
    createSession({
      req,
      audit,
      getInputs,
      loadFiles,
      filterFiles,
      getStrategyFunctions,
    }): SdkFileSession {
      const user = req.user;
      if (!user) throw new HostFileServiceError('forbidden');
      const { id: userId, tenantId, role } = user;
      const fileRevision = (file: NativeFile): string =>
        revision(
          file,
          getStrategyFunctions(file.source ?? FileSources.local).getStorageKey?.(file) ??
            stableLocator(file),
        );
      let binding: Binding | undefined;
      let boundIdentity: string | undefined;
      let closed = false;
      const captures = new Map<string, Promise<RunFileSnapshot>>();
      const openings = new WeakMap<RunArtifactDescriptor, Promise<Readable>>();
      const selected = new Map<string, { file: NativeFile; descriptor: HostFileDescriptor }>();
      const lifetime = new AbortController();
      const store = createRunFileSnapshotStore({
        maxBytes: limits.maxSnapshotBytes,
        maxFiles: limits.maxSnapshotFiles,
        reserve: (source) => {
          const item = selected.get(source.id);
          if (!item) throw new HostFileServiceError('forbidden');
          const release = snapshots.acquire(item.file.bytes);
          return () => {
            const pending = openings.get(source);
            if (pending) void pending.then(release, release);
            else release();
          };
        },
        open: async (source, signal) => {
          const item = selected.get(source.id);
          if (!item) throw new HostFileServiceError('forbidden');
          const opening = Promise.resolve().then(() => {
            signal?.throwIfAborted();
            return getStrategyFunctions(item.file.source ?? FileSources.local).getDownloadStream(
              req,
              resolveDownloadPath(item.file),
              { signal },
            );
          });
          openings.set(source, opening);
          const stream = await opening;
          if (signal?.aborted) {
            stream.destroy();
            signal.throwIfAborted();
          }
          if (signal) addAbortSignal(signal, stream);
          // Bound actual disk consumption even when storage disagrees with metadata.
          return Readable.from(
            (async function* () {
              let bytes = 0;
              try {
                for await (const chunk of stream) {
                  signal?.throwIfAborted();
                  if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))
                    throw new HostFileServiceError('unavailable');
                  bytes += chunk.byteLength;
                  if (bytes > item.file.bytes) throw new HostFileServiceError('conflict');
                  yield chunk;
                }
                if (bytes !== item.file.bytes) throw new HostFileServiceError('conflict');
              } finally {
                stream.destroy();
              }
            })(),
          );
        },
      });
      async function authorize(
        item: { file: NativeFile; descriptor: HostFileDescriptor },
        identity: Readonly<SdkAgentIdentity>,
      ): Promise<void> {
        const files = await loadFiles([item.file.file_id]);
        const admitted = await filterFiles({
          files,
          userId: identity.userId,
          role,
          agentId: identity.agentId,
        });
        const current = admitted.find((file) => file.file_id === item.file.file_id);
        if (!current) throw new HostFileServiceError('forbidden');
        if (fileRevision(current) !== item.descriptor.revision)
          throw new HostFileServiceError('conflict');
        assertModelBoundContent({ filters: req.config?.filters, files: [current] });
        item.file.filepath = current.filepath;
        item.file.storageKey = current.storageKey;
      }
      return {
        bind(identity, signal) {
          if (closed) throw new HostFileServiceError('unavailable');
          if (identity.userId !== userId || identity.tenantId !== (tenantId ?? undefined))
            throw new HostFileServiceError('forbidden');
          const key = identityKey(identity);
          if (binding) {
            if (key !== boundIdentity) throw new HostFileServiceError('forbidden');
            return binding;
          }
          const inputs = [...new Map(getInputs().map((file) => [file.file_id, file])).values()];
          if (inputs.length > limits.maxSnapshotFiles) throw new HostFileServiceError('overflow');
          // Raw byte reads cannot substitute metadata inspection for content transformation.
          if (inputs.length && hasActiveFilePolicy(req.config?.filters))
            throw new HostFileServiceError('forbidden');
          assertModelBoundContent({ filters: req.config?.filters, files: inputs });
          selected.clear();
          const sources = inputs.map((file): HostFileDescriptor => {
            if (!nativeSources.has(file.source ?? FileSources.local))
              throw new HostFileServiceError('incompatible');
            if (
              !Number.isSafeInteger(file.bytes) ||
              file.bytes < 0 ||
              file.bytes > limits.maxFileBytes
            )
              throw new HostFileServiceError('overflow');
            const descriptor = Object.freeze({
              reference: digest([key, file.file_id]),
              revision: fileRevision(file),
              filename: file.filename,
              mediaType: file.type,
              bytes: file.bytes,
            });
            const {
              file_id,
              user,
              source,
              filepath,
              bytes,
              type,
              filename,
              updatedAt,
              storageKey,
            } = file;
            selected.set(descriptor.reference, {
              file: structuredClone({
                file_id,
                user,
                source,
                filepath,
                bytes,
                type,
                filename,
                updatedAt,
                storageKey,
              }),
              descriptor,
            });
            return descriptor;
          });
          const effectiveSignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
          const service = createHostFileService({
            identity,
            descriptor: {
              version: 1,
              operations: ['read'],
              maxFileBytes: limits.maxFileBytes,
              maxChunkBytes: limits.maxChunkBytes,
            },
            admission: operations,
            timeoutMs: limits.timeoutMs,
            signal: effectiveSignal,
            store: {
              async read(request, readSignal) {
                const item = selected.get(request.reference);
                if (!item) throw new HostFileServiceError('forbidden');
                if (request.revision !== item.descriptor.revision)
                  throw new HostFileServiceError('conflict');
                if (
                  request.offset > item.file.bytes ||
                  request.length > item.file.bytes - request.offset
                )
                  throw new HostFileServiceError('conflict');
                let capture = captures.get(request.reference);
                if (!capture) {
                  // A snapshot belongs to the run, not to whichever chunk request arrived first.
                  capture = (async () => {
                    await authorize(item, identity);
                    effectiveSignal.throwIfAborted();
                    const source = {
                      id: request.reference,
                      name: item.file.filename,
                      sessionId: identity.runId,
                    };
                    try {
                      return await store.capture(source, effectiveSignal);
                    } finally {
                      // SDK timeouts may return early; admission stays held until an
                      // uncooperative native opener settles and its late stream is destroyed.
                      await openings.get(source)?.catch(() => undefined);
                    }
                  })();
                  captures.set(request.reference, capture);
                  void capture.catch(() => {
                    if (captures.get(request.reference) === capture)
                      captures.delete(request.reference);
                  });
                }
                const captured = await capture;
                readSignal?.throwIfAborted();
                const data = await store.readRange(
                  captured.snapshotId,
                  request.offset,
                  request.length,
                  readSignal,
                );
                // Check current permission/revision after IO, including cached snapshots.
                await authorize(item, identity);
                readSignal?.throwIfAborted();
                return {
                  reference: request.reference,
                  revision: request.revision,
                  offset: request.offset,
                  data,
                };
              },
              async stage() {
                throw new HostFileServiceError('incompatible');
              },
              async publish() {
                throw new HostFileServiceError('incompatible');
              },
            },
          });
          binding = { ...service, sources: Object.freeze(sources) };
          boundIdentity = key;
          return binding;
        },
        async close() {
          closed = true;
          lifetime.abort();
          await Promise.allSettled(captures.values());
          await store.close().catch(() => {
            // Cleanup must not prevent usage settlement or turn finalization. The
            // snapshot store retains quota for private bytes it could not delete.
            try {
              audit?.({ action: 'cleanup_failed' });
            } catch {
              /* Diagnostics cannot own settlement. */
            }
          });
          captures.clear();
          selected.clear();
        },
      };
    },
  };
}

/** Request wiring supplies native storage and authorization; absence stays opt-out. */
export function createChatSdkFileSession({
  host,
  ...inputs
}: Inputs & { host?: SdkFileHost }): SdkFileSession | undefined {
  return host?.createSession(inputs);
}
