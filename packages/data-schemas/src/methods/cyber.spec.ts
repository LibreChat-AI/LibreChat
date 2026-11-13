import { createTxMethods, cacheTokenValues, premiumCacheTokenValues } from './tx';
import { matchModelName, findMatchingPattern } from './test-helpers';

const { getMultiplier, getCacheMultiplier } = createTxMethods({} as typeof import('mongoose'), {
  matchModelName,
  findMatchingPattern,
});
const model = 'gpt-6-cyber';

it.each([272000, 272001])(
  'uses the published whole-request Cyber tier for %i input tokens',
  (inputTokenCount) => {
    const long = inputTokenCount > 272000;
    expect(getMultiplier({ model, tokenType: 'prompt', inputTokenCount })).toBe(long ? 40 : 20);
    expect(getMultiplier({ model, tokenType: 'completion', inputTokenCount })).toBe(
      long ? 150 : 100,
    );
    expect(getCacheMultiplier({ model, cacheType: 'read', inputTokenCount })).toBe(long ? 4 : 2);
    expect(getCacheMultiplier({ model, cacheType: 'write', inputTokenCount })).toBe(
      long ? null : 25,
    );
    expect(getCacheMultiplier({ model, cacheType: 'write12h', inputTokenCount })).toBe(
      long ? null : 50,
    );
  },
);

it('records 30-minute and 12-hour writes without inventing long-context cache-write rates', () => {
  expect(cacheTokenValues[model]).toEqual({ write: 25, write12h: 50, read: 2 });
  expect(premiumCacheTokenValues[model]).toEqual({ threshold: 272000, read: 4 });
  expect(
    getCacheMultiplier({ valueKey: model, cacheType: 'write', inputTokenCount: 300000 }),
  ).toBeNull();
});

it('does not invent an Anthropic-style one-hour cache-write rate for Cyber', () => {
  expect(getCacheMultiplier({ model, cacheType: 'write1h' })).toBeNull();
});
