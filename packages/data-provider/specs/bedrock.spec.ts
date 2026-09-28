import {
  ThinkingDisplay,
  AnthropicEffort,
  isMythosClassModel,
  MYTHOS_CLASS_FAMILIES,
} from '../src/schemas';
import {
  BEDROCK_OUTPUT_128K_BETA,
  supportsAdaptiveThinking,
  omitsSamplingParameters,
  omitsThinkingByDefault,
  requiresExplicitThinkingDisabled,
  capsEffortWhenThinkingDisabled,
  clampEffortForDisabledThinking,
  resolveThinkingDisplay,
  bedrockOutputParser,
  bedrockInputParser,
  bedrockInputSchema,
  supportsContext1m,
  BEDROCK_FINE_GRAINED_TOOL_STREAMING_BETA,
} from '../src/bedrock';

const BEDROCK_CLAUDE_4_BETAS = [BEDROCK_OUTPUT_128K_BETA, BEDROCK_FINE_GRAINED_TOOL_STREAMING_BETA];

describe('isMythosClassModel (single source of truth for Fable/Mythos)', () => {
  test('matches every declared family across naming variants', () => {
    MYTHOS_CLASS_FAMILIES.forEach((family) => {
      expect(isMythosClassModel(`claude-${family}-5`)).toBe(true);
      expect(isMythosClassModel(`anthropic.claude-${family}-5`)).toBe(true);
      expect(isMythosClassModel(`us.anthropic.claude-${family}-5`)).toBe(true);
      expect(isMythosClassModel(`claude-${family}-5-20260609`)).toBe(true);
      expect(isMythosClassModel(`claude-${family}-5-1`)).toBe(true);
      expect(isMythosClassModel(`global.anthropic.claude-${family}-5-1`)).toBe(true);
    });
  });

  test('does not match opus/sonnet/haiku or unrelated models', () => {
    ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'gpt-4o', ''].forEach((model) => {
      expect(isMythosClassModel(model)).toBe(false);
    });
  });
});

describe('supportsAdaptiveThinking', () => {
  test('should return true for claude-opus-4-6', () => {
    expect(supportsAdaptiveThinking('claude-opus-4-6')).toBe(true);
  });

  test('should return true for claude-opus-4.6', () => {
    expect(supportsAdaptiveThinking('claude-opus-4.6')).toBe(true);
  });

  test('should return true for claude-opus-4-7 (future)', () => {
    expect(supportsAdaptiveThinking('claude-opus-4-7')).toBe(true);
  });

  test('should return true for claude-opus-5 (future)', () => {
    expect(supportsAdaptiveThinking('claude-opus-5')).toBe(true);
  });

  test('should return true for claude-opus-9 (future)', () => {
    expect(supportsAdaptiveThinking('claude-opus-9')).toBe(true);
  });

  test('should return true for claude-sonnet-5 (future)', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-5')).toBe(true);
  });

  test('should return true for claude-sonnet-6 (future)', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-6')).toBe(true);
  });

  test('should return true for Mythos-class models (Fable / Mythos)', () => {
    expect(supportsAdaptiveThinking('claude-fable-5')).toBe(true);
    expect(supportsAdaptiveThinking('claude-mythos-5')).toBe(true);
    expect(supportsAdaptiveThinking('anthropic.claude-fable-5')).toBe(true);
    expect(supportsAdaptiveThinking('us.anthropic.claude-fable-5')).toBe(true);
  });

  test('should return false for claude-opus-4-5', () => {
    expect(supportsAdaptiveThinking('claude-opus-4-5')).toBe(false);
  });

  test('should return false for claude-opus-4', () => {
    expect(supportsAdaptiveThinking('claude-opus-4')).toBe(false);
  });

  test('should return false for claude-opus-4-0', () => {
    expect(supportsAdaptiveThinking('claude-opus-4-0')).toBe(false);
  });

  test('should return true for claude-sonnet-4-6', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true);
  });

  test('should return true for claude-sonnet-4.6', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-4.6')).toBe(true);
  });

  test('should return true for claude-sonnet-4-7 (future)', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-4-7')).toBe(true);
  });

  test('should return true for double-digit claude-sonnet-4 minors', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-4-10')).toBe(true);
    expect(supportsAdaptiveThinking('claude-sonnet-4.10')).toBe(true);
    expect(supportsAdaptiveThinking('claude-4-10-sonnet')).toBe(true);
  });

  test('should not parse Sonnet 4 date suffixes as double-digit minors', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-4-20250514')).toBe(false);
  });

  test('should return true for anthropic.claude-sonnet-4-6 (Bedrock)', () => {
    expect(supportsAdaptiveThinking('anthropic.claude-sonnet-4-6')).toBe(true);
  });

  test('should return true for us.anthropic.claude-sonnet-4-6 (cross-region Bedrock)', () => {
    expect(supportsAdaptiveThinking('us.anthropic.claude-sonnet-4-6')).toBe(true);
  });

  test('should return true for claude-4-6-sonnet (alternate naming)', () => {
    expect(supportsAdaptiveThinking('claude-4-6-sonnet')).toBe(true);
  });

  test('should return false for claude-sonnet-4-5', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false);
  });

  test('should return false for claude-sonnet-4', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-4')).toBe(false);
  });

  test('should return false for claude-3-7-sonnet', () => {
    expect(supportsAdaptiveThinking('claude-3-7-sonnet')).toBe(false);
  });

  test('should return false for unrelated model', () => {
    expect(supportsAdaptiveThinking('gpt-4o')).toBe(false);
  });

  test('should handle Bedrock model ID with prefix stripping', () => {
    expect(supportsAdaptiveThinking('anthropic.claude-opus-4-6-v1:0')).toBe(true);
  });

  test('should handle cross-region Bedrock model ID', () => {
    expect(supportsAdaptiveThinking('us.anthropic.claude-opus-4-6-v1')).toBe(true);
  });

  test('should return true for claude-4-6-opus (alternate naming)', () => {
    expect(supportsAdaptiveThinking('claude-4-6-opus')).toBe(true);
  });

  test('should return true for anthropic.claude-4-6-opus (alternate naming)', () => {
    expect(supportsAdaptiveThinking('anthropic.claude-4-6-opus')).toBe(true);
  });

  test('should return true for claude-5-sonnet (alternate naming)', () => {
    expect(supportsAdaptiveThinking('claude-5-sonnet')).toBe(true);
  });

  test('should return true for anthropic.claude-5-sonnet (alternate naming)', () => {
    expect(supportsAdaptiveThinking('anthropic.claude-5-sonnet')).toBe(true);
  });

  test('should return false for claude-4-5-opus (alternate naming, below threshold)', () => {
    expect(supportsAdaptiveThinking('claude-4-5-opus')).toBe(false);
  });

  test('should return false for claude-4-sonnet (alternate naming, below threshold)', () => {
    expect(supportsAdaptiveThinking('claude-4-sonnet')).toBe(false);
  });
});

describe('supportsContext1m', () => {
  test('should return false for claude-sonnet-4', () => {
    expect(supportsContext1m('claude-sonnet-4')).toBe(false);
  });

  test('should return false for claude-sonnet-4-5', () => {
    expect(supportsContext1m('claude-sonnet-4-5')).toBe(false);
  });

  test('should return true for claude-sonnet-4-6', () => {
    expect(supportsContext1m('claude-sonnet-4-6')).toBe(true);
  });

  test('should return true for double-digit claude-sonnet-4 minors', () => {
    expect(supportsContext1m('claude-sonnet-4-10')).toBe(true);
    expect(supportsContext1m('claude-sonnet-4.10')).toBe(true);
    expect(supportsContext1m('claude-4-10-sonnet')).toBe(true);
  });

  test('should not treat Sonnet 4 date suffixes as 1M context models', () => {
    expect(supportsContext1m('claude-sonnet-4-20250514')).toBe(false);
  });

  test('should return true for anthropic.claude-sonnet-4-6 (Bedrock)', () => {
    expect(supportsContext1m('anthropic.claude-sonnet-4-6')).toBe(true);
  });

  test('should return true for claude-sonnet-5 (future)', () => {
    expect(supportsContext1m('claude-sonnet-5')).toBe(true);
  });

  test('should return true for claude-opus-4-6', () => {
    expect(supportsContext1m('claude-opus-4-6')).toBe(true);
  });

  test('should return true for claude-opus-4-7', () => {
    expect(supportsContext1m('claude-opus-4-7')).toBe(true);
  });

  test('should return true for claude-opus-5 (future)', () => {
    expect(supportsContext1m('claude-opus-5')).toBe(true);
  });

  test('should return true for Mythos-class models (Fable / Mythos)', () => {
    expect(supportsContext1m('claude-fable-5')).toBe(true);
    expect(supportsContext1m('claude-mythos-5')).toBe(true);
    expect(supportsContext1m('anthropic.claude-fable-5')).toBe(true);
  });

  test('should return false for claude-opus-4-5', () => {
    expect(supportsContext1m('claude-opus-4-5')).toBe(false);
  });

  test('should return false for claude-opus-4', () => {
    expect(supportsContext1m('claude-opus-4')).toBe(false);
  });

  test('should return false for claude-3-7-sonnet', () => {
    expect(supportsContext1m('claude-3-7-sonnet')).toBe(false);
  });

  test('should return false for claude-sonnet-3', () => {
    expect(supportsContext1m('claude-sonnet-3')).toBe(false);
  });

  test('should return false for unrelated model', () => {
    expect(supportsContext1m('gpt-4o')).toBe(false);
  });

  test('should return false for claude-4-sonnet (alternate naming, below threshold)', () => {
    expect(supportsContext1m('claude-4-sonnet')).toBe(false);
  });

  test('should return true for claude-5-sonnet (alternate naming)', () => {
    expect(supportsContext1m('claude-5-sonnet')).toBe(true);
  });

  test('should return true for claude-4-6-sonnet (alternate naming)', () => {
    expect(supportsContext1m('claude-4-6-sonnet')).toBe(true);
  });

  test('should return true for claude-4-6-opus (alternate naming)', () => {
    expect(supportsContext1m('claude-4-6-opus')).toBe(true);
  });

  test('should return false for claude-3-sonnet (alternate naming, below threshold)', () => {
    expect(supportsContext1m('claude-3-sonnet')).toBe(false);
  });

  test('should return false for claude-4-5-opus (alternate naming, below threshold)', () => {
    expect(supportsContext1m('claude-4-5-opus')).toBe(false);
  });
});

describe('omitsThinkingByDefault', () => {
  test('returns true for claude-opus-4-7', () => {
    expect(omitsThinkingByDefault('claude-opus-4-7')).toBe(true);
  });

  test('returns true for claude-opus-4.7', () => {
    expect(omitsThinkingByDefault('claude-opus-4.7')).toBe(true);
  });

  test('returns true for anthropic.claude-opus-4-7 (Bedrock)', () => {
    expect(omitsThinkingByDefault('anthropic.claude-opus-4-7')).toBe(true);
  });

  test('returns true for us.anthropic.claude-opus-4-7 (cross-region Bedrock)', () => {
    expect(omitsThinkingByDefault('us.anthropic.claude-opus-4-7')).toBe(true);
  });

  test('returns true for claude-opus-4-8', () => {
    expect(omitsThinkingByDefault('claude-opus-4-8')).toBe(true);
  });

  test('returns true for claude-opus-5 (future major Opus)', () => {
    expect(omitsThinkingByDefault('claude-opus-5')).toBe(true);
  });

  test('returns true for claude-opus-9 (far-future Opus)', () => {
    expect(omitsThinkingByDefault('claude-opus-9')).toBe(true);
  });

  test('returns true for Mythos-class models (Fable / Mythos)', () => {
    expect(omitsThinkingByDefault('claude-fable-5')).toBe(true);
    expect(omitsThinkingByDefault('claude-mythos-5')).toBe(true);
    expect(omitsThinkingByDefault('anthropic.claude-fable-5')).toBe(true);
  });

  test('returns false for claude-opus-4-6 (adaptive but pre-4.7)', () => {
    expect(omitsThinkingByDefault('claude-opus-4-6')).toBe(false);
  });

  test('returns false for base Opus 4 snapshot IDs', () => {
    expect(omitsThinkingByDefault('claude-opus-4-20250514')).toBe(false);
    expect(omitsThinkingByDefault('anthropic.claude-opus-4-20250514-v1:0')).toBe(false);
  });

  test('returns false for claude-opus-4-5', () => {
    expect(omitsThinkingByDefault('claude-opus-4-5')).toBe(false);
  });

  test('returns false for claude-sonnet-4-6', () => {
    expect(omitsThinkingByDefault('claude-sonnet-4-6')).toBe(false);
  });

  test('returns false for claude-sonnet-4-7 (pre-5 Sonnet keeps summarized default)', () => {
    expect(omitsThinkingByDefault('claude-sonnet-4-7')).toBe(false);
  });

  test('returns true for Sonnet 5+ (omits thinking display by default)', () => {
    expect(omitsThinkingByDefault('claude-sonnet-5')).toBe(true);
    expect(omitsThinkingByDefault('claude-sonnet-5-20260101')).toBe(true);
    expect(omitsThinkingByDefault('anthropic.claude-sonnet-5')).toBe(true);
    expect(omitsThinkingByDefault('claude-sonnet-9')).toBe(true);
  });

  test('returns false for claude-haiku-4-5', () => {
    expect(omitsThinkingByDefault('claude-haiku-4-5')).toBe(false);
  });

  test('returns false for claude-3-7-sonnet', () => {
    expect(omitsThinkingByDefault('claude-3-7-sonnet')).toBe(false);
  });

  test('returns false for unrelated models', () => {
    expect(omitsThinkingByDefault('gpt-4o')).toBe(false);
    expect(omitsThinkingByDefault('')).toBe(false);
  });
});

describe('omitsSamplingParameters', () => {
  test('returns true for Opus 4.7+ models', () => {
    const models = [
      'claude-opus-4-7',
      'claude-opus-4-8',
      'anthropic.claude-opus-4-8',
      'us.anthropic.claude-opus-4-8',
      'claude-opus-5',
    ];

    models.forEach((model) => {
      expect(omitsSamplingParameters(model)).toBe(true);
    });
  });

  test('returns true for Mythos-class models (Fable / Mythos)', () => {
    const models = [
      'claude-fable-5',
      'claude-mythos-5',
      'anthropic.claude-fable-5',
      'us.anthropic.claude-fable-5',
    ];

    models.forEach((model) => {
      expect(omitsSamplingParameters(model)).toBe(true);
    });
  });

  test('returns true for Sonnet 5+ models (non-default sampling params rejected)', () => {
    const models = [
      'claude-sonnet-5',
      'claude-sonnet-5-20260101',
      'anthropic.claude-sonnet-5',
      'us.anthropic.claude-sonnet-5',
      'claude-sonnet-9',
    ];

    models.forEach((model) => {
      expect(omitsSamplingParameters(model)).toBe(true);
    });
  });

  test('returns false for older Opus and pre-5 Sonnet models', () => {
    const models = [
      'claude-opus-4-20250514',
      'anthropic.claude-opus-4-20250514-v1:0',
      'claude-opus-4-1-20250805',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-sonnet-4-7',
    ];

    models.forEach((model) => {
      expect(omitsSamplingParameters(model)).toBe(false);
    });
  });
});

describe('requiresExplicitThinkingDisabled', () => {
  test('returns true for Sonnet 5+ (omitted thinking runs adaptive by default)', () => {
    expect(requiresExplicitThinkingDisabled('claude-sonnet-5')).toBe(true);
    expect(requiresExplicitThinkingDisabled('claude-sonnet-5-20260101')).toBe(true);
    expect(requiresExplicitThinkingDisabled('anthropic.claude-sonnet-5')).toBe(true);
    expect(requiresExplicitThinkingDisabled('claude-sonnet-9')).toBe(true);
  });

  test('returns true for Opus 5+ (omitted thinking runs adaptive by default)', () => {
    expect(requiresExplicitThinkingDisabled('claude-opus-5')).toBe(true);
    expect(requiresExplicitThinkingDisabled('claude-opus-5-20260701')).toBe(true);
    expect(requiresExplicitThinkingDisabled('anthropic.claude-opus-5')).toBe(true);
    expect(requiresExplicitThinkingDisabled('us.anthropic.claude-opus-5')).toBe(true);
    expect(requiresExplicitThinkingDisabled('claude-opus-9')).toBe(true);
  });

  test('returns false for pre-5 Sonnet, pre-5 Opus, and Mythos-class models', () => {
    // Opus 4.7/4.8 omit -> off; Fable/Mythos reject an explicit disabled config (400)
    expect(requiresExplicitThinkingDisabled('claude-sonnet-4-6')).toBe(false);
    expect(requiresExplicitThinkingDisabled('claude-opus-4-8')).toBe(false);
    expect(requiresExplicitThinkingDisabled('claude-opus-4-7')).toBe(false);
    expect(requiresExplicitThinkingDisabled('claude-fable-5')).toBe(false);
    expect(requiresExplicitThinkingDisabled('claude-mythos-5')).toBe(false);
    expect(requiresExplicitThinkingDisabled('gpt-4o')).toBe(false);
  });
});

describe('capsEffortWhenThinkingDisabled', () => {
  test('returns true for Opus 5+', () => {
    expect(capsEffortWhenThinkingDisabled('claude-opus-5')).toBe(true);
    expect(capsEffortWhenThinkingDisabled('anthropic.claude-opus-5')).toBe(true);
    expect(capsEffortWhenThinkingDisabled('claude-opus-9')).toBe(true);
  });

  test('returns false for models that accept every effort with thinking off', () => {
    // Live-verified: these all return 200 for thinking disabled + effort xhigh/max
    expect(capsEffortWhenThinkingDisabled('claude-opus-4-8')).toBe(false);
    expect(capsEffortWhenThinkingDisabled('claude-opus-4-7')).toBe(false);
    expect(capsEffortWhenThinkingDisabled('claude-sonnet-5')).toBe(false);
    expect(capsEffortWhenThinkingDisabled('claude-fable-5')).toBe(false);
    expect(capsEffortWhenThinkingDisabled('gpt-4o')).toBe(false);
  });
});

describe('clampEffortForDisabledThinking', () => {
  test('lowers xhigh/max to high on Opus 5', () => {
    expect(clampEffortForDisabledThinking('claude-opus-5', AnthropicEffort.xhigh)).toBe('high');
    expect(clampEffortForDisabledThinking('claude-opus-5', AnthropicEffort.max)).toBe('high');
  });

  test('leaves accepted effort levels untouched on Opus 5', () => {
    expect(clampEffortForDisabledThinking('claude-opus-5', AnthropicEffort.high)).toBe('high');
    expect(clampEffortForDisabledThinking('claude-opus-5', AnthropicEffort.medium)).toBe('medium');
    expect(clampEffortForDisabledThinking('claude-opus-5', AnthropicEffort.low)).toBe('low');
  });

  test('leaves effort untouched on models without the cap', () => {
    expect(clampEffortForDisabledThinking('claude-opus-4-8', AnthropicEffort.xhigh)).toBe('xhigh');
    expect(clampEffortForDisabledThinking('claude-sonnet-5', AnthropicEffort.max)).toBe('max');
  });
});

describe('resolveThinkingDisplay', () => {
  test('returns "summarized" for Opus 4.7 when explicit is auto/null/undefined', () => {
    expect(resolveThinkingDisplay('claude-opus-4-7', ThinkingDisplay.auto)).toBe('summarized');
    expect(resolveThinkingDisplay('claude-opus-4-7', null)).toBe('summarized');
    expect(resolveThinkingDisplay('claude-opus-4-7', undefined)).toBe('summarized');
  });

  test('returns undefined for Opus 4.6 when explicit is auto/null/undefined', () => {
    expect(resolveThinkingDisplay('claude-opus-4-6', ThinkingDisplay.auto)).toBeUndefined();
    expect(resolveThinkingDisplay('claude-opus-4-6', null)).toBeUndefined();
    expect(resolveThinkingDisplay('claude-opus-4-6', undefined)).toBeUndefined();
  });

  test('explicit summarized wins for any adaptive model', () => {
    expect(resolveThinkingDisplay('claude-opus-4-6', ThinkingDisplay.summarized)).toBe(
      'summarized',
    );
    expect(resolveThinkingDisplay('claude-sonnet-4-6', ThinkingDisplay.summarized)).toBe(
      'summarized',
    );
    expect(resolveThinkingDisplay('claude-opus-4-7', ThinkingDisplay.summarized)).toBe(
      'summarized',
    );
  });

  test('explicit omitted wins even for Opus 4.7', () => {
    expect(resolveThinkingDisplay('claude-opus-4-7', ThinkingDisplay.omitted)).toBe('omitted');
    expect(resolveThinkingDisplay('claude-opus-4-6', ThinkingDisplay.omitted)).toBe('omitted');
  });

  test('unknown string values fall through to auto behavior', () => {
    expect(resolveThinkingDisplay('claude-opus-4-7', 'bogus')).toBe('summarized');
    expect(resolveThinkingDisplay('claude-opus-4-6', 'bogus')).toBeUndefined();
  });
});

describe('bedrockInputParser', () => {
  test('keeps Opus 5.5 adaptive thinking enabled and binds prior blocks', () => {
    const result = bedrockInputParser.parse({
      model: 'anthropic.claude-opus-5-5',
      thinking: false,
    }) as Record<string, unknown>;
    const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;

    expect(additionalFields.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
    expect(additionalFields.anthropic_beta).toEqual(['thinking-binding-controls-2026-08-01']);
  });

  test('restores Opus 5.5 settings and removes its generated binding on a model switch', () => {
    const first = bedrockOutputParser(
      bedrockInputParser.parse({
        model: 'global.anthropic.claude-opus-5-5',
        additionalModelRequestFields: {
          thinking: { type: 'disabled', display: 'omitted' },
          output_config: { effort: 'max' },
          top_k: 40,
          anthropic_beta: ['custom-beta', BEDROCK_OUTPUT_128K_BETA],
        },
      }),
    );
    const fields = structuredClone(first.additionalModelRequestFields);
    expect(fields).toMatchObject({
      thinking: {
        type: 'adaptive',
        display: 'omitted',
        block_binding: { prefix_mismatch_behavior: 'drop_block' },
      },
      output_config: { effort: 'max' },
      anthropic_beta: ['custom-beta', 'thinking-binding-controls-2026-08-01'],
    });
    expect(fields).not.toHaveProperty('top_k');
    expect(first.maxTokens).toBe(128000);
    expect(bedrockOutputParser(bedrockInputParser.parse(first))).toEqual(first);

    const switched = bedrockOutputParser(
      bedrockInputParser.parse({
        ...first,
        model: 'global.anthropic.claude-opus-5',
        thinking: false,
      }),
    );
    expect(switched.additionalModelRequestFields).toMatchObject({
      thinking: { type: 'disabled' },
      output_config: { effort: 'high' },
      anthropic_beta: ['custom-beta', ...BEDROCK_CLAUDE_4_BETAS],
    });
    expect(switched.additionalModelRequestFields).not.toHaveProperty('thinking.block_binding');
    expect(first.additionalModelRequestFields).toEqual(fields);
  });

  describe('Model Matching for Reasoning Configuration', () => {
    test('should match anthropic.claude-3-7-sonnet model', () => {
      const input = {
        model: 'anthropic.claude-3-7-sonnet',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBe(true);
      expect(additionalFields.thinkingBudget).toBe(2000);
      expect(additionalFields.anthropic_beta).toEqual([BEDROCK_OUTPUT_128K_BETA]);
    });

    test('should match anthropic.claude-sonnet-4 model without context beta header', () => {
      const input = {
        model: 'anthropic.claude-sonnet-4',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBe(true);
      expect(additionalFields.thinkingBudget).toBe(2000);
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should match anthropic.claude-opus-5 model with adaptive thinking', () => {
      const input = {
        model: 'anthropic.claude-opus-5',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(additionalFields.thinkingBudget).toBeUndefined();
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    // Bedrock application inference profiles surface a bare `claude-*` model ID
    // (no `anthropic.` prefix). The thinking/beta config must still apply.
    test('should configure adaptive thinking for a bare claude-sonnet-5 (inference profile) ID', () => {
      const input = { model: 'claude-sonnet-5' };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(additionalFields.thinkingBudget).toBeUndefined();
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('bare claude-* IDs match their anthropic.-prefixed equivalents', () => {
      const thinkingFor = (model: string) => {
        const result = bedrockInputParser.parse({ model }) as Record<string, unknown>;
        return (result.additionalModelRequestFields as Record<string, unknown>).thinking;
      };
      expect(thinkingFor('claude-sonnet-5')).toEqual(thinkingFor('anthropic.claude-sonnet-5'));
      expect(thinkingFor('claude-opus-4-8')).toEqual(thinkingFor('us.anthropic.claude-opus-4-8'));
      expect(thinkingFor('claude-sonnet-4-6')).toEqual(thinkingFor('anthropic.claude-sonnet-4-6'));
    });

    test('should configure extended thinking for a bare claude-3-7-sonnet ID', () => {
      const input = { model: 'claude-3-7-sonnet' };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBe(true);
      expect(additionalFields.thinkingBudget).toBe(2000);
      expect(additionalFields.anthropic_beta).toEqual([BEDROCK_OUTPUT_128K_BETA]);
    });

    test('should not configure thinking for non-Claude Bedrock models', () => {
      const input = { model: 'meta.llama3-1-8b-instruct-v1:0' };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as
        | Record<string, unknown>
        | undefined;
      expect(additionalFields?.thinking).toBeUndefined();
      expect(additionalFields?.anthropic_beta).toBeUndefined();
    });

    // Switching a persisted conversation to a non-thinking Claude model (bare or
    // prefixed) must strip stale thinking fields carried over in AMRF, so they
    // aren't sent to a profile that can't accept them — but a user-configured
    // `anthropic_beta` opt-in must be preserved.
    test.each(['claude-3-5-sonnet', 'anthropic.claude-3-5-sonnet'])(
      'strips stale thinking fields but keeps user anthropic_beta for non-thinking Claude %s',
      (model) => {
        const input = {
          model,
          additionalModelRequestFields: {
            thinking: { type: 'adaptive', display: 'summarized' },
            anthropic_beta: ['max-tokens-3-5-sonnet-2024-07-15'],
            output_config: { effort: 'high' },
          },
        };
        const result = bedrockInputParser.parse(input) as Record<string, unknown>;
        const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
        expect(amrf?.thinking).toBeUndefined();
        expect(amrf?.output_config).toBeUndefined();
        expect(amrf?.anthropic_beta).toEqual(['max-tokens-3-5-sonnet-2024-07-15']);
      },
    );

    test('keeps thinking config for a bare thinking Claude model with persisted AMRF', () => {
      const input = {
        model: 'claude-sonnet-5',
        additionalModelRequestFields: { thinking: { type: 'adaptive', display: 'summarized' } },
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    });

    // The persisted AMRF is spread back into the final request, so clearing only
    // the freshly-built fields leaves a stale value from a prior selection.
    // An agent resume round-trips its llmConfig back into model_parameters, so a
    // persisted output_config with NO top-level effort must be preserved as the
    // user's saved choice; only an explicit unset ('' / null) clears it.
    test('preserves persisted output_config when an adaptive model is re-parsed without top-level effort', () => {
      const input = {
        model: 'claude-opus-4-8',
        additionalModelRequestFields: {
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'high' },
        },
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.output_config).toEqual({ effort: 'high' });
      expect(amrf?.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    });

    test.each(['', null])(
      'clears persisted output_config when effort is explicitly unset (%p)',
      (effort) => {
        const input = {
          model: 'claude-opus-4-8',
          effort,
          additionalModelRequestFields: {
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: 'high' },
          },
        };
        const result = bedrockInputParser.parse(input) as Record<string, unknown>;
        const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
        expect(amrf?.output_config).toBeUndefined();
      },
    );

    // Switching a persisted adaptive/disabled conversation to a bare non-adaptive
    // thinking profile (3.7) must not leak the prior thinking object or output_config.
    test('clears persisted thinking + output_config when switching to a bare non-adaptive thinking model', () => {
      const input = {
        model: 'claude-3-7-sonnet',
        additionalModelRequestFields: {
          thinking: { type: 'disabled' },
          output_config: { effort: 'high' },
        },
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.output_config).toBeUndefined();
      expect(amrf?.thinking).not.toEqual({ type: 'disabled' });
    });

    // Switching a bare Claude 4+/5 profile (both generated betas persisted) to a
    // bare 3.7 profile must drop the fine-grained beta 3.7 does not generate.
    test('drops a stale generated beta not applicable to the target thinking model', () => {
      const input = {
        model: 'claude-3-7-sonnet',
        additionalModelRequestFields: {
          anthropic_beta: [
            BEDROCK_OUTPUT_128K_BETA,
            BEDROCK_FINE_GRAINED_TOOL_STREAMING_BETA,
            'context-1m-2025-08-07',
          ],
        },
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.anthropic_beta).toEqual([
        BEDROCK_OUTPUT_128K_BETA,
        'context-1m-2025-08-07',
      ]);
    });

    test('disabling thinking on a bare adaptive model clears the persisted adaptive config', () => {
      const input = {
        model: 'claude-opus-4-8',
        thinking: false,
        additionalModelRequestFields: {
          thinking: { type: 'adaptive', display: 'summarized' },
        },
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.thinking).toBeUndefined();
    });

    test('strips only LibreChat-generated betas from persisted AMRF, keeping user betas', () => {
      const input = {
        model: 'claude-3-5-sonnet',
        additionalModelRequestFields: {
          anthropic_beta: [BEDROCK_OUTPUT_128K_BETA, 'context-1m-2025-08-07'],
        },
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.anthropic_beta).toEqual(['context-1m-2025-08-07']);
    });

    test('drops persisted anthropic_beta entirely when it holds only generated betas', () => {
      const input = {
        model: 'claude-3-5-sonnet',
        additionalModelRequestFields: {
          anthropic_beta: [BEDROCK_OUTPUT_128K_BETA, BEDROCK_FINE_GRAINED_TOOL_STREAMING_BETA],
        },
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.anthropic_beta).toBeUndefined();
    });

    // Persisted anthropic_beta may be a bare string or a comma-delimited string,
    // which the merge helper accepts; the non-thinking cleanup must normalize
    // that shape before filtering out generated betas.
    test('strips a string-form generated beta for non-thinking Claude', () => {
      const input = {
        model: 'claude-3-5-sonnet',
        additionalModelRequestFields: { anthropic_beta: BEDROCK_OUTPUT_128K_BETA },
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.anthropic_beta).toBeUndefined();
    });

    test('strips generated betas from a comma-delimited string, keeping user betas', () => {
      const input = {
        model: 'claude-3-5-sonnet',
        additionalModelRequestFields: {
          anthropic_beta: `${BEDROCK_OUTPUT_128K_BETA}, context-1m-2025-08-07`,
        },
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.anthropic_beta).toEqual(['context-1m-2025-08-07']);
    });

    test('should match anthropic.claude-haiku-6 model without context beta header', () => {
      const input = {
        model: 'anthropic.claude-haiku-6',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBe(true);
      expect(additionalFields.thinkingBudget).toBe(2000);
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should match anthropic.claude-4-sonnet model without context beta header', () => {
      const input = {
        model: 'anthropic.claude-4-sonnet',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBe(true);
      expect(additionalFields.thinkingBudget).toBe(2000);
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should match anthropic.claude-4.5-sonnet model without context beta header', () => {
      const input = {
        model: 'anthropic.claude-4.5-sonnet',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBe(true);
      expect(additionalFields.thinkingBudget).toBe(2000);
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should match anthropic.claude-sonnet-4-6 with adaptive thinking', () => {
      const input = {
        model: 'anthropic.claude-sonnet-4-6',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive' });
      expect(additionalFields.thinkingBudget).toBeUndefined();
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should match us.anthropic.claude-sonnet-4-6 with adaptive thinking', () => {
      const input = {
        model: 'us.anthropic.claude-sonnet-4-6',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive' });
      expect(additionalFields.thinkingBudget).toBeUndefined();
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should match anthropic.claude-4-7-sonnet model with adaptive thinking', () => {
      const input = {
        model: 'anthropic.claude-4-7-sonnet',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive' });
      expect(additionalFields.thinkingBudget).toBeUndefined();
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should match anthropic.claude-sonnet-4-20250514-v1:0 with full model ID', () => {
      const input = {
        model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBe(true);
      expect(additionalFields.thinkingBudget).toBe(2000);
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should not match non-Claude models', () => {
      const input = {
        model: 'some-other-model',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      expect(result.additionalModelRequestFields).toBeUndefined();
    });

    test('should not add anthropic_beta to Moonshot Kimi K2 models', () => {
      const input = {
        model: 'moonshot.kimi-k2-0711-thinking',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as
        | Record<string, unknown>
        | undefined;
      expect(additionalFields?.anthropic_beta).toBeUndefined();
    });

    test('should not add anthropic_beta to DeepSeek models', () => {
      const input = {
        model: 'deepseek.deepseek-r1',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as
        | Record<string, unknown>
        | undefined;
      expect(additionalFields?.anthropic_beta).toBeUndefined();
    });

    test('should respect explicit thinking configuration but still add beta headers', () => {
      const input = {
        model: 'anthropic.claude-sonnet-4',
        thinking: false,
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBeUndefined();
      expect(additionalFields.thinkingBudget).toBeUndefined();
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should send explicit disabled thinking for Bedrock Sonnet 5 when thinking is off', () => {
      const input = {
        model: 'anthropic.claude-sonnet-5',
        thinking: false,
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'disabled' });
    });

    test('should keep Bedrock Sonnet 5 thinking off when only the persisted AMRF disabled config remains', () => {
      // initializeBedrock feeds persisted model_parameters straight through this
      // parser. A prior "thinking off" survives only as AMRF.thinking; it must
      // not be rebuilt as adaptive on reload.
      const input = {
        model: 'anthropic.claude-sonnet-5',
        additionalModelRequestFields: { thinking: { type: 'disabled' } },
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'disabled' });
    });

    test('should respect custom thinking budget', () => {
      const input = {
        model: 'anthropic.claude-sonnet-4',
        thinking: true,
        thinkingBudget: 3000,
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBe(true);
      expect(additionalFields.thinkingBudget).toBe(3000);
    });

    test('should preserve user-provided anthropic_beta values for Claude 4 models', () => {
      const input = {
        model: 'anthropic.claude-sonnet-4',
        additionalModelRequestFields: {
          anthropic_beta: ['context-1m-2025-08-07'],
          custom_flag: true,
        },
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.anthropic_beta).toEqual([
        'context-1m-2025-08-07',
        ...BEDROCK_CLAUDE_4_BETAS,
      ]);
      expect(additionalFields.custom_flag).toBe(true);
    });
  });

  describe('Opus 4.6 Adaptive Thinking', () => {
    test('should default to adaptive thinking for anthropic.claude-opus-4-6-v1', () => {
      const input = {
        model: 'anthropic.claude-opus-4-6-v1',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive' });
      expect(additionalFields.thinkingBudget).toBeUndefined();
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should handle cross-region model ID us.anthropic.claude-opus-4-6-v1', () => {
      const input = {
        model: 'us.anthropic.claude-opus-4-6-v1',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive' });
      expect(additionalFields.thinkingBudget).toBeUndefined();
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should handle cross-region model ID global.anthropic.claude-opus-4-6-v1', () => {
      const input = {
        model: 'global.anthropic.claude-opus-4-6-v1',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive' });
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should pass effort parameter via output_config for adaptive models', () => {
      const input = {
        model: 'anthropic.claude-opus-4-6-v1',
        effort: 'medium',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive' });
      expect(additionalFields.output_config).toEqual({ effort: 'medium' });
      expect(additionalFields.effort).toBeUndefined();
    });

    test('should pass xhigh effort via output_config for adaptive models (Opus 4.7)', () => {
      const input = {
        model: 'anthropic.claude-opus-4-7',
        effort: 'xhigh',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(additionalFields.output_config).toEqual({ effort: 'xhigh' });
      expect(additionalFields.effort).toBeUndefined();
    });

    test('should strip sampling parameters for Opus 4.8 Bedrock models', () => {
      const input = {
        model: 'anthropic.claude-opus-4-8',
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        top_p: 0.8,
        additionalModelRequestFields: {
          custom_flag: true,
          temperature: 0.5,
          topP: 0.95,
          top_k: 20,
        },
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(result.temperature).toBeUndefined();
      expect(result.topP).toBeUndefined();
      expect(additionalFields.temperature).toBeUndefined();
      expect(additionalFields.topP).toBeUndefined();
      expect(additionalFields.top_p).toBeUndefined();
      expect(additionalFields.top_k).toBeUndefined();
      expect(additionalFields.custom_flag).toBe(true);
      expect(additionalFields.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should preserve sampling parameters for Opus 4.6 Bedrock models', () => {
      const input = {
        model: 'anthropic.claude-opus-4-6-v1',
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(result.temperature).toBe(0.7);
      expect(result.topP).toBe(0.9);
      expect(additionalFields.top_k).toBe(40);
    });

    test('should set adaptive thinking and strip sampling params for Fable 5 Bedrock models', () => {
      const input = {
        model: 'anthropic.claude-fable-5',
        effort: 'high',
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        top_p: 0.8,
        additionalModelRequestFields: {
          custom_flag: true,
          temperature: 0.5,
          top_k: 20,
        },
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(result.temperature).toBeUndefined();
      expect(result.topP).toBeUndefined();
      expect(additionalFields.temperature).toBeUndefined();
      expect(additionalFields.top_p).toBeUndefined();
      expect(additionalFields.top_k).toBeUndefined();
      expect(additionalFields.custom_flag).toBe(true);
      expect(additionalFields.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(additionalFields.output_config).toEqual({ effort: 'high' });
      /** Mythos-class models do not receive the legacy output-128k / fine-grained-tool-streaming betas. */
      expect(additionalFields.anthropic_beta).toBeUndefined();
    });

    test('should set thinking.display to "summarized" so Opus 4.7 returns reasoning blocks', () => {
      const input = {
        model: 'anthropic.claude-opus-4-7',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    });

    test('should NOT set thinking.display for pre-Opus-4.7 adaptive models', () => {
      const pre47Models = [
        'anthropic.claude-opus-4-6-v1',
        'anthropic.claude-sonnet-4-6',
        'us.anthropic.claude-opus-4-6-v1',
      ];

      pre47Models.forEach((model) => {
        const result = bedrockInputParser.parse({ model }) as Record<string, unknown>;
        const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
        expect(additionalFields.thinking).toEqual({ type: 'adaptive' });
        expect(additionalFields.thinking).not.toHaveProperty('display');
      });
    });

    test('explicit thinkingDisplay="summarized" forces display even on Opus 4.6', () => {
      const result = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-6-v1',
        thinkingDisplay: ThinkingDisplay.summarized,
      }) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(additionalFields.thinkingDisplay).toBeUndefined();
    });

    test('explicit thinkingDisplay="omitted" wins even on Opus 4.7', () => {
      const result = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-7',
        thinkingDisplay: ThinkingDisplay.omitted,
      }) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
      expect(additionalFields.thinkingDisplay).toBeUndefined();
    });

    test('thinkingDisplay="auto" defers to model default', () => {
      const opus47 = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-7',
        thinkingDisplay: ThinkingDisplay.auto,
      }) as Record<string, unknown>;
      expect((opus47.additionalModelRequestFields as Record<string, unknown>).thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });

      const opus46 = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-6-v1',
        thinkingDisplay: ThinkingDisplay.auto,
      }) as Record<string, unknown>;
      expect((opus46.additionalModelRequestFields as Record<string, unknown>).thinking).toEqual({
        type: 'adaptive',
      });
    });

    test('thinkingDisplay is stripped when model does not support adaptive thinking', () => {
      const result = bedrockInputParser.parse({
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        thinkingDisplay: ThinkingDisplay.summarized,
      }) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields?.thinkingDisplay).toBeUndefined();
    });

    test('thinkingDisplay is stripped when adaptive thinking is disabled', () => {
      const result = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-7',
        thinking: false,
        thinkingDisplay: ThinkingDisplay.summarized,
      }) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBeUndefined();
      expect(additionalFields.thinkingBudget).toBeUndefined();
      expect(additionalFields.thinkingDisplay).toBeUndefined();
    });

    test('round-trips persisted display from AMRF.thinking.display (Opus 4.7 omitted)', () => {
      /** Simulates a persisted conversation where the prior parse already set
       * display on the nested AMRF.thinking object but did not persist the
       * top-level thinkingDisplay field. The schema (bedrockInputSchema) should
       * recover display → thinkingDisplay so the parser can honor the explicit
       * choice on subsequent requests. */
      const persisted = bedrockInputSchema.parse({
        model: 'anthropic.claude-opus-4-7',
        additionalModelRequestFields: {
          thinking: { type: 'adaptive', display: 'omitted' },
        },
      }) as Record<string, unknown>;
      expect(persisted.thinkingDisplay).toBe('omitted');
    });

    test('round-trips persisted display from AMRF.thinking.display (summarized)', () => {
      const persisted = bedrockInputSchema.parse({
        model: 'anthropic.claude-opus-4-6-v1',
        additionalModelRequestFields: {
          thinking: { type: 'adaptive', display: 'summarized' },
        },
      }) as Record<string, unknown>;
      expect(persisted.thinkingDisplay).toBe('summarized');
    });

    test('coerces a persisted disabled AMRF.thinking back to thinking=false (Sonnet 5)', () => {
      /** A persisted Sonnet 5 "thinking off" carries AMRF.thinking =
       * { type: 'disabled' }. The schema must coerce that to top-level
       * thinking=false (not the truthy-object default of true), so the parser
       * re-emits the disabled config instead of flipping back to adaptive. */
      const persisted = bedrockInputSchema.parse({
        model: 'anthropic.claude-sonnet-5',
        additionalModelRequestFields: { thinking: { type: 'disabled' } },
      }) as Record<string, unknown>;
      expect(persisted.thinking).toBe(false);
    });

    test('ignores unknown display values during round-trip extraction', () => {
      const persisted = bedrockInputSchema.parse({
        model: 'anthropic.claude-opus-4-7',
        additionalModelRequestFields: {
          thinking: { type: 'adaptive', display: 'bogus' },
        },
      }) as Record<string, unknown>;
      expect(persisted.thinkingDisplay).toBeUndefined();
    });

    test('top-level thinkingDisplay wins over persisted AMRF display', () => {
      const persisted = bedrockInputSchema.parse({
        model: 'anthropic.claude-opus-4-7',
        thinkingDisplay: ThinkingDisplay.omitted,
        additionalModelRequestFields: {
          thinking: { type: 'adaptive', display: 'summarized' },
        },
      }) as Record<string, unknown>;
      expect(persisted.thinkingDisplay).toBe(ThinkingDisplay.omitted);
    });

    test('bedrockInputParser preserves persisted AMRF.thinking.display (Opus 4.7 omitted)', () => {
      /** initializeBedrock calls bedrockInputParser directly on persisted
       * model_parameters. Without the parser-side extraction, the 'omitted'
       * user choice baked into AMRF would be silently reverted to
       * 'summarized' by the Opus 4.7+ auto fallback. */
      const result = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-7',
        additionalModelRequestFields: {
          thinking: { type: 'adaptive', display: 'omitted' },
        },
      }) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    });

    test('bedrockInputParser: top-level thinkingDisplay wins over persisted AMRF display', () => {
      const result = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-7',
        thinkingDisplay: ThinkingDisplay.summarized,
        additionalModelRequestFields: {
          thinking: { type: 'adaptive', display: 'omitted' },
        },
      }) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    });

    test('should not include output_config when effort is unset (empty string)', () => {
      const input = {
        model: 'anthropic.claude-opus-4-6-v1',
        effort: '',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive' });
      expect(additionalFields.output_config).toBeUndefined();
    });

    test('should respect thinking=false for adaptive models', () => {
      const input = {
        model: 'anthropic.claude-opus-4-6-v1',
        thinking: false,
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBeUndefined();
      expect(additionalFields.thinkingBudget).toBeUndefined();
      expect(additionalFields.anthropic_beta).toEqual(BEDROCK_CLAUDE_4_BETAS);
    });

    test('should preserve effort when thinking=false for adaptive models', () => {
      const input = {
        model: 'anthropic.claude-opus-4-6-v1',
        thinking: false,
        effort: 'high',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBeUndefined();
      expect(additionalFields.thinkingBudget).toBeUndefined();
      expect(additionalFields.output_config).toEqual({ effort: 'high' });
      expect(additionalFields.effort).toBeUndefined();
    });

    test('should strip effort for non-adaptive thinking models', () => {
      const input = {
        model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
        effort: 'high',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBe(true);
      expect(additionalFields.thinkingBudget).toBe(2000);
      expect(additionalFields.effort).toBeUndefined();
      expect(additionalFields.output_config).toBeUndefined();
    });

    test('should not include effort for Opus 4.5 (non-adaptive)', () => {
      const input = {
        model: 'anthropic.claude-opus-4-5-v1:0',
        effort: 'low',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toBe(true);
      expect(additionalFields.effort).toBeUndefined();
      expect(additionalFields.output_config).toBeUndefined();
    });

    test('should support max effort for Opus 4.6', () => {
      const input = {
        model: 'anthropic.claude-opus-4-6-v1',
        effort: 'max',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive' });
      expect(additionalFields.output_config).toEqual({ effort: 'max' });
    });

    test.each(['xhigh', 'max'])(
      'clamps %s effort to high for Opus 5 when thinking is disabled',
      (effort) => {
        const result = bedrockInputParser.parse({
          model: 'anthropic.claude-opus-5',
          thinking: false,
          effort,
        }) as Record<string, unknown>;
        const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
        expect(additionalFields.thinking).toEqual({ type: 'disabled' });
        expect(additionalFields.output_config).toEqual({ effort: 'high' });
      },
    );

    test('clamps persisted output_config effort for Opus 5 when thinking is disabled', () => {
      const result = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-5',
        thinking: false,
        additionalModelRequestFields: {
          output_config: { effort: 'xhigh' },
        },
      }) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.output_config).toEqual({ effort: 'high' });
    });

    test('clamps persisted effort for Opus 5 when a disabled config round-trips from persistence', () => {
      const result = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-5',
        additionalModelRequestFields: {
          thinking: { type: 'disabled' },
          output_config: { effort: 'max' },
        },
      }) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'disabled' });
      expect(additionalFields.output_config).toEqual({ effort: 'high' });
    });

    test('keeps xhigh effort for Opus 5 while thinking is enabled', () => {
      const result = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-5',
        thinking: true,
        effort: 'xhigh',
      }) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(additionalFields.output_config).toEqual({ effort: 'xhigh' });
    });

    test('does not clamp xhigh effort for Opus 4.8 when thinking is disabled', () => {
      const result = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-8',
        thinking: false,
        effort: 'xhigh',
      }) as Record<string, unknown>;
      const additionalFields = result.additionalModelRequestFields as Record<string, unknown>;
      expect(additionalFields.output_config).toEqual({ effort: 'xhigh' });
    });
  });

  describe('bedrockOutputParser with configureThinking', () => {
    test('defaults adaptive maxTokens to the model max output when unset', () => {
      const parsed = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-6-v1',
      }) as Record<string, unknown>;
      const output = bedrockOutputParser(parsed as Record<string, unknown>);
      const amrf = output.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.thinking).toEqual({ type: 'adaptive' });
      expect(output.maxTokens).toBe(128000);
      expect(output.maxOutputTokens).toBeUndefined();
    });

    test('defaults Bedrock Claude Sonnet 4.6 adaptive maxTokens to its Bedrock max output when unset', () => {
      const parsed = bedrockInputParser.parse({
        model: 'anthropic.claude-sonnet-4-6',
      }) as Record<string, unknown>;
      const output = bedrockOutputParser(parsed as Record<string, unknown>);
      const amrf = output.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.thinking).toEqual({ type: 'adaptive' });
      expect(output.maxTokens).toBe(64000);
      expect(output.maxOutputTokens).toBeUndefined();
    });

    test('should respect user-provided maxTokens for adaptive model', () => {
      const parsed = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-6-v1',
        maxTokens: 32000,
      }) as Record<string, unknown>;
      const output = bedrockOutputParser(parsed as Record<string, unknown>);
      expect(output.maxTokens).toBe(32000);
    });

    test('should use maxOutputTokens as maxTokens for adaptive model when maxTokens is not set', () => {
      const parsed = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-6-v1',
        maxOutputTokens: 24000,
      }) as Record<string, unknown>;
      const output = bedrockOutputParser(parsed as Record<string, unknown>);
      expect(output.maxTokens).toBe(24000);
      expect(output.maxOutputTokens).toBeUndefined();
    });

    test('should convert thinking=true to enabled config for non-adaptive models', () => {
      const parsed = bedrockInputParser.parse({
        model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      }) as Record<string, unknown>;
      const output = bedrockOutputParser(parsed as Record<string, unknown>);
      const amrf = output.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 });
      expect(output.maxTokens).toBe(64000);
    });

    test('should pass output_config through for adaptive model with effort', () => {
      const parsed = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-6-v1',
        effort: 'low',
      }) as Record<string, unknown>;
      const output = bedrockOutputParser(parsed as Record<string, unknown>);
      const amrf = output.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.thinking).toEqual({ type: 'adaptive' });
      expect(amrf.output_config).toEqual({ effort: 'low' });
    });

    test('defaults adaptive maxTokens to the model max when neither maxTokens nor maxOutputTokens are provided', () => {
      const parsed = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-6-v1',
      }) as Record<string, unknown>;
      parsed.maxOutputTokens = undefined;
      (parsed as Record<string, unknown>).maxTokens = undefined;
      const output = bedrockOutputParser(parsed as Record<string, unknown>);
      expect(output.maxTokens).toBe(128000);
    });

    // Regression: a bare inference-profile adaptive model (e.g. claude-sonnet-5)
    // with no explicit maxTokens must get the model's full output budget so
    // reasoning + a large create_file argument does not truncate mid-stream.
    test('defaults a bare adaptive inference-profile model to its full max output', () => {
      const parsed = bedrockInputParser.parse({
        model: 'claude-sonnet-5',
      }) as Record<string, unknown>;
      const output = bedrockOutputParser(parsed as Record<string, unknown>);
      const amrf = output.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(output.maxTokens).toBe(128000);
    });

    // Number-first aliases (claude-4-7-sonnet, claude-5-sonnet) are gated as
    // thinking models here but are not matched by the family-first reset()
    // regex; they must still resolve to the real ceiling, not the 8192 fallback.
    test.each([
      ['anthropic.claude-4-7-sonnet', 128000],
      ['claude-5-sonnet', 128000],
      ['anthropic.claude-4-8-opus', 128000],
    ])('defaults number-first adaptive alias %s to its real max output', (model, expected) => {
      const parsed = bedrockInputParser.parse({ model }) as Record<string, unknown>;
      const output = bedrockOutputParser(parsed as Record<string, unknown>);
      const amrf = output.additionalModelRequestFields as Record<string, unknown>;
      expect((amrf.thinking as { type: string }).type).toBe('adaptive');
      expect(output.maxTokens).toBe(expected);
    });

    test('defaults non-adaptive thinking maxTokens to the model max output', () => {
      const parsed = bedrockInputParser.parse({
        model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      }) as Record<string, unknown>;
      parsed.maxOutputTokens = undefined;
      (parsed as Record<string, unknown>).maxTokens = undefined;
      const output = bedrockOutputParser(parsed as Record<string, unknown>);
      expect(output.maxTokens).toBe(64000);
    });

    test('should use default thinking budget (2000) when no custom budget is set', () => {
      const parsed = bedrockInputParser.parse({
        model: 'anthropic.claude-3-7-sonnet',
      }) as Record<string, unknown>;
      const output = bedrockOutputParser(parsed as Record<string, unknown>);
      const amrf = output.additionalModelRequestFields as Record<string, unknown>;
      const thinking = amrf.thinking as { type: string; budget_tokens: number };
      expect(thinking.budget_tokens).toBe(2000);
    });

    test('should override default thinking budget with custom value', () => {
      const parsed = bedrockInputParser.parse({
        model: 'anthropic.claude-3-7-sonnet',
        thinkingBudget: 5000,
        maxTokens: 8192,
      }) as Record<string, unknown>;
      const output = bedrockOutputParser(parsed as Record<string, unknown>);
      const amrf = output.additionalModelRequestFields as Record<string, unknown>;
      const thinking = amrf.thinking as { type: string; budget_tokens: number };
      expect(thinking.budget_tokens).toBe(5000);
    });

    test('should remove additionalModelRequestFields when thinking disabled and no other fields', () => {
      const parsed = bedrockInputParser.parse({
        model: 'some-other-model',
      }) as Record<string, unknown>;
      const output = bedrockOutputParser(parsed as Record<string, unknown>);
      expect(output.additionalModelRequestFields).toBeUndefined();
    });
  });

  // Regression for #14029: `system` is a reserved top-level Converse field, so a
  // copy left inside additionalModelRequestFields makes Bedrock reject the request
  // ("The additional field system conflicts with an existing field").
  describe('system field (issue #14029)', () => {
    test('promotes system to root without duplicating it in additionalModelRequestFields', () => {
      const parsed = bedrockInputParser.parse({
        model: 'some-other-model',
        system: 'You are a helpful assistant.',
      }) as Record<string, unknown>;
      expect((parsed.additionalModelRequestFields as Record<string, unknown>).system).toBe(
        'You are a helpful assistant.',
      );

      const output = bedrockOutputParser(parsed);
      expect(output.system).toBe('You are a helpful assistant.');
      expect(output.additionalModelRequestFields).toBeUndefined();
    });

    test('strips system from additionalModelRequestFields while preserving other fields', () => {
      const parsed = bedrockInputParser.parse({
        model: 'anthropic.claude-3-7-sonnet',
        system: 'You are a helpful assistant.',
      }) as Record<string, unknown>;

      const output = bedrockOutputParser(parsed);
      const amrf = output.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(output.system).toBe('You are a helpful assistant.');
      expect(amrf?.system).toBeUndefined();
      expect(amrf?.thinking).toBeDefined();
    });

    // DocumentType permits scalars, so a saved preset can carry a non-object
    // additionalModelRequestFields; the `system` cleanup must not throw on it.
    test.each([['a-scalar-string'], [42], [true]])(
      'tolerates a scalar additionalModelRequestFields (%p) without throwing',
      (scalar) => {
        expect(() =>
          bedrockOutputParser({
            model: 'some-other-model',
            additionalModelRequestFields: scalar,
          }),
        ).not.toThrow();
      },
    );

    // `system` is not the only reserved name: the input parser's catch-all routes
    // ANY unknown preset key into additionalModelRequestFields, and each reserved
    // Converse field collides the same way when the request sends it top-level.
    test.each([['messages'], ['modelId'], ['toolConfig'], ['inferenceConfig']])(
      'strips reserved Converse field %p from additionalModelRequestFields',
      (reserved) => {
        const parsed = bedrockInputParser.parse({
          model: 'some-other-model',
          [reserved]: { some: 'value' },
        }) as Record<string, unknown>;
        expect(
          (parsed.additionalModelRequestFields as Record<string, unknown>)[reserved],
        ).toBeDefined();

        const output = bedrockOutputParser(parsed);
        const amrf = output.additionalModelRequestFields as Record<string, unknown> | undefined;
        expect(amrf?.[reserved]).toBeUndefined();
      },
    );

    test('keeps non-reserved passthrough fields intact while stripping reserved ones', () => {
      const output = bedrockOutputParser({
        model: 'some-other-model',
        additionalModelRequestFields: {
          system: 'dup',
          messages: [],
          anthropic_beta: ['context-1m-2025-08-07'],
          top_k: 40,
        },
      });
      const amrf = output.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.system).toBeUndefined();
      expect(amrf.messages).toBeUndefined();
      expect(amrf.anthropic_beta).toEqual(['context-1m-2025-08-07']);
      expect(amrf.top_k).toBe(40);
    });
  });

  describe('Model switching cleanup', () => {
    test('should strip anthropic_beta when switching from Anthropic to non-Anthropic model', () => {
      const staleConversationData = {
        model: 'openai.gpt-oss-120b-1:0',
        promptCache: true,
        additionalModelRequestFields: {
          anthropic_beta: ['output-128k-2025-02-19'],
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high' },
        },
      };
      const result = bedrockInputParser.parse(staleConversationData) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.anthropic_beta).toBeUndefined();
      expect(amrf?.thinking).toBeUndefined();
      expect(amrf?.output_config).toBeUndefined();
      expect(result.promptCache).toBeUndefined();
    });

    test('should strip promptCache when switching from Claude to non-Claude/Nova model', () => {
      const staleConversationData = {
        model: 'deepseek.deepseek-r1',
        promptCache: true,
      };
      const result = bedrockInputParser.parse(staleConversationData) as Record<string, unknown>;
      expect(result.promptCache).toBeUndefined();
    });

    test('should preserve promptCache for Claude models', () => {
      const input = {
        model: 'anthropic.claude-sonnet-4-20250514-v1:0',
        promptCache: true,
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      expect(result.promptCache).toBe(true);
    });

    test('should preserve promptCache for Nova models', () => {
      const input = {
        model: 'amazon.nova-pro-v1:0',
        promptCache: true,
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      expect(result.promptCache).toBe(true);
    });

    test('should strip stale thinking config from additionalModelRequestFields for non-Anthropic models', () => {
      const staleConversationData = {
        model: 'moonshot.kimi-k2-0711-thinking',
        additionalModelRequestFields: {
          thinking: { type: 'enabled', budget_tokens: 2000 },
          thinkingBudget: 2000,
          anthropic_beta: ['output-128k-2025-02-19'],
        },
      };
      const result = bedrockInputParser.parse(staleConversationData) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.anthropic_beta).toBeUndefined();
      expect(amrf?.thinking).toBeUndefined();
      expect(amrf?.thinkingBudget).toBeUndefined();
    });

    test('should not strip anthropic_beta when staying on an Anthropic model', () => {
      const input = {
        model: 'anthropic.claude-opus-4-6-v1',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.anthropic_beta).toBeDefined();
      expect(Array.isArray(amrf.anthropic_beta)).toBe(true);
    });

    test('should strip stale reasoning_config when switching to Anthropic model', () => {
      const staleConversationData = {
        model: 'anthropic.claude-sonnet-4-6',
        additionalModelRequestFields: {
          reasoning_config: 'high',
        },
      };
      const result = bedrockInputParser.parse(staleConversationData) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.reasoning_config).toBeUndefined();
    });

    test('should strip stale reasoning_config when switching from Moonshot to Meta model', () => {
      const staleData = {
        model: 'meta.llama-3-1-70b',
        additionalModelRequestFields: {
          reasoning_config: 'high',
        },
      };
      const result = bedrockInputParser.parse(staleData) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.reasoning_config).toBeUndefined();
    });

    test('should strip stale reasoning_config when switching from ZAI to DeepSeek model', () => {
      const staleData = {
        model: 'deepseek.deepseek-r1',
        additionalModelRequestFields: {
          reasoning_config: 'medium',
        },
      };
      const result = bedrockInputParser.parse(staleData) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.reasoning_config).toBeUndefined();
    });
  });

  describe('Bedrock reasoning_effort → reasoning_config for Moonshot/ZAI models', () => {
    test('should map reasoning_effort to reasoning_config for moonshotai.kimi-k2.5', () => {
      const input = {
        model: 'moonshotai.kimi-k2.5',
        reasoning_effort: 'high',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.reasoning_config).toBe('high');
      expect(amrf.reasoning_effort).toBeUndefined();
    });

    test('should map reasoning_effort to reasoning_config for moonshot.kimi-k2.5', () => {
      const input = {
        model: 'moonshot.kimi-k2.5',
        reasoning_effort: 'medium',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.reasoning_config).toBe('medium');
    });

    test('should map reasoning_effort to reasoning_config for zai.glm-4.7', () => {
      const input = {
        model: 'zai.glm-4.7',
        reasoning_effort: 'high',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.reasoning_config).toBe('high');
    });

    test('should map reasoning_effort "low" to reasoning_config for Moonshot model', () => {
      const input = {
        model: 'moonshotai.kimi-k2.5',
        reasoning_effort: 'low',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.reasoning_config).toBe('low');
    });

    test('should not include reasoning_config when reasoning_effort is unset (empty string)', () => {
      const input = {
        model: 'moonshotai.kimi-k2.5',
        reasoning_effort: '',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.reasoning_config).toBeUndefined();
    });

    test('should not include reasoning_config when reasoning_effort is not provided', () => {
      const input = {
        model: 'moonshotai.kimi-k2.5',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.reasoning_config).toBeUndefined();
    });

    test('should not forward reasoning_effort "none" to reasoning_config', () => {
      const result = bedrockInputParser.parse({
        model: 'moonshotai.kimi-k2.5',
        reasoning_effort: 'none',
      }) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.reasoning_config).toBeUndefined();
    });

    test('should not forward reasoning_effort "minimal" to reasoning_config', () => {
      const result = bedrockInputParser.parse({
        model: 'moonshotai.kimi-k2.5',
        reasoning_effort: 'minimal',
      }) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.reasoning_config).toBeUndefined();
    });

    test('should not forward reasoning_effort "xhigh" to reasoning_config', () => {
      const result = bedrockInputParser.parse({
        model: 'zai.glm-4.7',
        reasoning_effort: 'xhigh',
      }) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(amrf?.reasoning_config).toBeUndefined();
    });

    test('should not add reasoning_config to Anthropic models', () => {
      const input = {
        model: 'anthropic.claude-sonnet-4-6',
        reasoning_effort: 'high',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.reasoning_config).toBeUndefined();
      expect(amrf.reasoning_effort).toBeUndefined();
    });

    test('should not add thinking or anthropic_beta to Moonshot models with reasoning_effort', () => {
      const input = {
        model: 'moonshotai.kimi-k2.5',
        reasoning_effort: 'high',
      };
      const result = bedrockInputParser.parse(input) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.thinking).toBeUndefined();
      expect(amrf.thinkingBudget).toBeUndefined();
      expect(amrf.anthropic_beta).toBeUndefined();
    });

    test('should pass reasoning_config through bedrockOutputParser', () => {
      const parsed = bedrockInputParser.parse({
        model: 'moonshotai.kimi-k2.5',
        reasoning_effort: 'high',
      }) as Record<string, unknown>;
      const output = bedrockOutputParser(parsed);
      const amrf = output.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.reasoning_config).toBe('high');
    });

    test('should strip stale reasoning_config from additionalModelRequestFields for Anthropic models', () => {
      const staleData = {
        model: 'anthropic.claude-opus-4-6-v1',
        additionalModelRequestFields: {
          reasoning_config: 'high',
        },
      };
      const result = bedrockInputParser.parse(staleData) as Record<string, unknown>;
      const amrf = result.additionalModelRequestFields as Record<string, unknown>;
      expect(amrf.reasoning_config).toBeUndefined();
    });
  });

  describe('promptCacheTtl tied to promptCache', () => {
    test('preserves promptCacheTtl when caching is enabled (claude default)', () => {
      const result = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-6-v1',
        promptCacheTtl: '1h',
      }) as Record<string, unknown>;
      expect(result.promptCache).toBe(true);
      expect(result.promptCacheTtl).toBe('1h');
    });

    test('clears promptCacheTtl when promptCache is explicitly disabled', () => {
      const result = bedrockInputParser.parse({
        model: 'anthropic.claude-opus-4-6-v1',
        promptCache: false,
        promptCacheTtl: '1h',
      }) as Record<string, unknown>;
      expect(result.promptCacheTtl).toBeUndefined();
    });

    test('clears promptCache and promptCacheTtl for non-caching models', () => {
      const result = bedrockInputParser.parse({
        model: 'meta.llama3-1-70b-instruct-v1:0',
        promptCache: true,
        promptCacheTtl: '1h',
      }) as Record<string, unknown>;
      expect(result.promptCache).toBeUndefined();
      expect(result.promptCacheTtl).toBeUndefined();
    });
  });
});
