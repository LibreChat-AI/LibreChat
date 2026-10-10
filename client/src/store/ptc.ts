import { atomFamily } from 'recoil';
import type { PtcTrace } from '~/common';

/**
 * Stable identity for one PTC invocation in its parent message. Providers
 * reuse `tool_call_id` across turns and agents, so the raw id is not
 * sufficient identity for live progress — the same rule `subagentProgressKey`
 * exists for. Without the message scope, a later program's rows would land in
 * an earlier card that happened to share `call_0`.
 */
export const ptcTraceKey = (parentMessageId: string, toolCallId: string) =>
  `${parentMessageId}\u0000${toolCallId}`;

/**
 * Rolling cap on retained rows. A program looping over a large collection can
 * make thousands of inner calls; without a bound, every event would copy an
 * ever-growing array and the card would render a row per call.
 */
export const PTC_TRACE_MAX_ENTRIES = 100;

/** Shared empty value — one reference, so untouched atoms compare equal. */
export const EMPTY_PTC_TRACE: PtcTrace = { entries: [], dropped: 0 };

/**
 * Live trace of the inner tool calls made by one PTC run step, in the order
 * the sandbox started them (`on_ptc_tool_call` SSE events). Keyed by
 * {@link ptcTraceKey} — one concrete invocation in one message.
 *
 * Session-scoped like the subagent ticker: inner calls open no run step, so
 * nothing persists them on the message. Cleared on conversation switch rather
 * than at run boundaries, so a finished program's trace stays readable.
 */
export const ptcTraceByToolCallId = atomFamily<PtcTrace, string>({
  key: 'ptcTraceByToolCallId',
  default: EMPTY_PTC_TRACE,
});
