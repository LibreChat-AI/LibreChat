import { configSchema, adminRefreshRateLimitSchema } from './config';

describe('admin refresh rate limits', () => {
  it('provides a renewal budget independent of login attempts', () => {
    expect(adminRefreshRateLimitSchema.parse({})).toEqual({ windowMs: 60_000, max: 120 });
    expect(
      configSchema.parse({ version: '1.2.1', rateLimits: { adminRefresh: { max: 240 } } })
        .rateLimits?.adminRefresh,
    ).toEqual({ windowMs: 60_000, max: 240 });
  });

  it.each([{ max: 0 }, { max: -1 }, { max: 1.5 }, { windowMs: 0 }, { windowMs: 2_147_483_648 }])(
    'rejects invalid budgets: %j',
    (config) => {
      expect(adminRefreshRateLimitSchema.safeParse(config).success).toBe(false);
    },
  );
});
