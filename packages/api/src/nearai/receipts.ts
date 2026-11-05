import { AsyncLocalStorage } from 'node:async_hooks';
import type { TNearAIReceipt } from 'librechat-data-provider';

/** Signature verification result for one NEAR AI completion, stored on the reply's metadata. */
export type NearAIReceipt = TNearAIReceipt;

/** Collects the receipts of every NEAR AI completion made while producing one reply. */
export interface NearAIReceiptCollector {
  /** `onTimeout` records a verification still pending when `settle` stops waiting. */
  add(receipt: Promise<NearAIReceipt>, onTimeout?: () => NearAIReceipt): void;
  /** Waits for pending verifications, bounded so a slow signature lookup cannot hold the reply. */
  settle(timeoutMs?: number): Promise<NearAIReceipt[]>;
}

const storage = new AsyncLocalStorage<NearAIReceiptCollector>();

const SETTLE_TIMEOUT_MS = 15_000;

type Entry = {
  done: Promise<void>;
  settled: boolean;
  receipt?: NearAIReceipt;
  onTimeout?: () => NearAIReceipt;
};

export function createNearAIReceiptCollector(): NearAIReceiptCollector {
  const entries: Entry[] = [];
  return {
    add(receipt, onTimeout) {
      const entry: Entry = { done: Promise.resolve(), settled: false, onTimeout };
      entry.done = receipt.then(
        (value) => {
          entry.settled = true;
          entry.receipt = value;
        },
        () => {
          entry.settled = true;
        },
      );
      entries.push(entry);
    },
    async settle(timeoutMs = SETTLE_TIMEOUT_MS) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([Promise.all(entries.map((entry) => entry.done)), timeout]);
      clearTimeout(timer);
      // Keep finished receipts; a late one is recorded as timed out rather than dropped.
      const receipts: NearAIReceipt[] = [];
      for (const entry of entries) {
        const receipt = entry.settled ? entry.receipt : entry.onTimeout?.();
        if (receipt) receipts.push(receipt);
      }
      return receipts;
    },
  };
}

/** Runs `fn` with `collector` receiving receipts from NEAR AI completions made inside it. */
export function runWithNearAIReceipts<T>(
  collector: NearAIReceiptCollector,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(collector, fn);
}

export function getNearAIReceiptCollector(): NearAIReceiptCollector | undefined {
  return storage.getStore();
}

const ID_SCAN_LIMIT = 64 * 1024;

/**
 * Passes a completion body through unchanged, reading its top-level `id` (the first one
 * in JSON or SSE output) and calling `onComplete` once the body has been fully read.
 */
export function observeCompletionBody(
  response: Response,
  onComplete: (completionId: string) => void,
): Response {
  if (!response.body) {
    return response;
  }
  const decoder = new TextDecoder();
  let scanned = '';
  let completionId: string | undefined;
  const observer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (completionId == null && scanned.length < ID_SCAN_LIMIT) {
        scanned += decoder.decode(chunk, { stream: true });
        completionId = /"id"\s*:\s*"([^"]+)"/.exec(scanned)?.[1];
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (completionId) {
        onComplete(completionId);
      }
    },
  });
  return new Response(response.body.pipeThrough(observer), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function collectNearAIReply<T>(
  owner: { nearaiReceipts?: NearAIReceipt[] },
  work: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  owner.nearaiReceipts = undefined;
  const collector = createNearAIReceiptCollector();
  const value = await runWithNearAIReceipts(collector, work);
  owner.nearaiReceipts = await collector.settle(timeoutMs);
  return value;
}

export function withNearAIMetadata(
  metadata: Record<string, unknown> | undefined,
  receipts?: NearAIReceipt[],
): Record<string, unknown> | undefined {
  return receipts?.length ? { ...metadata, nearai: { receipts } } : metadata;
}
