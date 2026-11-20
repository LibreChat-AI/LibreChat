import type { ToolCallPhaseInput } from '../toolCallPhase';
import { resolveToolCallPhase } from '../toolCallPhase';

const resolve = (overrides: Partial<ToolCallPhaseInput> = {}) =>
  resolveToolCallPhase({
    displayProgress: 1,
    reportedProgress: 1,
    isSubmitting: false,
    hasError: false,
    ...overrides,
  });

describe('resolveToolCallPhase', () => {
  describe('with an explicit run-step status', () => {
    it('reports a completed close as completed', () => {
      expect(resolve({ runStepStatus: 'completed' })).toBe('completed');
    });

    it('reports a failed close as failed', () => {
      expect(resolve({ runStepStatus: 'failed' })).toBe('failed');
    });

    it('reports a cancelled close as cancelled', () => {
      expect(resolve({ runStepStatus: 'cancelled' })).toBe('cancelled');
    });

    /**
     * The status is authoritative on its own terms. Gating it on output
     * parsing let a step the run reported as stopped be demoted back into an
     * in-flight state.
     */
    it('never returns running for a closed step, whatever progress says', () => {
      expect(
        resolve({ runStepStatus: 'completed', displayProgress: 0.4, reportedProgress: 0.4 }),
      ).toBe('completed');
      expect(
        resolve({
          runStepStatus: 'cancelled',
          displayProgress: 0.1,
          reportedProgress: 0.1,
          isSubmitting: true,
        }),
      ).toBe('cancelled');
    });

    /** Explicit cancellation outranks a failure-shaped result. */
    it('keeps a cancelled close cancelled even when the output parses as an error', () => {
      expect(resolve({ runStepStatus: 'cancelled', hasError: true })).toBe('cancelled');
    });

    /** A completed close whose result reads as a failure is still a failure —
     *  the card must not present an error as a clean success. */
    it('reports a completed close with error output as failed', () => {
      expect(resolve({ runStepStatus: 'completed', hasError: true })).toBe('failed');
    });
  });

  describe('under the legacy heuristic', () => {
    it('reports an in-flight call as running', () => {
      expect(resolve({ displayProgress: 0.4, reportedProgress: 0.4, isSubmitting: true })).toBe(
        'running',
      );
    });

    it('reports a settled call as completed', () => {
      expect(resolve({ displayProgress: 1, reportedProgress: 1, isSubmitting: true })).toBe(
        'completed',
      );
    });

    /** Unfinished progress with the message no longer streaming is the only
     *  signal the pre-`on_run_step_closed` path had for a stop. */
    it('infers cancellation from an unfinished call once submission ends', () => {
      expect(resolve({ displayProgress: 0.4, reportedProgress: 0.4, isSubmitting: false })).toBe(
        'cancelled',
      );
    });

    /**
     * The precedence inverts here, deliberately: the cancellation inference
     * ("not submitting and not finished") is also satisfied by a genuine
     * failure, so applying the explicit-close ordering relabelled real
     * failures as user stops on historical messages.
     */
    it('lets failure outrank the cancellation inference', () => {
      expect(
        resolve({
          displayProgress: 0.4,
          reportedProgress: 0.4,
          isSubmitting: false,
          hasError: true,
        }),
      ).toBe('failed');
    });

    it('reports a failure even while the message is still streaming', () => {
      expect(
        resolve({
          displayProgress: 0.4,
          reportedProgress: 0.4,
          isSubmitting: true,
          hasError: true,
        }),
      ).toBe('failed');
    });
  });

  describe('the useProgress settle window', () => {
    /**
     * `useProgress` holds below 1 for ~200ms after a call reports completion
     * (it emits `0.99`, then `1` on a timeout). Inferring cancellation from
     * that animated value labelled — and announced — a successful call as
     * "Cancelled" whenever submission ended inside the window
     * (Codex round 1 on #14934).
     */
    it('does not call a reported-complete call cancelled while the animation settles', () => {
      expect(resolve({ displayProgress: 0.99, reportedProgress: 1, isSubmitting: false })).toBe(
        'running',
      );
    });

    /** The inference still fires for a call that genuinely never finished. */
    it('still infers cancellation when the stream itself never reported completion', () => {
      expect(resolve({ displayProgress: 0.99, reportedProgress: 0.4, isSubmitting: false })).toBe(
        'cancelled',
      );
    });

    /** Once the animation catches up the card settles, without a cancelled
     *  frame in between. */
    it('settles to completed once the animation catches up', () => {
      expect(resolve({ displayProgress: 1, reportedProgress: 1, isSubmitting: false })).toBe(
        'completed',
      );
    });
  });

  /**
   * The two precedence rules are opposites and have been collapsed into one
   * another twice under review. Pinned side by side so a future edit cannot
   * quietly unify them.
   */
  it('applies opposite precedence for an explicit close and the heuristic', () => {
    const withError = {
      hasError: true,
      displayProgress: 0.4,
      reportedProgress: 0.4,
      isSubmitting: false,
    };
    expect(resolve({ ...withError, runStepStatus: 'cancelled' })).toBe('cancelled');
    expect(resolve(withError)).toBe('failed');
  });
});
