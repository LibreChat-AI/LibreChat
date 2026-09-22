import {
  AnthropicEffort,
  ReasoningEffort,
  ReasoningMode,
  ReasoningContext,
  googleSettings,
  anthropicSettings,
  compactGoogleSchema,
  tMessageSchema,
  eAnthropicEffortSchema,
  eReasoningEffortSchema,
  eReasoningModeSchema,
  eReasoningContextSchema,
  reasoningOverrideSchema,
  subagentThreadLineageSchema,
  getGoogleThinkingBudgetBounds,
  tPresetSchema,
} from './schemas';

describe('reasoningOverrideSchema', () => {
  it.each([
    { key: 'reasoning_effort', value: ReasoningEffort.high },
    { key: 'effort', value: AnthropicEffort.medium },
    { key: 'thinkingLevel', value: 'low' },
    { key: 'thinkingBudget', value: -1 },
    { key: 'thinkingBudget', value: 32768 },
    { key: 'thinkingBudget', value: 500000 },
  ])('accepts a supported request-scoped override: %o', (override) => {
    expect(reasoningOverrideSchema.parse(override)).toEqual(override);
  });

  it.each([
    { key: 'temperature', value: 1 },
    { key: 'reasoning_effort', value: 'turbo' },
    { key: 'effort', value: 'none' },
    { key: 'thinkingLevel', value: 'max' },
    { key: 'thinkingBudget', value: 1.5 },
    { key: 'thinkingBudget', value: -2 },
    { key: 'thinkingBudget', value: 1000, extra: true },
  ])('rejects an invalid request-scoped override: %o', (override) => {
    expect(reasoningOverrideSchema.safeParse(override).success).toBe(false);
  });
});

describe('anthropicSettings', () => {
  describe('maxOutputTokens.reset()', () => {
    const { reset } = anthropicSettings.maxOutputTokens;

    describe('Claude Sonnet 4/4.5 models (64K limit)', () => {
      it('should return 64K for claude-sonnet-4', () => {
        expect(reset('claude-sonnet-4')).toBe(64000);
      });

      it('should return 64K for claude-sonnet-4-5', () => {
        expect(reset('claude-sonnet-4-5')).toBe(64000);
      });

      it('should return 64K for dated claude-sonnet-4', () => {
        expect(reset('claude-sonnet-4-20250514')).toBe(64000);
      });
    });

    describe('Claude Sonnet 4.6+ models (128K limit)', () => {
      it('should return 128K for claude-sonnet-4-6', () => {
        expect(reset('claude-sonnet-4-6')).toBe(128000);
      });

      it('should return 128K for claude-sonnet-4.6', () => {
        expect(reset('claude-sonnet-4.6')).toBe(128000);
      });

      it('should return 128K for claude-sonnet-4-7', () => {
        expect(reset('claude-sonnet-4-7')).toBe(128000);
      });

      it('should return 128K for claude-sonnet-4-9', () => {
        expect(reset('claude-sonnet-4-9')).toBe(128000);
      });

      it('should return 128K for double-digit claude-sonnet-4 minors', () => {
        expect(reset('claude-sonnet-4-10')).toBe(128000);
        expect(reset('claude-sonnet-4.10')).toBe(128000);
      });
    });

    describe('Claude Sonnet 5+ models (128K limit)', () => {
      it('should return 128K for claude-sonnet-5', () => {
        expect(reset('claude-sonnet-5')).toBe(128000);
      });

      it('should return 128K for future versions like claude-sonnet-9', () => {
        expect(reset('claude-sonnet-9')).toBe(128000);
      });

      it('should return 128K for double-digit minor versions like claude-sonnet-5-10', () => {
        expect(reset('claude-sonnet-5-10')).toBe(128000);
      });
    });

    describe('Claude Haiku models', () => {
      it('should return 64K for claude-haiku-4-5', () => {
        expect(reset('claude-haiku-4-5')).toBe(64000);
      });

      it('should return 64K for claude-haiku-4', () => {
        expect(reset('claude-haiku-4')).toBe(64000);
      });

      it('should return 64K for claude-haiku-5', () => {
        expect(reset('claude-haiku-5')).toBe(64000);
      });

      it('should return 64K for future versions like claude-haiku-9', () => {
        expect(reset('claude-haiku-9')).toBe(64000);
      });
    });

    describe('Claude Opus 4.0-4.4 models (32K limit)', () => {
      it('should return 32K for claude-opus-4', () => {
        expect(reset('claude-opus-4')).toBe(32000);
      });

      it('should return 32K for claude-opus-4-0', () => {
        expect(reset('claude-opus-4-0')).toBe(32000);
      });

      it('should return 32K for claude-opus-4-1', () => {
        expect(reset('claude-opus-4-1')).toBe(32000);
      });

      it('should return 32K for claude-opus-4-2', () => {
        expect(reset('claude-opus-4-2')).toBe(32000);
      });

      it('should return 32K for claude-opus-4-3', () => {
        expect(reset('claude-opus-4-3')).toBe(32000);
      });

      it('should return 32K for claude-opus-4-4', () => {
        expect(reset('claude-opus-4-4')).toBe(32000);
      });

      it('should return 32K for claude-opus-4.0', () => {
        expect(reset('claude-opus-4.0')).toBe(32000);
      });

      it('should return 32K for claude-opus-4.1', () => {
        expect(reset('claude-opus-4.1')).toBe(32000);
      });
    });

    describe('Claude Opus 4.5 models (64K limit)', () => {
      it('should return 64K for claude-opus-4-5', () => {
        expect(reset('claude-opus-4-5')).toBe(64000);
      });

      it('should return 64K for claude-opus-4.5', () => {
        expect(reset('claude-opus-4.5')).toBe(64000);
      });
    });

    describe('Claude Opus 4.6+ models (128K limit - future-proof)', () => {
      it('should return 128K for claude-opus-4-6', () => {
        expect(reset('claude-opus-4-6')).toBe(128000);
      });

      it('should return 128K for claude-opus-4.6', () => {
        expect(reset('claude-opus-4.6')).toBe(128000);
      });

      it('should return 128K for claude-opus-4-7', () => {
        expect(reset('claude-opus-4-7')).toBe(128000);
      });

      it('should return 128K for claude-opus-4-8', () => {
        expect(reset('claude-opus-4-8')).toBe(128000);
      });

      it('should return 128K for claude-opus-4-9', () => {
        expect(reset('claude-opus-4-9')).toBe(128000);
      });
    });

    describe('Claude Opus 4.10+ models (double-digit minor versions)', () => {
      it('should return 128K for claude-opus-4-10', () => {
        expect(reset('claude-opus-4-10')).toBe(128000);
      });

      it('should return 128K for claude-opus-4-11', () => {
        expect(reset('claude-opus-4-11')).toBe(128000);
      });

      it('should return 128K for claude-opus-4-15', () => {
        expect(reset('claude-opus-4-15')).toBe(128000);
      });

      it('should return 128K for claude-opus-4-20', () => {
        expect(reset('claude-opus-4-20')).toBe(128000);
      });

      it('should return 128K for claude-opus-4.10', () => {
        expect(reset('claude-opus-4.10')).toBe(128000);
      });
    });

    describe('Claude Opus 5+ models (future major versions)', () => {
      it('should return 128K for claude-opus-5', () => {
        expect(reset('claude-opus-5')).toBe(128000);
      });

      it('should return 128K for claude-opus-6', () => {
        expect(reset('claude-opus-6')).toBe(128000);
      });

      it('should return 128K for claude-opus-7', () => {
        expect(reset('claude-opus-7')).toBe(128000);
      });

      it('should return 128K for claude-opus-9', () => {
        expect(reset('claude-opus-9')).toBe(128000);
      });

      it('should return 128K for claude-opus-5-0', () => {
        expect(reset('claude-opus-5-0')).toBe(128000);
      });

      it('should return 128K for claude-opus-5.0', () => {
        expect(reset('claude-opus-5.0')).toBe(128000);
      });
    });

    describe('Model name variations with dates and suffixes', () => {
      it('should return 64K for claude-opus-4-5-20250420', () => {
        expect(reset('claude-opus-4-5-20250420')).toBe(64000);
      });

      it('should return 128K for claude-opus-4-6-20260101', () => {
        expect(reset('claude-opus-4-6-20260101')).toBe(128000);
      });

      it('should return 32K for claude-opus-4-1-20250805', () => {
        expect(reset('claude-opus-4-1-20250805')).toBe(32000);
      });

      it('should return 32K for claude-opus-4-0-20240229', () => {
        expect(reset('claude-opus-4-0-20240229')).toBe(32000);
      });
    });

    describe('Legacy Claude models', () => {
      it('should return 8192 for claude-3-opus', () => {
        expect(reset('claude-3-opus')).toBe(8192);
      });

      it('should return 8192 for claude-3-5-sonnet', () => {
        expect(reset('claude-3-5-sonnet')).toBe(8192);
      });

      it('should return 8192 for claude-3-5-haiku', () => {
        expect(reset('claude-3-5-haiku')).toBe(8192);
      });

      it('should return 8192 for claude-3-7-sonnet', () => {
        expect(reset('claude-3-7-sonnet')).toBe(8192);
      });

      it('should return 8192 for claude-2', () => {
        expect(reset('claude-2')).toBe(8192);
      });

      it('should return 8192 for claude-2.1', () => {
        expect(reset('claude-2.1')).toBe(8192);
      });

      it('should return 8192 for claude-instant', () => {
        expect(reset('claude-instant')).toBe(8192);
      });
    });

    describe('Non-Claude models and edge cases', () => {
      it('should return 8192 for unknown model', () => {
        expect(reset('unknown-model')).toBe(8192);
      });

      it('should return 8192 for empty string', () => {
        expect(reset('')).toBe(8192);
      });

      it('should return 8192 for gpt-4', () => {
        expect(reset('gpt-4')).toBe(8192);
      });

      it('should return 8192 for gemini-pro', () => {
        expect(reset('gemini-pro')).toBe(8192);
      });
    });

    describe('Regex pattern edge cases', () => {
      it('should not match claude-opus-3', () => {
        expect(reset('claude-opus-3')).toBe(8192);
      });

      it('should not match opus-4-5 without claude prefix', () => {
        expect(reset('opus-4-5')).toBe(8192);
      });

      it('should NOT match claude.opus.4.5 (incorrect separator pattern)', () => {
        // Model names use hyphens after "claude", not dots
        expect(reset('claude.opus.4.5')).toBe(8192);
      });

      it('should match claude-opus45 (no separator after opus)', () => {
        // The regex allows optional separators, so "45" can follow directly
        // "45" is treated as major version 45 (>= 5), so it gets 128K
        expect(reset('claude-opus45')).toBe(128000);
      });
    });
  });

  describe('maxOutputTokens.set()', () => {
    const { set } = anthropicSettings.maxOutputTokens;

    describe('Claude Sonnet 4/4.5 and Haiku 4+ models (64K cap)', () => {
      it('should cap at 64K for claude-sonnet-4 when value exceeds', () => {
        expect(set(100000, 'claude-sonnet-4')).toBe(64000);
      });

      it('should cap at 64K for dated claude-sonnet-4 when value exceeds', () => {
        expect(set(100000, 'claude-sonnet-4-20250514')).toBe(64000);
      });

      it('should allow 50K for claude-sonnet-4', () => {
        expect(set(50000, 'claude-sonnet-4')).toBe(50000);
      });

      it('should cap at 64K for claude-haiku-4-5 when value exceeds', () => {
        expect(set(80000, 'claude-haiku-4-5')).toBe(64000);
      });
    });

    describe('Claude Sonnet 4.6+ models (128K cap)', () => {
      it('should allow 100K for claude-sonnet-4-6', () => {
        expect(set(100000, 'claude-sonnet-4-6')).toBe(100000);
      });

      it('should cap at 128K for claude-sonnet-4-6 when value exceeds', () => {
        expect(set(150000, 'claude-sonnet-4-6')).toBe(128000);
      });

      it('should allow 100K for claude-sonnet-4.6', () => {
        expect(set(100000, 'claude-sonnet-4.6')).toBe(100000);
      });

      it('should cap at 128K for claude-sonnet-4.6 when value exceeds', () => {
        expect(set(150000, 'claude-sonnet-4.6')).toBe(128000);
      });

      it('should cap at 128K for double-digit claude-sonnet-4 minors', () => {
        expect(set(100000, 'claude-sonnet-4-10')).toBe(100000);
        expect(set(150000, 'claude-sonnet-4.10')).toBe(128000);
      });

      it('should allow 100K for claude-sonnet-5', () => {
        expect(set(100000, 'claude-sonnet-5')).toBe(100000);
      });

      it('should cap at 128K for claude-sonnet-5 when value exceeds', () => {
        expect(set(150000, 'claude-sonnet-5')).toBe(128000);
      });

      it('should cap at 128K for future versions like claude-sonnet-9', () => {
        expect(set(150000, 'claude-sonnet-9')).toBe(128000);
      });
    });

    describe('Claude Opus 4.5+ models (64K cap)', () => {
      it('should cap at 64K for claude-opus-4-5 when value exceeds', () => {
        expect(set(100000, 'claude-opus-4-5')).toBe(64000);
      });

      it('should cap at model-specific 64K limit, not global 128K limit', () => {
        // Values between 64K and 128K should be capped at 64K (model limit)
        // This verifies the fix for the unreachable code issue
        expect(set(70000, 'claude-opus-4-5')).toBe(64000);
        expect(set(80000, 'claude-opus-4-5')).toBe(64000);
        expect(set(100000, 'claude-opus-4-5')).toBe(64000);
        expect(set(128000, 'claude-opus-4-5')).toBe(64000);

        // Values above 128K should also be capped at 64K (not 128K)
        expect(set(150000, 'claude-opus-4-5')).toBe(64000);
      });

      it('should allow 50K for claude-opus-4-5', () => {
        expect(set(50000, 'claude-opus-4-5')).toBe(50000);
      });

      it('should allow 80K for claude-opus-4-6 (128K cap)', () => {
        expect(set(80000, 'claude-opus-4-6')).toBe(80000);
      });

      it('should cap at 128K for claude-opus-4-6', () => {
        expect(set(150000, 'claude-opus-4-6')).toBe(128000);
      });

      it('should cap at 128K for claude-opus-5', () => {
        expect(set(150000, 'claude-opus-5')).toBe(128000);
      });

      it('should allow 100K for claude-opus-5', () => {
        expect(set(100000, 'claude-opus-5')).toBe(100000);
      });

      it('should cap at 128K for claude-opus-4-10', () => {
        expect(set(150000, 'claude-opus-4-10')).toBe(128000);
      });

      it('should allow 100K for claude-opus-4-10', () => {
        expect(set(100000, 'claude-opus-4-10')).toBe(100000);
      });
    });

    describe('Claude Opus 4.0-4.4 models (32K cap)', () => {
      it('should cap at 32K for claude-opus-4', () => {
        expect(set(50000, 'claude-opus-4')).toBe(32000);
      });

      it('should allow 20K for claude-opus-4', () => {
        expect(set(20000, 'claude-opus-4')).toBe(20000);
      });

      it('should cap at 32K for claude-opus-4-1', () => {
        expect(set(50000, 'claude-opus-4-1')).toBe(32000);
      });

      it('should cap at 32K for claude-opus-4-4', () => {
        expect(set(40000, 'claude-opus-4-4')).toBe(32000);
      });
    });

    describe('Global 128K cap for all models', () => {
      it('should cap at model-specific limit first, then global', () => {
        // claude-sonnet-4 has 64K limit, so caps at 64K not 128K
        expect(set(150000, 'claude-sonnet-4')).toBe(64000);
      });

      it('should cap at 128K for claude-3 models', () => {
        expect(set(150000, 'claude-3-opus')).toBe(128000);
      });

      it('should cap at 128K for unknown models', () => {
        expect(set(200000, 'unknown-model')).toBe(128000);
      });
    });

    describe('Valid values within limits', () => {
      it('should allow valid values for legacy models', () => {
        expect(set(8000, 'claude-3-opus')).toBe(8000);
      });

      it('should allow 1 token minimum', () => {
        expect(set(1, 'claude-opus-4-5')).toBe(1);
      });

      it('should allow 128K exactly', () => {
        expect(set(128000, 'claude-3-opus')).toBe(128000);
      });
    });
  });
});

describe('googleSettings', () => {
  describe('maxOutputTokens.reset()', () => {
    const { reset } = googleSettings.maxOutputTokens;

    describe('current Gemini text models (64K, Vertex-safe)', () => {
      it.each([
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.5-pro-preview-05-06',
        'gemini-3',
        'gemini-3-pro',
        'gemini-3.1',
        'gemini-3.1-flash-lite',
        'gemini-3.5-flash',
        'models/gemini-3.5-flash',
        'gemini-4-pro',
        'gemini-10-flash',
      ])('returns 65535 for %s', (model) => {
        expect(reset(model)).toBe(65535);
      });
    });

    describe('Gemini image models (32K)', () => {
      it.each(['gemini-2.5-flash-image', 'gemini-3-pro-image'])('returns 32768 for %s', (model) => {
        expect(reset(model)).toBe(32768);
      });
    });

    describe('legacy/deprecated Gemini and Gemma models (8K)', () => {
      it.each([
        'gemini',
        'gemini-pro',
        'gemini-pro-vision',
        'gemini-1.0-pro',
        'gemini-1.5-pro',
        'gemini-1.5-flash',
        'gemini-1.5-flash-latest',
        'gemini-1.5-flash-8b',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-2.0-flash-preview-image-generation',
        'gemini-exp-1206',
        'gemma-3-27b',
      ])('returns 8192 for %s', (model) => {
        expect(reset(model)).toBe(8192);
      });
    });
  });

  describe('maxOutputTokens.set()', () => {
    const { set } = googleSettings.maxOutputTokens;

    it('caps current Gemini models at 65535', () => {
      expect(set(100000, 'gemini-2.5-pro')).toBe(65535);
      expect(set(100000, 'gemini-3.5-flash')).toBe(65535);
    });

    it('allows values within the current 64K limit', () => {
      expect(set(32000, 'gemini-2.5-flash')).toBe(32000);
      expect(set(65535, 'gemini-3.5-flash')).toBe(65535);
    });

    it('caps Gemini image models at 32768', () => {
      expect(set(65535, 'gemini-2.5-flash-image')).toBe(32768);
      expect(set(32768, 'gemini-2.5-flash-image')).toBe(32768);
    });

    it('caps legacy Gemini models at 8192', () => {
      expect(set(65535, 'gemini-2.0-flash')).toBe(8192);
      expect(set(20000, 'gemini-1.5-flash')).toBe(8192);
    });

    it('allows values within the legacy 8K limit', () => {
      expect(set(4096, 'gemini-1.5-flash')).toBe(4096);
      expect(set(8192, 'gemini-2.0-flash')).toBe(8192);
    });
  });

  describe('getGoogleThinkingBudgetBounds()', () => {
    it('returns the documented Pro floor and ceiling', () => {
      expect(getGoogleThinkingBudgetBounds('gemini-2.5-pro')).toEqual({ min: 128, max: 32768 });
      expect(getGoogleThinkingBudgetBounds('gemini-2.5-pro-preview-05-06')).toEqual({
        min: 128,
        max: 32768,
      });
    });

    it('returns the documented Flash floor and ceiling', () => {
      expect(getGoogleThinkingBudgetBounds('gemini-2.5-flash')).toEqual({ min: 0, max: 24576 });
    });

    it('returns the documented Flash Lite floor and ceiling', () => {
      expect(getGoogleThinkingBudgetBounds('gemini-2.5-flash-lite')).toEqual({
        min: 512,
        max: 24576,
      });
      expect(getGoogleThinkingBudgetBounds('gemini-2.5-flash-lite-preview-09-2025')).toEqual({
        min: 512,
        max: 24576,
      });
    });

    it('does not apply 2.5 bounds to other Gemini families', () => {
      expect(getGoogleThinkingBudgetBounds('gemini-2.0-flash')).toBeUndefined();
      expect(getGoogleThinkingBudgetBounds('gemini-3-pro')).toBeUndefined();
      expect(getGoogleThinkingBudgetBounds('gemini-1.5-pro')).toBeUndefined();
    });
  });

  describe('compactGoogleSchema (model-aware maxOutputTokens)', () => {
    it('strips the model default for current Gemini models', () => {
      const result = compactGoogleSchema.parse({
        model: 'gemini-2.5-pro',
        maxOutputTokens: 65535,
      });
      expect(result.maxOutputTokens).toBeUndefined();
    });

    it('preserves a deliberate below-default value for current Gemini models', () => {
      const result = compactGoogleSchema.parse({
        model: 'gemini-2.5-pro',
        maxOutputTokens: 8192,
      });
      expect(result.maxOutputTokens).toBe(8192);
    });

    it('strips the legacy default for legacy Gemini models', () => {
      const result = compactGoogleSchema.parse({
        model: 'gemini-1.5-flash',
        maxOutputTokens: 8192,
      });
      expect(result.maxOutputTokens).toBeUndefined();
    });

    it('preserves chat project membership metadata', () => {
      const result = compactGoogleSchema.parse({
        model: 'gemini-2.5-pro',
        chatProjectId: 'project-1',
      });
      expect(result.chatProjectId).toBe('project-1');
    });
  });
});

describe('AnthropicEffort', () => {
  it('exposes xhigh between high and max in the enum', () => {
    expect(AnthropicEffort.xhigh).toBe('xhigh');
    const keys = Object.keys(AnthropicEffort);
    expect(keys.indexOf('xhigh')).toBeGreaterThan(keys.indexOf('high'));
    expect(keys.indexOf('xhigh')).toBeLessThan(keys.indexOf('max'));
  });

  it('includes xhigh in anthropicSettings.effort.options', () => {
    expect(anthropicSettings.effort.options).toContain(AnthropicEffort.xhigh);
  });

  it('accepts xhigh through the zod schema', () => {
    expect(eAnthropicEffortSchema.parse('xhigh')).toBe('xhigh');
    expect(eAnthropicEffortSchema.parse(AnthropicEffort.xhigh)).toBe('xhigh');
  });

  it('rejects unknown effort values', () => {
    expect(() => eAnthropicEffortSchema.parse('ultra')).toThrow();
  });
});

describe('ReasoningEffort', () => {
  it('exposes max as the highest OpenAI reasoning effort, after xhigh', () => {
    expect(ReasoningEffort.max).toBe('max');
    const keys = Object.keys(ReasoningEffort);
    expect(keys.indexOf('max')).toBeGreaterThan(keys.indexOf('xhigh'));
  });

  it('accepts max through the zod schema', () => {
    expect(eReasoningEffortSchema.parse('max')).toBe('max');
    expect(eReasoningEffortSchema.parse(ReasoningEffort.max)).toBe('max');
  });

  it('still rejects unknown effort values', () => {
    expect(() => eReasoningEffortSchema.parse('ultra')).toThrow();
  });
});

describe('ReasoningMode', () => {
  it('exposes standard and pro plus an unset sentinel', () => {
    expect(ReasoningMode.unset).toBe('');
    expect(ReasoningMode.standard).toBe('standard');
    expect(ReasoningMode.pro).toBe('pro');
  });

  it('accepts its values through the zod schema and rejects unknowns', () => {
    expect(eReasoningModeSchema.parse('standard')).toBe('standard');
    expect(eReasoningModeSchema.parse('pro')).toBe('pro');
    expect(eReasoningModeSchema.parse('')).toBe('');
    expect(() => eReasoningModeSchema.parse('turbo')).toThrow();
  });
});

describe('ReasoningContext', () => {
  it('exposes auto, current_turn, and all_turns plus an unset sentinel', () => {
    expect(ReasoningContext.unset).toBe('');
    expect(ReasoningContext.auto).toBe('auto');
    expect(ReasoningContext.current_turn).toBe('current_turn');
    expect(ReasoningContext.all_turns).toBe('all_turns');
  });

  it('accepts its values through the zod schema and rejects unknowns', () => {
    expect(eReasoningContextSchema.parse('auto')).toBe('auto');
    expect(eReasoningContextSchema.parse('current_turn')).toBe('current_turn');
    expect(eReasoningContextSchema.parse('all_turns')).toBe('all_turns');
    expect(() => eReasoningContextSchema.parse('next_turn')).toThrow();
  });
});

describe('subagentThreadLineageSchema', () => {
  const lineage = {
    rootConversationId: 'root-conversation',
    parentConversationId: 'parent-conversation',
    parentMessageId: 'parent-message',
    parentToolCallId: 'tool-call',
    parentAgentId: 'parent-agent',
    subagentType: 'researcher',
    subagentKind: 'agent',
    depth: 1,
  };

  it('accepts durable child-thread lineage', () => {
    expect(subagentThreadLineageSchema.parse(lineage)).toEqual(lineage);
  });

  it('rejects non-positive depth and unknown execution shapes', () => {
    expect(() => subagentThreadLineageSchema.parse({ ...lineage, depth: 0 })).toThrow();
    expect(() =>
      subagentThreadLineageSchema.parse({ ...lineage, subagentKind: 'workflow' }),
    ).toThrow();
    expect(() =>
      subagentThreadLineageSchema.parse({ ...lineage, parentConversationId: '' }),
    ).toThrow();
  });
});

describe('tMessageSchema user-submitted provenance', () => {
  const message = {
    messageId: 'message-1',
    conversationId: 'conversation-1',
    parentMessageId: null,
    text: 'Assistant-role text',
    isCreatedByUser: false,
  };

  it('preserves an explicit user-submitted marker', () => {
    expect(
      tMessageSchema.parse({
        ...message,
        isUserSubmitted: true,
        userSubmittedPaths: ['/text', '/content/0/steer'],
        userSubmittedMessageFieldPaths: [
          { path: '/content/1/tool_call/output', field: 'decision_response' },
        ],
      }),
    ).toMatchObject({
      isCreatedByUser: false,
      isUserSubmitted: true,
      userSubmittedPaths: ['/text', '/content/0/steer'],
      userSubmittedMessageFieldPaths: [
        { path: '/content/1/tool_call/output', field: 'decision_response' },
      ],
    });
  });

  it('keeps the marker optional for legacy messages', () => {
    expect(tMessageSchema.parse(message)).not.toHaveProperty('isUserSubmitted');
    expect(tMessageSchema.parse(message)).not.toHaveProperty('userSubmittedPaths');
    expect(tMessageSchema.parse(message)).not.toHaveProperty('userSubmittedMessageFieldPaths');
  });

  it('rejects provenance paths that are not JSON pointers', () => {
    expect(() =>
      tMessageSchema.parse({ ...message, userSubmittedPaths: ['content/0/text'] }),
    ).toThrow();
  });

  it.each([
    [{ path: 'content/0/tool_call/output', field: 'answer' }],
    [{ path: '/content/0/tool_call/output', field: 'content_part' }],
    [{ path: '/content/0/tool_call/output', field: 'answer', extra: true }],
  ])('rejects invalid exact message-field provenance %#', (userSubmittedMessageFieldPaths) => {
    expect(() => tMessageSchema.parse({ ...message, userSubmittedMessageFieldPaths })).toThrow();
  });
});

describe('tPresetSchema', () => {
  it('strips all unseen-reply state from preset payloads', () => {
    /* Saving a preset off a live conversation captures read-state fields; none may stamp stale
       state back onto every conversation it is applied to. */
    const parsed = tPresetSchema.parse({
      conversationId: null,
      endpoint: 'openAI',
      lastResponseAt: '2026-08-16T10:00:00.000Z',
      lastResponseMessageId: 'reply-1',
      lastResponseIsManual: true,
      lastSeenAt: '2026-08-16T09:00:00.000Z',
    });

    expect(parsed).not.toHaveProperty('lastResponseAt');
    expect(parsed).not.toHaveProperty('lastResponseMessageId');
    expect(parsed).not.toHaveProperty('lastResponseIsManual');
    expect(parsed).not.toHaveProperty('lastSeenAt');
  });

  it('keeps stripping the runtime timestamps presets never carry', () => {
    const parsed = tPresetSchema.parse({
      conversationId: null,
      endpoint: 'openAI',
      createdAt: '2026-08-16T10:00:00.000Z',
      updatedAt: '2026-08-16T10:00:00.000Z',
    });

    expect(parsed).not.toHaveProperty('createdAt');
    expect(parsed).not.toHaveProperty('updatedAt');
  });
});
