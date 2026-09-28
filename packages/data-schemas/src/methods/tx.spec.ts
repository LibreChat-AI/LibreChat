/** Note: No hard-coded values should be used in this file. */
import { EModelEndpoint } from 'librechat-data-provider';
import {
  createTxMethods,
  tokenValues,
  cacheTokenValues,
  premiumTokenValues,
  premiumCacheTokenValues,
  defaultRate,
} from './tx';
import { matchModelName, findMatchingPattern } from './test-helpers';

const { getValueKey, getMultiplier, getPremiumRate, getCacheMultiplier } = createTxMethods(
  {} as typeof import('mongoose'),
  { matchModelName, findMatchingPattern },
);

describe('getValueKey', () => {
  it('should return "16k" for model name containing "gpt-3.5-turbo-16k"', () => {
    expect(getValueKey('gpt-3.5-turbo-16k-some-other-info')).toBe('16k');
  });

  it('should return "4k" for model name containing "gpt-3.5"', () => {
    expect(getValueKey('gpt-3.5-some-other-info')).toBe('4k');
  });

  it('should return "32k" for model name containing "gpt-4-32k"', () => {
    expect(getValueKey('gpt-4-32k-some-other-info')).toBe('32k');
  });

  it('should return "8k" for model name containing "gpt-4"', () => {
    expect(getValueKey('gpt-4-some-other-info')).toBe('8k');
  });

  it('should return "gpt-5" for model name containing "gpt-5"', () => {
    expect(getValueKey('gpt-5-some-other-info')).toBe('gpt-5');
    expect(getValueKey('gpt-5-2025-01-30')).toBe('gpt-5');
    expect(getValueKey('gpt-5-2025-01-30-0130')).toBe('gpt-5');
    expect(getValueKey('openai/gpt-5')).toBe('gpt-5');
    expect(getValueKey('openai/gpt-5-2025-01-30')).toBe('gpt-5');
    expect(getValueKey('gpt-5-turbo')).toBe('gpt-5');
    expect(getValueKey('gpt-5-0130')).toBe('gpt-5');
  });

  it('should return "gpt-5.1" for model name containing "gpt-5.1"', () => {
    expect(getValueKey('gpt-5.1')).toBe('gpt-5.1');
    expect(getValueKey('gpt-5.1-chat')).toBe('gpt-5.1');
    expect(getValueKey('gpt-5.1-codex')).toBe('gpt-5.1');
    expect(getValueKey('openai/gpt-5.1')).toBe('gpt-5.1');
  });

  it('should return "gpt-5.2" for model name containing "gpt-5.2"', () => {
    expect(getValueKey('gpt-5.2')).toBe('gpt-5.2');
    expect(getValueKey('gpt-5.2-chat')).toBe('gpt-5.2');
    expect(getValueKey('openai/gpt-5.2')).toBe('gpt-5.2');
  });

  it('should return "gpt-5.3" for model name containing "gpt-5.3"', () => {
    expect(getValueKey('gpt-5.3')).toBe('gpt-5.3');
    expect(getValueKey('gpt-5.3-codex')).toBe('gpt-5.3');
    expect(getValueKey('openai/gpt-5.3')).toBe('gpt-5.3');
  });

  it('should return explicit keys for chat-latest aliases', () => {
    expect(getValueKey('chat-latest')).toBe('chat-latest');
    expect(getValueKey('openai/chat-latest')).toBe('chat-latest');
    expect(getValueKey('gpt-5-chat-latest')).toBe('gpt-5-chat-latest');
    expect(getValueKey('gpt-5.1-chat-latest')).toBe('gpt-5.1-chat-latest');
    expect(getValueKey('gpt-5.2-chat-latest')).toBe('gpt-5.2-chat-latest');
    expect(getValueKey('gpt-5.3-chat-latest')).toBe('gpt-5.3-chat-latest');
  });

  it('should return "gpt-5.4" for model name containing "gpt-5.4"', () => {
    expect(getValueKey('gpt-5.4')).toBe('gpt-5.4');
    expect(getValueKey('gpt-5.4-thinking')).toBe('gpt-5.4');
    expect(getValueKey('openai/gpt-5.4')).toBe('gpt-5.4');
  });

  it('should return "gpt-5.4-pro" for model name containing "gpt-5.4-pro"', () => {
    expect(getValueKey('gpt-5.4-pro')).toBe('gpt-5.4-pro');
    expect(getValueKey('openai/gpt-5.4-pro')).toBe('gpt-5.4-pro');
  });

  it('should return "gpt-3.5-turbo-1106" for model name containing "gpt-3.5-turbo-1106"', () => {
    expect(getValueKey('gpt-3.5-turbo-1106-some-other-info')).toBe('gpt-3.5-turbo-1106');
    expect(getValueKey('openai/gpt-3.5-turbo-1106')).toBe('gpt-3.5-turbo-1106');
    expect(getValueKey('gpt-3.5-turbo-1106/openai')).toBe('gpt-3.5-turbo-1106');
  });

  it('should return "gpt-4-1106" for model name containing "gpt-4-1106"', () => {
    expect(getValueKey('gpt-4-1106-some-other-info')).toBe('gpt-4-1106');
    expect(getValueKey('gpt-4-1106-vision-preview')).toBe('gpt-4-1106');
    expect(getValueKey('gpt-4-1106-preview')).toBe('gpt-4-1106');
    expect(getValueKey('openai/gpt-4-1106')).toBe('gpt-4-1106');
    expect(getValueKey('gpt-4-1106/openai/')).toBe('gpt-4-1106');
  });

  it('should return "gpt-4-1106" for model type of "gpt-4-1106"', () => {
    expect(getValueKey('gpt-4-vision-preview')).toBe('gpt-4-1106');
    expect(getValueKey('openai/gpt-4-1106')).toBe('gpt-4-1106');
    expect(getValueKey('gpt-4-turbo')).toBe('gpt-4-1106');
    expect(getValueKey('gpt-4-0125')).toBe('gpt-4-1106');
  });

  it('should return "gpt-4.5" for model type of "gpt-4.5"', () => {
    expect(getValueKey('gpt-4.5-preview')).toBe('gpt-4.5');
    expect(getValueKey('gpt-4.5-2024-08-06')).toBe('gpt-4.5');
    expect(getValueKey('gpt-4.5-2024-08-06-0718')).toBe('gpt-4.5');
    expect(getValueKey('openai/gpt-4.5')).toBe('gpt-4.5');
    expect(getValueKey('openai/gpt-4.5-2024-08-06')).toBe('gpt-4.5');
    expect(getValueKey('gpt-4.5-turbo')).toBe('gpt-4.5');
    expect(getValueKey('gpt-4.5-0125')).toBe('gpt-4.5');
  });

  it('should return "gpt-4.1" for model type of "gpt-4.1"', () => {
    expect(getValueKey('gpt-4.1-preview')).toBe('gpt-4.1');
    expect(getValueKey('gpt-4.1-2024-08-06')).toBe('gpt-4.1');
    expect(getValueKey('gpt-4.1-2024-08-06-0718')).toBe('gpt-4.1');
    expect(getValueKey('openai/gpt-4.1')).toBe('gpt-4.1');
    expect(getValueKey('openai/gpt-4.1-2024-08-06')).toBe('gpt-4.1');
    expect(getValueKey('gpt-4.1-turbo')).toBe('gpt-4.1');
    expect(getValueKey('gpt-4.1-0125')).toBe('gpt-4.1');
  });

  it('should return "gpt-4.1-mini" for model type of "gpt-4.1-mini"', () => {
    expect(getValueKey('gpt-4.1-mini-preview')).toBe('gpt-4.1-mini');
    expect(getValueKey('gpt-4.1-mini-2024-08-06')).toBe('gpt-4.1-mini');
    expect(getValueKey('openai/gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(getValueKey('gpt-4.1-mini-0125')).toBe('gpt-4.1-mini');
  });

  it('should return "gpt-4.1-nano" for model type of "gpt-4.1-nano"', () => {
    expect(getValueKey('gpt-4.1-nano-preview')).toBe('gpt-4.1-nano');
    expect(getValueKey('gpt-4.1-nano-2024-08-06')).toBe('gpt-4.1-nano');
    expect(getValueKey('openai/gpt-4.1-nano')).toBe('gpt-4.1-nano');
    expect(getValueKey('gpt-4.1-nano-0125')).toBe('gpt-4.1-nano');
  });

  it('should return "gpt-5" for model type of "gpt-5"', () => {
    expect(getValueKey('gpt-5-2025-01-30')).toBe('gpt-5');
    expect(getValueKey('gpt-5-2025-01-30-0130')).toBe('gpt-5');
    expect(getValueKey('openai/gpt-5')).toBe('gpt-5');
    expect(getValueKey('openai/gpt-5-2025-01-30')).toBe('gpt-5');
    expect(getValueKey('gpt-5-turbo')).toBe('gpt-5');
    expect(getValueKey('gpt-5-0130')).toBe('gpt-5');
  });

  it('should return "gpt-5-mini" for model type of "gpt-5-mini"', () => {
    expect(getValueKey('gpt-5-mini-2025-01-30')).toBe('gpt-5-mini');
    expect(getValueKey('openai/gpt-5-mini')).toBe('gpt-5-mini');
    expect(getValueKey('gpt-5-mini-0130')).toBe('gpt-5-mini');
    expect(getValueKey('gpt-5-mini-2025-01-30-0130')).toBe('gpt-5-mini');
  });

  it('should return "gpt-5-nano" for model type of "gpt-5-nano"', () => {
    expect(getValueKey('gpt-5-nano-2025-01-30')).toBe('gpt-5-nano');
    expect(getValueKey('openai/gpt-5-nano')).toBe('gpt-5-nano');
    expect(getValueKey('gpt-5-nano-0130')).toBe('gpt-5-nano');
    expect(getValueKey('gpt-5-nano-2025-01-30-0130')).toBe('gpt-5-nano');
  });

  it('should return "gpt-5-pro" for model type of "gpt-5-pro"', () => {
    expect(getValueKey('gpt-5-pro-2025-01-30')).toBe('gpt-5-pro');
    expect(getValueKey('openai/gpt-5-pro')).toBe('gpt-5-pro');
    expect(getValueKey('gpt-5-pro-0130')).toBe('gpt-5-pro');
    expect(getValueKey('gpt-5-pro-2025-01-30-0130')).toBe('gpt-5-pro');
    expect(getValueKey('gpt-5-pro-preview')).toBe('gpt-5-pro');
  });

  it('should return "gpt-5.2-pro" for model name containing "gpt-5.2-pro"', () => {
    expect(getValueKey('gpt-5.2-pro')).toBe('gpt-5.2-pro');
    expect(getValueKey('gpt-5.2-pro-2025-03-01')).toBe('gpt-5.2-pro');
    expect(getValueKey('openai/gpt-5.2-pro')).toBe('gpt-5.2-pro');
  });

  it('should return "gpt-4o" for model type of "gpt-4o"', () => {
    expect(getValueKey('gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(getValueKey('gpt-4o-2024-08-06-0718')).toBe('gpt-4o');
    expect(getValueKey('openai/gpt-4o')).toBe('gpt-4o');
    expect(getValueKey('openai/gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(getValueKey('gpt-4o-turbo')).toBe('gpt-4o');
    expect(getValueKey('gpt-4o-0125')).toBe('gpt-4o');
  });

  it('should return "gpt-4o-mini" for model type of "gpt-4o-mini"', () => {
    expect(getValueKey('gpt-4o-mini-2024-07-18')).toBe('gpt-4o-mini');
    expect(getValueKey('openai/gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(getValueKey('gpt-4o-mini-0718')).toBe('gpt-4o-mini');
    expect(getValueKey('gpt-4o-2024-08-06-0718')).not.toBe('gpt-4o-mini');
  });

  it('should return "gpt-4o-2024-05-13" for model type of "gpt-4o-2024-05-13"', () => {
    expect(getValueKey('gpt-4o-2024-05-13')).toBe('gpt-4o-2024-05-13');
    expect(getValueKey('openai/gpt-4o-2024-05-13')).toBe('gpt-4o-2024-05-13');
    expect(getValueKey('gpt-4o-2024-05-13-0718')).toBe('gpt-4o-2024-05-13');
    expect(getValueKey('gpt-4o-2024-05-13-0718')).not.toBe('gpt-4o');
  });

  it('should return "gpt-4o" for model type of "chatgpt-4o"', () => {
    expect(getValueKey('chatgpt-4o-latest')).toBe('gpt-4o');
    expect(getValueKey('openai/chatgpt-4o-latest')).toBe('gpt-4o');
    expect(getValueKey('chatgpt-4o-latest-0916')).toBe('gpt-4o');
    expect(getValueKey('chatgpt-4o-latest-0718')).toBe('gpt-4o');
  });

  it('should return "claude-3-7-sonnet" for model type of "claude-3-7-sonnet-"', () => {
    expect(getValueKey('claude-3-7-sonnet-20240620')).toBe('claude-3-7-sonnet');
    expect(getValueKey('anthropic/claude-3-7-sonnet')).toBe('claude-3-7-sonnet');
    expect(getValueKey('claude-3-7-sonnet-turbo')).toBe('claude-3-7-sonnet');
    expect(getValueKey('claude-3-7-sonnet-0125')).toBe('claude-3-7-sonnet');
  });

  it('should return "claude-3.7-sonnet" for model type of "claude-3.7-sonnet-"', () => {
    expect(getValueKey('claude-3.7-sonnet-20240620')).toBe('claude-3.7-sonnet');
    expect(getValueKey('anthropic/claude-3.7-sonnet')).toBe('claude-3.7-sonnet');
    expect(getValueKey('claude-3.7-sonnet-turbo')).toBe('claude-3.7-sonnet');
    expect(getValueKey('claude-3.7-sonnet-0125')).toBe('claude-3.7-sonnet');
  });

  it('should return "claude-3-5-sonnet" for model type of "claude-3-5-sonnet-"', () => {
    expect(getValueKey('claude-3-5-sonnet-20240620')).toBe('claude-3-5-sonnet');
    expect(getValueKey('anthropic/claude-3-5-sonnet')).toBe('claude-3-5-sonnet');
    expect(getValueKey('claude-3-5-sonnet-turbo')).toBe('claude-3-5-sonnet');
    expect(getValueKey('claude-3-5-sonnet-0125')).toBe('claude-3-5-sonnet');
  });

  it('should return "claude-3.5-sonnet" for model type of "claude-3.5-sonnet-"', () => {
    expect(getValueKey('claude-3.5-sonnet-20240620')).toBe('claude-3.5-sonnet');
    expect(getValueKey('anthropic/claude-3.5-sonnet')).toBe('claude-3.5-sonnet');
    expect(getValueKey('claude-3.5-sonnet-turbo')).toBe('claude-3.5-sonnet');
    expect(getValueKey('claude-3.5-sonnet-0125')).toBe('claude-3.5-sonnet');
  });

  it('should return "claude-3-5-haiku" for model type of "claude-3-5-haiku-"', () => {
    expect(getValueKey('claude-3-5-haiku-20240620')).toBe('claude-3-5-haiku');
    expect(getValueKey('anthropic/claude-3-5-haiku')).toBe('claude-3-5-haiku');
    expect(getValueKey('claude-3-5-haiku-turbo')).toBe('claude-3-5-haiku');
    expect(getValueKey('claude-3-5-haiku-0125')).toBe('claude-3-5-haiku');
  });

  it('should return "claude-3.5-haiku" for model type of "claude-3.5-haiku-"', () => {
    expect(getValueKey('claude-3.5-haiku-20240620')).toBe('claude-3.5-haiku');
    expect(getValueKey('anthropic/claude-3.5-haiku')).toBe('claude-3.5-haiku');
    expect(getValueKey('claude-3.5-haiku-turbo')).toBe('claude-3.5-haiku');
    expect(getValueKey('claude-3.5-haiku-0125')).toBe('claude-3.5-haiku');
  });

  it('should return expected value keys for "gpt-oss" models', () => {
    expect(getValueKey('openai/gpt-oss-120b')).toBe('gpt-oss-120b');
    expect(getValueKey('openai/gpt-oss:120b')).toBe('gpt-oss:120b');
    expect(getValueKey('openai/gpt-oss-570b')).toBe('gpt-oss');
    expect(getValueKey('gpt-oss-570b')).toBe('gpt-oss');
    expect(getValueKey('groq/gpt-oss-1080b')).toBe('gpt-oss');
    expect(getValueKey('gpt-oss-20b')).toBe('gpt-oss-20b');
    expect(getValueKey('oai/gpt-oss:20b')).toBe('gpt-oss:20b');
  });
});

describe('getMultiplier', () => {
  it('should return the correct multiplier for a given valueKey and tokenType', () => {
    expect(getMultiplier({ valueKey: '8k', tokenType: 'prompt' })).toBe(tokenValues['8k'].prompt);
    expect(getMultiplier({ valueKey: '8k', tokenType: 'completion' })).toBe(
      tokenValues['8k'].completion,
    );
  });

  it('should return correct multipliers for o4-mini and o3', () => {
    ['o4-mini', 'o3'].forEach((model) => {
      const prompt = getMultiplier({ model, tokenType: 'prompt' });
      const completion = getMultiplier({ model, tokenType: 'completion' });
      expect(prompt).toBe(tokenValues[model].prompt);
      expect(completion).toBe(tokenValues[model].completion);
    });
  });

  it('should return defaultRate if tokenType is provided but not found in tokenValues', () => {
    // @ts-expect-error: intentionally passing invalid tokenType to test error handling
    expect(getMultiplier({ valueKey: '8k', tokenType: 'unknownType' })).toBe(defaultRate);
  });

  it('should return defaultRate if valueKey does not exist in tokenValues', () => {
    expect(getMultiplier({ valueKey: 'non-existent-model', tokenType: 'prompt' })).toBe(
      defaultRate,
    );
    expect(getMultiplier({ valueKey: 'non-existent-model', tokenType: 'completion' })).toBe(
      defaultRate,
    );
  });

  it('should derive the valueKey from the model if not provided', () => {
    expect(getMultiplier({ tokenType: 'prompt', model: 'gpt-4-some-other-info' })).toBe(
      tokenValues['8k'].prompt,
    );
  });

  it('should return 1 if only model or tokenType is missing', () => {
    expect(getMultiplier({ tokenType: 'prompt' })).toBe(1);
    expect(getMultiplier({ model: 'gpt-4-some-other-info' })).toBe(1);
  });

  it('should return the correct multiplier for gpt-3.5-turbo-1106', () => {
    expect(getMultiplier({ valueKey: 'gpt-3.5-turbo-1106', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-3.5-turbo-1106'].prompt,
    );
    expect(getMultiplier({ valueKey: 'gpt-3.5-turbo-1106', tokenType: 'completion' })).toBe(
      tokenValues['gpt-3.5-turbo-1106'].completion,
    );
  });

  it('should return the correct multiplier for gpt-4-1106', () => {
    expect(getMultiplier({ valueKey: 'gpt-4-1106', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-4-1106'].prompt,
    );
    expect(getMultiplier({ valueKey: 'gpt-4-1106', tokenType: 'completion' })).toBe(
      tokenValues['gpt-4-1106'].completion,
    );
  });

  it('should return the correct multiplier for gpt-5', () => {
    const valueKey = getValueKey('gpt-5-2025-01-30');
    expect(getMultiplier({ valueKey, tokenType: 'prompt' })).toBe(tokenValues['gpt-5'].prompt);
    expect(getMultiplier({ valueKey, tokenType: 'completion' })).toBe(
      tokenValues['gpt-5'].completion,
    );
    expect(getMultiplier({ model: 'gpt-5-preview', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5'].prompt,
    );
    expect(getMultiplier({ model: 'openai/gpt-5', tokenType: 'completion' })).toBe(
      tokenValues['gpt-5'].completion,
    );
  });

  it('should return the correct multiplier for gpt-5-mini', () => {
    const valueKey = getValueKey('gpt-5-mini-2025-01-30');
    expect(getMultiplier({ valueKey, tokenType: 'prompt' })).toBe(tokenValues['gpt-5-mini'].prompt);
    expect(getMultiplier({ valueKey, tokenType: 'completion' })).toBe(
      tokenValues['gpt-5-mini'].completion,
    );
    expect(getMultiplier({ model: 'gpt-5-mini-preview', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5-mini'].prompt,
    );
    expect(getMultiplier({ model: 'openai/gpt-5-mini', tokenType: 'completion' })).toBe(
      tokenValues['gpt-5-mini'].completion,
    );
  });

  it('should return the correct multiplier for gpt-5-nano', () => {
    const valueKey = getValueKey('gpt-5-nano-2025-01-30');
    expect(getMultiplier({ valueKey, tokenType: 'prompt' })).toBe(tokenValues['gpt-5-nano'].prompt);
    expect(getMultiplier({ valueKey, tokenType: 'completion' })).toBe(
      tokenValues['gpt-5-nano'].completion,
    );
    expect(getMultiplier({ model: 'gpt-5-nano-preview', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5-nano'].prompt,
    );
    expect(getMultiplier({ model: 'openai/gpt-5-nano', tokenType: 'completion' })).toBe(
      tokenValues['gpt-5-nano'].completion,
    );
  });

  it('should return the correct multiplier for gpt-5-pro', () => {
    const valueKey = getValueKey('gpt-5-pro-2025-01-30');
    expect(getMultiplier({ valueKey, tokenType: 'prompt' })).toBe(tokenValues['gpt-5-pro'].prompt);
    expect(getMultiplier({ valueKey, tokenType: 'completion' })).toBe(
      tokenValues['gpt-5-pro'].completion,
    );
    expect(getMultiplier({ model: 'gpt-5-pro-preview', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5-pro'].prompt,
    );
    expect(getMultiplier({ model: 'openai/gpt-5-pro', tokenType: 'completion' })).toBe(
      tokenValues['gpt-5-pro'].completion,
    );
  });

  it('should return the correct multiplier for gpt-5.2-pro', () => {
    expect(getMultiplier({ model: 'gpt-5.2-pro', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5.2-pro'].prompt,
    );
    expect(getMultiplier({ model: 'gpt-5.2-pro', tokenType: 'completion' })).toBe(
      tokenValues['gpt-5.2-pro'].completion,
    );
    expect(getMultiplier({ model: 'openai/gpt-5.2-pro', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5.2-pro'].prompt,
    );
  });

  it('should return the correct multiplier for gpt-5.1', () => {
    expect(getMultiplier({ model: 'gpt-5.1', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5.1'].prompt,
    );
    expect(getMultiplier({ model: 'gpt-5.1', tokenType: 'completion' })).toBe(
      tokenValues['gpt-5.1'].completion,
    );
    expect(getMultiplier({ model: 'openai/gpt-5.1', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5.1'].prompt,
    );
  });

  it('should return the correct multiplier for gpt-5.2', () => {
    expect(getMultiplier({ model: 'gpt-5.2', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5.2'].prompt,
    );
    expect(getMultiplier({ model: 'gpt-5.2', tokenType: 'completion' })).toBe(
      tokenValues['gpt-5.2'].completion,
    );
    expect(getMultiplier({ model: 'openai/gpt-5.2', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5.2'].prompt,
    );
  });

  it('should return the correct multiplier for gpt-5.3', () => {
    expect(getMultiplier({ model: 'gpt-5.3', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5.3'].prompt,
    );
    expect(getMultiplier({ model: 'gpt-5.3', tokenType: 'completion' })).toBe(
      tokenValues['gpt-5.3'].completion,
    );
    expect(getMultiplier({ model: 'gpt-5.3-codex', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5.3'].prompt,
    );
    expect(getMultiplier({ model: 'openai/gpt-5.3', tokenType: 'completion' })).toBe(
      tokenValues['gpt-5.3'].completion,
    );
  });

  it('should return the correct multiplier for gpt-5.4', () => {
    expect(getMultiplier({ model: 'gpt-5.4', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5.4'].prompt,
    );
    expect(getMultiplier({ model: 'gpt-5.4', tokenType: 'completion' })).toBe(
      tokenValues['gpt-5.4'].completion,
    );
    expect(getMultiplier({ model: 'gpt-5.4-thinking', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5.4'].prompt,
    );
    expect(getMultiplier({ model: 'openai/gpt-5.4', tokenType: 'completion' })).toBe(
      tokenValues['gpt-5.4'].completion,
    );
  });

  it('should return the correct multiplier for gpt-5.4-pro', () => {
    expect(getMultiplier({ model: 'gpt-5.4-pro', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5.4-pro'].prompt,
    );
    expect(getMultiplier({ model: 'gpt-5.4-pro', tokenType: 'completion' })).toBe(
      tokenValues['gpt-5.4-pro'].completion,
    );
    expect(getMultiplier({ model: 'openai/gpt-5.4-pro', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-5.4-pro'].prompt,
    );
  });

  it('should return the correct multiplier for gpt-5.6 tiers', () => {
    for (const model of ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(getValueKey(model)).toBe(model);
      expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(tokenValues[model].prompt);
      expect(getMultiplier({ model, tokenType: 'completion' })).toBe(tokenValues[model].completion);
      expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(cacheTokenValues[model].write);
      expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(cacheTokenValues[model].read);
    }
    expect(getValueKey('gpt-5.6-sol')).toBe('gpt-5.6');
    expect(getMultiplier({ model: 'openai/gpt-5.6-terra', tokenType: 'completion' })).toBe(
      tokenValues['gpt-5.6-terra'].completion,
    );
  });

  it('should bill gpt-5.6 cache writes at the documented 1.25x input surcharge', () => {
    for (const model of ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(cacheTokenValues[model].write).toBeCloseTo(tokenValues[model].prompt * 1.25);
    }
  });

  it('should use the documented gpt-6-astra pricing', () => {
    expect(tokenValues['gpt-6-astra']).toEqual({ prompt: 10, completion: 50 });
    expect(cacheTokenValues['gpt-6-astra']).toEqual({ write: 12.5, read: 1 });
    expect(premiumTokenValues['gpt-6-astra']).toEqual({
      threshold: 272000,
      prompt: 20,
      completion: 75,
    });
    expect(premiumCacheTokenValues['gpt-6-astra']).toEqual({
      threshold: 272000,
      write: 25,
      read: 2,
    });
  });

  it('should bill gpt-6-astra cache writes at the documented 1.25x input surcharge', () => {
    expect(cacheTokenValues['gpt-6-astra'].write).toBeCloseTo(
      tokenValues['gpt-6-astra'].prompt * 1.25,
    );
  });

  it('should apply the documented gpt-6-astra long-context multipliers', () => {
    const standard = tokenValues['gpt-6-astra'];
    const premium = premiumTokenValues['gpt-6-astra'];
    const standardCache = cacheTokenValues['gpt-6-astra'];
    const premiumCache = premiumCacheTokenValues['gpt-6-astra'];
    /** >272K input: 2x input and cache rates, 1.5x output, for the full request. */
    expect(premium.prompt).toBeCloseTo(standard.prompt * 2);
    expect(premium.completion).toBeCloseTo(standard.completion * 1.5);
    expect(premiumCache.write).toBeCloseTo(standardCache.write * 2);
    expect(premiumCache.read).toBeCloseTo(standardCache.read * 2);
  });

  it('should resolve gpt-6-astra to its own key rather than a gpt-6 prefix', () => {
    for (const model of [
      'gpt-6-astra',
      'gpt-6-astra-2026-04-30',
      'openai/gpt-6-astra',
      'gpt-6-astra/openai',
    ]) {
      expect(getValueKey(model)).toBe('gpt-6-astra');
      expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(10);
      expect(getMultiplier({ model, tokenType: 'completion' })).toBe(50);
    }
  });

  it('should charge gpt-6-astra premium rates only past the 272K threshold', () => {
    const model = 'gpt-6-astra';
    expect(getMultiplier({ model, tokenType: 'prompt', inputTokenCount: 272000 })).toBe(10);
    expect(getMultiplier({ model, tokenType: 'prompt', inputTokenCount: 272001 })).toBe(20);
    expect(getMultiplier({ model, tokenType: 'completion', inputTokenCount: 272001 })).toBe(75);
  });

  it('should use the documented gpt-5.6 pricing', () => {
    const expectedPricing = {
      'gpt-5.6': {
        standard: { prompt: 4, completion: 20 },
        cache: { write: 5, read: 0.4 },
        premium: { threshold: 272000, prompt: 8, completion: 30 },
        premiumCache: { threshold: 272000, write: 10, read: 0.8 },
      },
      'gpt-5.6-terra': {
        standard: { prompt: 2, completion: 12 },
        cache: { write: 2.5, read: 0.2 },
        premium: { threshold: 272000, prompt: 4, completion: 18 },
        premiumCache: { threshold: 272000, write: 5, read: 0.4 },
      },
      'gpt-5.6-luna': {
        standard: { prompt: 0.2, completion: 1.2 },
        cache: { write: 0.25, read: 0.02 },
        premium: { threshold: 272000, prompt: 0.4, completion: 1.8 },
        premiumCache: { threshold: 272000, write: 0.5, read: 0.04 },
      },
    };

    for (const [model, pricing] of Object.entries(expectedPricing)) {
      expect(tokenValues[model]).toEqual(pricing.standard);
      expect(cacheTokenValues[model]).toEqual(pricing.cache);
      expect(premiumTokenValues[model]).toEqual(pricing.premium);
      expect(premiumCacheTokenValues[model]).toEqual(pricing.premiumCache);
    }
  });

  it('should return the correct multiplier for gpt-4o', () => {
    const valueKey = getValueKey('gpt-4o-2024-08-06');
    expect(getMultiplier({ valueKey, tokenType: 'prompt' })).toBe(tokenValues['gpt-4o'].prompt);
    expect(getMultiplier({ valueKey, tokenType: 'completion' })).toBe(
      tokenValues['gpt-4o'].completion,
    );
    expect(getMultiplier({ valueKey, tokenType: 'completion' })).not.toBe(
      tokenValues['gpt-4-1106'].completion,
    );
  });

  it('should return the correct multiplier for gpt-4.1', () => {
    const valueKey = getValueKey('gpt-4.1-2024-08-06');
    expect(getMultiplier({ valueKey, tokenType: 'prompt' })).toBe(tokenValues['gpt-4.1'].prompt);
    expect(getMultiplier({ valueKey, tokenType: 'completion' })).toBe(
      tokenValues['gpt-4.1'].completion,
    );
    expect(getMultiplier({ model: 'gpt-4.1-preview', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-4.1'].prompt,
    );
    expect(getMultiplier({ model: 'openai/gpt-4.1', tokenType: 'completion' })).toBe(
      tokenValues['gpt-4.1'].completion,
    );
  });

  it('should return the correct multiplier for gpt-4.1-mini', () => {
    const valueKey = getValueKey('gpt-4.1-mini-2024-08-06');
    expect(getMultiplier({ valueKey, tokenType: 'prompt' })).toBe(
      tokenValues['gpt-4.1-mini'].prompt,
    );
    expect(getMultiplier({ valueKey, tokenType: 'completion' })).toBe(
      tokenValues['gpt-4.1-mini'].completion,
    );
    expect(getMultiplier({ model: 'gpt-4.1-mini-preview', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-4.1-mini'].prompt,
    );
    expect(getMultiplier({ model: 'openai/gpt-4.1-mini', tokenType: 'completion' })).toBe(
      tokenValues['gpt-4.1-mini'].completion,
    );
  });

  it('should return the correct multiplier for gpt-4.1-nano', () => {
    const valueKey = getValueKey('gpt-4.1-nano-2024-08-06');
    expect(getMultiplier({ valueKey, tokenType: 'prompt' })).toBe(
      tokenValues['gpt-4.1-nano'].prompt,
    );
    expect(getMultiplier({ valueKey, tokenType: 'completion' })).toBe(
      tokenValues['gpt-4.1-nano'].completion,
    );
    expect(getMultiplier({ model: 'gpt-4.1-nano-preview', tokenType: 'prompt' })).toBe(
      tokenValues['gpt-4.1-nano'].prompt,
    );
    expect(getMultiplier({ model: 'openai/gpt-4.1-nano', tokenType: 'completion' })).toBe(
      tokenValues['gpt-4.1-nano'].completion,
    );
  });

  it('should return the correct multiplier for gpt-4o-mini', () => {
    const valueKey = getValueKey('gpt-4o-mini-2024-07-18');
    expect(getMultiplier({ valueKey, tokenType: 'prompt' })).toBe(
      tokenValues['gpt-4o-mini'].prompt,
    );
    expect(getMultiplier({ valueKey, tokenType: 'completion' })).toBe(
      tokenValues['gpt-4o-mini'].completion,
    );
    expect(getMultiplier({ valueKey, tokenType: 'completion' })).not.toBe(
      tokenValues['gpt-4-1106'].completion,
    );
  });

  it('should return the correct multiplier for chatgpt-4o-latest', () => {
    const valueKey = getValueKey('chatgpt-4o-latest');
    expect(getMultiplier({ valueKey, tokenType: 'prompt' })).toBe(tokenValues['gpt-4o'].prompt);
    expect(getMultiplier({ valueKey, tokenType: 'completion' })).toBe(
      tokenValues['gpt-4o'].completion,
    );
    expect(getMultiplier({ valueKey, tokenType: 'completion' })).not.toBe(
      tokenValues['gpt-4o-mini'].completion,
    );
  });

  it('should derive the valueKey from the model if not provided for new models', () => {
    expect(
      getMultiplier({ tokenType: 'prompt', model: 'gpt-3.5-turbo-1106-some-other-info' }),
    ).toBe(tokenValues['gpt-3.5-turbo-1106'].prompt);
    expect(getMultiplier({ tokenType: 'completion', model: 'gpt-4-1106-vision-preview' })).toBe(
      tokenValues['gpt-4-1106'].completion,
    );
    expect(getMultiplier({ tokenType: 'completion', model: 'gpt-4-0125-preview' })).toBe(
      tokenValues['gpt-4-1106'].completion,
    );
    expect(getMultiplier({ tokenType: 'completion', model: 'gpt-4-turbo-vision-preview' })).toBe(
      tokenValues['gpt-4-1106'].completion,
    );
    expect(getMultiplier({ tokenType: 'completion', model: 'gpt-3.5-turbo-0125' })).toBe(
      tokenValues['gpt-3.5-turbo-0125'].completion,
    );
  });

  it('should return defaultRate if derived valueKey does not match any known patterns', () => {
    expect(getMultiplier({ tokenType: 'prompt', model: 'gpt-10-some-other-info' })).toBe(
      defaultRate,
    );
  });

  it('should return correct multipliers for GPT-OSS models', () => {
    const models = ['gpt-oss-20b', 'gpt-oss-120b'];
    models.forEach((key) => {
      const expectedPrompt = tokenValues[key].prompt;
      const expectedCompletion = tokenValues[key].completion;
      expect(getMultiplier({ valueKey: key, tokenType: 'prompt' })).toBe(expectedPrompt);
      expect(getMultiplier({ valueKey: key, tokenType: 'completion' })).toBe(expectedCompletion);
      expect(getMultiplier({ model: key, tokenType: 'prompt' })).toBe(expectedPrompt);
      expect(getMultiplier({ model: key, tokenType: 'completion' })).toBe(expectedCompletion);
    });
  });

  it('should return correct multipliers for GLM models', () => {
    const models = ['glm-4.6', 'glm-4.5v', 'glm-4.5-air', 'glm-4.5', 'glm-4-32b', 'glm-4', 'glm4'];
    models.forEach((key) => {
      const expectedPrompt = tokenValues[key].prompt;
      const expectedCompletion = tokenValues[key].completion;
      expect(getMultiplier({ valueKey: key, tokenType: 'prompt' })).toBe(expectedPrompt);
      expect(getMultiplier({ valueKey: key, tokenType: 'completion' })).toBe(expectedCompletion);
      expect(getMultiplier({ model: key, tokenType: 'prompt' })).toBe(expectedPrompt);
      expect(getMultiplier({ model: key, tokenType: 'completion' })).toBe(expectedCompletion);
    });
  });
});

describe('AWS Bedrock Model Tests', () => {
  const awsModels = [
    'anthropic.claude-3-5-haiku-20241022-v1:0',
    'anthropic.claude-3-haiku-20240307-v1:0',
    'anthropic.claude-3-sonnet-20240229-v1:0',
    'anthropic.claude-3-opus-20240229-v1:0',
    'anthropic.claude-3-5-sonnet-20240620-v1:0',
    'anthropic.claude-v2:1',
    'anthropic.claude-instant-v1',
    'meta.llama2-13b-chat-v1',
    'meta.llama2-70b-chat-v1',
    'meta.llama3-8b-instruct-v1:0',
    'meta.llama3-70b-instruct-v1:0',
    'meta.llama3-1-8b-instruct-v1:0',
    'meta.llama3-1-70b-instruct-v1:0',
    'meta.llama3-1-405b-instruct-v1:0',
    'mistral.mistral-7b-instruct-v0:2',
    'mistral.mistral-small-2402-v1:0',
    'mistral.mixtral-8x7b-instruct-v0:1',
    'mistral.mistral-large-2402-v1:0',
    'mistral.mistral-large-2407-v1:0',
    'cohere.command-text-v14',
    'cohere.command-light-text-v14',
    'cohere.command-r-v1:0',
    'cohere.command-r-plus-v1:0',
    'ai21.j2-mid-v1',
    'ai21.j2-ultra-v1',
    'amazon.titan-text-lite-v1',
    'amazon.titan-text-express-v1',
    'amazon.nova-micro-v1:0',
    'amazon.nova-lite-v1:0',
    'amazon.nova-pro-v1:0',
  ];

  it('should return the correct prompt multipliers for all models', () => {
    const results = awsModels.map((model) => {
      const valueKey = getValueKey(model, EModelEndpoint.bedrock);
      const multiplier = getMultiplier({ valueKey, tokenType: 'prompt' });
      return tokenValues[valueKey!].prompt && multiplier === tokenValues[valueKey!].prompt;
    });
    expect(results.every(Boolean)).toBe(true);
  });

  it('should return the correct completion multipliers for all models', () => {
    const results = awsModels.map((model) => {
      const valueKey = getValueKey(model, EModelEndpoint.bedrock);
      const multiplier = getMultiplier({ valueKey, tokenType: 'completion' });
      return tokenValues[valueKey!].completion && multiplier === tokenValues[valueKey!].completion;
    });
    expect(results.every(Boolean)).toBe(true);
  });
});

describe('Amazon Model Tests', () => {
  describe('Amazon Nova Models', () => {
    it('should return correct pricing for nova-premier', () => {
      expect(getMultiplier({ model: 'nova-premier', tokenType: 'prompt' })).toBe(
        tokenValues['nova-premier'].prompt,
      );
      expect(getMultiplier({ model: 'nova-premier', tokenType: 'completion' })).toBe(
        tokenValues['nova-premier'].completion,
      );
      expect(getMultiplier({ model: 'amazon.nova-premier-v1:0', tokenType: 'prompt' })).toBe(
        tokenValues['nova-premier'].prompt,
      );
      expect(getMultiplier({ model: 'amazon.nova-premier-v1:0', tokenType: 'completion' })).toBe(
        tokenValues['nova-premier'].completion,
      );
    });

    it('should return correct pricing for nova-pro', () => {
      expect(getMultiplier({ model: 'nova-pro', tokenType: 'prompt' })).toBe(
        tokenValues['nova-pro'].prompt,
      );
      expect(getMultiplier({ model: 'nova-pro', tokenType: 'completion' })).toBe(
        tokenValues['nova-pro'].completion,
      );
      expect(getMultiplier({ model: 'amazon.nova-pro-v1:0', tokenType: 'prompt' })).toBe(
        tokenValues['nova-pro'].prompt,
      );
      expect(getMultiplier({ model: 'amazon.nova-pro-v1:0', tokenType: 'completion' })).toBe(
        tokenValues['nova-pro'].completion,
      );
    });

    it('should return correct pricing for nova-lite', () => {
      expect(getMultiplier({ model: 'nova-lite', tokenType: 'prompt' })).toBe(
        tokenValues['nova-lite'].prompt,
      );
      expect(getMultiplier({ model: 'nova-lite', tokenType: 'completion' })).toBe(
        tokenValues['nova-lite'].completion,
      );
      expect(getMultiplier({ model: 'amazon.nova-lite-v1:0', tokenType: 'prompt' })).toBe(
        tokenValues['nova-lite'].prompt,
      );
      expect(getMultiplier({ model: 'amazon.nova-lite-v1:0', tokenType: 'completion' })).toBe(
        tokenValues['nova-lite'].completion,
      );
    });

    it('should return correct pricing for nova-micro', () => {
      expect(getMultiplier({ model: 'nova-micro', tokenType: 'prompt' })).toBe(
        tokenValues['nova-micro'].prompt,
      );
      expect(getMultiplier({ model: 'nova-micro', tokenType: 'completion' })).toBe(
        tokenValues['nova-micro'].completion,
      );
      expect(getMultiplier({ model: 'amazon.nova-micro-v1:0', tokenType: 'prompt' })).toBe(
        tokenValues['nova-micro'].prompt,
      );
      expect(getMultiplier({ model: 'amazon.nova-micro-v1:0', tokenType: 'completion' })).toBe(
        tokenValues['nova-micro'].completion,
      );
    });

    it('should match both short and full model names to the same pricing', () => {
      const models = ['nova-micro', 'nova-lite', 'nova-pro', 'nova-premier'];
      const fullModels = [
        'amazon.nova-micro-v1:0',
        'amazon.nova-lite-v1:0',
        'amazon.nova-pro-v1:0',
        'amazon.nova-premier-v1:0',
      ];

      models.forEach((shortModel, i) => {
        const fullModel = fullModels[i];
        const shortPrompt = getMultiplier({ model: shortModel, tokenType: 'prompt' });
        const fullPrompt = getMultiplier({ model: fullModel, tokenType: 'prompt' });
        const shortCompletion = getMultiplier({ model: shortModel, tokenType: 'completion' });
        const fullCompletion = getMultiplier({ model: fullModel, tokenType: 'completion' });

        expect(shortPrompt).toBe(fullPrompt);
        expect(shortCompletion).toBe(fullCompletion);
        expect(shortPrompt).toBe(tokenValues[shortModel].prompt);
        expect(shortCompletion).toBe(tokenValues[shortModel].completion);
      });
    });
  });

  describe('Amazon Titan Models', () => {
    it('should return correct pricing for titan-text-premier', () => {
      expect(getMultiplier({ model: 'titan-text-premier', tokenType: 'prompt' })).toBe(
        tokenValues['titan-text-premier'].prompt,
      );
      expect(getMultiplier({ model: 'titan-text-premier', tokenType: 'completion' })).toBe(
        tokenValues['titan-text-premier'].completion,
      );
      expect(getMultiplier({ model: 'amazon.titan-text-premier-v1:0', tokenType: 'prompt' })).toBe(
        tokenValues['titan-text-premier'].prompt,
      );
      expect(
        getMultiplier({ model: 'amazon.titan-text-premier-v1:0', tokenType: 'completion' }),
      ).toBe(tokenValues['titan-text-premier'].completion);
    });

    it('should return correct pricing for titan-text-express', () => {
      expect(getMultiplier({ model: 'titan-text-express', tokenType: 'prompt' })).toBe(
        tokenValues['titan-text-express'].prompt,
      );
      expect(getMultiplier({ model: 'titan-text-express', tokenType: 'completion' })).toBe(
        tokenValues['titan-text-express'].completion,
      );
      expect(getMultiplier({ model: 'amazon.titan-text-express-v1', tokenType: 'prompt' })).toBe(
        tokenValues['titan-text-express'].prompt,
      );
      expect(
        getMultiplier({ model: 'amazon.titan-text-express-v1', tokenType: 'completion' }),
      ).toBe(tokenValues['titan-text-express'].completion);
    });

    it('should return correct pricing for titan-text-lite', () => {
      expect(getMultiplier({ model: 'titan-text-lite', tokenType: 'prompt' })).toBe(
        tokenValues['titan-text-lite'].prompt,
      );
      expect(getMultiplier({ model: 'titan-text-lite', tokenType: 'completion' })).toBe(
        tokenValues['titan-text-lite'].completion,
      );
      expect(getMultiplier({ model: 'amazon.titan-text-lite-v1', tokenType: 'prompt' })).toBe(
        tokenValues['titan-text-lite'].prompt,
      );
      expect(getMultiplier({ model: 'amazon.titan-text-lite-v1', tokenType: 'completion' })).toBe(
        tokenValues['titan-text-lite'].completion,
      );
    });

    it('should match both short and full model names to the same pricing', () => {
      const models = ['titan-text-lite', 'titan-text-express', 'titan-text-premier'];
      const fullModels = [
        'amazon.titan-text-lite-v1',
        'amazon.titan-text-express-v1',
        'amazon.titan-text-premier-v1:0',
      ];

      models.forEach((shortModel, i) => {
        const fullModel = fullModels[i];
        const shortPrompt = getMultiplier({ model: shortModel, tokenType: 'prompt' });
        const fullPrompt = getMultiplier({ model: fullModel, tokenType: 'prompt' });
        const shortCompletion = getMultiplier({ model: shortModel, tokenType: 'completion' });
        const fullCompletion = getMultiplier({ model: fullModel, tokenType: 'completion' });

        expect(shortPrompt).toBe(fullPrompt);
        expect(shortCompletion).toBe(fullCompletion);
        expect(shortPrompt).toBe(tokenValues[shortModel].prompt);
        expect(shortCompletion).toBe(tokenValues[shortModel].completion);
      });
    });
  });
});

describe('AI21 Model Tests', () => {
  describe('AI21 J2 Models', () => {
    it('should return correct pricing for j2-mid', () => {
      expect(getMultiplier({ model: 'j2-mid', tokenType: 'prompt' })).toBe(
        tokenValues['j2-mid'].prompt,
      );
      expect(getMultiplier({ model: 'j2-mid', tokenType: 'completion' })).toBe(
        tokenValues['j2-mid'].completion,
      );
      expect(getMultiplier({ model: 'ai21.j2-mid-v1', tokenType: 'prompt' })).toBe(
        tokenValues['j2-mid'].prompt,
      );
      expect(getMultiplier({ model: 'ai21.j2-mid-v1', tokenType: 'completion' })).toBe(
        tokenValues['j2-mid'].completion,
      );
    });

    it('should return correct pricing for j2-ultra', () => {
      expect(getMultiplier({ model: 'j2-ultra', tokenType: 'prompt' })).toBe(
        tokenValues['j2-ultra'].prompt,
      );
      expect(getMultiplier({ model: 'j2-ultra', tokenType: 'completion' })).toBe(
        tokenValues['j2-ultra'].completion,
      );
      expect(getMultiplier({ model: 'ai21.j2-ultra-v1', tokenType: 'prompt' })).toBe(
        tokenValues['j2-ultra'].prompt,
      );
      expect(getMultiplier({ model: 'ai21.j2-ultra-v1', tokenType: 'completion' })).toBe(
        tokenValues['j2-ultra'].completion,
      );
    });

    it('should match both short and full model names to the same pricing', () => {
      const models = ['j2-mid', 'j2-ultra'];
      const fullModels = ['ai21.j2-mid-v1', 'ai21.j2-ultra-v1'];

      models.forEach((shortModel, i) => {
        const fullModel = fullModels[i];
        const shortPrompt = getMultiplier({ model: shortModel, tokenType: 'prompt' });
        const fullPrompt = getMultiplier({ model: fullModel, tokenType: 'prompt' });
        const shortCompletion = getMultiplier({ model: shortModel, tokenType: 'completion' });
        const fullCompletion = getMultiplier({ model: fullModel, tokenType: 'completion' });

        expect(shortPrompt).toBe(fullPrompt);
        expect(shortCompletion).toBe(fullCompletion);
        expect(shortPrompt).toBe(tokenValues[shortModel].prompt);
        expect(shortCompletion).toBe(tokenValues[shortModel].completion);
      });
    });
  });

  describe('AI21 Jamba Models', () => {
    it('should return correct pricing for jamba-instruct', () => {
      expect(getMultiplier({ model: 'jamba-instruct', tokenType: 'prompt' })).toBe(
        tokenValues['jamba-instruct'].prompt,
      );
      expect(getMultiplier({ model: 'jamba-instruct', tokenType: 'completion' })).toBe(
        tokenValues['jamba-instruct'].completion,
      );
      expect(getMultiplier({ model: 'ai21.jamba-instruct-v1:0', tokenType: 'prompt' })).toBe(
        tokenValues['jamba-instruct'].prompt,
      );
      expect(getMultiplier({ model: 'ai21.jamba-instruct-v1:0', tokenType: 'completion' })).toBe(
        tokenValues['jamba-instruct'].completion,
      );
    });

    it('should match both short and full model names to the same pricing', () => {
      const shortPrompt = getMultiplier({ model: 'jamba-instruct', tokenType: 'prompt' });
      const fullPrompt = getMultiplier({
        model: 'ai21.jamba-instruct-v1:0',
        tokenType: 'prompt',
      });
      const shortCompletion = getMultiplier({ model: 'jamba-instruct', tokenType: 'completion' });
      const fullCompletion = getMultiplier({
        model: 'ai21.jamba-instruct-v1:0',
        tokenType: 'completion',
      });

      expect(shortPrompt).toBe(fullPrompt);
      expect(shortCompletion).toBe(fullCompletion);
      expect(shortPrompt).toBe(tokenValues['jamba-instruct'].prompt);
      expect(shortCompletion).toBe(tokenValues['jamba-instruct'].completion);
    });
  });
});

describe('Deepseek Model Tests', () => {
  const deepseekModels = ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner', 'deepseek.r1'];

  it('should return the correct prompt multipliers for all models', () => {
    const results = deepseekModels.map((model) => {
      const valueKey = getValueKey(model);
      const multiplier = getMultiplier({ valueKey, tokenType: 'prompt' });
      return tokenValues[valueKey!].prompt && multiplier === tokenValues[valueKey!].prompt;
    });
    expect(results.every(Boolean)).toBe(true);
  });

  it('should return the correct completion multipliers for all models', () => {
    const results = deepseekModels.map((model) => {
      const valueKey = getValueKey(model);
      const multiplier = getMultiplier({ valueKey, tokenType: 'completion' });
      return tokenValues[valueKey!].completion && multiplier === tokenValues[valueKey!].completion;
    });
    expect(results.every(Boolean)).toBe(true);
  });

  it('should return the correct prompt multipliers for reasoning model', () => {
    const model = 'deepseek-reasoner';
    const valueKey = getValueKey(model);
    expect(valueKey).toBe(model);
    const multiplier = getMultiplier({ valueKey, tokenType: 'prompt' });
    const result = tokenValues[valueKey!].prompt && multiplier === tokenValues[valueKey!].prompt;
    expect(result).toBe(true);
  });

  it('should return correct pricing for deepseek-chat', () => {
    expect(getMultiplier({ model: 'deepseek-chat', tokenType: 'prompt' })).toBe(
      tokenValues['deepseek-chat'].prompt,
    );
    expect(getMultiplier({ model: 'deepseek-chat', tokenType: 'completion' })).toBe(
      tokenValues['deepseek-chat'].completion,
    );
  });

  it('should return correct pricing for deepseek-reasoner', () => {
    expect(getMultiplier({ model: 'deepseek-reasoner', tokenType: 'prompt' })).toBe(
      tokenValues['deepseek-reasoner'].prompt,
    );
    expect(getMultiplier({ model: 'deepseek-reasoner', tokenType: 'completion' })).toBe(
      tokenValues['deepseek-reasoner'].completion,
    );
  });

  it('should handle DeepSeek model name variations with provider prefixes', () => {
    const modelVariations = [
      'deepseek/deepseek-chat',
      'openrouter/deepseek-chat',
      'deepseek/deepseek-reasoner',
    ];

    modelVariations.forEach((model) => {
      const promptMultiplier = getMultiplier({ model, tokenType: 'prompt' });
      const completionMultiplier = getMultiplier({ model, tokenType: 'completion' });
      expect(promptMultiplier).toBe(tokenValues['deepseek-chat'].prompt);
      expect(completionMultiplier).toBe(tokenValues['deepseek-chat'].completion);
    });
  });

  it('should return correct cache multipliers for DeepSeek models', () => {
    expect(getCacheMultiplier({ model: 'deepseek-chat', cacheType: 'write' })).toBe(
      cacheTokenValues['deepseek-chat'].write,
    );
    expect(getCacheMultiplier({ model: 'deepseek-chat', cacheType: 'read' })).toBe(
      cacheTokenValues['deepseek-chat'].read,
    );
    expect(getCacheMultiplier({ model: 'deepseek-reasoner', cacheType: 'write' })).toBe(
      cacheTokenValues['deepseek-reasoner'].write,
    );
    expect(getCacheMultiplier({ model: 'deepseek-reasoner', cacheType: 'read' })).toBe(
      cacheTokenValues['deepseek-reasoner'].read,
    );
  });

  it('should have consistent cache pricing across DeepSeek model variants', () => {
    expect(cacheTokenValues['deepseek'].write).toBe(cacheTokenValues['deepseek-chat'].write);
    expect(cacheTokenValues['deepseek'].read).toBe(cacheTokenValues['deepseek-chat'].read);
    expect(cacheTokenValues['deepseek-reasoner'].write).toBe(
      cacheTokenValues['deepseek-chat'].write,
    );
    expect(cacheTokenValues['deepseek-reasoner'].read).toBe(cacheTokenValues['deepseek-chat'].read);
  });

  it('should handle DeepSeek cache multipliers with model variations', () => {
    const modelVariations = ['deepseek/deepseek-chat', 'openrouter/deepseek-reasoner'];

    modelVariations.forEach((model) => {
      const writeMultiplier = getCacheMultiplier({ model, cacheType: 'write' });
      const readMultiplier = getCacheMultiplier({ model, cacheType: 'read' });
      expect(writeMultiplier).toBe(cacheTokenValues['deepseek-chat'].write);
      expect(readMultiplier).toBe(cacheTokenValues['deepseek-chat'].read);
    });
  });
});

describe('Moonshot/Kimi Model Tests - Pricing', () => {
  describe('Kimi Models', () => {
    it('should return correct pricing for kimi base pattern', () => {
      expect(getMultiplier({ model: 'kimi', tokenType: 'prompt' })).toBe(
        tokenValues['kimi'].prompt,
      );
      expect(getMultiplier({ model: 'kimi', tokenType: 'completion' })).toBe(
        tokenValues['kimi'].completion,
      );
    });

    it('should return correct pricing for kimi-k2.5', () => {
      expect(getMultiplier({ model: 'kimi-k2.5', tokenType: 'prompt' })).toBe(
        tokenValues['kimi-k2.5'].prompt,
      );
      expect(getMultiplier({ model: 'kimi-k2.5', tokenType: 'completion' })).toBe(
        tokenValues['kimi-k2.5'].completion,
      );
    });

    it('should return correct pricing for kimi-k2 series', () => {
      expect(getMultiplier({ model: 'kimi-k2', tokenType: 'prompt' })).toBe(
        tokenValues['kimi-k2'].prompt,
      );
      expect(getMultiplier({ model: 'kimi-k2', tokenType: 'completion' })).toBe(
        tokenValues['kimi-k2'].completion,
      );
    });

    it('should return correct pricing for kimi-k2-turbo (higher pricing)', () => {
      expect(getMultiplier({ model: 'kimi-k2-turbo', tokenType: 'prompt' })).toBe(
        tokenValues['kimi-k2-turbo'].prompt,
      );
      expect(getMultiplier({ model: 'kimi-k2-turbo', tokenType: 'completion' })).toBe(
        tokenValues['kimi-k2-turbo'].completion,
      );
    });

    it('should return correct pricing for kimi-k2-thinking models', () => {
      expect(getMultiplier({ model: 'kimi-k2-thinking', tokenType: 'prompt' })).toBe(
        tokenValues['kimi-k2-thinking'].prompt,
      );
      expect(getMultiplier({ model: 'kimi-k2-thinking', tokenType: 'completion' })).toBe(
        tokenValues['kimi-k2-thinking'].completion,
      );
      expect(getMultiplier({ model: 'kimi-k2-thinking-turbo', tokenType: 'prompt' })).toBe(
        tokenValues['kimi-k2-thinking-turbo'].prompt,
      );
      expect(getMultiplier({ model: 'kimi-k2-thinking-turbo', tokenType: 'completion' })).toBe(
        tokenValues['kimi-k2-thinking-turbo'].completion,
      );
    });

    it('should handle Kimi model variations with provider prefixes', () => {
      const modelVariations = ['openrouter/kimi-k2', 'openrouter/kimi-k2.5', 'openrouter/kimi'];

      modelVariations.forEach((model) => {
        const promptMultiplier = getMultiplier({ model, tokenType: 'prompt' });
        const completionMultiplier = getMultiplier({ model, tokenType: 'completion' });
        expect(promptMultiplier).toBe(tokenValues['kimi'].prompt);
        expect([tokenValues['kimi'].completion, tokenValues['kimi-k2.5'].completion]).toContain(
          completionMultiplier,
        );
      });
    });
  });

  describe('Moonshot Models', () => {
    it('should return correct pricing for moonshot base pattern (128k pricing)', () => {
      expect(getMultiplier({ model: 'moonshot', tokenType: 'prompt' })).toBe(
        tokenValues['moonshot'].prompt,
      );
      expect(getMultiplier({ model: 'moonshot', tokenType: 'completion' })).toBe(
        tokenValues['moonshot'].completion,
      );
    });

    it('should return correct pricing for moonshot-v1-8k', () => {
      expect(getMultiplier({ model: 'moonshot-v1-8k', tokenType: 'prompt' })).toBe(
        tokenValues['moonshot-v1-8k'].prompt,
      );
      expect(getMultiplier({ model: 'moonshot-v1-8k', tokenType: 'completion' })).toBe(
        tokenValues['moonshot-v1-8k'].completion,
      );
    });

    it('should return correct pricing for moonshot-v1-32k', () => {
      expect(getMultiplier({ model: 'moonshot-v1-32k', tokenType: 'prompt' })).toBe(
        tokenValues['moonshot-v1-32k'].prompt,
      );
      expect(getMultiplier({ model: 'moonshot-v1-32k', tokenType: 'completion' })).toBe(
        tokenValues['moonshot-v1-32k'].completion,
      );
    });

    it('should return correct pricing for moonshot-v1-128k', () => {
      expect(getMultiplier({ model: 'moonshot-v1-128k', tokenType: 'prompt' })).toBe(
        tokenValues['moonshot-v1-128k'].prompt,
      );
      expect(getMultiplier({ model: 'moonshot-v1-128k', tokenType: 'completion' })).toBe(
        tokenValues['moonshot-v1-128k'].completion,
      );
    });

    it('should return correct pricing for moonshot-v1 vision models', () => {
      expect(getMultiplier({ model: 'moonshot-v1-8k-vision', tokenType: 'prompt' })).toBe(
        tokenValues['moonshot-v1-8k-vision'].prompt,
      );
      expect(getMultiplier({ model: 'moonshot-v1-8k-vision', tokenType: 'completion' })).toBe(
        tokenValues['moonshot-v1-8k-vision'].completion,
      );
      expect(getMultiplier({ model: 'moonshot-v1-32k-vision', tokenType: 'prompt' })).toBe(
        tokenValues['moonshot-v1-32k-vision'].prompt,
      );
      expect(getMultiplier({ model: 'moonshot-v1-32k-vision', tokenType: 'completion' })).toBe(
        tokenValues['moonshot-v1-32k-vision'].completion,
      );
      expect(getMultiplier({ model: 'moonshot-v1-128k-vision', tokenType: 'prompt' })).toBe(
        tokenValues['moonshot-v1-128k-vision'].prompt,
      );
      expect(getMultiplier({ model: 'moonshot-v1-128k-vision', tokenType: 'completion' })).toBe(
        tokenValues['moonshot-v1-128k-vision'].completion,
      );
    });
  });

  describe('Kimi Cache Multipliers', () => {
    it('should return correct cache multipliers for kimi-k2 models', () => {
      expect(getCacheMultiplier({ model: 'kimi', cacheType: 'write' })).toBe(
        cacheTokenValues['kimi'].write,
      );
      expect(getCacheMultiplier({ model: 'kimi', cacheType: 'read' })).toBe(
        cacheTokenValues['kimi'].read,
      );
    });

    it('should return correct cache multipliers for kimi-k2.5 (lower read price)', () => {
      expect(getCacheMultiplier({ model: 'kimi-k2.5', cacheType: 'write' })).toBe(
        cacheTokenValues['kimi-k2.5'].write,
      );
      expect(getCacheMultiplier({ model: 'kimi-k2.5', cacheType: 'read' })).toBe(
        cacheTokenValues['kimi-k2.5'].read,
      );
    });

    it('should return correct cache multipliers for kimi-k2-turbo', () => {
      expect(getCacheMultiplier({ model: 'kimi-k2-turbo', cacheType: 'write' })).toBe(
        cacheTokenValues['kimi-k2-turbo'].write,
      );
      expect(getCacheMultiplier({ model: 'kimi-k2-turbo', cacheType: 'read' })).toBe(
        cacheTokenValues['kimi-k2-turbo'].read,
      );
    });

    it('should handle Kimi cache multipliers with model variations', () => {
      const modelVariations = ['openrouter/kimi-k2', 'openrouter/kimi'];

      modelVariations.forEach((model) => {
        const writeMultiplier = getCacheMultiplier({ model, cacheType: 'write' });
        const readMultiplier = getCacheMultiplier({ model, cacheType: 'read' });
        expect(writeMultiplier).toBe(cacheTokenValues['kimi'].write);
        expect(readMultiplier).toBe(cacheTokenValues['kimi'].read);
      });
    });
  });

  describe('Bedrock Moonshot Models', () => {
    it('should return correct pricing for Bedrock moonshot models', () => {
      expect(getMultiplier({ model: 'moonshot.kimi', tokenType: 'prompt' })).toBe(
        tokenValues['moonshot.kimi'].prompt,
      );
      expect(getMultiplier({ model: 'moonshot.kimi', tokenType: 'completion' })).toBe(
        tokenValues['moonshot.kimi'].completion,
      );
      expect(getMultiplier({ model: 'moonshot.kimi-k2', tokenType: 'prompt' })).toBe(
        tokenValues['moonshot.kimi-k2'].prompt,
      );
      expect(getMultiplier({ model: 'moonshot.kimi-k2.5', tokenType: 'prompt' })).toBe(
        tokenValues['moonshot.kimi-k2.5'].prompt,
      );
      expect(getMultiplier({ model: 'moonshot.kimi-k2.5', tokenType: 'completion' })).toBe(
        tokenValues['moonshot.kimi-k2.5'].completion,
      );
    });
  });
});

describe('Qwen3 Model Tests', () => {
  describe('Qwen3 Base Models', () => {
    it('should return correct pricing for qwen3 base pattern', () => {
      expect(getMultiplier({ model: 'qwen3', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3', tokenType: 'completion' })).toBe(
        tokenValues['qwen3'].completion,
      );
    });

    it('should return correct pricing for qwen3-4b (falls back to qwen3)', () => {
      expect(getMultiplier({ model: 'qwen3-4b', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3-4b', tokenType: 'completion' })).toBe(
        tokenValues['qwen3'].completion,
      );
    });

    it('should return correct pricing for qwen3-8b', () => {
      expect(getMultiplier({ model: 'qwen3-8b', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3-8b'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3-8b', tokenType: 'completion' })).toBe(
        tokenValues['qwen3-8b'].completion,
      );
    });

    it('should return correct pricing for qwen3-14b', () => {
      expect(getMultiplier({ model: 'qwen3-14b', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3-14b'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3-14b', tokenType: 'completion' })).toBe(
        tokenValues['qwen3-14b'].completion,
      );
    });

    it('should return correct pricing for qwen3-235b-a22b', () => {
      expect(getMultiplier({ model: 'qwen3-235b-a22b', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3-235b-a22b'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3-235b-a22b', tokenType: 'completion' })).toBe(
        tokenValues['qwen3-235b-a22b'].completion,
      );
    });

    it('should handle model name variations with provider prefixes', () => {
      const models = [
        { input: 'qwen3', expected: 'qwen3' },
        { input: 'qwen3-4b', expected: 'qwen3' },
        { input: 'qwen3-8b', expected: 'qwen3-8b' },
        { input: 'qwen3-32b', expected: 'qwen3-32b' },
      ];
      models.forEach(({ input, expected }) => {
        const withPrefix = `alibaba/${input}`;
        expect(getMultiplier({ model: withPrefix, tokenType: 'prompt' })).toBe(
          tokenValues[expected].prompt,
        );
        expect(getMultiplier({ model: withPrefix, tokenType: 'completion' })).toBe(
          tokenValues[expected].completion,
        );
      });
    });
  });

  describe('Qwen3 VL (Vision-Language) Models', () => {
    it('should return correct pricing for qwen3-vl-8b-thinking', () => {
      expect(getMultiplier({ model: 'qwen3-vl-8b-thinking', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3-vl-8b-thinking'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3-vl-8b-thinking', tokenType: 'completion' })).toBe(
        tokenValues['qwen3-vl-8b-thinking'].completion,
      );
    });

    it('should return correct pricing for qwen3-vl-8b-instruct', () => {
      expect(getMultiplier({ model: 'qwen3-vl-8b-instruct', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3-vl-8b-instruct'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3-vl-8b-instruct', tokenType: 'completion' })).toBe(
        tokenValues['qwen3-vl-8b-instruct'].completion,
      );
    });

    it('should return correct pricing for qwen3-vl-30b-a3b', () => {
      expect(getMultiplier({ model: 'qwen3-vl-30b-a3b', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3-vl-30b-a3b'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3-vl-30b-a3b', tokenType: 'completion' })).toBe(
        tokenValues['qwen3-vl-30b-a3b'].completion,
      );
    });

    it('should return correct pricing for qwen3-vl-235b-a22b', () => {
      expect(getMultiplier({ model: 'qwen3-vl-235b-a22b', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3-vl-235b-a22b'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3-vl-235b-a22b', tokenType: 'completion' })).toBe(
        tokenValues['qwen3-vl-235b-a22b'].completion,
      );
    });
  });

  describe('Qwen3 Specialized Models', () => {
    it('should return correct pricing for qwen3-max', () => {
      expect(getMultiplier({ model: 'qwen3-max', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3-max'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3-max', tokenType: 'completion' })).toBe(
        tokenValues['qwen3-max'].completion,
      );
    });

    it('should return correct pricing for qwen3-coder', () => {
      expect(getMultiplier({ model: 'qwen3-coder', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3-coder'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3-coder', tokenType: 'completion' })).toBe(
        tokenValues['qwen3-coder'].completion,
      );
    });

    it('should return correct pricing for qwen3-coder-plus', () => {
      expect(getMultiplier({ model: 'qwen3-coder-plus', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3-coder-plus'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3-coder-plus', tokenType: 'completion' })).toBe(
        tokenValues['qwen3-coder-plus'].completion,
      );
    });

    it('should return correct pricing for qwen3-coder-flash', () => {
      expect(getMultiplier({ model: 'qwen3-coder-flash', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3-coder-flash'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3-coder-flash', tokenType: 'completion' })).toBe(
        tokenValues['qwen3-coder-flash'].completion,
      );
    });

    it('should return correct pricing for qwen3-next-80b-a3b', () => {
      expect(getMultiplier({ model: 'qwen3-next-80b-a3b', tokenType: 'prompt' })).toBe(
        tokenValues['qwen3-next-80b-a3b'].prompt,
      );
      expect(getMultiplier({ model: 'qwen3-next-80b-a3b', tokenType: 'completion' })).toBe(
        tokenValues['qwen3-next-80b-a3b'].completion,
      );
    });
  });

  describe('Qwen3 Model Variations', () => {
    it('should handle all qwen3 models with provider prefixes', () => {
      const models = ['qwen3', 'qwen3-8b', 'qwen3-max', 'qwen3-coder', 'qwen3-vl-8b-instruct'];
      const prefixes = ['alibaba', 'qwen', 'openrouter'];

      models.forEach((model) => {
        prefixes.forEach((prefix) => {
          const fullModel = `${prefix}/${model}`;
          expect(getMultiplier({ model: fullModel, tokenType: 'prompt' })).toBe(
            tokenValues[model].prompt,
          );
          expect(getMultiplier({ model: fullModel, tokenType: 'completion' })).toBe(
            tokenValues[model].completion,
          );
        });
      });
    });

    it('should handle qwen3-4b falling back to qwen3 base pattern', () => {
      const testCases = ['qwen3-4b', 'alibaba/qwen3-4b', 'qwen/qwen3-4b-preview'];
      testCases.forEach((model) => {
        expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(tokenValues['qwen3'].prompt);
        expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
          tokenValues['qwen3'].completion,
        );
      });
    });
  });
});

describe('getCacheMultiplier', () => {
  it('should return the correct cache multiplier for a given valueKey and cacheType', () => {
    expect(getCacheMultiplier({ valueKey: 'claude-3-5-sonnet', cacheType: 'write' })).toBe(
      cacheTokenValues['claude-3-5-sonnet'].write,
    );
    expect(getCacheMultiplier({ valueKey: 'claude-3-5-sonnet', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-3-5-sonnet'].read,
    );
    expect(getCacheMultiplier({ valueKey: 'claude-3-5-haiku', cacheType: 'write' })).toBe(
      cacheTokenValues['claude-3-5-haiku'].write,
    );
    expect(getCacheMultiplier({ valueKey: 'claude-3-5-haiku', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-3-5-haiku'].read,
    );
    expect(getCacheMultiplier({ valueKey: 'claude-3-haiku', cacheType: 'write' })).toBe(
      cacheTokenValues['claude-3-haiku'].write,
    );
    expect(getCacheMultiplier({ valueKey: 'claude-3-haiku', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-3-haiku'].read,
    );
  });

  it('should return null if cacheType is provided but not found in cacheTokenValues', () => {
    expect(
      // @ts-expect-error: intentionally passing invalid cacheType to test error handling
      getCacheMultiplier({ valueKey: 'claude-3-5-sonnet', cacheType: 'unknownType' }),
    ).toBeNull();
  });

  it('should derive the valueKey from the model if not provided', () => {
    expect(getCacheMultiplier({ cacheType: 'write', model: 'claude-3-5-sonnet-20240620' })).toBe(
      cacheTokenValues['claude-3-5-sonnet'].write,
    );
    expect(getCacheMultiplier({ cacheType: 'read', model: 'claude-3-haiku-20240307' })).toBe(
      cacheTokenValues['claude-3-haiku'].read,
    );
  });

  it('should return null if only model or cacheType is missing', () => {
    expect(getCacheMultiplier({ cacheType: 'write' })).toBeNull();
    expect(getCacheMultiplier({ model: 'claude-3-5-sonnet' })).toBeNull();
  });

  it('should return null if derived valueKey does not match any known patterns', () => {
    expect(getCacheMultiplier({ cacheType: 'write', model: 'gpt-4-some-other-info' })).toBeNull();
  });

  it('should handle endpointTokenConfig if provided', () => {
    const endpointTokenConfig = {
      'custom-model': {
        write: 5,
        read: 1,
      },
    };
    expect(
      getCacheMultiplier({ model: 'custom-model', cacheType: 'write', endpointTokenConfig }),
    ).toBe(endpointTokenConfig['custom-model'].write);
    expect(
      getCacheMultiplier({ model: 'custom-model', cacheType: 'read', endpointTokenConfig }),
    ).toBe(endpointTokenConfig['custom-model'].read);
  });

  it('should return null if model is not found in endpointTokenConfig', () => {
    const endpointTokenConfig = {
      'custom-model': {
        write: 5,
        read: 1,
      },
    };
    expect(
      getCacheMultiplier({ model: 'unknown-model', cacheType: 'write', endpointTokenConfig }),
    ).toBeNull();
  });

  it('should return correct cache multipliers for OpenAI models', () => {
    const openaiCacheModels = [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-5',
      'gpt-5.1',
      'gpt-5.2',
      'gpt-5.3',
      'gpt-5.4',
      'gpt-5-mini',
      'gpt-5-nano',
      'o1',
      'o1-mini',
      'o1-preview',
      'o3',
      'o3-mini',
      'o4-mini',
    ];

    for (const model of openaiCacheModels) {
      expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(cacheTokenValues[model].write);
      expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(cacheTokenValues[model].read);
    }
  });

  it('should return correct cache multipliers for OpenAI dated variants', () => {
    expect(getCacheMultiplier({ model: 'gpt-4o-2024-08-06', cacheType: 'read' })).toBe(
      cacheTokenValues['gpt-4o'].read,
    );
    expect(getCacheMultiplier({ model: 'gpt-4.1-2026-01-01', cacheType: 'read' })).toBe(
      cacheTokenValues['gpt-4.1'].read,
    );
    expect(getCacheMultiplier({ model: 'gpt-5.3-codex', cacheType: 'read' })).toBe(
      cacheTokenValues['gpt-5.3'].read,
    );
    expect(getCacheMultiplier({ model: 'openai/gpt-5.3', cacheType: 'write' })).toBe(
      cacheTokenValues['gpt-5.3'].write,
    );
  });

  it('should return null for pro models that do not support caching', () => {
    expect(getCacheMultiplier({ model: 'gpt-5-pro', cacheType: 'read' })).toBeNull();
    expect(getCacheMultiplier({ model: 'gpt-5-pro', cacheType: 'write' })).toBeNull();
    expect(getCacheMultiplier({ model: 'gpt-5.2-pro', cacheType: 'read' })).toBeNull();
    expect(getCacheMultiplier({ model: 'gpt-5.2-pro', cacheType: 'write' })).toBeNull();
    expect(getCacheMultiplier({ model: 'gpt-5.4-pro', cacheType: 'read' })).toBeNull();
    expect(getCacheMultiplier({ model: 'gpt-5.4-pro', cacheType: 'write' })).toBeNull();
  });

  it('should have consistent 10% cache read pricing for gpt-5.x models', () => {
    const gpt5CacheModels = [
      'gpt-5',
      'gpt-5.1',
      'gpt-5.2',
      'gpt-5.3',
      'gpt-5.4',
      'gpt-5-mini',
      'gpt-5-nano',
    ];
    for (const model of gpt5CacheModels) {
      expect(cacheTokenValues[model].read).toBeCloseTo(cacheTokenValues[model].write * 0.1, 10);
    }
  });

  it('should handle models with "bedrock/" prefix', () => {
    expect(
      getCacheMultiplier({
        model: 'bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0',
        cacheType: 'write',
      }),
    ).toBe(cacheTokenValues['claude-3-5-sonnet'].write);
    expect(
      getCacheMultiplier({
        model: 'bedrock/anthropic.claude-3-haiku-20240307-v1:0',
        cacheType: 'read',
      }),
    ).toBe(cacheTokenValues['claude-3-haiku'].read);
  });
});

describe('Google Model Tests', () => {
  const googleModels = [
    'gemini-3',
    'gemini-3.1-pro-preview',
    'gemini-3.1-pro-preview-customtools',
    'gemini-3.1-flash-lite-preview',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro-preview-05-06',
    'gemini-2.5-flash-preview-04-17',
    'gemini-2.5-exp',
    'gemini-2.0-flash-lite-preview-02-05',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-exp',
    'gemini-2.0-pro-exp-02-05',
    'gemini-1.5-flash-8b',
    'gemini-1.5-flash-thinking',
    'gemini-1.5-pro-latest',
    'gemini-1.5-pro-preview-0409',
    'gemini-pro-vision',
    'gemini-1.0',
    'gemini-pro',
  ];

  it('should return the correct prompt and completion rates for all models', () => {
    const results = googleModels.map((model) => {
      const valueKey = getValueKey(model, EModelEndpoint.google);
      const promptRate = getMultiplier({
        model,
        tokenType: 'prompt',
        endpoint: EModelEndpoint.google,
      });
      const completionRate = getMultiplier({
        model,
        tokenType: 'completion',
        endpoint: EModelEndpoint.google,
      });
      return { model, valueKey, promptRate, completionRate };
    });

    results.forEach(({ valueKey, promptRate, completionRate }) => {
      expect(promptRate).toBe(tokenValues[valueKey!].prompt);
      expect(completionRate).toBe(tokenValues[valueKey!].completion);
    });
  });

  it('should map to the correct model keys', () => {
    const expected = {
      'gemini-3': 'gemini-3',
      'gemini-3.1-pro-preview': 'gemini-3.1',
      'gemini-3.1-pro-preview-customtools': 'gemini-3.1',
      'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite',
      'gemini-3.8-flash': 'gemini-3.8-flash',
      'gemini-3.7-flash': 'gemini-3.7-flash',
      'gemini-3.6-flash': 'gemini-3.6-flash',
      'gemini-3.5-flash': 'gemini-3.5-flash',
      'gemini-3.5-flash-lite': 'gemini-3.5-flash-lite',
      'gemini-2.5-pro': 'gemini-2.5-pro',
      'gemini-2.5-flash': 'gemini-2.5-flash',
      'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
      'gemini-2.5-pro-preview-05-06': 'gemini-2.5-pro',
      'gemini-2.5-flash-preview-04-17': 'gemini-2.5-flash',
      'gemini-2.5-exp': 'gemini-2.5',
      'gemini-2.0-flash-lite-preview-02-05': 'gemini-2.0-flash-lite',
      'gemini-2.0-flash-001': 'gemini-2.0-flash',
      'gemini-2.0-flash-exp': 'gemini-2.0-flash',
      'gemini-2.0-pro-exp-02-05': 'gemini-2.0',
      'gemini-1.5-flash-8b': 'gemini-1.5-flash-8b',
      'gemini-1.5-flash-thinking': 'gemini-1.5-flash',
      'gemini-1.5-pro-latest': 'gemini-1.5',
      'gemini-1.5-pro-preview-0409': 'gemini-1.5',
      'gemini-pro-vision': 'gemini-pro-vision',
      'gemini-1.0': 'gemini',
      'gemini-pro': 'gemini',
    };

    Object.entries(expected).forEach(([model, expectedKey]) => {
      const valueKey = getValueKey(model, EModelEndpoint.google);
      expect(valueKey).toBe(expectedKey);
    });
  });

  it('should handle model names with different formats', () => {
    const testCases = [
      { input: 'google/gemini-pro', expected: 'gemini' },
      { input: 'gemini-pro/google', expected: 'gemini' },
      { input: 'google/gemini-2.0-flash-lite', expected: 'gemini-2.0-flash-lite' },
    ];

    testCases.forEach(({ input, expected }) => {
      const valueKey = getValueKey(input, EModelEndpoint.google);
      expect(valueKey).toBe(expected);
      expect(
        getMultiplier({ model: input, tokenType: 'prompt', endpoint: EModelEndpoint.google }),
      ).toBe(tokenValues[expected].prompt);
      expect(
        getMultiplier({ model: input, tokenType: 'completion', endpoint: EModelEndpoint.google }),
      ).toBe(tokenValues[expected].completion);
    });
  });

  it('should return correct prompt and completion rates for Gemini 3.1', () => {
    expect(
      getMultiplier({
        model: 'gemini-3.1-pro-preview',
        tokenType: 'prompt',
        endpoint: EModelEndpoint.google,
      }),
    ).toBe(tokenValues['gemini-3.1'].prompt);
    expect(
      getMultiplier({
        model: 'gemini-3.1-pro-preview',
        tokenType: 'completion',
        endpoint: EModelEndpoint.google,
      }),
    ).toBe(tokenValues['gemini-3.1'].completion);
    expect(
      getMultiplier({
        model: 'gemini-3.1-pro-preview-customtools',
        tokenType: 'prompt',
        endpoint: EModelEndpoint.google,
      }),
    ).toBe(tokenValues['gemini-3.1'].prompt);
    expect(
      getMultiplier({
        model: 'gemini-3.1-pro-preview-customtools',
        tokenType: 'completion',
        endpoint: EModelEndpoint.google,
      }),
    ).toBe(tokenValues['gemini-3.1'].completion);
  });

  it('should return correct cache rates for Gemini 3.1', () => {
    ['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools'].forEach((model) => {
      expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(
        cacheTokenValues['gemini-3.1'].write,
      );
      expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(
        cacheTokenValues['gemini-3.1'].read,
      );
    });
  });

  it('should return correct rates for Gemini 3.1 Flash-Lite', () => {
    const model = 'gemini-3.1-flash-lite-preview';
    expect(getMultiplier({ model, tokenType: 'prompt', endpoint: EModelEndpoint.google })).toBe(
      tokenValues['gemini-3.1-flash-lite'].prompt,
    );
    expect(getMultiplier({ model, tokenType: 'completion', endpoint: EModelEndpoint.google })).toBe(
      tokenValues['gemini-3.1-flash-lite'].completion,
    );
    expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(
      cacheTokenValues['gemini-3.1-flash-lite'].write,
    );
    expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(
      cacheTokenValues['gemini-3.1-flash-lite'].read,
    );
  });

  it('should return correct rates for Gemini 3.5 Flash', () => {
    const model = 'gemini-3.5-flash';
    expect(getMultiplier({ model, tokenType: 'prompt', endpoint: EModelEndpoint.google })).toBe(
      tokenValues['gemini-3.5-flash'].prompt,
    );
    expect(getMultiplier({ model, tokenType: 'completion', endpoint: EModelEndpoint.google })).toBe(
      tokenValues['gemini-3.5-flash'].completion,
    );
    expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(
      cacheTokenValues['gemini-3.5-flash'].write,
    );
    expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(
      cacheTokenValues['gemini-3.5-flash'].read,
    );
  });

  it('should return correct rates for Gemini 3.6 Flash', () => {
    const model = 'gemini-3.6-flash';
    expect(getMultiplier({ model, tokenType: 'prompt', endpoint: EModelEndpoint.google })).toBe(
      tokenValues['gemini-3.6-flash'].prompt,
    );
    expect(getMultiplier({ model, tokenType: 'completion', endpoint: EModelEndpoint.google })).toBe(
      tokenValues['gemini-3.6-flash'].completion,
    );
    expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(
      cacheTokenValues['gemini-3.6-flash'].write,
    );
    expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(
      cacheTokenValues['gemini-3.6-flash'].read,
    );
  });

  it('should return correct rates for Gemini 3.7 Flash', () => {
    const model = 'gemini-3.7-flash';
    expect(getMultiplier({ model, tokenType: 'prompt', endpoint: EModelEndpoint.google })).toBe(
      tokenValues['gemini-3.7-flash'].prompt,
    );
    expect(getMultiplier({ model, tokenType: 'completion', endpoint: EModelEndpoint.google })).toBe(
      tokenValues['gemini-3.7-flash'].completion,
    );
    expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(
      cacheTokenValues['gemini-3.7-flash'].write,
    );
    expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(
      cacheTokenValues['gemini-3.7-flash'].read,
    );
  });

  it('should return correct rates for Gemini 3.8 Flash', () => {
    const model = 'gemini-3.8-flash';
    expect(getMultiplier({ model, tokenType: 'prompt', endpoint: EModelEndpoint.google })).toBe(
      tokenValues['gemini-3.8-flash'].prompt,
    );
    expect(getMultiplier({ model, tokenType: 'completion', endpoint: EModelEndpoint.google })).toBe(
      tokenValues['gemini-3.8-flash'].completion,
    );
    expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(
      cacheTokenValues['gemini-3.8-flash'].write,
    );
    expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(
      cacheTokenValues['gemini-3.8-flash'].read,
    );
  });

  it('should apply the introductory Flash rates to Gemini 3.6, 3.7 and 3.8 Flash', () => {
    for (const model of ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash']) {
      expect(getMultiplier({ model, tokenType: 'prompt', endpoint: EModelEndpoint.google })).toBe(
        0.75,
      );
      expect(
        getMultiplier({ model, tokenType: 'completion', endpoint: EModelEndpoint.google }),
      ).toBe(3.75);
      expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(0.75);
      expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(0.075);
    }
  });

  it('should return correct rates for Gemini 3.5 Flash-Lite', () => {
    const model = 'gemini-3.5-flash-lite';
    expect(getMultiplier({ model, tokenType: 'prompt', endpoint: EModelEndpoint.google })).toBe(
      tokenValues['gemini-3.5-flash-lite'].prompt,
    );
    expect(getMultiplier({ model, tokenType: 'completion', endpoint: EModelEndpoint.google })).toBe(
      tokenValues['gemini-3.5-flash-lite'].completion,
    );
    expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(
      cacheTokenValues['gemini-3.5-flash-lite'].write,
    );
    expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(
      cacheTokenValues['gemini-3.5-flash-lite'].read,
    );
  });
});

describe('Gemini 3.1 Premium Token Pricing', () => {
  const premiumKey = 'gemini-3.1';
  const premiumEntry = premiumTokenValues[premiumKey];
  const { threshold } = premiumEntry;
  const belowThreshold = threshold - 1;
  const aboveThreshold = threshold + 1;
  const wellAboveThreshold = threshold * 2;

  it('should have premium pricing defined for gemini-3.1', () => {
    expect(premiumEntry).toBeDefined();
    expect(premiumEntry.threshold).toBeDefined();
    expect(premiumEntry.prompt).toBeDefined();
    expect(premiumEntry.completion).toBeDefined();
    expect(premiumEntry.prompt).toBeGreaterThan(tokenValues[premiumKey].prompt);
    expect(premiumEntry.completion).toBeGreaterThan(tokenValues[premiumKey].completion);
  });

  it('should return null from getPremiumRate when inputTokenCount is below or at threshold', () => {
    expect(getPremiumRate(premiumKey, 'prompt', belowThreshold)).toBeNull();
    expect(getPremiumRate(premiumKey, 'completion', belowThreshold)).toBeNull();
    expect(getPremiumRate(premiumKey, 'prompt', threshold)).toBeNull();
  });

  it('should return premium rate from getPremiumRate when inputTokenCount exceeds threshold', () => {
    expect(getPremiumRate(premiumKey, 'prompt', aboveThreshold)).toBe(premiumEntry.prompt);
    expect(getPremiumRate(premiumKey, 'completion', aboveThreshold)).toBe(premiumEntry.completion);
    expect(getPremiumRate(premiumKey, 'prompt', wellAboveThreshold)).toBe(premiumEntry.prompt);
  });

  it('should return null from getPremiumRate when inputTokenCount is undefined or null', () => {
    expect(getPremiumRate(premiumKey, 'prompt', undefined)).toBeNull();
    expect(getPremiumRate(premiumKey, 'prompt', null)).toBeNull();
  });

  it('should return standard rate from getMultiplier when inputTokenCount is below threshold', () => {
    expect(
      getMultiplier({
        model: 'gemini-3.1-pro-preview',
        tokenType: 'prompt',
        inputTokenCount: belowThreshold,
      }),
    ).toBe(tokenValues[premiumKey].prompt);
    expect(
      getMultiplier({
        model: 'gemini-3.1-pro-preview',
        tokenType: 'completion',
        inputTokenCount: belowThreshold,
      }),
    ).toBe(tokenValues[premiumKey].completion);
  });

  it('should return premium rate from getMultiplier when inputTokenCount exceeds threshold', () => {
    expect(
      getMultiplier({
        model: 'gemini-3.1-pro-preview',
        tokenType: 'prompt',
        inputTokenCount: aboveThreshold,
      }),
    ).toBe(premiumEntry.prompt);
    expect(
      getMultiplier({
        model: 'gemini-3.1-pro-preview',
        tokenType: 'completion',
        inputTokenCount: aboveThreshold,
      }),
    ).toBe(premiumEntry.completion);
  });

  it('should return standard rate from getMultiplier when inputTokenCount is exactly at threshold', () => {
    expect(
      getMultiplier({
        model: 'gemini-3.1-pro-preview',
        tokenType: 'prompt',
        inputTokenCount: threshold,
      }),
    ).toBe(tokenValues[premiumKey].prompt);
  });

  it('should apply premium pricing to customtools variant above threshold', () => {
    expect(
      getMultiplier({
        model: 'gemini-3.1-pro-preview-customtools',
        tokenType: 'prompt',
        inputTokenCount: aboveThreshold,
      }),
    ).toBe(premiumEntry.prompt);
    expect(
      getMultiplier({
        model: 'gemini-3.1-pro-preview-customtools',
        tokenType: 'completion',
        inputTokenCount: aboveThreshold,
      }),
    ).toBe(premiumEntry.completion);
  });

  it('should use standard rate when inputTokenCount is not provided', () => {
    expect(getMultiplier({ model: 'gemini-3.1-pro-preview', tokenType: 'prompt' })).toBe(
      tokenValues[premiumKey].prompt,
    );
    expect(getMultiplier({ model: 'gemini-3.1-pro-preview', tokenType: 'completion' })).toBe(
      tokenValues[premiumKey].completion,
    );
  });

  it('should apply premium pricing through getMultiplier with valueKey path', () => {
    const valueKey = getValueKey('gemini-3.1-pro-preview');
    expect(valueKey).toBe(premiumKey);
    expect(getMultiplier({ valueKey, tokenType: 'prompt', inputTokenCount: aboveThreshold })).toBe(
      premiumEntry.prompt,
    );
    expect(
      getMultiplier({ valueKey, tokenType: 'completion', inputTokenCount: aboveThreshold }),
    ).toBe(premiumEntry.completion);
  });

  it('should apply standard pricing through getMultiplier with valueKey path when below threshold', () => {
    const valueKey = getValueKey('gemini-3.1-pro-preview');
    expect(getMultiplier({ valueKey, tokenType: 'prompt', inputTokenCount: belowThreshold })).toBe(
      tokenValues[premiumKey].prompt,
    );
    expect(
      getMultiplier({ valueKey, tokenType: 'completion', inputTokenCount: belowThreshold }),
    ).toBe(tokenValues[premiumKey].completion);
  });
});

describe('Grok Model Tests - Pricing', () => {
  describe('getMultiplier', () => {
    test('should return correct prompt and completion rates for Grok vision models', () => {
      const models = ['grok-2-vision-1212', 'grok-2-vision', 'grok-2-vision-latest'];
      models.forEach((model) => {
        expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(
          tokenValues['grok-2-vision'].prompt,
        );
        expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
          tokenValues['grok-2-vision'].completion,
        );
      });
    });

    test('should return correct prompt and completion rates for Grok text models', () => {
      const models = ['grok-2-1212', 'grok-2', 'grok-2-latest'];
      models.forEach((model) => {
        expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(tokenValues['grok-2'].prompt);
        expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
          tokenValues['grok-2'].completion,
        );
      });
    });

    test('should return correct prompt and completion rates for Grok beta models', () => {
      expect(getMultiplier({ model: 'grok-vision-beta', tokenType: 'prompt' })).toBe(
        tokenValues['grok-vision-beta'].prompt,
      );
      expect(getMultiplier({ model: 'grok-vision-beta', tokenType: 'completion' })).toBe(
        tokenValues['grok-vision-beta'].completion,
      );
      expect(getMultiplier({ model: 'grok-beta', tokenType: 'prompt' })).toBe(
        tokenValues['grok-beta'].prompt,
      );
      expect(getMultiplier({ model: 'grok-beta', tokenType: 'completion' })).toBe(
        tokenValues['grok-beta'].completion,
      );
    });

    test('should return correct prompt and completion rates for Grok 3 models', () => {
      expect(getMultiplier({ model: 'grok-3', tokenType: 'prompt' })).toBe(
        tokenValues['grok-3'].prompt,
      );
      expect(getMultiplier({ model: 'grok-3', tokenType: 'completion' })).toBe(
        tokenValues['grok-3'].completion,
      );
      expect(getMultiplier({ model: 'grok-3-fast', tokenType: 'prompt' })).toBe(
        tokenValues['grok-3-fast'].prompt,
      );
      expect(getMultiplier({ model: 'grok-3-fast', tokenType: 'completion' })).toBe(
        tokenValues['grok-3-fast'].completion,
      );
      expect(getMultiplier({ model: 'grok-3-mini', tokenType: 'prompt' })).toBe(
        tokenValues['grok-3-mini'].prompt,
      );
      expect(getMultiplier({ model: 'grok-3-mini', tokenType: 'completion' })).toBe(
        tokenValues['grok-3-mini'].completion,
      );
      expect(getMultiplier({ model: 'grok-3-mini-fast', tokenType: 'prompt' })).toBe(
        tokenValues['grok-3-mini-fast'].prompt,
      );
      expect(getMultiplier({ model: 'grok-3-mini-fast', tokenType: 'completion' })).toBe(
        tokenValues['grok-3-mini-fast'].completion,
      );
    });

    test('should return correct prompt and completion rates for Grok 4 model', () => {
      expect(getMultiplier({ model: 'grok-4-0709', tokenType: 'prompt' })).toBe(
        tokenValues['grok-4'].prompt,
      );
      expect(getMultiplier({ model: 'grok-4-0709', tokenType: 'completion' })).toBe(
        tokenValues['grok-4'].completion,
      );
    });

    test('should return correct prompt and completion rates for Grok 4 Fast model', () => {
      expect(getMultiplier({ model: 'grok-4-fast', tokenType: 'prompt' })).toBe(
        tokenValues['grok-4-fast'].prompt,
      );
      expect(getMultiplier({ model: 'grok-4-fast', tokenType: 'completion' })).toBe(
        tokenValues['grok-4-fast'].completion,
      );
    });

    test('should return correct prompt and completion rates for Grok 4.1 Fast models', () => {
      expect(getMultiplier({ model: 'grok-4-1-fast-reasoning', tokenType: 'prompt' })).toBe(
        tokenValues['grok-4-1-fast'].prompt,
      );
      expect(getMultiplier({ model: 'grok-4-1-fast-reasoning', tokenType: 'completion' })).toBe(
        tokenValues['grok-4-1-fast'].completion,
      );
      expect(getMultiplier({ model: 'grok-4-1-fast-non-reasoning', tokenType: 'prompt' })).toBe(
        tokenValues['grok-4-1-fast'].prompt,
      );
      expect(getMultiplier({ model: 'grok-4-1-fast-non-reasoning', tokenType: 'completion' })).toBe(
        tokenValues['grok-4-1-fast'].completion,
      );
    });

    test('should return correct prompt and completion rates for Grok Code Fast model', () => {
      expect(getMultiplier({ model: 'grok-code-fast-1', tokenType: 'prompt' })).toBe(
        tokenValues['grok-code-fast'].prompt,
      );
      expect(getMultiplier({ model: 'grok-code-fast-1', tokenType: 'completion' })).toBe(
        tokenValues['grok-code-fast'].completion,
      );
    });

    test('should return correct prompt and completion rates for Grok 3 models with prefixes', () => {
      expect(getMultiplier({ model: 'xai/grok-3', tokenType: 'prompt' })).toBe(
        tokenValues['grok-3'].prompt,
      );
      expect(getMultiplier({ model: 'xai/grok-3', tokenType: 'completion' })).toBe(
        tokenValues['grok-3'].completion,
      );
      expect(getMultiplier({ model: 'xai/grok-3-fast', tokenType: 'prompt' })).toBe(
        tokenValues['grok-3-fast'].prompt,
      );
      expect(getMultiplier({ model: 'xai/grok-3-fast', tokenType: 'completion' })).toBe(
        tokenValues['grok-3-fast'].completion,
      );
      expect(getMultiplier({ model: 'xai/grok-3-mini', tokenType: 'prompt' })).toBe(
        tokenValues['grok-3-mini'].prompt,
      );
      expect(getMultiplier({ model: 'xai/grok-3-mini', tokenType: 'completion' })).toBe(
        tokenValues['grok-3-mini'].completion,
      );
      expect(getMultiplier({ model: 'xai/grok-3-mini-fast', tokenType: 'prompt' })).toBe(
        tokenValues['grok-3-mini-fast'].prompt,
      );
      expect(getMultiplier({ model: 'xai/grok-3-mini-fast', tokenType: 'completion' })).toBe(
        tokenValues['grok-3-mini-fast'].completion,
      );
    });

    test('should return correct prompt and completion rates for Grok 4 model with prefixes', () => {
      expect(getMultiplier({ model: 'xai/grok-4-0709', tokenType: 'prompt' })).toBe(
        tokenValues['grok-4'].prompt,
      );
      expect(getMultiplier({ model: 'xai/grok-4-0709', tokenType: 'completion' })).toBe(
        tokenValues['grok-4'].completion,
      );
    });

    test('should return correct prompt and completion rates for Grok 4 Fast model with prefixes', () => {
      expect(getMultiplier({ model: 'xai/grok-4-fast', tokenType: 'prompt' })).toBe(
        tokenValues['grok-4-fast'].prompt,
      );
      expect(getMultiplier({ model: 'xai/grok-4-fast', tokenType: 'completion' })).toBe(
        tokenValues['grok-4-fast'].completion,
      );
    });

    test('should return correct prompt and completion rates for Grok 4.1 Fast models with prefixes', () => {
      expect(getMultiplier({ model: 'xai/grok-4-1-fast-reasoning', tokenType: 'prompt' })).toBe(
        tokenValues['grok-4-1-fast'].prompt,
      );
      expect(getMultiplier({ model: 'xai/grok-4-1-fast-reasoning', tokenType: 'completion' })).toBe(
        tokenValues['grok-4-1-fast'].completion,
      );
      expect(getMultiplier({ model: 'xai/grok-4-1-fast-non-reasoning', tokenType: 'prompt' })).toBe(
        tokenValues['grok-4-1-fast'].prompt,
      );
      expect(
        getMultiplier({ model: 'xai/grok-4-1-fast-non-reasoning', tokenType: 'completion' }),
      ).toBe(tokenValues['grok-4-1-fast'].completion);
    });

    test('should return correct prompt and completion rates for Grok Code Fast model with prefixes', () => {
      expect(getMultiplier({ model: 'xai/grok-code-fast-1', tokenType: 'prompt' })).toBe(
        tokenValues['grok-code-fast'].prompt,
      );
      expect(getMultiplier({ model: 'xai/grok-code-fast-1', tokenType: 'completion' })).toBe(
        tokenValues['grok-code-fast'].completion,
      );
    });
  });
});

describe('GLM Model Tests', () => {
  it('should return expected value keys for GLM models', () => {
    expect(getValueKey('glm-4.6')).toBe('glm-4.6');
    expect(getValueKey('glm-4.5')).toBe('glm-4.5');
    expect(getValueKey('glm-4.5v')).toBe('glm-4.5v');
    expect(getValueKey('glm-4.5-air')).toBe('glm-4.5-air');
    expect(getValueKey('glm-4-32b')).toBe('glm-4-32b');
    expect(getValueKey('glm-4')).toBe('glm-4');
    expect(getValueKey('glm4')).toBe('glm4');
  });

  it('should match GLM model variations with provider prefixes', () => {
    expect(getValueKey('z-ai/glm-4.6')).toBe('glm-4.6');
    expect(getValueKey('z-ai/glm-4.5')).toBe('glm-4.5');
    expect(getValueKey('z-ai/glm-4.5-air')).toBe('glm-4.5-air');
    expect(getValueKey('z-ai/glm-4.5v')).toBe('glm-4.5v');
    expect(getValueKey('z-ai/glm-4-32b')).toBe('glm-4-32b');

    expect(getValueKey('zai/glm-4.6')).toBe('glm-4.6');
    expect(getValueKey('zai/glm-4.5')).toBe('glm-4.5');
    expect(getValueKey('zai/glm-4.5-air')).toBe('glm-4.5-air');
    expect(getValueKey('zai/glm-4.5v')).toBe('glm-4.5v');

    expect(getValueKey('zai-org/GLM-4.6')).toBe('glm-4.6');
    expect(getValueKey('zai-org/GLM-4.5')).toBe('glm-4.5');
    expect(getValueKey('zai-org/GLM-4.5-Air')).toBe('glm-4.5-air');
    expect(getValueKey('zai-org/GLM-4.5V')).toBe('glm-4.5v');
    expect(getValueKey('zai-org/GLM-4-32B-0414')).toBe('glm-4-32b');
  });

  it('should match GLM model variations with suffixes', () => {
    expect(getValueKey('glm-4.6-fp8')).toBe('glm-4.6');
    expect(getValueKey('zai-org/GLM-4.6-FP8')).toBe('glm-4.6');
    expect(getValueKey('zai-org/GLM-4.5-Air-FP8')).toBe('glm-4.5-air');
  });

  it('should prioritize more specific GLM model patterns', () => {
    expect(getValueKey('glm-4.5-air-something')).toBe('glm-4.5-air');
    expect(getValueKey('glm-4.5-something')).toBe('glm-4.5');
    expect(getValueKey('glm-4.5v-something')).toBe('glm-4.5v');
  });

  it('should return correct multipliers for all GLM models', () => {
    expect(getMultiplier({ model: 'glm-4.6', tokenType: 'prompt' })).toBe(
      tokenValues['glm-4.6'].prompt,
    );
    expect(getMultiplier({ model: 'glm-4.6', tokenType: 'completion' })).toBe(
      tokenValues['glm-4.6'].completion,
    );

    expect(getMultiplier({ model: 'glm-4.5v', tokenType: 'prompt' })).toBe(
      tokenValues['glm-4.5v'].prompt,
    );
    expect(getMultiplier({ model: 'glm-4.5v', tokenType: 'completion' })).toBe(
      tokenValues['glm-4.5v'].completion,
    );

    expect(getMultiplier({ model: 'glm-4.5-air', tokenType: 'prompt' })).toBe(
      tokenValues['glm-4.5-air'].prompt,
    );
    expect(getMultiplier({ model: 'glm-4.5-air', tokenType: 'completion' })).toBe(
      tokenValues['glm-4.5-air'].completion,
    );

    expect(getMultiplier({ model: 'glm-4.5', tokenType: 'prompt' })).toBe(
      tokenValues['glm-4.5'].prompt,
    );
    expect(getMultiplier({ model: 'glm-4.5', tokenType: 'completion' })).toBe(
      tokenValues['glm-4.5'].completion,
    );

    expect(getMultiplier({ model: 'glm-4-32b', tokenType: 'prompt' })).toBe(
      tokenValues['glm-4-32b'].prompt,
    );
    expect(getMultiplier({ model: 'glm-4-32b', tokenType: 'completion' })).toBe(
      tokenValues['glm-4-32b'].completion,
    );

    expect(getMultiplier({ model: 'glm-4', tokenType: 'prompt' })).toBe(
      tokenValues['glm-4'].prompt,
    );
    expect(getMultiplier({ model: 'glm-4', tokenType: 'completion' })).toBe(
      tokenValues['glm-4'].completion,
    );

    expect(getMultiplier({ model: 'glm4', tokenType: 'prompt' })).toBe(tokenValues['glm4'].prompt);
    expect(getMultiplier({ model: 'glm4', tokenType: 'completion' })).toBe(
      tokenValues['glm4'].completion,
    );
  });

  it('should return correct multipliers for GLM models with provider prefixes', () => {
    expect(getMultiplier({ model: 'z-ai/glm-4.6', tokenType: 'prompt' })).toBe(
      tokenValues['glm-4.6'].prompt,
    );
    expect(getMultiplier({ model: 'zai/glm-4.5-air', tokenType: 'completion' })).toBe(
      tokenValues['glm-4.5-air'].completion,
    );
    expect(getMultiplier({ model: 'zai-org/GLM-4.5V', tokenType: 'prompt' })).toBe(
      tokenValues['glm-4.5v'].prompt,
    );
  });
});

describe('Claude Model Tests', () => {
  it('should return correct prompt and completion rates for Claude 4 models', () => {
    expect(getMultiplier({ model: 'claude-sonnet-4', tokenType: 'prompt' })).toBe(
      tokenValues['claude-sonnet-4'].prompt,
    );
    expect(getMultiplier({ model: 'claude-sonnet-4', tokenType: 'completion' })).toBe(
      tokenValues['claude-sonnet-4'].completion,
    );
    expect(getMultiplier({ model: 'claude-opus-4', tokenType: 'prompt' })).toBe(
      tokenValues['claude-opus-4'].prompt,
    );
    expect(getMultiplier({ model: 'claude-opus-4', tokenType: 'completion' })).toBe(
      tokenValues['claude-opus-4'].completion,
    );
  });

  it('should return correct prompt and completion rates for Claude Haiku 4.5', () => {
    expect(getMultiplier({ model: 'claude-haiku-4-5', tokenType: 'prompt' })).toBe(
      tokenValues['claude-haiku-4-5'].prompt,
    );
    expect(getMultiplier({ model: 'claude-haiku-4-5', tokenType: 'completion' })).toBe(
      tokenValues['claude-haiku-4-5'].completion,
    );
  });

  it('should return correct prompt and completion rates for Claude Opus 4.5', () => {
    expect(getMultiplier({ model: 'claude-opus-4-5', tokenType: 'prompt' })).toBe(
      tokenValues['claude-opus-4-5'].prompt,
    );
    expect(getMultiplier({ model: 'claude-opus-4-5', tokenType: 'completion' })).toBe(
      tokenValues['claude-opus-4-5'].completion,
    );
  });

  it('should handle Claude Haiku 4.5 model name variations', () => {
    const modelVariations = [
      'claude-haiku-4-5',
      'claude-haiku-4-5-20250420',
      'claude-haiku-4-5-latest',
      'anthropic/claude-haiku-4-5',
      'claude-haiku-4-5/anthropic',
      'claude-haiku-4-5-preview',
    ];

    modelVariations.forEach((model) => {
      const valueKey = getValueKey(model);
      expect(valueKey).toBe('claude-haiku-4-5');
      expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(
        tokenValues['claude-haiku-4-5'].prompt,
      );
      expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
        tokenValues['claude-haiku-4-5'].completion,
      );
    });
  });

  it('should handle Claude Opus 4.5 model name variations', () => {
    const modelVariations = [
      'claude-opus-4-5',
      'claude-opus-4-5-20250420',
      'claude-opus-4-5-latest',
      'anthropic/claude-opus-4-5',
      'claude-opus-4-5/anthropic',
      'claude-opus-4-5-preview',
    ];

    modelVariations.forEach((model) => {
      const valueKey = getValueKey(model);
      expect(valueKey).toBe('claude-opus-4-5');
      expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(
        tokenValues['claude-opus-4-5'].prompt,
      );
      expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
        tokenValues['claude-opus-4-5'].completion,
      );
    });
  });

  it('should handle Claude 4 model name variations with different prefixes and suffixes', () => {
    const modelVariations = [
      'claude-sonnet-4',
      'claude-sonnet-4-20240229',
      'claude-sonnet-4-latest',
      'anthropic/claude-sonnet-4',
      'claude-sonnet-4/anthropic',
      'claude-sonnet-4-preview',
      'claude-sonnet-4-20240229-preview',
      'claude-opus-4',
      'claude-opus-4-20240229',
      'claude-opus-4-latest',
      'anthropic/claude-opus-4',
      'claude-opus-4/anthropic',
      'claude-opus-4-preview',
      'claude-opus-4-20240229-preview',
    ];

    modelVariations.forEach((model) => {
      const valueKey = getValueKey(model);
      const isSonnet = model.includes('sonnet');
      const expectedKey = isSonnet ? 'claude-sonnet-4' : 'claude-opus-4';

      expect(valueKey).toBe(expectedKey);
      expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(tokenValues[expectedKey].prompt);
      expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
        tokenValues[expectedKey].completion,
      );
    });
  });

  it('should return correct cache rates for Claude 4 models', () => {
    expect(getCacheMultiplier({ model: 'claude-sonnet-4', cacheType: 'write' })).toBe(
      cacheTokenValues['claude-sonnet-4'].write,
    );
    expect(getCacheMultiplier({ model: 'claude-sonnet-4', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-sonnet-4'].read,
    );
    expect(getCacheMultiplier({ model: 'claude-opus-4', cacheType: 'write' })).toBe(
      cacheTokenValues['claude-opus-4'].write,
    );
    expect(getCacheMultiplier({ model: 'claude-opus-4', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-opus-4'].read,
    );
  });

  it('should return correct cache rates for Claude Opus 4.5', () => {
    expect(getCacheMultiplier({ model: 'claude-opus-4-5', cacheType: 'write' })).toBe(
      cacheTokenValues['claude-opus-4-5'].write,
    );
    expect(getCacheMultiplier({ model: 'claude-opus-4-5', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-opus-4-5'].read,
    );
  });

  it('should handle Claude 4 model cache rates with different prefixes and suffixes', () => {
    const modelVariations = [
      'claude-sonnet-4',
      'claude-sonnet-4-20240229',
      'claude-sonnet-4-latest',
      'anthropic/claude-sonnet-4',
      'claude-sonnet-4/anthropic',
      'claude-sonnet-4-preview',
      'claude-sonnet-4-20240229-preview',
      'claude-opus-4',
      'claude-opus-4-20240229',
      'claude-opus-4-latest',
      'anthropic/claude-opus-4',
      'claude-opus-4/anthropic',
      'claude-opus-4-preview',
      'claude-opus-4-20240229-preview',
    ];

    modelVariations.forEach((model) => {
      const isSonnet = model.includes('sonnet');
      const expectedKey = isSonnet ? 'claude-sonnet-4' : 'claude-opus-4';

      expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(
        cacheTokenValues[expectedKey].write,
      );
      expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(
        cacheTokenValues[expectedKey].read,
      );
    });
  });

  it('should return correct prompt and completion rates for Claude Opus 4.6', () => {
    expect(getMultiplier({ model: 'claude-opus-4-6', tokenType: 'prompt' })).toBe(
      tokenValues['claude-opus-4-6'].prompt,
    );
    expect(getMultiplier({ model: 'claude-opus-4-6', tokenType: 'completion' })).toBe(
      tokenValues['claude-opus-4-6'].completion,
    );
  });

  it('should handle Claude Opus 4.6 model name variations', () => {
    const modelVariations = [
      'claude-opus-4-6',
      'claude-opus-4-6-20250801',
      'claude-opus-4-6-latest',
      'anthropic/claude-opus-4-6',
      'claude-opus-4-6/anthropic',
      'claude-opus-4-6-preview',
    ];

    modelVariations.forEach((model) => {
      const valueKey = getValueKey(model);
      expect(valueKey).toBe('claude-opus-4-6');
      expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(
        tokenValues['claude-opus-4-6'].prompt,
      );
      expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
        tokenValues['claude-opus-4-6'].completion,
      );
    });
  });

  it('should return correct cache rates for Claude Opus 4.6', () => {
    expect(getCacheMultiplier({ model: 'claude-opus-4-6', cacheType: 'write' })).toBe(
      cacheTokenValues['claude-opus-4-6'].write,
    );
    expect(getCacheMultiplier({ model: 'claude-opus-4-6', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-opus-4-6'].read,
    );
  });

  it('should handle Claude Opus 4.6 cache rates with model name variations', () => {
    const modelVariations = [
      'claude-opus-4-6',
      'claude-opus-4-6-20250801',
      'claude-opus-4-6-latest',
      'anthropic/claude-opus-4-6',
      'claude-opus-4-6/anthropic',
      'claude-opus-4-6-preview',
    ];

    modelVariations.forEach((model) => {
      expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(
        cacheTokenValues['claude-opus-4-6'].write,
      );
      expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(
        cacheTokenValues['claude-opus-4-6'].read,
      );
    });
  });

  it('should return correct prompt and completion rates for Claude Opus 4.7', () => {
    expect(getMultiplier({ model: 'claude-opus-4-7', tokenType: 'prompt' })).toBe(
      tokenValues['claude-opus-4-7'].prompt,
    );
    expect(getMultiplier({ model: 'claude-opus-4-7', tokenType: 'completion' })).toBe(
      tokenValues['claude-opus-4-7'].completion,
    );
  });

  it('should handle Claude Opus 4.7 model name variations', () => {
    const modelVariations = [
      'claude-opus-4-7',
      'claude-opus-4-7-20260401',
      'claude-opus-4-7-latest',
      'anthropic/claude-opus-4-7',
      'claude-opus-4-7/anthropic',
      'claude-opus-4-7-preview',
    ];

    modelVariations.forEach((model) => {
      const valueKey = getValueKey(model);
      expect(valueKey).toBe('claude-opus-4-7');
      expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(
        tokenValues['claude-opus-4-7'].prompt,
      );
      expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
        tokenValues['claude-opus-4-7'].completion,
      );
    });
  });

  it('should return correct cache rates for Claude Opus 4.7', () => {
    expect(getCacheMultiplier({ model: 'claude-opus-4-7', cacheType: 'write' })).toBe(
      cacheTokenValues['claude-opus-4-7'].write,
    );
    expect(getCacheMultiplier({ model: 'claude-opus-4-7', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-opus-4-7'].read,
    );
  });

  it('should return correct prompt and completion rates for Claude Opus 4.8', () => {
    expect(getMultiplier({ model: 'claude-opus-4-8', tokenType: 'prompt' })).toBe(
      tokenValues['claude-opus-4-8'].prompt,
    );
    expect(getMultiplier({ model: 'claude-opus-4-8', tokenType: 'completion' })).toBe(
      tokenValues['claude-opus-4-8'].completion,
    );
  });

  it('should handle Claude Opus 4.8 model name variations', () => {
    const modelVariations = [
      'claude-opus-4-8',
      'claude-opus-4-8-20260528',
      'claude-opus-4-8-latest',
      'anthropic/claude-opus-4-8',
      'claude-opus-4-8/anthropic',
      'claude-opus-4-8-preview',
    ];

    modelVariations.forEach((model) => {
      const valueKey = getValueKey(model);
      expect(valueKey).toBe('claude-opus-4-8');
      expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(
        tokenValues['claude-opus-4-8'].prompt,
      );
      expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
        tokenValues['claude-opus-4-8'].completion,
      );
    });
  });

  it('should return correct cache rates for Claude Opus 4.8', () => {
    expect(getCacheMultiplier({ model: 'claude-opus-4-8', cacheType: 'write' })).toBe(
      cacheTokenValues['claude-opus-4-8'].write,
    );
    expect(getCacheMultiplier({ model: 'claude-opus-4-8', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-opus-4-8'].read,
    );
  });

  it('should return correct prompt and completion rates for Claude Opus 5', () => {
    expect(getMultiplier({ model: 'claude-opus-5', tokenType: 'prompt' })).toBe(
      tokenValues['claude-opus-5'].prompt,
    );
    expect(getMultiplier({ model: 'claude-opus-5', tokenType: 'completion' })).toBe(
      tokenValues['claude-opus-5'].completion,
    );
  });

  it('should handle Claude Opus 5 model name variations', () => {
    const modelVariations = [
      'claude-opus-5',
      'claude-opus-5-20260701',
      'claude-opus-5-latest',
      'anthropic/claude-opus-5',
      'claude-opus-5/anthropic',
      'claude-opus-5-preview',
    ];

    modelVariations.forEach((model) => {
      const valueKey = getValueKey(model);
      expect(valueKey).toBe('claude-opus-5');
      expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(
        tokenValues['claude-opus-5'].prompt,
      );
      expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
        tokenValues['claude-opus-5'].completion,
      );
    });
  });

  it('should not confuse Claude Opus 5 with Claude Opus 4.5', () => {
    expect(getValueKey('claude-opus-5')).toBe('claude-opus-5');
    expect(getValueKey('claude-opus-4-5')).toBe('claude-opus-4-5');
  });

  it('should return correct cache rates for Claude Opus 5', () => {
    expect(getCacheMultiplier({ model: 'claude-opus-5', cacheType: 'write' })).toBe(
      cacheTokenValues['claude-opus-5'].write,
    );
    expect(getCacheMultiplier({ model: 'claude-opus-5', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-opus-5'].read,
    );
  });

  it('should price Bedrock cross-region inference profile IDs like their base model', () => {
    const profileToBase: Array<[string, string]> = [
      ['global.anthropic.claude-opus-5', 'claude-opus-5'],
      ['us.anthropic.claude-opus-5', 'claude-opus-5'],
      ['global.anthropic.claude-opus-4-8', 'claude-opus-4-8'],
      ['global.anthropic.claude-sonnet-5', 'claude-sonnet-5'],
      ['global.anthropic.claude-sonnet-4-6', 'claude-sonnet-4-6'],
      ['global.anthropic.claude-fable-5', 'claude-fable-5'],
    ];

    profileToBase.forEach(([profileId, base]) => {
      expect(getValueKey(profileId)).toBe(base);
      expect(getMultiplier({ model: profileId, tokenType: 'prompt' })).toBe(
        tokenValues[base].prompt,
      );
      expect(getMultiplier({ model: profileId, tokenType: 'completion' })).toBe(
        tokenValues[base].completion,
      );
      expect(getCacheMultiplier({ model: profileId, cacheType: 'write' })).toBe(
        cacheTokenValues[base].write,
      );
    });
  });

  it('should return correct prompt and completion rates for Claude Fable 5', () => {
    expect(getMultiplier({ model: 'claude-fable-5', tokenType: 'prompt' })).toBe(
      tokenValues['claude-fable-5'].prompt,
    );
    expect(getMultiplier({ model: 'claude-fable-5', tokenType: 'completion' })).toBe(
      tokenValues['claude-fable-5'].completion,
    );
  });

  it('should pin Claude Fable 5 pricing to $10 / $50 per MTok', () => {
    expect(tokenValues['claude-fable-5']).toEqual({ prompt: 10, completion: 50 });
  });

  it('should handle Claude Fable 5 model name variations', () => {
    const modelVariations = [
      'claude-fable-5',
      'claude-fable-5-20260609',
      'claude-fable-5-latest',
      'anthropic/claude-fable-5',
      'claude-fable-5/anthropic',
      'anthropic.claude-fable-5',
    ];

    modelVariations.forEach((model) => {
      const valueKey = getValueKey(model);
      expect(valueKey).toBe('claude-fable-5');
      expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(
        tokenValues['claude-fable-5'].prompt,
      );
      expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
        tokenValues['claude-fable-5'].completion,
      );
    });
  });

  it('should return correct cache rates for Claude Fable 5', () => {
    expect(getCacheMultiplier({ model: 'claude-fable-5', cacheType: 'write' })).toBe(
      cacheTokenValues['claude-fable-5'].write,
    );
    expect(getCacheMultiplier({ model: 'claude-fable-5', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-fable-5'].read,
    );
  });

  it('should return correct prompt and completion rates for Claude Mythos 5', () => {
    expect(getMultiplier({ model: 'claude-mythos-5', tokenType: 'prompt' })).toBe(
      tokenValues['claude-mythos-5'].prompt,
    );
    expect(getMultiplier({ model: 'claude-mythos-5', tokenType: 'completion' })).toBe(
      tokenValues['claude-mythos-5'].completion,
    );
  });

  it('should pin Claude Mythos 5 pricing to $10 / $50 per MTok', () => {
    expect(tokenValues['claude-mythos-5']).toEqual({ prompt: 10, completion: 50 });
  });

  it('should handle Claude Mythos 5 model name variations', () => {
    const modelVariations = [
      'claude-mythos-5',
      'claude-mythos-5-20260609',
      'claude-mythos-5-latest',
      'anthropic/claude-mythos-5',
      'claude-mythos-5/anthropic',
      'anthropic.claude-mythos-5',
    ];

    modelVariations.forEach((model) => {
      const valueKey = getValueKey(model);
      expect(valueKey).toBe('claude-mythos-5');
      expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(
        tokenValues['claude-mythos-5'].prompt,
      );
      expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
        tokenValues['claude-mythos-5'].completion,
      );
    });
  });

  it('should return correct cache rates for Claude Mythos 5', () => {
    expect(getCacheMultiplier({ model: 'claude-mythos-5', cacheType: 'write' })).toBe(
      cacheTokenValues['claude-mythos-5'].write,
    );
    expect(getCacheMultiplier({ model: 'claude-mythos-5', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-mythos-5'].read,
    );
  });

  it('should pin Claude Fable 5.1 pricing to $10 / $50 per MTok', () => {
    expect(tokenValues['claude-fable-5-1']).toEqual({ prompt: 10, completion: 50 });
    expect(tokenValues['claude-mythos-5-1']).toEqual({ prompt: 10, completion: 50 });
  });

  it('should charge Claude Fable 5.1 cache reads at a quarter of the Fable 5 rate', () => {
    expect(cacheTokenValues['claude-fable-5-1']).toEqual({ write: 12.5, read: 0.25 });
    expect(cacheTokenValues['claude-mythos-5-1']).toEqual({ write: 12.5, read: 0.25 });
    expect(getCacheMultiplier({ model: 'claude-fable-5-1', cacheType: 'read' })).toBe(0.25);
    expect(getCacheMultiplier({ model: 'claude-fable-5-1', cacheType: 'write' })).toBe(12.5);
    expect(getCacheMultiplier({ model: 'claude-fable-5', cacheType: 'read' })).toBe(1);
  });

  it('should handle Claude Fable 5.1 model name variations without collapsing to Fable 5', () => {
    const modelVariations = [
      'claude-fable-5-1',
      'claude-fable-5-1-20260901',
      'claude-fable-5-1-latest',
      'anthropic/claude-fable-5-1',
      'claude-fable-5-1/anthropic',
      'anthropic.claude-fable-5-1',
      'global.anthropic.claude-fable-5-1',
    ];

    modelVariations.forEach((model) => {
      expect(getValueKey(model)).toBe('claude-fable-5-1');
      expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(0.25);
    });

    expect(getValueKey('claude-fable-5-20260609')).toBe('claude-fable-5');
  });

  it('should return correct prompt and completion rates for Claude Sonnet 5', () => {
    expect(getMultiplier({ model: 'claude-sonnet-5', tokenType: 'prompt' })).toBe(
      tokenValues['claude-sonnet-5'].prompt,
    );
    expect(getMultiplier({ model: 'claude-sonnet-5', tokenType: 'completion' })).toBe(
      tokenValues['claude-sonnet-5'].completion,
    );
  });

  it('should pin Claude Sonnet 5 to introductory $2 / $10 per MTok (through 2026-08-31)', () => {
    expect(tokenValues['claude-sonnet-5']).toEqual({ prompt: 2, completion: 10 });
  });

  it('should apply introductory cache rates ($2.50 / $0.20) for Claude Sonnet 5', () => {
    expect(cacheTokenValues['claude-sonnet-5']).toEqual({ write: 2.5, read: 0.2 });
  });

  it('should handle Claude Sonnet 5 model name variations without matching Sonnet 4', () => {
    const modelVariations = [
      'claude-sonnet-5',
      'claude-sonnet-5-20260101',
      'claude-sonnet-5-latest',
      'anthropic/claude-sonnet-5',
      'claude-sonnet-5/anthropic',
      'anthropic.claude-sonnet-5',
    ];

    modelVariations.forEach((model) => {
      const valueKey = getValueKey(model);
      expect(valueKey).toBe('claude-sonnet-5');
      expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(
        tokenValues['claude-sonnet-5'].prompt,
      );
      expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
        tokenValues['claude-sonnet-5'].completion,
      );
    });
  });

  it('should return correct cache rates for Claude Sonnet 5', () => {
    expect(getCacheMultiplier({ model: 'claude-sonnet-5', cacheType: 'write' })).toBe(
      cacheTokenValues['claude-sonnet-5'].write,
    );
    expect(getCacheMultiplier({ model: 'claude-sonnet-5', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-sonnet-5'].read,
    );
  });
});

describe('Premium Token Pricing', () => {
  const premiumModel = 'gemini-3.1';
  const premiumEntry = premiumTokenValues[premiumModel];
  const { threshold } = premiumEntry;
  const belowThreshold = threshold - 1;
  const aboveThreshold = threshold + 1;
  const wellAboveThreshold = threshold * 2;

  it('should have premium pricing defined for gemini-3.1', () => {
    expect(premiumEntry).toBeDefined();
    expect(premiumEntry.threshold).toBeDefined();
    expect(premiumEntry.prompt).toBeDefined();
    expect(premiumEntry.completion).toBeDefined();
    expect(premiumEntry.prompt).toBeGreaterThan(tokenValues[premiumModel].prompt);
    expect(premiumEntry.completion).toBeGreaterThan(tokenValues[premiumModel].completion);
  });

  it('should not apply premium pricing to Claude 1M GA models', () => {
    const claudeModels = [
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
    ];
    claudeModels.forEach((model) => {
      expect(premiumTokenValues[model]).toBeUndefined();
      expect(getPremiumRate(model, 'prompt', wellAboveThreshold)).toBeNull();
      expect(
        getMultiplier({
          model,
          tokenType: 'prompt',
          inputTokenCount: wellAboveThreshold,
        }),
      ).toBe(tokenValues[model].prompt);
      expect(
        getMultiplier({
          model,
          tokenType: 'completion',
          inputTokenCount: wellAboveThreshold,
        }),
      ).toBe(tokenValues[model].completion);
    });
  });

  it('should return null from getPremiumRate when inputTokenCount is below threshold', () => {
    expect(getPremiumRate(premiumModel, 'prompt', belowThreshold)).toBeNull();
    expect(getPremiumRate(premiumModel, 'completion', belowThreshold)).toBeNull();
    expect(getPremiumRate(premiumModel, 'prompt', threshold)).toBeNull();
  });

  it('should return premium rate from getPremiumRate when inputTokenCount exceeds threshold', () => {
    expect(getPremiumRate(premiumModel, 'prompt', aboveThreshold)).toBe(premiumEntry.prompt);
    expect(getPremiumRate(premiumModel, 'completion', aboveThreshold)).toBe(
      premiumEntry.completion,
    );
    expect(getPremiumRate(premiumModel, 'prompt', wellAboveThreshold)).toBe(premiumEntry.prompt);
  });

  it('should return null from getPremiumRate when inputTokenCount is undefined or null', () => {
    expect(getPremiumRate(premiumModel, 'prompt', undefined)).toBeNull();
    expect(getPremiumRate(premiumModel, 'prompt', undefined)).toBeNull();
  });

  it('should return null from getPremiumRate for models without premium pricing', () => {
    expect(getPremiumRate('claude-opus-4-5', 'prompt', wellAboveThreshold)).toBeNull();
    expect(getPremiumRate('claude-sonnet-4', 'prompt', wellAboveThreshold)).toBeNull();
    expect(getPremiumRate('gpt-4o', 'prompt', wellAboveThreshold)).toBeNull();
  });

  it('should return standard rate from getMultiplier when inputTokenCount is below threshold', () => {
    expect(
      getMultiplier({
        model: premiumModel,
        tokenType: 'prompt',
        inputTokenCount: belowThreshold,
      }),
    ).toBe(tokenValues[premiumModel].prompt);
    expect(
      getMultiplier({
        model: premiumModel,
        tokenType: 'completion',
        inputTokenCount: belowThreshold,
      }),
    ).toBe(tokenValues[premiumModel].completion);
  });

  it('should return premium rate from getMultiplier when inputTokenCount exceeds threshold', () => {
    expect(
      getMultiplier({
        model: premiumModel,
        tokenType: 'prompt',
        inputTokenCount: aboveThreshold,
      }),
    ).toBe(premiumEntry.prompt);
    expect(
      getMultiplier({
        model: premiumModel,
        tokenType: 'completion',
        inputTokenCount: aboveThreshold,
      }),
    ).toBe(premiumEntry.completion);
  });

  it('should return standard rate from getMultiplier when inputTokenCount is exactly at threshold', () => {
    expect(
      getMultiplier({ model: premiumModel, tokenType: 'prompt', inputTokenCount: threshold }),
    ).toBe(tokenValues[premiumModel].prompt);
  });

  it('should return premium rate from getMultiplier when inputTokenCount is one above threshold', () => {
    expect(
      getMultiplier({ model: premiumModel, tokenType: 'prompt', inputTokenCount: aboveThreshold }),
    ).toBe(premiumEntry.prompt);
  });

  it('should not apply premium pricing to models without premium entries', () => {
    expect(
      getMultiplier({
        model: 'claude-opus-4-5',
        tokenType: 'prompt',
        inputTokenCount: wellAboveThreshold,
      }),
    ).toBe(tokenValues['claude-opus-4-5'].prompt);
    expect(
      getMultiplier({
        model: 'claude-sonnet-4',
        tokenType: 'prompt',
        inputTokenCount: wellAboveThreshold,
      }),
    ).toBe(tokenValues['claude-sonnet-4'].prompt);
  });

  it('should use standard rate when inputTokenCount is not provided', () => {
    expect(getMultiplier({ model: premiumModel, tokenType: 'prompt' })).toBe(
      tokenValues[premiumModel].prompt,
    );
    expect(getMultiplier({ model: premiumModel, tokenType: 'completion' })).toBe(
      tokenValues[premiumModel].completion,
    );
  });

  it('should apply premium pricing through getMultiplier with valueKey path', () => {
    const valueKey = getValueKey(premiumModel);
    expect(getMultiplier({ valueKey, tokenType: 'prompt', inputTokenCount: aboveThreshold })).toBe(
      premiumEntry.prompt,
    );
    expect(
      getMultiplier({ valueKey, tokenType: 'completion', inputTokenCount: aboveThreshold }),
    ).toBe(premiumEntry.completion);
  });

  it('should apply standard pricing through getMultiplier with valueKey path when below threshold', () => {
    const valueKey = getValueKey(premiumModel);
    expect(getMultiplier({ valueKey, tokenType: 'prompt', inputTokenCount: belowThreshold })).toBe(
      tokenValues[premiumModel].prompt,
    );
    expect(
      getMultiplier({ valueKey, tokenType: 'completion', inputTokenCount: belowThreshold }),
    ).toBe(tokenValues[premiumModel].completion);
  });
});

describe('GPT-5.6 Long-Context Premium Pricing', () => {
  const tiers = ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'];

  it('should define a premium entry above standard rates for every tier', () => {
    for (const model of tiers) {
      const premiumEntry = premiumTokenValues[model];
      expect(premiumEntry).toBeDefined();
      expect(premiumEntry.threshold).toBe(272000);
      expect(premiumEntry.prompt).toBeCloseTo(tokenValues[model].prompt * 2);
      expect(premiumEntry.completion).toBeCloseTo(tokenValues[model].completion * 1.5);
    }
  });

  it('should bill standard rates at or below threshold and premium rates above', () => {
    for (const model of tiers) {
      const { threshold, prompt, completion } = premiumTokenValues[model];
      expect(getMultiplier({ model, tokenType: 'prompt', inputTokenCount: threshold })).toBe(
        tokenValues[model].prompt,
      );
      expect(getMultiplier({ model, tokenType: 'prompt', inputTokenCount: threshold + 1 })).toBe(
        prompt,
      );
      expect(
        getMultiplier({ model, tokenType: 'completion', inputTokenCount: threshold + 1 }),
      ).toBe(completion);
    }
  });
});

describe('Long-Context Premium Cache Pricing', () => {
  const premiumCacheModels = Object.keys(premiumCacheTokenValues);

  it('should scale cache write/read by the same long-context multiplier as input', () => {
    for (const model of premiumCacheModels) {
      const inputRatio = premiumTokenValues[model].prompt / tokenValues[model].prompt;
      expect(premiumCacheTokenValues[model].write).toBeCloseTo(
        cacheTokenValues[model].write * inputRatio,
      );
      expect(premiumCacheTokenValues[model].read).toBeCloseTo(
        cacheTokenValues[model].read * inputRatio,
      );
    }
  });

  it('should return premium cache rates above threshold and standard rates at/below', () => {
    for (const model of premiumCacheModels) {
      const { threshold } = premiumCacheTokenValues[model];
      for (const cacheType of ['write', 'read'] as const) {
        expect(getCacheMultiplier({ model, cacheType, inputTokenCount: threshold + 1 })).toBe(
          premiumCacheTokenValues[model][cacheType],
        );
        expect(getCacheMultiplier({ model, cacheType, inputTokenCount: threshold })).toBe(
          cacheTokenValues[model][cacheType],
        );
        expect(getCacheMultiplier({ model, cacheType })).toBe(cacheTokenValues[model][cacheType]);
      }
    }
  });

  it('should not apply premium cache rates to models without a premium cache entry', () => {
    for (const model of ['gpt-5-mini', 'gpt-5.4-mini', 'gpt-4o']) {
      expect(premiumCacheTokenValues[model]).toBeUndefined();
      expect(getCacheMultiplier({ model, cacheType: 'read', inputTokenCount: 5_000_000 })).toBe(
        getCacheMultiplier({ model, cacheType: 'read' }),
      );
    }
  });
});

describe('Newer model pricing', () => {
  const newlyPriced = [
    'llama4-scout',
    'llama-4-maverick',
    'muse-spark-1.1',
    'musespark',
    'muse-glimmer-30b',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'kimi-k3',
    'glm-4.7',
    'glm-4.7-flash',
    'glm-5.1',
    'glm-5.2',
    'grok-4.5',
    'grok-4.6',
    'ministral-8b-2512',
    'ministral-14b-2512',
    'nova-2-lite',
    'command-a',
    'minimax-m2.7',
    'minimax-m3',
    'qwen3-coder-next',
  ];

  it.each(newlyPriced)('bills %s at its own rate rather than the default', (model) => {
    const valueKey = getValueKey(model);
    expect(valueKey).toBe(model);
    expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(tokenValues[model].prompt);
    expect(getMultiplier({ model, tokenType: 'completion' })).toBe(tokenValues[model].completion);
    expect(getMultiplier({ model, tokenType: 'prompt' })).not.toBe(defaultRate);
  });

  it('keeps the preceding generation on its own rate', () => {
    for (const model of [
      'grok-4',
      'grok-4-fast',
      'ministral-8b',
      'qwen3-coder',
      'command-r-plus',
    ]) {
      expect(getValueKey(model)).toBe(model);
      expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(tokenValues[model].prompt);
    }
  });

  it('resolves dated and vendor-prefixed variants to the same rate', () => {
    expect(getMultiplier({ model: 'moonshotai/kimi-k3', tokenType: 'completion' })).toBe(
      tokenValues['kimi-k3'].completion,
    );
    expect(getMultiplier({ model: 'x-ai/grok-4-6', tokenType: 'prompt' })).toBe(
      tokenValues['grok-4-6'].prompt,
    );
    expect(getMultiplier({ model: 'command-a-plus-05-2026', tokenType: 'prompt' })).toBe(
      tokenValues['command-a'].prompt,
    );
  });
});

describe('dot-prefixed Kimi K3 aliases', () => {
  it('bills both bedrock forms at the K3 rate rather than an older Kimi row', () => {
    for (const model of ['moonshot.kimi-k3', 'moonshotai.kimi-k3']) {
      expect(getMultiplier({ model, tokenType: 'completion' })).toBe(
        tokenValues['kimi-k3'].completion,
      );
      expect(getMultiplier({ model, tokenType: 'completion' })).not.toBe(
        tokenValues['moonshot.kimi'].completion,
      );
      expect(getMultiplier({ model, tokenType: 'completion' })).not.toBe(
        tokenValues['moonshot'].completion,
      );
    }
  });
});

describe('Grok long-context premium tier', () => {
  it('doubles the rate once a prompt passes the 200K threshold', () => {
    for (const model of ['grok-4.5', 'grok-4.6']) {
      const { threshold } = premiumTokenValues[model];
      expect(getMultiplier({ model, tokenType: 'prompt', inputTokenCount: threshold })).toBe(
        tokenValues[model].prompt,
      );
      expect(getMultiplier({ model, tokenType: 'prompt', inputTokenCount: threshold + 1 })).toBe(
        premiumTokenValues[model].prompt,
      );
      expect(
        getMultiplier({ model, tokenType: 'completion', inputTokenCount: threshold + 1 }),
      ).toBe(premiumTokenValues[model].completion);
    }
  });
});

describe('vendor-prefixed pricing keys', () => {
  it('prices the model segment rather than the vendor prefix', () => {
    expect(getValueKey('moonshotai/kimi-k2')).toBe('kimi-k2');
    expect(getMultiplier({ model: 'moonshotai/kimi-k2', tokenType: 'prompt' })).toBe(
      tokenValues['kimi-k2'].prompt,
    );
    expect(getMultiplier({ model: 'moonshotai/kimi-k2', tokenType: 'prompt' })).not.toBe(
      tokenValues['moonshot'].prompt,
    );
  });
});

// Cross-package sync validation tests (tokens.ts ↔ tx.ts) moved to
// packages/api tests since they require maxTokensMap from @librechat/api.

describe('Grok 4.7 pricing', () => {
  it.each(['grok-4.7', 'x-ai/grok-4.7', 'xai/grok-4.7', 'grok-4-7'])(
    'bills %s at standard and inclusive long-context rates',
    (model) => {
      const key = model.split('/').pop()!;
      for (const inputTokenCount of [199999, 200000, 200001, 500000]) {
        const rates = inputTokenCount < 200000 ? tokenValues[key] : premiumTokenValues[key];
        const cache =
          inputTokenCount < 200000 ? cacheTokenValues[key] : premiumCacheTokenValues[key];
        expect(getMultiplier({ model, tokenType: 'prompt', inputTokenCount })).toBe(rates.prompt);
        expect(getMultiplier({ model, tokenType: 'completion', inputTokenCount })).toBe(
          rates.completion,
        );
        expect(getCacheMultiplier({ model, cacheType: 'read', inputTokenCount })).toBe(cache.read);
        expect(getCacheMultiplier({ model, cacheType: 'write', inputTokenCount })).toBe(
          cache.write,
        );
      }
    },
  );

  it('preserves explicit operator billing overrides', () => {
    const model = 'grok-4.7';
    const endpointTokenConfig = { [model]: { prompt: 3, completion: 7, read: 0.75, write: 3 } };
    expect(
      getMultiplier({ model, tokenType: 'prompt', inputTokenCount: 200000, endpointTokenConfig }),
    ).toBe(endpointTokenConfig[model].prompt);
    expect(
      getCacheMultiplier({
        model,
        cacheType: 'read',
        inputTokenCount: 200000,
        endpointTokenConfig,
      }),
    ).toBe(endpointTokenConfig[model].read);
  });
});

describe('Opus 5.5 pricing', () => {
  it.each([
    'claude-opus-5-5',
    'claude-opus-5.5',
    'anthropic/claude-opus-5-5',
    'global.anthropic.claude-opus-5-5',
  ])('prices %s independently of Opus 5, without a long-context surcharge', (model) => {
    const key = model.includes('5.5') ? 'claude-opus-5.5' : 'claude-opus-5-5';
    for (const inputTokenCount of [1000, 200000, 1000000]) {
      expect(getMultiplier({ model, tokenType: 'prompt', inputTokenCount })).toBe(
        tokenValues[key].prompt,
      );
      expect(getMultiplier({ model, tokenType: 'completion', inputTokenCount })).toBe(
        tokenValues[key].completion,
      );
      expect(getCacheMultiplier({ model, cacheType: 'write', inputTokenCount })).toBe(
        cacheTokenValues[key].write,
      );
      expect(getCacheMultiplier({ model, cacheType: 'read', inputTokenCount })).toBe(
        cacheTokenValues[key].read,
      );
    }
    expect(tokenValues[key].prompt).toBeLessThan(tokenValues['claude-opus-5'].prompt);
    expect(cacheTokenValues[key].read).toBeLessThan(cacheTokenValues['claude-opus-5'].read);
  });
});

describe.each([
  ['gpt-6-sol', 2, 0.2, 2.5, 10],
  ['gpt-6-luna', 0.1, 0.01, 0.125, 0.5],
] as const)('%s published pricing', (model, input, read, write, output) => {
  it.each([272000, 272001])(
    'applies full-request rates at %i total input tokens',
    (inputTokenCount) => {
      const premium = inputTokenCount > 272000;
      for (const name of [model, `${model}-2026-09-22`, `openai/${model}`]) {
        expect(getValueKey(name)).toBe(model);
        expect(getMultiplier({ model: name, tokenType: 'prompt', inputTokenCount })).toBeCloseTo(
          input * (premium ? 2 : 1),
        );
        expect(
          getMultiplier({ model: name, tokenType: 'completion', inputTokenCount }),
        ).toBeCloseTo(output * (premium ? 1.5 : 1));
        expect(getCacheMultiplier({ model: name, cacheType: 'read', inputTokenCount })).toBeCloseTo(
          read * (premium ? 2 : 1),
        );
        expect(
          getCacheMultiplier({ model: name, cacheType: 'write', inputTokenCount }),
        ).toBeCloseTo(write * (premium ? 2 : 1));
      }
    },
  );
});
