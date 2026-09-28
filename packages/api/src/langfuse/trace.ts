import { createHash } from 'crypto';

type TraceRefFields = {
  langfuseSampled?: boolean | null;
  langfuseDestinationIds?: string[] | null;
  langfuseRunId?: string | null;
};

export function traceIdForMessage(messageId: string): string {
  return createHash('sha256').update(messageId, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Replaces a message's trace sampling record with an explicit "never traced".
 * A copied or client-authored row carries an id no run was traced under, so the
 * source's record would claim a trace the row never produced — for feedback
 * scores and the trace viewer alike — while a missing record would let a
 * feedback score recompute sampling for a trace that does not exist.
 */
export function withoutTraceRefs<T extends TraceRefFields>(
  message: T,
): Omit<T, keyof TraceRefFields> & { langfuseSampled: false } {
  const {
    langfuseSampled: _sampled,
    langfuseDestinationIds: _destinations,
    langfuseRunId: _runId,
    ...rest
  } = message;
  return { ...rest, langfuseSampled: false };
}
