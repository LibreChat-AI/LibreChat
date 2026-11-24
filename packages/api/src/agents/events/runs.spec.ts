import { runSettings, RUN_DEFAULTS } from './settings';

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
