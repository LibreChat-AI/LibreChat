import { extractionServiceSchema } from 'librechat-data-provider';
import type { EventEmitter } from 'node:events';
import { ExtractionServiceError } from './client';

export interface ExtractionLifetime {
  signal?: AbortSignal;
  request?: Partial<Pick<EventEmitter, 'once' | 'off'>> & { aborted?: boolean };
  response?: Partial<Pick<EventEmitter, 'once' | 'off'>> & {
    destroyed?: boolean;
    writableFinished?: boolean;
  };
}

const defaultDeadlineMs = extractionServiceSchema.parse({}).deadlineMs;

export function assertExtractionActive(owner: ExtractionLifetime): void {
  if (
    owner.signal?.aborted ||
    owner.request?.aborted ||
    (owner.response?.destroyed && !owner.response.writableFinished)
  ) {
    throw new ExtractionServiceError('CANCELLED');
  }
}

/** HTTP uploads own their response lifetime; resumable/harvest callers supply only their run signal. */
export async function withExtractionLifetime<T>(
  owner: ExtractionLifetime & { deadlineMs?: number | false },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new ExtractionServiceError('CANCELLED'));
  const close = () => {
    if (!owner.response?.writableFinished) cancel();
  };
  owner.signal?.addEventListener('abort', cancel, { once: true });
  owner.request?.once?.('aborted', cancel);
  owner.response?.once?.('close', close);
  const timeout =
    owner.deadlineMs === false
      ? undefined
      : setTimeout(
          () => controller.abort(new ExtractionServiceError('DEADLINE')),
          owner.deadlineMs ?? defaultDeadlineMs,
        );
  try {
    assertExtractionActive(owner);
    controller.signal.throwIfAborted();
    const value = await run(controller.signal);
    controller.signal.throwIfAborted();
    return value;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    owner.signal?.removeEventListener('abort', cancel);
    owner.request?.off?.('aborted', cancel);
    owner.response?.off?.('close', close);
  }
}
