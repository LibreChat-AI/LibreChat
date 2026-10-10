import type { PtcToolCallStatus } from 'librechat-data-provider';

/**
 * A row's outcome. Widens the wire status with `interrupted`, which the
 * backend never sends: it is what the client concludes locally about a call
 * that was still running when a stream gap swallowed its settling event.
 */
export type PtcTraceStatus = PtcToolCallStatus | 'interrupted';

/** One tool call a programmatic (PTC) program made from inside the sandbox. */
export interface PtcTraceEntry {
  /** Stable id from the backend; the settle event updates this row in place. */
  callId: string;
  /** Inner tool id, e.g. `search_code_mcp_github`. */
  name: string;
  status: PtcTraceStatus;
  /** `key=value` preview of the call's input. */
  args?: string;
  /** Truncated failure message on a failed call. */
  error?: string;
  durationMs?: number;
}

/** One PTC program's trace: the retained tail plus what the cap discarded. */
export interface PtcTrace {
  entries: PtcTraceEntry[];
  /** Rows evicted by the trace cap (`PTC_TRACE_MAX_ENTRIES`), so the cap is never silent. */
  dropped: number;
}
