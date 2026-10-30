import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  ChannelRunRecord,
  RunArtifactRunScope,
  ResponseArtifactFile,
  ResponseArtifactQuery,
} from '@librechat/data-schemas';
import type { ChannelArtifact, ChannelRunSnapshot } from 'librechat-data-provider';
import type { Readable } from 'node:stream';

interface ArtifactLimits {
  artifactMaxBytes: number;
  artifactMaxFiles: number;
  artifactReadTimeoutMs: number;
}
export interface ChannelArtifactDependencies {
  /** Null means the owned assistant response is absent or expired; failures propagate. */
  readArtifacts: (
    scope: RunArtifactRunScope,
    query: ResponseArtifactQuery,
  ) => Promise<ResponseArtifactFile[] | null>;
  readFile: (
    file: ResponseArtifactFile,
    run: ChannelRunRecord,
    signal: AbortSignal,
  ) => Promise<Readable | null>;
  limits: () => Promise<ArtifactLimits>;
}
export class ChannelArtifactError extends Error {
  constructor(readonly code: 'artifact_unavailable' | 'artifact_changed' | 'artifact_too_large') {
    super(code);
    this.name = 'ChannelArtifactError';
  }
}
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const filename = (value: string) =>
  basename(value.replace(/\\/g, '/'))
    .replace(/\p{Cc}/gu, '')
    .slice(0, 180) || 'artifact.bin';
const mediaType = (value: string) =>
  /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value) ? value : 'application/octet-stream';

export interface ChannelArtifactService {
  list(
    run: ChannelRunRecord,
    snapshot: ChannelRunSnapshot,
  ): Promise<{ artifacts: ChannelArtifact[]; unavailable: boolean }>;
  content(
    run: ChannelRunRecord,
    artifactId: string,
  ): Promise<{ descriptor: ChannelArtifact; bytes: Buffer }>;
}
function artifactScope(run: ChannelRunRecord, responseId: string): RunArtifactRunScope {
  if (!run.execution || run.execution.responseId !== responseId)
    throw new ChannelArtifactError('artifact_changed');
  return {
    userId: run.principal.userId,
    tenantId: run.tenantId === '_' ? undefined : run.tenantId || undefined,
    conversationId: run.execution.conversationId,
    runId: responseId,
  };
}

export function isChannelArtifactExpired(file: ResponseArtifactFile): boolean {
  return [file.expiredAt, file.expiresAt].some(
    (value) =>
      value != null &&
      (!Number.isFinite(new Date(value).getTime()) || new Date(value).getTime() <= Date.now()),
  );
}

/** One response-scoped catalog owns provenance, expiry, projection and database bounds. */
export function createChannelArtifactService(
  deps: ChannelArtifactDependencies,
): ChannelArtifactService {
  async function read(
    run: ChannelRunRecord,
    file: ResponseArtifactFile,
    limits: ArtifactLimits,
  ): Promise<Buffer | null> {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > limits.artifactMaxBytes)
      return null;
    const controller = new AbortController();
    const signal = controller.signal;
    let stream: Readable | null = null;
    let rejectDeadline!: (error: ChannelArtifactError) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const abort = () => {
      stream?.destroy();
      rejectDeadline(new ChannelArtifactError('artifact_unavailable'));
    };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), limits.artifactReadTimeoutMs);
    const acquisition = Promise.resolve().then(() => deps.readFile(file, run, signal));
    void acquisition.then(
      (late) => {
        if (signal.aborted && late) {
          late.once('error', () => {});
          late.destroy();
        }
      },
      () => {},
    );
    try {
      stream = await Promise.race([acquisition, deadline]);
      if (!stream) return null;
      const acquired = stream;
      const consume = async () => {
        let length = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of acquired) {
          if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string')
            throw new ChannelArtifactError('artifact_unavailable');
          length += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
          if (length > limits.artifactMaxBytes)
            throw new ChannelArtifactError('artifact_too_large');
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (isChannelArtifactExpired(file)) return null;
        return Buffer.concat(chunks, length);
      };
      return await Promise.race([consume(), deadline]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      stream?.destroy();
    }
  }
  return {
    async list(run, snapshot) {
      if (snapshot.status !== 'completed' || !snapshot.responseId)
        return { artifacts: [], unavailable: false };
      const scope = artifactScope(run, snapshot.responseId);
      const limits = await deps.limits();
      const candidates = await deps.readArtifacts(scope, {
        kind: 'list',
        limit: limits.artifactMaxFiles + 1,
      });
      if (!candidates) return { artifacts: [], unavailable: true };
      const descriptors: ChannelArtifact[] = [];
      let unavailable = candidates.length > limits.artifactMaxFiles;
      for (const file of candidates.slice(0, limits.artifactMaxFiles)) {
        let content: Buffer | null;
        try {
          content = await read(run, file, limits);
        } catch {
          unavailable = true;
          continue;
        }
        if (!content) {
          unavailable = true;
          continue;
        }
        const sha256 = hash(content);
        descriptors.push({
          artifactId: `${file.file_id}:${sha256}`,
          filename: filename(file.filename),
          mediaType: mediaType(file.type),
          bytes: content.length,
          sha256,
        });
      }
      const answerLength = Buffer.byteLength(snapshot.text);
      if (
        !descriptors.length &&
        (snapshot.text.includes('```') || answerLength > 6000) &&
        answerLength <= limits.artifactMaxBytes
      ) {
        const answer = Buffer.from(snapshot.text);
        const sha256 = hash(answer);
        descriptors.push({
          artifactId: `answer:${sha256}`,
          filename: 'agent-response.md',
          mediaType: 'text/markdown',
          bytes: answer.length,
          sha256,
        });
      }
      if (!(await deps.readArtifacts(scope, { kind: 'authorize' })))
        return { artifacts: [], unavailable: true };
      return { artifacts: descriptors, unavailable };
    },
    async content(run, artifactId) {
      const descriptor = run.snapshot?.artifacts?.find((item) => item.artifactId === artifactId);
      if (!descriptor || run.snapshot?.status !== 'completed' || !run.snapshot.responseId)
        throw new ChannelArtifactError('artifact_unavailable');
      const scope = artifactScope(run, run.snapshot.responseId);
      const limits = await deps.limits();
      if (descriptor.bytes > limits.artifactMaxBytes)
        throw new ChannelArtifactError('artifact_too_large');
      let bytes: Buffer | null;
      if (artifactId === `answer:${descriptor.sha256}`) {
        if (!(await deps.readArtifacts(scope, { kind: 'authorize' })))
          throw new ChannelArtifactError('artifact_unavailable');
        if (Buffer.byteLength(run.snapshot.text) > limits.artifactMaxBytes)
          throw new ChannelArtifactError('artifact_too_large');
        bytes = Buffer.from(run.snapshot.text);
      } else {
        const suffix = `:${descriptor.sha256}`;
        if (!artifactId.endsWith(suffix)) throw new ChannelArtifactError('artifact_changed');
        const files = await deps.readArtifacts(scope, {
          kind: 'file',
          fileId: artifactId.slice(0, -suffix.length),
        });
        bytes = files?.[0] ? await read(run, files[0], limits) : null;
      }
      if (!bytes || !(await deps.readArtifacts(scope, { kind: 'authorize' })))
        throw new ChannelArtifactError('artifact_unavailable');
      if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256)
        throw new ChannelArtifactError('artifact_changed');
      return { descriptor, bytes };
    },
  };
}
