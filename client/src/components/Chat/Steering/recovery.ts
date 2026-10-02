import { atomFamily, atomWithStorage, createJSONStorage } from 'jotai/utils';
import type { QueuedMessage } from '~/store/families';

export type RecoveryDisposition = 'blocked' | 'cancelling' | 'cancelled' | 'dismissed';
export type RecoveryDispositions = Partial<Record<string, RecoveryDisposition>>;

/** Receipt-scoped safety decisions survive remounts and reloads in this tab.
 * No message content is stored. A crashed cancellation stays held, not sendable. */
export const recoveryDispositionsFamily = atomFamily((conversationId: string) =>
  atomWithStorage<RecoveryDispositions>(
    `steer-recovery:${conversationId}`,
    {},
    createJSONStorage(
      () => ({
        getItem(key) {
          try {
            return sessionStorage.getItem(key);
          } catch {
            return null;
          }
        },
        setItem(key, value) {
          try {
            sessionStorage.setItem(key, value);
          } catch {
            /* Keep the in-memory safety decision. */
          }
        },
        removeItem(key) {
          try {
            sessionStorage.removeItem(key);
          } catch {
            /* Storage may be disabled. */
          }
        },
      }),
      {
        reviver: (_key, value) => (value === 'cancelling' ? 'blocked' : value),
      },
    ),
    { getOnInit: true },
  ),
);

export function recoveryDisposition(
  dispositions: RecoveryDispositions,
  item: Pick<QueuedMessage, 'recoverySteerId'>,
): RecoveryDisposition | undefined {
  return item.recoverySteerId == null ? undefined : dispositions?.[item.recoverySteerId];
}

export function canRestoreRecovery(
  dispositions: RecoveryDispositions,
  item: Pick<QueuedMessage, 'recoverySteerId'>,
): boolean {
  const disposition = recoveryDisposition(dispositions, item);
  return disposition !== 'cancelled' && disposition !== 'dismissed';
}

export function blockRecovery(dispositions: RecoveryDispositions, steerId: string) {
  return dispositions?.[steerId] != null
    ? dispositions
    : { ...dispositions, [steerId]: 'blocked' as const };
}
