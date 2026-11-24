import { Providers } from '@librechat/agents';
import { AuthKeys, ThinkingLevel } from 'librechat-data-provider';
import { getGoogleConfig, getGoogleInputTokenLimit } from './llm';
import { getGoogleTokenConfig } from './pricing';

describe('Hydrogen request contract', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GOOGLE_LOC;
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  describe.each([
    [Providers.GOOGLE, { [AuthKeys.GOOGLE_API_KEY]: 'test-key' }],
    [Providers.VERTEXAI, { [AuthKeys.GOOGLE_SERVICE_KEY]: { project_id: 'test-project' } }],
  ])('%s', (provider, credentials) => {
    it.each([
      [ThinkingLevel.unset, 'HIGH'],
      [ThinkingLevel.minimal, 'LOW'],
      [ThinkingLevel.low, 'LOW'],
      [ThinkingLevel.medium, 'MEDIUM'],
      [ThinkingLevel.high, 'HIGH'],
      [ThinkingLevel.xhigh, 'XHIGH'],
    ])('normalizes thinking %s and excludes unsupported parameters', (thinkingLevel, expected) => {
      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-4-hydrogen',
          thinkingLevel,
          thinkingBudget: 4096,
          temperature: 0.2,
          topP: 0.3,
          topK: 20,
        },
        addParams: {
          maxOutputTokens: 100000,
          maxReasoningTokens: 4096,
          topP: 0.1,
          candidateCount: 2,
        },
      });
      expect(result.provider).toBe(provider);
      expect(result.llmConfig).toMatchObject({
        maxOutputTokens: 65536,
        thinkingConfig: { thinkingLevel: expected },
      });
      for (const param of [
        'temperature',
        'topP',
        'topK',
        'thinkingBudget',
        'maxReasoningTokens',
        'candidateCount',
      ]) {
        expect(result.llmConfig).not.toHaveProperty(param);
      }
      expect(result.llmConfig).not.toHaveProperty('thinkingConfig.thinkingBudget');
    });

    it.each([true, false])('caps foreground output with streaming=%s', (streaming) => {
      const result = getGoogleConfig(credentials, {
        modelOptions: { model: 'models/gemini-4-hydrogen' },
        streaming,
      });
      expect(result.llmConfig.maxOutputTokens).toBe(65536);
    });
  });

  it.each([
    ['global', 'aiplatform.googleapis.com'],
    ['us', 'aiplatform.us.rep.googleapis.com'],
    ['eu', 'aiplatform.eu.rep.googleapis.com'],
  ])('preserves configured Vertex geography %s', (location, endpoint) => {
    process.env.GOOGLE_LOC = location;
    const result = getGoogleConfig(
      { [AuthKeys.GOOGLE_SERVICE_KEY]: { project_id: 'test-project' } },
      { modelOptions: { model: 'gemini-4-hydrogen' } },
    );
    expect(result.llmConfig).toMatchObject({ location, endpoint });
  });

  it('reserves output and thinking inside the shared context even when output is omitted', () => {
    expect(getGoogleInputTokenLimit('gemini-4-hydrogen')).toBe(1048576 - 65536);
    expect(getGoogleInputTokenLimit('models/gemini-4-hydrogen-001', 4096)).toBe(1048576 - 4096);
    expect(getGoogleInputTokenLimit('gemini-4-argon')).toBeUndefined();
  });

  it.each([
    [undefined, 1.5, 7.5, 0.075],
    ['global', 1.5, 7.5, 0.075],
    ['us', 1.65, 8.25, 0.0825],
    ['eu', 1.65, 8.25, 0.0825],
  ])('uses standard rates for location %s', (location, prompt, completion, read) => {
    expect(getGoogleTokenConfig('gemini-4-hydrogen', undefined, location)).toEqual({
      prompt,
      completion,
      read,
      cacheRead: read,
    });
  });

  it('prefers the configured billing tier, including a free tier', () => {
    expect(
      getGoogleTokenConfig(
        'models/gemini-4-hydrogen',
        { 'gemini-4-hydrogen': { prompt: 0, completion: 0, cacheRead: 0 } },
        'eu',
      ),
    ).toEqual({ prompt: 0, completion: 0, read: 0, cacheRead: 0 });
  });
});
