const { BUILT_IN_ENDPOINT_ENV } = require('@librechat/api');
require('librechat-data-provider');
require('@librechat/data-schemas');
require('~/server/utils/handleText');

/**
 * The env names these services read decide whether a built-in endpoint is served, so the admin
 * catalog and env status (`BUILT_IN_ENDPOINT_ENV`) must name each of them. Their dependencies
 * load above, so only the services' own reads are recorded.
 */
describe('built-in endpoint env names', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('are all listed by the admin catalog', async () => {
    const read = new Set();
    process.env = new Proxy(
      {},
      {
        get(target, key) {
          if (typeof key === 'string') {
            read.add(key);
          }
          return Reflect.get(target, key);
        },
      },
    );
    const loadAsyncEndpoints = require('../loadAsyncEndpoints');
    await loadAsyncEndpoints();
    process.env = originalEnv;

    const listed = new Set(Object.values(BUILT_IN_ENDPOINT_ENV).flat());
    expect([...read]).toEqual(
      expect.arrayContaining([
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_USE_VERTEX',
        'GOOGLE_SERVICE_KEY_FILE',
      ]),
    );
    expect([...read].filter((name) => !listed.has(name))).toEqual([]);
  });
});
