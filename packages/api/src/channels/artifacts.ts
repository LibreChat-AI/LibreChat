import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  ChannelRunRecord,
  RunArtifactRunScope,
  RunArtifactFile,
} from '@librechat/data-schemas';
import type { ChannelArtifact, ChannelRunSnapshot } from 'librechat-data-provider';
import type { Readable } from 'node:stream';

export interface ChannelArtifactDependencies {
  /** Existing run-artifact storage enforces exact owner, tenant, conversation and response provenance. */
  listFiles: (scope: RunArtifactRunScope) => Promise<RunArtifactFile[]>;
  readFile: (
    file: RunArtifactFile,
    run: ChannelRunRecord,
    signal: AbortSignal,
  ) => Promise<Readable | null>;
  limits: () => Promise<{
    artifactMaxBytes: number;
    artifactMaxFiles: number;
    artifactReadTimeoutMs: number;
  }>;
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

/** No arbitrary paths/URLs: every binary is re-resolved from this exact saved response. */
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

export function createChannelArtifactService(
  deps: ChannelArtifactDependencies,
): ChannelArtifactService {
  async function files(run: ChannelRunRecord, responseId: string) {
    if (!run.execution) return [];
    const candidates = await deps.listFiles({
      userId: run.principal.userId,
      tenantId: run.tenantId === '_' ? undefined : run.tenantId,
      conversationId: run.execution.conversationId,
      runId: responseId,
    });
    const now = Date.now();
    return candidates.filter(
      (file) => file.expiredAt == null || new Date(file.expiredAt).getTime() > now,
    );
  }
  async function read(run: ChannelRunRecord, file: RunArtifactFile): Promise<Buffer | null> {
    const limits = await deps.limits();
    if (file.bytes < 0 || file.bytes > limits.artifactMaxBytes) return null;
    const signal = AbortSignal.timeout(limits.artifactReadTimeoutMs);
    const stream = await deps.readFile(file, run, signal);
    if (!stream) return null;
    const abort = () => stream.destroy(new ChannelArtifactError('artifact_unavailable'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string')
          throw new ChannelArtifactError('artifact_unavailable');
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > limits.artifactMaxBytes) throw new ChannelArtifactError('artifact_too_large');
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, length);
    } finally {
      signal.removeEventListener('abort', abort);
      stream.destroy();
    }
  }
  return {
    async list(run: ChannelRunRecord, snapshot: ChannelRunSnapshot) {
      if (snapshot.status !== 'completed' || !snapshot.responseId)
        return { artifacts: [], unavailable: false };
      const limits = await deps.limits();
      const descriptors: ChannelArtifact[] = [];
      const candidates = await files(run, snapshot.responseId);
      let unavailable = candidates.length > limits.artifactMaxFiles;
      for (const file of candidates.slice(0, limits.artifactMaxFiles)) {
        let content: Buffer | null;
        try {
          content = await read(run, file);
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
      // A bounded source attachment preserves long/code-rich answers when no generated file exists.
      const answer = Buffer.from(snapshot.text);
      if (
        !descriptors.length &&
        (snapshot.text.includes('```') || answer.length > 6000) &&
        answer.length <= limits.artifactMaxBytes
      ) {
        const sha256 = hash(answer);
        descriptors.push({
          artifactId: `answer:${sha256}`,
          filename: 'agent-response.md',
          mediaType: 'text/markdown',
          bytes: answer.length,
          sha256,
        });
      }
      return { artifacts: descriptors, unavailable };
    },
    async content(
      run: ChannelRunRecord,
      artifactId: string,
    ): Promise<{ descriptor: ChannelArtifact; bytes: Buffer }> {
      const descriptor = run.snapshot?.artifacts?.find((item) => item.artifactId === artifactId);
      if (!descriptor || !run.snapshot?.responseId)
        throw new ChannelArtifactError('artifact_unavailable');
      if (descriptor.bytes > (await deps.limits()).artifactMaxBytes)
        throw new ChannelArtifactError('artifact_too_large');
      let bytes: Buffer | null;
      if (artifactId === `answer:${descriptor.sha256}`) bytes = Buffer.from(run.snapshot.text);
      else {
        const file = (await files(run, run.snapshot.responseId)).find(
          (item) => `${item.file_id}:${descriptor.sha256}` === artifactId,
        );
        bytes = file ? await read(run, file) : null;
      }
      if (!bytes) throw new ChannelArtifactError('artifact_unavailable');
      if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256)
        throw new ChannelArtifactError('artifact_changed');
      return { descriptor, bytes };
    },
  };
}
