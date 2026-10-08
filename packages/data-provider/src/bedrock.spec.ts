import { supportsContext1m, supportsPromptCache } from './bedrock';

describe('Claude capability helpers', () => {
  it('recognizes the 1M context window for future Sonnet and Opus model IDs', () => {
    expect(supportsContext1m('claude-sonnet-6')).toBe(true);
    expect(supportsContext1m('claude-opus-6')).toBe(true);
    expect(supportsContext1m('claude-haiku-4')).toBe(false);
  });

  it('uses raw model IDs to resolve prompt-cache support', () => {
    expect(supportsPromptCache('claude-sonnet-6')).toBe(true);
    expect(supportsPromptCache('claude-3-5-sonnet-latest')).toBe(false);
  });
});
