import type { CodeApiExecutionProfile, FileRefs } from '@librechat/agents';
import type { SandboxImageReadResult } from './image';
import type { ServerRequest } from '~/types';

export interface SandboxTextReadParams {
  file_path: string;
  session_id?: string;
  files?: Array<FileRefs[number] & { session_id?: string }>;
  runtime_session_hint?: string;
  codeApiBaseUrl?: string;
  executionProfile?: CodeApiExecutionProfile;
  bridgeWorkerId?: string;
  executionRouteKey?: string;
  req?: ServerRequest;
  /** Requests the complete file within this byte budget, not a truncated prefix. */
  maxBytes?: number;
  signal?: AbortSignal;
}

export type SandboxTextReadResult =
  | { content: string; complete?: true }
  | { tooLarge: true; reason: 'size' | 'round_trips'; bytes: number }
  | null;

export type SandboxTextReader = (params: SandboxTextReadParams) => Promise<SandboxTextReadResult>;

/** Reuses windowed byte transport; omission preserves the legacy text-read contract. */
export function createSandboxTextReader({
  readFile,
  readBytes,
}: {
  readFile: (params: SandboxTextReadParams) => Promise<{ content: string } | null>;
  readBytes: (params: SandboxTextReadParams) => Promise<SandboxImageReadResult>;
}): SandboxTextReader {
  return async (params) => {
    if (params.maxBytes == null) return readFile(params);
    if (!Number.isSafeInteger(params.maxBytes) || params.maxBytes < 1) {
      throw new Error('Invalid sandbox text-read byte budget.');
    }
    params.signal?.throwIfAborted();
    const result = await readBytes(params);
    params.signal?.throwIfAborted();
    if (result == null) return null;
    if ('tooLarge' in result) return result;
    const buffer = Buffer.from(result.base64, 'base64');
    if (
      buffer.length !== result.bytes ||
      buffer.length > params.maxBytes ||
      buffer.toString('base64') !== result.base64
    ) {
      throw new Error('Sandbox text retrieval was incomplete. Use bash_tool to inspect the file.');
    }
    const content = buffer.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(buffer)) {
      throw new Error('Sandbox file is not UTF-8 text. Use bash_tool to process it.');
    }
    return { content, complete: true };
  };
}
