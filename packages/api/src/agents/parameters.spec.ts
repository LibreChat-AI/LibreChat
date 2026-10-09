import { sanitizeModelParameters } from './parameters';

describe('sanitizeModelParameters', () => {
  it('drops non-numeric strings from numeric keys', () => {
    const result = sanitizeModelParameters({
      max_tokens: 'System',
      maxContextTokens: 256000,
      fileTokenLimit: 256000,
    });
    expect(result).toEqual({ maxContextTokens: 256000, fileTokenLimit: 256000 });
  });

  it('coerces numeric strings to numbers', () => {
    const result = sanitizeModelParameters({
      max_tokens: '4096',
      temperature: ' 0.7 ',
      maxOutputTokens: '8192',
    });
    expect(result).toEqual({ max_tokens: 4096, temperature: 0.7, maxOutputTokens: 8192 });
  });

  it('preserves explicit zero and negative values', () => {
    const result = sanitizeModelParameters({
      max_tokens: 0,
      frequency_penalty: -1.5,
      presence_penalty: '-0.5',
    });
    expect(result).toEqual({ max_tokens: 0, frequency_penalty: -1.5, presence_penalty: -0.5 });
  });

  it('drops NaN, Infinity, empty strings, booleans, and objects from numeric keys', () => {
    const result = sanitizeModelParameters({
      max_tokens: NaN,
      maxTokens: Infinity,
      maxOutputTokens: '',
      max_output_tokens: '   ',
      maxContextTokens: true,
      max_context_tokens: { value: 4096 },
      topK: null,
      topP: undefined,
    });
    expect(result).toEqual({});
  });

  it('passes non-numeric keys through untouched', () => {
    const result = sanitizeModelParameters({
      model: 'gemma4:26b',
      region: 'us-east-1',
      useResponsesApi: true,
      promptCache: false,
      customSetting: 'value',
    });
    expect(result).toEqual({
      model: 'gemma4:26b',
      region: 'us-east-1',
      useResponsesApi: true,
      promptCache: false,
      customSetting: 'value',
    });
  });

  it('handles all known numeric key variants', () => {
    const keys = [
      'temperature',
      'top_p',
      'topP',
      'top_k',
      'topK',
      'frequency_penalty',
      'frequencyPenalty',
      'presence_penalty',
      'presencePenalty',
      'max_tokens',
      'maxTokens',
      'max_output_tokens',
      'maxOutputTokens',
      'max_context_tokens',
      'maxContextTokens',
      'fileTokenLimit',
      'thinking_budget',
      'thinkingBudget',
    ];
    const corrupt = Object.fromEntries(keys.map((key) => [key, 'System']));
    expect(sanitizeModelParameters(corrupt)).toEqual({});

    const valid = Object.fromEntries(keys.map((key, i) => [key, `${i + 1}`]));
    const expected = Object.fromEntries(keys.map((key, i) => [key, i + 1]));
    expect(sanitizeModelParameters(valid)).toEqual(expected);
  });
});
