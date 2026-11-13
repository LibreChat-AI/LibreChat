import { defaultModels } from '../src/config';
import { EModelEndpoint, anthropicSettings } from '../src/schemas';
import {
  supportsContext1m,
  supportsPromptCache,
  hasAlwaysOnThinking,
  bindsThinkingBlocks,
  omitsSamplingParameters,
  supportsAdaptiveThinking,
  resolveThinkingDisplay,
} from '../src/bedrock';

describe('Claude Fable 5.2', () => {
  it('offers the new release without removing Fable 5.1', () => {
    expect(defaultModels[EModelEndpoint.anthropic]).toContain('claude-fable-5-2');
    expect(defaultModels[EModelEndpoint.anthropic]).toContain('claude-fable-5-1');
  });

  it.each(['claude-fable-5-2', 'anthropic/claude-fable-5-2'])(
    'uses the modern Claude capability profile for %s',
    (model) => {
      expect(supportsContext1m(model)).toBe(true);
      expect(supportsPromptCache(model)).toBe(true);
      expect(hasAlwaysOnThinking(model)).toBe(true);
      expect(bindsThinkingBlocks(model)).toBe(true);
      expect(supportsAdaptiveThinking(model)).toBe(true);
      expect(omitsSamplingParameters(model)).toBe(true);
      expect(resolveThinkingDisplay(model)).toBe('summarized');
      expect(anthropicSettings.maxOutputTokens.reset(model)).toBe(128000);
      expect(anthropicSettings.maxOutputTokens.set(200000, model)).toBe(128000);
    },
  );
});
