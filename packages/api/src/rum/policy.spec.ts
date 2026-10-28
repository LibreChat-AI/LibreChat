import { telemetrySchema } from 'librechat-data-provider';
import type { RumRequest } from './policy';
import { resolveRumPolicy, loadRumConfig } from './policy';

describe('RUM replay policy', () => {
  it('keeps RUM and replay off without configuration', () => {
    expect(resolveRumPolicy(undefined, {})).toEqual({
      enabled: false,
      sessionReplay: { enabled: false },
    });
  });

  it.each([
    [{ RUM_ENABLED: 'true' }, true, false],
    [{ RUM_ENABLED: 'true', RUM_SESSION_REPLAY_ENABLED: 'true' }, true, true],
    [{ RUM_ENABLED: 'false', RUM_SESSION_REPLAY_ENABLED: 'true' }, false, false],
    [{ RUM_ENABLED: 'true', RUM_DISABLE_REPLAY: 'false' }, true, true],
    [
      { RUM_ENABLED: 'true', RUM_DISABLE_REPLAY: 'false', RUM_SESSION_REPLAY_ENABLED: 'false' },
      true,
      false,
    ],
    [
      { RUM_ENABLED: 'true', RUM_DISABLE_REPLAY: 'true', RUM_SESSION_REPLAY_ENABLED: 'true' },
      true,
      true,
    ],
    [
      { RUM_ENABLED: 'true', RUM_DISABLE_REPLAY: 'false', RUM_SESSION_REPLAY_ENABLED: 'invalid' },
      true,
      false,
    ],
  ])('resolves environment policy %p', (env, enabled, replay) => {
    expect(resolveRumPolicy(undefined, env)).toEqual({
      enabled,
      sessionReplay: { enabled: replay },
    });
  });

  it('lets YAML explicitly disable replay despite both environment opt-ins', () => {
    expect(
      resolveRumPolicy(
        { rum: { enabled: true, sessionReplay: { enabled: false } } },
        {
          RUM_ENABLED: 'true',
          RUM_SESSION_REPLAY_ENABLED: 'true',
          RUM_DISABLE_REPLAY: 'false',
        },
      ),
    ).toEqual({ enabled: true, sessionReplay: { enabled: false } });
  });

  it('treats a raw empty YAML replay block as off before schema defaults are materialized', () => {
    expect(
      resolveRumPolicy(
        { rum: { sessionReplay: {} } },
        {
          RUM_ENABLED: 'true',
          RUM_SESSION_REPLAY_ENABLED: 'true',
        },
      ),
    ).toEqual({ enabled: true, sessionReplay: { enabled: false } });
  });

  it('lets YAML enable RUM and replay and keeps the RUM master switch authoritative', () => {
    const replay = { enabled: true };
    expect(resolveRumPolicy({ rum: { enabled: true, sessionReplay: replay } }, {})).toEqual({
      enabled: true,
      sessionReplay: replay,
    });
    expect(
      resolveRumPolicy(
        { rum: { enabled: false, sessionReplay: replay } },
        {
          RUM_ENABLED: 'true',
          RUM_SESSION_REPLAY_ENABLED: 'true',
        },
      ),
    ).toEqual({ enabled: false, sessionReplay: { enabled: false } });
  });

  it('validates YAML flags without injecting defaults over existing environment configuration', () => {
    expect(telemetrySchema.parse({})).toEqual({});
    expect(telemetrySchema.parse({ rum: { sessionReplay: {} } })).toEqual({
      rum: { sessionReplay: { enabled: false } },
    });
    expect(telemetrySchema.safeParse({ rum: { sessionReplay: { enabled: 'true' } } }).success).toBe(
      false,
    );
  });

  it('loads only the cached deployment config and fails closed if loading fails', async () => {
    const getAppConfig = jest.fn().mockResolvedValue({ config: { telemetry: {} } });
    const middleware = loadRumConfig(getAppConfig);
    const req = {} as RumRequest;
    const next = jest.fn();
    await middleware(req, {} as Parameters<typeof middleware>[1], next);
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    expect(req.config?.config?.telemetry).toEqual({});
    const error = new Error('configuration unavailable');
    getAppConfig.mockRejectedValueOnce(error);
    await middleware(req, {} as Parameters<typeof middleware>[1], next);
    expect(next).toHaveBeenLastCalledWith(error);
  });
});
