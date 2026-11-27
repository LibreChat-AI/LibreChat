import { completedOutcome } from '~/schedules/outcome';
import { runSettings, RUN_DEFAULTS } from './settings';
import { runReason } from './subject';

describe('runSettings', () => {
  it('uses each default where the deployment sets none', () => {
    expect(runSettings(undefined)).toEqual(RUN_DEFAULTS);
    expect(runSettings({ enabled: true })).toEqual(RUN_DEFAULTS);
  });

  it('reads what the deployment sets, in minutes for the stale age', () => {
    expect(
      runSettings({ runs: { perHour: 5, maxPerHour: 50, failures: 0, staleMinutes: 10 } }),
    ).toEqual({ perHour: 5, maxPerHour: 50, failures: 0, staleMs: 600_000 });
  });

  it('holds the default hourly runs to the ceiling', () => {
    expect(runSettings({ runs: { maxPerHour: 3 } })).toMatchObject({ perHour: 3, maxPerHour: 3 });
  });
});

describe('runReason', () => {
  it('keeps a stable code for each fixed way the chat route ends a turn', () => {
    const reasons = [
      completedOutcome({ stopped: true }),
      completedOutcome({ preempted: true }),
      completedOutcome({ stepLimit: true }),
      completedOutcome({ content: [{ type: 'error' } as never] }),
    ].map((outcome) => runReason(outcome.error));
    expect(reasons).toEqual(['stopped', 'preempted', 'step_limit', 'error_response']);
    expect(runReason('Request aborted during initialization')).toBe('initialization_aborted');
  });

  it('reduces any other text to a generic code, and no text to none', () => {
    expect(runReason('provider said: SECRET-MARKER')).toBe('run_failed');
    expect(runReason(undefined)).toBeUndefined();
    expect(runReason('')).toBeUndefined();
  });
});
