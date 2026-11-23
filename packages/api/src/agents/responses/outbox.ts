import { runAsSystem, tenantStorage } from '@librechat/data-schemas';
import type { ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
import type { BackgroundResponseQueue } from './queue';

const terminal = (record: StoredResponseRecord) =>
  ['completed', 'failed', 'incomplete', 'cancelled'].includes(record.status);
function report(handler: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    handler?.(error);
  } catch {
    /* Diagnostics cannot revoke an already committed acceptance. */
  }
}

/** Publication is best effort after the source intent commits. Recovery owns every unacknowledged token. */
export async function publishResponseDispatch(
  deps: {
    storage: ResponseStorage;
    enqueue: (record: StoredResponseRecord) => Promise<void>;
    deliveryKey?: (record: StoredResponseRecord) => string;
    onError?: (error: unknown) => void;
  },
  initial: StoredResponseRecord,
  kind: 'create' | 'resume',
): Promise<{ record: StoredResponseRecord; settled: boolean }> {
  let record = initial;
  const id =
    kind === 'create' ? record.responseId : (record.resume?.intentId ?? record.dispatchOutbox?.id);
  if (!id) throw new Error('Response dispatch intent unavailable');
  try {
    if (!terminal(record)) {
      if (kind === 'create') {
        const attached = await deps.storage.attachDelivery(
          record,
          record.responseId,
          deps.deliveryKey!(record),
        );
        if (!attached.ok) return { record, settled: false };
        record = attached.record;
        if (record.status === 'queued') await deps.enqueue(record);
      } else if (record.resume?.intentId === id && record.resume.state === 'reserved')
        await deps.enqueue(record);
    }
    const settled = await deps.storage.settleDispatch(record, record.responseId, { kind, id });
    return { record, settled };
  } catch (error) {
    report(deps.onError, error);
    return { record, settled: false };
  }
}

/** Canonical trigger maintenance supplies the bound and scheduling; only metadata crosses SYSTEM scope. */
export function createResponseDispatchOutbox(deps: {
  storage: ResponseStorage;
  create: Pick<BackgroundResponseQueue, 'enqueue' | 'deliveryKey'>;
  resume?: Pick<BackgroundResponseQueue, 'enqueue'>;
  authorize: (record: StoredResponseRecord) => Promise<boolean>;
  retire: (record: StoredResponseRecord) => Promise<'stopped' | 'pending'>;
  onError: (error: unknown) => void;
  isReady: () => boolean;
}) {
  let cursor: string | undefined;
  return {
    async recoverPending(limit: number, activity: { found: boolean }): Promise<number> {
      if (!deps.isReady()) return 0;
      let page: Awaited<ReturnType<ResponseStorage['listPendingDispatches']>>;
      try {
        page = await runAsSystem(() =>
          deps.storage.listPendingDispatches(cursor, limit, deps.resume != null),
        );
      } catch (error) {
        activity.found = true;
        report(deps.onError, error);
        return 0;
      }
      cursor = page.next;
      if (page.responses.length) activity.found = true;
      let progress = 0;
      for (const owner of page.responses) {
        await tenantStorage.run({ tenantId: owner.tenantId || undefined }, async () => {
          try {
            const record = await deps.storage.read(owner, owner.responseId);
            if (!record) return;
            if (
              !record.dispatchOutbox ||
              !['create', 'resume'].includes(record.dispatchOutbox.kind) ||
              !['pending', 'settled'].includes(record.dispatchOutbox.state)
            )
              return;
            const kind = record.dispatchOutbox.kind;
            if (kind === 'resume' && !deps.resume) return;
            const tokenId =
              kind === 'create'
                ? record.responseId
                : (record.resume?.intentId ?? record.dispatchOutbox.id);
            if (record.dispatchOutbox.id !== tokenId || record.dispatchOutbox.state === 'settled')
              return;
            if (
              !terminal(record) &&
              (record.cancellationRequestedAt != null || !(await deps.authorize(record)))
            ) {
              if ((await deps.retire(record)) !== 'stopped') return;
              const current = await deps.storage.read(owner, owner.responseId);
              if (!current || !terminal(current)) return;
              if (
                (
                  await publishResponseDispatch(
                    { storage: deps.storage, enqueue: async () => {}, onError: deps.onError },
                    current,
                    kind,
                  )
                ).settled
              )
                progress++;
              return;
            }
            const queue = kind === 'create' ? deps.create : deps.resume!;
            const result = await publishResponseDispatch(
              {
                storage: deps.storage,
                enqueue: queue.enqueue,
                deliveryKey: deps.create.deliveryKey,
                onError: deps.onError,
              },
              record,
              kind,
            );
            if (result.settled) progress++;
          } catch (error) {
            report(deps.onError, error);
          }
        });
      }
      return progress;
    },
  };
}
