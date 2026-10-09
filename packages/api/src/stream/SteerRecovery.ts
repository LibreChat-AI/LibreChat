import { logger } from '@librechat/data-schemas';
import type { TFile, TPendingSteer } from 'librechat-data-provider';
import { getReferencedQuotes } from '../utils/quotes';

/** Immutable user-visible payload a parked steer recovery is allowed to submit. */
export interface RecoveredSteerPayload {
  text: string;
  /** Sorted, unique file ids. Display metadata is deliberately excluded: the
   * normal send path re-resolves files by owner and only identity is binding. */
  fileIds: string[];
  /** Normalized quoted excerpts, order-significant. Model-bound exactly like
   * the text, so the proof must bind them too: a stale client presenting the
   * same recoverySteerId with altered or missing quotes must not consume the
   * parked source. Empty when the source carried none. */
  quotes: string[];
}

const recoveryFailureMessages = {
  source_missing: 'Recovered steer source is no longer available',
  protocol_mismatch: 'Recovered steer source requires protocol v2',
  owner_mismatch: 'Recovered steer source belongs to a different owner',
  invalid_payload: 'Recovered steer request payload is invalid',
  payload_mismatch: 'Recovered steer payload does not match its parked source',
} as const;

type RecoveryFailureReason = keyof typeof recoveryFailureMessages;

/** Retain the wire code for old clients; the reason distinguishes permanent failures. */
export class RecoveredSteerPayloadMismatchError extends Error {
  readonly code = 'RECOVERY_PAYLOAD_MISMATCH';
  readonly reason: RecoveryFailureReason;

  constructor(reason: RecoveryFailureReason = 'payload_mismatch') {
    super(recoveryFailureMessages[reason]);
    this.reason = reason;
    this.name = 'RecoveredSteerPayloadMismatchError';
  }
}

export function getSteerRecoveryFailure(
  error: RecoveredSteerPayloadMismatchError,
  context: { conversationId?: string; streamId: string; recoveredSteerId?: string },
): { code: 'RECOVERY_PAYLOAD_MISMATCH'; reason: RecoveryFailureReason; error: string } {
  const reason = error.reason ?? 'payload_mismatch';
  logger.warn('[SteerRecovery] Recovery rejected', { ...context, reason });
  return {
    code: error.code,
    reason,
    error: 'The queued message could not be recovered. Review it before sending again.',
  };
}

/** Canonical attachment identity: every entry must name a file; ordering,
 * duplicates, and mutable display metadata do not affect identity. */
export function canonicalRecoveryFileIds(files: unknown): string[] | null {
  if (files == null) {
    return [];
  }
  if (!Array.isArray(files)) {
    return null;
  }
  const ids = new Set<string>();
  for (const file of files) {
    if (file == null || typeof file !== 'object') {
      return null;
    }
    const fileId = (file as Partial<TFile>).file_id;
    if (typeof fileId !== 'string' || fileId.length === 0) {
      return null;
    }
    ids.add(fileId);
  }
  return [...ids].sort();
}

/** Build the trusted payload proof passed from the HTTP controller into the
 * atomic job-creation transaction. `null` means the recovery request itself
 * is malformed and must be rejected before claiming a generation. */
export function buildRecoveredSteerPayload(
  text: unknown,
  files: unknown,
  quotes?: unknown,
): RecoveredSteerPayload | null {
  if (typeof text !== 'string') {
    return null;
  }
  const fileIds = canonicalRecoveryFileIds(files);
  if (fileIds == null) {
    return null;
  }
  return { text, fileIds, quotes: getReferencedQuotes(quotes) ?? [] };
}

export function isRecoveredSteerPayload(value: unknown): value is RecoveredSteerPayload {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const payload = value as Partial<RecoveredSteerPayload>;
  return (
    typeof payload.text === 'string' &&
    Array.isArray(payload.fileIds) &&
    payload.fileIds.every((id) => typeof id === 'string' && id.length > 0) &&
    payload.fileIds.length === new Set(payload.fileIds).size &&
    payload.fileIds.every((id, index) => index === 0 || payload.fileIds![index - 1] < id) &&
    Array.isArray(payload.quotes) &&
    payload.quotes.every((quote) => typeof quote === 'string' && quote.length > 0)
  );
}

export function recoveredSteerPayloadMatches(
  item: Pick<TPendingSteer, 'text' | 'files' | 'quotes'>,
  expected: RecoveredSteerPayload,
): boolean {
  const fileIds = canonicalRecoveryFileIds(item.files);
  const itemQuotes = getReferencedQuotes(item.quotes) ?? [];
  return (
    item.text === expected.text &&
    fileIds != null &&
    fileIds.length === expected.fileIds.length &&
    fileIds.every((id, index) => id === expected.fileIds[index]) &&
    itemQuotes.length === expected.quotes.length &&
    itemQuotes.every((quote, index) => quote === expected.quotes[index])
  );
}
