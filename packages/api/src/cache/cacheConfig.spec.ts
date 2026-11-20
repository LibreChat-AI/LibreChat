jest.mock('@librechat/data-schemas', () => ({ logger: { warn: jest.fn(), error: jest.fn() } }));
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils/math'),
  ...jest.requireActual('~/utils/common'),
}));

describe('Redis retry configuration', () => {
  const original = process.env.REDIS_RETRY_MAX_ATTEMPTS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.REDIS_RETRY_MAX_ATTEMPTS;
    } else {
      process.env.REDIS_RETRY_MAX_ATTEMPTS = original;
    }
  });

  it.each([
    [undefined, 0],
    ['0', 0],
    ['5', 5],
  ])('reads %s as %s attempts', (value, expected) => {
    if (value === undefined) {
      delete process.env.REDIS_RETRY_MAX_ATTEMPTS;
    } else {
      process.env.REDIS_RETRY_MAX_ATTEMPTS = value;
    }
    jest.isolateModules(() => {
      const { cacheConfig } = jest.requireActual<typeof import('./cacheConfig')>('./cacheConfig');
      expect(cacheConfig.REDIS_RETRY_MAX_ATTEMPTS).toBe(expected);
    });
  });
});
