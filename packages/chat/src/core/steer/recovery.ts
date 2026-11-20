import type { QueuedMessage } from './types';

export type RecoveryDisposition = 'blocked' | 'cancelling' | 'cancelled' | 'dismissed';
export type RecoveryDispositions = Partial<Record<string, RecoveryDisposition>>;

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

export function blockRecovery(
  dispositions: RecoveryDispositions,
  steerId: string,
): RecoveryDispositions {
  return dispositions?.[steerId] != null
    ? dispositions
    : { ...dispositions, [steerId]: 'blocked' as const };
}
