import { gptPointReleaseFamily } from 'librechat-data-provider';

/** Fail promptly if an operation settles without reaching the expected pause. */
export function waitForPause<T>(pause: Promise<void>, operation: Promise<T>): Promise<void> {
  return Promise.race([
    pause,
    operation.then(() => {
      throw new Error('Operation completed before reaching its pause');
    }),
  ]);
}

/**
 * Inlined utility functions previously imported from @librechat/api.
 * These are used only by test files in data-schemas.
 */

function findLongestKey(
  lowerModelName: string,
  tokensMap: Record<string, number | Record<string, number>>,
): string | undefined {
  const keys = Object.keys(tokensMap);
  let bestMatch: string | undefined;
  let bestLength = 0;
  for (let i = keys.length - 1; i >= 0; i--) {
    const key = keys[i];
    const lowerKey = key.toLowerCase();
    if (lowerKey.length <= bestLength) {
      continue;
    }
    const keyIndex = lowerModelName.indexOf(lowerKey);
    if (keyIndex === -1) {
      continue;
    }
    if (lowerKey.length === lowerModelName.length) {
      return key;
    }
    // A minor version must not match the beginning of a snapshot date.
    const nextCharacter = lowerModelName.charCodeAt(keyIndex + lowerKey.length);
    if (nextCharacter >= 48 && nextCharacter <= 57 && /\d$/.test(lowerKey)) {
      continue;
    }
    bestMatch = key;
    bestLength = lowerKey.length;
  }

  return bestMatch;
}

/**
 * Finds the longest matching key in a tokens/values map by substring match,
 * preferring the model segment of a vendor-prefixed id.
 *
 * Mirrors @librechat/api findMatchingPattern. Keep the two in step: this is the
 * function production injects into `createTxMethods`, so a divergence here means
 * the pricing tests stop describing real billing behavior.
 */
export function findMatchingPattern(
  modelName: string,
  tokensMap: Record<string, number | Record<string, number>>,
): string | undefined {
  const direct = findVendorAwarePattern(modelName, tokensMap);
  if (direct != null) {
    return direct;
  }
  const family = gptPointReleaseFamily(modelName);
  return family == null ? undefined : findVendorAwarePattern(family, tokensMap);
}

function findVendorAwarePattern(
  modelName: string,
  tokensMap: Record<string, number | Record<string, number>>,
): string | undefined {
  const lowerModelName = modelName.toLowerCase();
  const slashIndex = lowerModelName.lastIndexOf('/');
  if (slashIndex === -1) {
    return findLongestKey(lowerModelName, tokensMap);
  }

  const fullMatch = findLongestKey(lowerModelName, tokensMap);
  if (fullMatch != null && fullMatch.includes('/')) {
    return fullMatch;
  }
  return findLongestKey(lowerModelName.slice(slashIndex + 1), tokensMap) ?? fullMatch;
}

/**
 * Matches a model name to a canonical key. When no maxTokensMap is available
 * (as in data-schemas tests), returns the model name as-is.
 *
 * Inlined from @librechat/api matchModelName (simplified for test use)
 */
export function matchModelName(modelName: string, _endpoint?: string): string | undefined {
  if (typeof modelName !== 'string') {
    return undefined;
  }
  return modelName;
}
