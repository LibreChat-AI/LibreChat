import { gpt6Tier, gptPointReleaseFamily } from './families';

describe('gptPointReleaseFamily', () => {
  it.each([
    ['gpt-6.1-sol', 'gpt-6-sol'],
    ['GPT-6.1-Sol', 'GPT-6-Sol'],
    ['gpt-6.1-sol-2026-10-01', 'gpt-6-sol-2026-10-01'],
    ['gpt-6.2-astra', 'gpt-6-astra'],
    ['openai/gpt-6.1-luna', 'openai/gpt-6-luna'],
    ['us.openai.gpt-6.1-sol', 'us.openai.gpt-6-sol'],
    ['gpt-7.3-sol', 'gpt-7-sol'],
  ])('maps %s to its family %s', (model, family) => {
    expect(gptPointReleaseFamily(model)).toBe(family);
  });

  it.each([
    'gpt-6-sol',
    'gpt-5.6',
    'gpt-6.1',
    'chatgpt-4o-latest',
    'mygpt-6.1-sol',
    'claude-opus-5-5',
  ])('leaves %s alone', (model) => {
    expect(gptPointReleaseFamily(model)).toBeUndefined();
  });
});

describe('gpt6Tier', () => {
  it.each([
    ['gpt-6-sol', 'sol'],
    ['gpt-6.1-sol', 'sol'],
    ['GPT-6.1-SOL-2026-10-01', 'sol'],
    ['gpt-6-luna-2026-09-22', 'luna'],
    ['gpt-6.2-astra', 'astra'],
  ])('reads the tier of %s', (model, tier) => {
    expect(gpt6Tier(model)).toBe(tier);
  });

  it.each([undefined, null, '', 'gpt-6-solar', 'gpt-60-sol', 'gpt-5.6-luna', 'openai/gpt-6-sol'])(
    'has no tier for %p',
    (model) => {
      expect(gpt6Tier(model)).toBeUndefined();
    },
  );
});
