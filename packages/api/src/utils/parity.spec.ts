import { EModelEndpoint } from 'librechat-data-provider';
import { createTxMethods, tokenValues, defaultRate } from '@librechat/data-schemas';
import { maxTokensMap, getModelMaxTokens, matchModelName, findMatchingPattern } from './tokens';

/**
 * Parity between the context-window map here and the pricing map in
 * `@librechat/data-schemas`. The two are maintained by hand and neither imports
 * the other, so a model added to one and forgotten in the other is silently
 * wrong at runtime: it either bills at `defaultRate` or has no window to prune
 * against. These tests fail on the half-added model rather than on the invoice.
 *
 * Exact key parity is not the invariant. Both maps resolve by longest-substring
 * match, so `gpt-4-32k` legitimately prices via the `32k` bucket without its own
 * row. What must hold is that every key *resolves* in the other map.
 */

/** Context-map keys with no pricing key. Shrink this list, do not grow it. */
const UNPRICED = new Set([
  /** Degenerate prefix key: no pricing key is a substring of it. */
  'mistral-',
  /** AWS has not published a Nova 2 Pro rate. */
  'nova-2-pro',
]);

/** Pricing keys with no context window. Shrink this list, do not grow it. */
const NO_CONTEXT = new Set([
  /** Legacy OpenAI pricing buckets, not model ids. */
  '8k',
  '32k',
  '4k',
  '16k',
  /** Priced, but no published window has been added to the context map. */
  'devstral',
  'voxtral',
  'holo2',
]);

const { getValueKey } = createTxMethods({} as typeof import('mongoose'), {
  matchModelName: (model: string, endpoint?: string) =>
    matchModelName(model, endpoint as EModelEndpoint),
  findMatchingPattern: (model: string, values: Record<string, number | Record<string, number>>) =>
    findMatchingPattern(model, values) ?? undefined,
});

const contextKeys = Object.keys(maxTokensMap[EModelEndpoint.openAI]);
const priceKeys = Object.keys(tokenValues);

describe('context map and pricing map parity', () => {
  it('prices every model that has a context window', () => {
    const unpriced = contextKeys.filter((model) => !getValueKey(model) && !UNPRICED.has(model));
    expect(unpriced).toEqual([]);
  });

  it('gives every priced model a context window', () => {
    const windowless = priceKeys.filter(
      (model) =>
        getModelMaxTokens(model, EModelEndpoint.openAI) === undefined && !NO_CONTEXT.has(model),
    );
    expect(windowless).toEqual([]);
  });

  it('never lets a context-map model silently fall to the default rate', () => {
    for (const model of contextKeys) {
      if (UNPRICED.has(model)) {
        continue;
      }
      const valueKey = getValueKey(model);
      expect(valueKey).toBeDefined();
      expect(tokenValues[valueKey as string]).toBeDefined();
    }
  });

  it('keeps both exemption lists free of stale entries', () => {
    const fixed = {
      unpriced: [...UNPRICED].filter((model) => getValueKey(model)),
      windowless: [...NO_CONTEXT].filter(
        (model) => getModelMaxTokens(model, EModelEndpoint.openAI) !== undefined,
      ),
    };
    expect(fixed).toEqual({ unpriced: [], windowless: [] });
  });

  it('bills a representative new model at its own rate, not the default', () => {
    for (const model of ['muse-spark-1.1', 'kimi-k3', 'glm-5.2', 'minimax-m3']) {
      expect(getModelMaxTokens(model, EModelEndpoint.openAI)).toBeGreaterThan(0);
      expect(tokenValues[getValueKey(model) as string].prompt).not.toBe(defaultRate);
    }
  });
});
