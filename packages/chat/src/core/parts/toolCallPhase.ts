import type { PartMetadata } from 'librechat-data-provider';

/**
 * The settled state of one tool call, as every part of its card should read
 * it: the visible label, the `aria-live` announcement, the icon, the shimmer,
 * and whether a duration is worth showing.
 *
 * Before this existed each card derived those independently — the label from
 * one expression, the announcement from another, the animation from a third —
 * and a change to one kept missing the others. Thirteen of the seventeen
 * review findings on #14873 were instances of that drift, and #14892 added a
 * fourteenth. One value, read everywhere, is what stops it: two presentations
 * of the same card can no longer disagree about what happened.
 */
export type ToolCallPhase = 'running' | 'completed' | 'cancelled' | 'failed';

export interface ToolCallPhaseInput {
  /**
   * The run's own terminal verdict from `on_run_step_closed`. Absent on parts
   * saved before the event existed and on endpoints that never emit it, which
   * is what the heuristic below is for.
   */
  runStepStatus?: PartMetadata['runStepStatus'];
  /**
   * The animated value from `useProgress` — what the card is showing right
   * now. Drives `running` vs `completed` so the label and shimmer follow the
   * animation rather than snapping.
   */
  displayProgress: number;
  /**
   * The progress the stream actually reported, before display animation.
   * Kept separate because `useProgress` holds below 1 for ~200ms after a call
   * reports completion (it emits `0.99`, then `1` on a timeout), and the
   * cancellation inference must not read that lag as an unfinished call.
   */
  reportedProgress: number;
  /** Whether the whole message is still streaming — a message-level fact. */
  isSubmitting: boolean;
  /**
   * Whether this call's own result reads as a failure: parsed error output,
   * or a card-specific signal such as a backgrounded task settling as `error`.
   */
  hasError: boolean;
}

/**
 * Resolve a tool call's phase from every signal that bears on it.
 *
 * The precedence rules encoded here were each established by a specific
 * review finding, and each is load-bearing:
 *
 * - **An explicit status is authoritative and never gated on output parsing.**
 *   Reading the result text can otherwise demote a step the run reported as
 *   stopped back into an in-flight state.
 * - **Explicit cancellation outranks a failure-shaped result.** A step the
 *   user stopped is cancelled even if its partial output parses as an error.
 * - **Under the legacy heuristic the opposite holds: failure outranks
 *   cancellation**, because that inference reads "not submitting and not
 *   finished" as a stop, which a genuine failure also satisfies. Applying the
 *   explicit-close precedence there relabelled real failures as user stops.
 * - **A closed step is never `running`**, whatever progress says.
 * - **Cancellation is inferred from reported progress, never from the
 *   animation.** `useProgress` lags a completed call by ~200ms; reading that
 *   lag would label — and announce — a successful call as cancelled whenever
 *   submission ended inside the window.
 */
export function resolveToolCallPhase({
  runStepStatus,
  displayProgress,
  reportedProgress,
  isSubmitting,
  hasError,
}: ToolCallPhaseInput): ToolCallPhase {
  if (runStepStatus != null) {
    if (runStepStatus === 'cancelled') {
      return 'cancelled';
    }
    return runStepStatus === 'failed' || hasError ? 'failed' : 'completed';
  }

  if (hasError) {
    return 'failed';
  }
  if (!isSubmitting && reportedProgress < 1) {
    return 'cancelled';
  }
  return displayProgress < 1 ? 'running' : 'completed';
}
