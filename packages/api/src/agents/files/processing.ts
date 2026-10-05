import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { hostFileEditLimitsSchema } from 'librechat-data-provider';
import type { HostFileEditLimits } from 'librechat-data-provider';
import type { HostEditJob, HostEditReply } from './edit-worker';
import type { HostEditResult } from './matching';
import type { TextEdit } from '../edits';
import { HostEditError } from './matching';

interface EditWorkerSlot {
  worker: Worker;
  idleTimer?: NodeJS.Timeout;
  active: boolean;
}

/** No waiting queue: admitted jobs retain at most one input/output per bounded worker. */
export function createHostEditProcessor(workerPath: string): {
  apply: (
    content: string,
    edits: TextEdit[],
    configured?: Partial<HostFileEditLimits>,
    signal?: AbortSignal,
  ) => Promise<HostEditResult>;
  close: () => Promise<void>;
} {
  const slots = new Set<EditWorkerSlot>();
  let active = 0;
  let closed = false;

  const remove = (slot: EditWorkerSlot): void => {
    clearTimeout(slot.idleTimer);
    slots.delete(slot);
  };

  const acquire = (): EditWorkerSlot => {
    for (const slot of slots) {
      if (slot.active) continue;
      clearTimeout(slot.idleTimer);
      slot.active = true;
      slot.worker.ref();
      return slot;
    }
    const worker = new Worker(workerPath, {
      execArgv: [],
      // The pure matcher never needs application services or an unbounded heap.
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const slot: EditWorkerSlot = { worker, active: true };
    slots.add(slot);
    worker.on('error', () => {
      if (!slot.active) remove(slot);
    });
    worker.on('exit', () => remove(slot));
    return slot;
  };

  return {
    async apply(content, edits, configured, signal): Promise<HostEditResult> {
      signal?.throwIfAborted();
      const parsed = hostFileEditLimitsSchema.safeParse(configured ?? {});
      if (!parsed.success) {
        throw new HostEditError('File edit configuration is invalid. Nothing was written.');
      }
      const limits = parsed.data;
      if (edits.length > limits.maxEdits) {
        throw new HostEditError(
          `File edits are limited to ${limits.maxEdits} replacements per call. Nothing was written.`,
        );
      }
      if (closed || active >= limits.maxConcurrent) {
        throw new HostEditError('File edit processing is busy; retry later. Nothing was written.');
      }
      const maxOutputBytes = 10 * 1024 * 1024;
      if (content.length > maxOutputBytes) {
        throw new HostEditError('File exceeds the authoring size limit. Nothing was written.');
      }
      // Bound UTF-16 clone bytes without scanning; the worker accounts UTF-8 processing.
      let inputUnits = content.length;
      for (const edit of edits) {
        inputUnits += edit.old_text.length + edit.new_text.length;
        if (inputUnits > limits.maxWorkBytes / 2) {
          throw new HostEditError(
            'File edit processing budget exceeded; split the batch. Nothing was written.',
          );
        }
      }
      const deadline = performance.now() + limits.timeoutMs;
      let slot: EditWorkerSlot;
      try {
        slot = acquire();
      } catch {
        throw new HostEditError('File edit processing failed. Nothing was written.');
      }
      active++;
      const job: HostEditJob = {
        content,
        edits,
        limits: { ...limits, maxOutputBytes },
      };
      return await new Promise<HostEditResult>((resolve, reject) => {
        let settled = false;
        const finish = async (
          result: HostEditResult | undefined,
          error: Error | undefined,
          terminate: boolean,
        ): Promise<void> => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          slot.worker.off('message', message);
          slot.worker.off('error', failed);
          slot.worker.off('exit', exited);
          if (terminate || closed) {
            await slot.worker.terminate().catch(() => undefined);
            remove(slot);
          } else {
            slot.active = false;
            slot.worker.unref();
            slot.idleTimer = setTimeout(() => {
              remove(slot);
              void slot.worker.terminate();
            }, 30_000);
            slot.idleTimer.unref();
          }
          active--;
          if (error) reject(error);
          else if (result) resolve(result);
        };
        const abort = (): void => {
          void finish(
            undefined,
            new DOMException('File edit cancelled. Nothing was written.', 'AbortError'),
            true,
          );
        };
        const failed = (): void => {
          void finish(
            undefined,
            new HostEditError('File edit processing failed. Nothing was written.'),
            true,
          );
        };
        const exited = (): void => failed();
        const timeout = (): void => {
          void finish(
            undefined,
            new HostEditError('File edit processing timed out. Nothing was written.'),
            true,
          );
        };
        const message = (reply: HostEditReply): void => {
          if (signal?.aborted) {
            abort();
            return;
          }
          if (performance.now() >= deadline) {
            timeout();
            return;
          }
          void finish(
            reply.ok ? reply.result : undefined,
            reply.ok ? undefined : new HostEditError(reply.message),
            false,
          );
        };
        const timer = setTimeout(timeout, Math.max(0, deadline - performance.now()));
        slot.worker.once('message', message);
        slot.worker.once('error', failed);
        slot.worker.once('exit', exited);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        try {
          slot.worker.postMessage(job);
        } catch {
          failed();
        }
      });
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.all(
        [...slots].map(async (slot) => {
          clearTimeout(slot.idleTimer);
          await slot.worker.terminate();
          remove(slot);
        }),
      );
    },
  };
}

let processor: ReturnType<typeof createHostEditProcessor> | undefined;

export function applyHostTextEdits(
  content: string,
  edits: TextEdit[],
  configured?: Partial<HostFileEditLimits>,
  signal?: AbortSignal,
): Promise<HostEditResult> {
  processor ??= createHostEditProcessor(
    path.join(path.dirname(require.resolve('@librechat/api')), 'agents/files/edit-worker.cjs'),
  );
  return processor.apply(content, edits, configured, signal);
}
