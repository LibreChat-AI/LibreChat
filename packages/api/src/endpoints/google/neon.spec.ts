import { Providers } from '@librechat/agents';
import { AuthKeys, ThinkingLevel } from 'librechat-data-provider';
import { getGoogleConfig } from './llm';

describe('Gemini 4 Neon request contract', () => {
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
    ])('normalizes thinking %s and excludes rejected parameters', (thinkingLevel, expected) => {
      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-4-neon',
          thinkingLevel,
          thinkingBudget: 4096,
          temperature: 0.2,
          topP: 0.3,
          topK: 20,
        },
        addParams: {
          maxReasoningTokens: 4096,
          presencePenalty: 0.5,
          frequencyPenalty: 0.5,
          cachedContent: 'cachedContents/123',
        },
      });
      expect(result.provider).toBe(provider);
      expect(result.llmConfig).toMatchObject({
        thinkingConfig: { includeThoughts: true, thinkingLevel: expected },
      });
      for (const param of [
        'temperature',
        'topP',
        'topK',
        'thinkingBudget',
        'maxReasoningTokens',
        'presencePenalty',
        'frequencyPenalty',
        'cachedContent',
      ]) {
        expect(result.llmConfig).not.toHaveProperty(param);
      }
      expect(result.llmConfig).not.toHaveProperty('thinkingConfig.thinkingBudget');
    });

    it('applies the Neon handling to versioned and provider-prefixed ids', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: { model: 'models/gemini-4-neon-001', temperature: 0.7 },
      });
      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect(result.llmConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'HIGH' } });
    });
  });

  it('defaults to the global Vertex AI endpoint when GOOGLE_LOC is unset', () => {
    const result = getGoogleConfig(
      { [AuthKeys.GOOGLE_SERVICE_KEY]: { project_id: 'test-project' } },
      { modelOptions: { model: 'gemini-4-neon' } },
    );
    expect(result.llmConfig).toMatchObject({
      location: 'global',
      endpoint: 'aiplatform.googleapis.com',
    });
  });

  it.each([
    ['global', 'global', 'aiplatform.googleapis.com'],
    ['eu', 'eu', 'aiplatform.eu.rep.googleapis.com'],
    ['us', 'us', 'aiplatform.us.rep.googleapis.com'],
    ['europe-west4', 'eu', 'aiplatform.eu.rep.googleapis.com'],
    ['us-central1', 'us', 'aiplatform.us.rep.googleapis.com'],
  ])(
    'serves a configured %s Vertex AI location from the %s multi-region',
    (configured, location, endpoint) => {
      process.env.GOOGLE_LOC = configured;
      const result = getGoogleConfig(
        { [AuthKeys.GOOGLE_SERVICE_KEY]: { project_id: 'test-project' } },
        { modelOptions: { model: 'gemini-4-neon' } },
      );
      expect(result.llmConfig).toMatchObject({ location, endpoint });
    },
  );
});
