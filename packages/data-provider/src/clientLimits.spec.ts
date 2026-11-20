/**
 * @jest-environment jsdom
 */
import { DEFAULT_CLIENT_LIMITS, getClientLimit, setClientLimits } from './clientLimits';
import { configSchema } from './config';

describe('client timeouts', () => {
  afterEach(() => {
    setClientLimits(undefined);
    localStorage.clear();
  });

  it('uses the defaults until the startup config sets values', () => {
    expect(getClientLimit('refreshMs')).toBe(DEFAULT_CLIENT_LIMITS.refreshMs);
    setClientLimits({ refreshMs: 90_000 });
    expect(getClientLimit('refreshMs')).toBe(90_000);
    expect(getClientLimit('ttsMs')).toBe(DEFAULT_CLIENT_LIMITS.ttsMs);
  });

  it('defaults upload concurrency to three and accepts an override', () => {
    expect(getClientLimit('uploadConcurrency')).toBe(3);
    setClientLimits({ uploadConcurrency: 5 });
    expect(getClientLimit('uploadConcurrency')).toBe(5);
  });

  it('falls back to defaults for invalid values', () => {
    setClientLimits({ refreshMs: -5 });
    expect(getClientLimit('refreshMs')).toBe(30_000);
  });

  it('keeps the published values for the next page load', () => {
    setClientLimits({ refreshMs: 45_000 });
    expect(JSON.parse(localStorage.getItem('librechat:clientLimits') ?? '{}')).toEqual({
      refreshMs: 45_000,
    });
  });

  it('is accepted by configSchema', () => {
    expect(configSchema.shape.clientLimits.safeParse({ cloudfrontMs: 20_000 }).success).toBe(true);
    expect(configSchema.shape.clientLimits.safeParse({ cloudfrontMs: 0 }).success).toBe(false);
  });
});
