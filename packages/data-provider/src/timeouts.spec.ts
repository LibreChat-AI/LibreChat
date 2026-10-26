import { DEFAULT_CLIENT_TIMEOUTS, getClientTimeout, setClientTimeouts } from './timeouts';
import { configSchema } from './config';

describe('client timeouts', () => {
  afterEach(() => setClientTimeouts(undefined));

  it('uses the defaults until the startup config sets values', () => {
    expect(getClientTimeout('refreshMs')).toBe(DEFAULT_CLIENT_TIMEOUTS.refreshMs);
    setClientTimeouts({ refreshMs: 90_000 });
    expect(getClientTimeout('refreshMs')).toBe(90_000);
    expect(getClientTimeout('ttsMs')).toBe(DEFAULT_CLIENT_TIMEOUTS.ttsMs);
  });

  it('falls back to defaults for invalid values', () => {
    setClientTimeouts({ refreshMs: -5 });
    expect(getClientTimeout('refreshMs')).toBe(30_000);
  });

  it('is accepted by configSchema', () => {
    expect(configSchema.shape.clientTimeouts.safeParse({ cloudfrontMs: 20_000 }).success).toBe(
      true,
    );
    expect(configSchema.shape.clientTimeouts.safeParse({ cloudfrontMs: 0 }).success).toBe(false);
  });
});
