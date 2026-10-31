import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { CHANNEL_ARTIFACT_READ_TIMEOUT_HARD_MAX_MS } from 'librechat-data-provider';
import type {
  ChannelRunRecord,
  RunArtifactRunScope,
  ResponseArtifactFile,
  ResponseArtifactQuery,
} from '@librechat/data-schemas';
import type { ChannelArtifact, ChannelRunSnapshot } from 'librechat-data-provider';
import type { ChannelConfig } from 'librechat-data-provider';
import type { Readable } from 'node:stream';

type ArtifactLimits = Pick<
  ChannelConfig,
  | 'artifactMaxBytes'
  | 'artifactMaxFiles'
  | 'artifactReadTimeoutMs'
  | 'artifactAnswerFileThresholdBytes'
>;
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

/** Policy lookup is capped by the schema maximum; the selected budget tightens from invocation. */
class ArtifactBudget {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly startedAt = performance.now();
  private expiresAt = this.startedAt + CHANNEL_ARTIFACT_READ_TIMEOUT_HARD_MAX_MS;
  private timer: ReturnType<typeof setTimeout>;

  constructor() {
    this.timer = setTimeout(
      () => this.controller.abort(),
      CHANNEL_ARTIFACT_READ_TIMEOUT_HARD_MAX_MS,
    );
  }

  tighten(timeoutMs: number): void {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > CHANNEL_ARTIFACT_READ_TIMEOUT_HARD_MAX_MS
    )
      throw new TypeError('Invalid artifact operation timeout');
    this.expiresAt = Math.min(this.expiresAt, this.startedAt + timeoutMs);
    clearTimeout(this.timer);
    this.assertActive();
    this.timer = setTimeout(
      () => this.controller.abort(),
      Math.ceil(this.expiresAt - performance.now()),
    );
  }

  assertActive(): void {
    if (this.signal.aborted || performance.now() >= this.expiresAt) {
      this.controller.abort();
      throw new ChannelArtifactError('artifact_unavailable');
    }
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.assertActive();
    let rejectAbort!: (error: ChannelArtifactError) => void;
    const expired = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const aborted = () => rejectAbort(new ChannelArtifactError('artifact_unavailable'));
    this.signal.addEventListener('abort', aborted, { once: true });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.assertActive();
          return work();
        }),
        expired,
      ]);
      this.assertActive();
      return result;
    } finally {
      // A shared pending race promise would retain every completed file buffer until operation end.
      this.signal.removeEventListener('abort', aborted);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.controller.abort();
  }
}

function destroyStream(stream: Readable | null): void {
  if (!stream) return;
  stream.once('error', () => {});
  stream.destroy();
}

/** One deadline and one bounded stream at a time cover policy, catalog and current authorization. */
export function createChannelArtifactService(
  deps: ChannelArtifactDependencies,
): ChannelArtifactService {
  async function read(
    run: ChannelRunRecord,
    file: ResponseArtifactFile,
    limits: ArtifactLimits,
    budget: ArtifactBudget,
  ): Promise<Buffer | null> {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > limits.artifactMaxBytes)
      return null;
    let stream: Readable | null = null;
    const abort = () => destroyStream(stream);
    budget.signal.addEventListener('abort', abort, { once: true });
    const acquisition = Promise.resolve().then(() => {
      budget.assertActive();
      return deps.readFile(file, run, budget.signal);
    });
    void acquisition.then(
      (late) => {
        if (budget.signal.aborted) destroyStream(late);
      },
      () => {},
    );
    try {
      stream = await budget.run(() => acquisition);
      if (!stream) return null;
      const acquired = stream;
      return await budget.run(async () => {
        let length = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of acquired) {
          budget.assertActive();
          if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string')
            throw new ChannelArtifactError('artifact_unavailable');
          length += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
          if (length > limits.artifactMaxBytes)
            throw new ChannelArtifactError('artifact_too_large');
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (isChannelArtifactExpired(file)) return null;
        return Buffer.concat(chunks, length);
      });
    } finally {
      budget.signal.removeEventListener('abort', abort);
      destroyStream(stream);
    }
  }
  return {
    async list(run, snapshot) {
      if (snapshot.status !== 'completed' || !snapshot.responseId)
        return { artifacts: [], unavailable: false };
      const scope = artifactScope(run, snapshot.responseId);
      const budget = new ArtifactBudget();
      try {
        const limits = await budget.run(() => deps.limits());
        budget.tighten(limits.artifactReadTimeoutMs);
        const candidates = await budget.run(() =>
          deps.readArtifacts(scope, { kind: 'list', limit: limits.artifactMaxFiles + 1 }),
        );
        if (!candidates) return { artifacts: [], unavailable: true };
        const descriptors: ChannelArtifact[] = [];
        let unavailable = candidates.length > limits.artifactMaxFiles;
        for (const file of candidates.slice(0, limits.artifactMaxFiles)) {
          budget.assertActive();
          let content: Buffer | null;
          try {
            content = await read(run, file, limits, budget);
          } catch {
            budget.assertActive();
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
          (snapshot.text.includes('```') ||
            answerLength > limits.artifactAnswerFileThresholdBytes) &&
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
        if (!(await budget.run(() => deps.readArtifacts(scope, { kind: 'authorize' }))))
          return { artifacts: [], unavailable: true };
        return { artifacts: descriptors, unavailable };
      } catch (error) {
        if (budget.signal.aborted) return { artifacts: [], unavailable: true };
        throw error;
      } finally {
        budget.dispose();
      }
    },
    async content(run, artifactId) {
      const descriptor = run.snapshot?.artifacts?.find((item) => item.artifactId === artifactId);
      if (!descriptor || run.snapshot?.status !== 'completed' || !run.snapshot.responseId)
        throw new ChannelArtifactError('artifact_unavailable');
      const scope = artifactScope(run, run.snapshot.responseId);
      const budget = new ArtifactBudget();
      try {
        const limits = await budget.run(() => deps.limits());
        budget.tighten(limits.artifactReadTimeoutMs);
        if (descriptor.bytes > limits.artifactMaxBytes)
          throw new ChannelArtifactError('artifact_too_large');
        let bytes: Buffer | null;
        if (artifactId === `answer:${descriptor.sha256}`) {
          if (!(await budget.run(() => deps.readArtifacts(scope, { kind: 'authorize' }))))
            throw new ChannelArtifactError('artifact_unavailable');
          if (Buffer.byteLength(run.snapshot.text) > limits.artifactMaxBytes)
            throw new ChannelArtifactError('artifact_too_large');
          bytes = Buffer.from(run.snapshot.text);
        } else {
          const suffix = `:${descriptor.sha256}`;
          if (!artifactId.endsWith(suffix)) throw new ChannelArtifactError('artifact_changed');
          const files = await budget.run(() =>
            deps.readArtifacts(scope, {
              kind: 'file',
              fileId: artifactId.slice(0, -suffix.length),
            }),
          );
          bytes = files?.[0] ? await read(run, files[0], limits, budget) : null;
        }
        if (!bytes || !(await budget.run(() => deps.readArtifacts(scope, { kind: 'authorize' }))))
          throw new ChannelArtifactError('artifact_unavailable');
        if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256)
          throw new ChannelArtifactError('artifact_changed');
        budget.assertActive();
        return { descriptor, bytes };
      } finally {
        budget.dispose();
      }
    },
  };
}
