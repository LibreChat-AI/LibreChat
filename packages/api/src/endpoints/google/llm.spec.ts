import { Providers } from '@librechat/agents';
import { AuthKeys, ThinkingLevel } from 'librechat-data-provider';
import type { GoogleClientOptions } from '@librechat/agents';
import type * as t from '~/types';
import { getGoogleConfig, getSafetySettings, knownGoogleParams } from './llm';

describe('getGoogleConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.GOOGLE_EXCLUDE_SAFETY_SETTINGS;
    delete process.env.GOOGLE_LOC;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Basic Configuration', () => {
    it('should create a basic configuration with API key', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
        },
      });

      expect(result.provider).toBe(Providers.GOOGLE);
      expect(result.llmConfig).toHaveProperty('apiKey', 'test-api-key');
      expect(result.llmConfig).toHaveProperty('model', 'gemini-1.5-flash');
      expect(result.llmConfig).toHaveProperty('maxRetries', 2);
      expect(result.tools).toEqual([]);
    });

    it('should handle JSON string credentials', () => {
      const credentials = JSON.stringify({
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key-from-json',
      });

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-pro',
        },
      });

      expect(result.llmConfig).toHaveProperty('apiKey', 'test-api-key-from-json');
    });

    it('should handle acceptRawApiKey flag', () => {
      const result = getGoogleConfig(
        'raw-api-key-string',
        {
          modelOptions: {
            model: 'gemini-1.5-flash',
          },
        },
        true,
      );

      expect(result.llmConfig).toHaveProperty('apiKey', 'raw-api-key-string');
    });

    it('should not let project id force Vertex AI without the force flag', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        projectId: 'fiery-catwalk-385918',
        modelOptions: {
          model: 'gemini-2.5-flash',
        },
      });

      expect(result.provider).toBe(Providers.GOOGLE);
      expect(result.llmConfig).toHaveProperty('apiKey', 'test-api-key');
      expect(result.llmConfig).not.toHaveProperty('authOptions');
    });

    it('should handle model options including temperature and topP/topK', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
          temperature: 0.7,
          topP: 0.9,
          topK: 40,
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0.7);
      expect(result.llmConfig).toHaveProperty('topP', 0.9);
      expect(result.llmConfig).toHaveProperty('topK', 40);
    });

    it('should handle maxOutputTokens', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
          maxOutputTokens: 4096,
        },
      });

      expect(result.llmConfig).toHaveProperty('maxOutputTokens', 4096);
    });
  });

  describe('Model-aware maxOutputTokens default', () => {
    const credentials = {
      [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
    };
    const vertexCredentials = {
      [AuthKeys.GOOGLE_SERVICE_KEY]: {
        project_id: 'test-project',
        client_email: 'test@test-project.iam.gserviceaccount.com',
        private_key: 'test-private-key',
      },
    };

    it('defaults current Gemini models to 65535 when unset', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: { model: 'gemini-2.5-pro' },
      });
      expect(result.llmConfig).toHaveProperty('maxOutputTokens', 65535);
    });

    it('defaults Gemini 3.5 Flash to 65535 when unset', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: { model: 'gemini-3.5-flash' },
      });
      expect(result.llmConfig).toHaveProperty('maxOutputTokens', 65535);
    });

    it('defaults Gemini image models to 32768 when unset', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: { model: 'gemini-2.5-flash-image' },
      });
      expect(result.llmConfig).toHaveProperty('maxOutputTokens', 32768);
    });

    it('defaults legacy Gemini models to 8192 when unset', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: { model: 'gemini-2.0-flash' },
      });
      expect(result.llmConfig).toHaveProperty('maxOutputTokens', 8192);
    });

    it('keeps the Vertex default within the model output limit', () => {
      const result = getGoogleConfig(vertexCredentials, {
        modelOptions: { model: 'gemini-2.5-flash' },
      });
      expect(result.provider).toBe(Providers.VERTEXAI);
      expect(result.llmConfig).toHaveProperty('maxOutputTokens', 65535);
    });

    it('preserves an explicit maxOutputTokens value', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: { model: 'gemini-2.5-pro', maxOutputTokens: 1024 },
      });
      expect(result.llmConfig).toHaveProperty('maxOutputTokens', 1024);
    });

    it('lets a configured defaultParams maxOutputTokens take precedence over the model default', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: { model: 'gemini-2.5-pro' },
        defaultParams: { maxOutputTokens: 2048 },
      });
      expect(result.llmConfig).toHaveProperty('maxOutputTokens', 2048);
    });

    it('omits maxOutputTokens when listed in dropParams', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: { model: 'gemini-2.5-pro' },
        dropParams: ['maxOutputTokens'],
      });
      expect(result.llmConfig).not.toHaveProperty('maxOutputTokens');
    });

    it('bases the default on the final model after an addParams override', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: { model: 'gemini-1.5-flash' },
        addParams: { model: 'gemini-2.5-pro' },
      });
      expect(result.llmConfig).toHaveProperty('model', 'gemini-2.5-pro');
      expect(result.llmConfig).toHaveProperty('maxOutputTokens', 65535);
    });
  });

  describe('Empty String Handling (Issue Fix)', () => {
    it('should remove empty string maxOutputTokens from config', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      // Simulating empty string from form - cast to any to bypass TypeScript
      const modelOptions = {
        model: 'gemini-1.5-flash',
        maxOutputTokens: '',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: modelOptions as unknown as t.GoogleParameters,
      });

      expect(result.llmConfig).not.toHaveProperty('maxOutputTokens');
    });

    it('should remove empty string temperature from config', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const modelOptions = {
        model: 'gemini-1.5-flash',
        temperature: '',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: modelOptions as unknown as t.GoogleParameters,
      });

      expect(result.llmConfig).not.toHaveProperty('temperature');
    });

    it('should remove empty string topP from config', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const modelOptions = {
        model: 'gemini-1.5-flash',
        topP: '',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: modelOptions as unknown as t.GoogleParameters,
      });

      expect(result.llmConfig).not.toHaveProperty('topP');
    });

    it('should remove empty string topK from config', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const modelOptions = {
        model: 'gemini-1.5-flash',
        topK: '',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: modelOptions as unknown as t.GoogleParameters,
      });

      expect(result.llmConfig).not.toHaveProperty('topK');
    });

    it('should preserve valid numeric values while removing empty strings', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const modelOptions = {
        model: 'gemini-1.5-flash',
        temperature: 0.5,
        maxOutputTokens: '', // Empty string
        topP: 0.9,
        topK: '', // Empty string
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: modelOptions as unknown as t.GoogleParameters,
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0.5);
      expect(result.llmConfig).toHaveProperty('topP', 0.9);
      expect(result.llmConfig).not.toHaveProperty('maxOutputTokens');
      expect(result.llmConfig).not.toHaveProperty('topK');
    });

    it('should preserve zero values (not treat them as empty)', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
          temperature: 0,
          topK: 0,
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0);
      expect(result.llmConfig).toHaveProperty('topK', 0);
    });
  });

  describe('Vertex AI Configuration', () => {
    it('should configure Vertex AI with service account credentials', () => {
      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
          client_email: 'test@test-project.iam.gserviceaccount.com',
          private_key: 'test-private-key',
        },
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-pro',
        },
      });

      expect(result.provider).toBe(Providers.VERTEXAI);
      expect(result.llmConfig).toHaveProperty('authOptions');
      expect((result.llmConfig as Record<string, unknown>).authOptions).toMatchObject({
        projectId: 'test-project',
        credentials: expect.objectContaining({
          project_id: 'test-project',
        }),
      });
      expect(result.llmConfig).toHaveProperty('location', 'us-central1');
    });

    it('should force Vertex AI ADC config with a project id even when an API key is present', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        forceVertex: true,
        projectId: 'fiery-catwalk-385918',
        modelOptions: {
          model: 'gemini-2.5-flash',
        },
      });

      expect(result.provider).toBe(Providers.VERTEXAI);
      expect(result.llmConfig).not.toHaveProperty('apiKey');
      expect((result.llmConfig as Record<string, unknown>).authOptions).toEqual({
        projectId: 'fiery-catwalk-385918',
      });
    });

    it('should force Vertex AI service-account config when an API key is also present', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
          client_email: 'test@test-project.iam.gserviceaccount.com',
          private_key: 'test-private-key',
        },
      };

      const result = getGoogleConfig(credentials, {
        forceVertex: true,
        modelOptions: {
          model: 'gemini-2.5-flash',
        },
      });

      expect(result.provider).toBe(Providers.VERTEXAI);
      expect(result.llmConfig).not.toHaveProperty('apiKey');
      expect((result.llmConfig as Record<string, unknown>).authOptions).toMatchObject({
        projectId: 'test-project',
        credentials: expect.objectContaining({
          project_id: 'test-project',
        }),
      });
    });

    it('should use GOOGLE_LOC env variable for Vertex AI location', () => {
      process.env.GOOGLE_LOC = 'europe-west1';

      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
        },
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-pro',
        },
      });

      expect(result.llmConfig).toHaveProperty('location', 'europe-west1');
    });

    it('should use Vertex AI multi-region endpoints for eu and us locations', () => {
      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
        },
      };

      const locations = [
        { location: 'eu', endpoint: 'aiplatform.eu.rep.googleapis.com' },
        { location: 'us', endpoint: 'aiplatform.us.rep.googleapis.com' },
        { location: 'global', endpoint: 'aiplatform.googleapis.com' },
      ];

      locations.forEach(({ location, endpoint }) => {
        process.env.GOOGLE_LOC = location;

        const result = getGoogleConfig(credentials, {
          modelOptions: {
            model: 'gemini-3.1-flash-lite-preview',
          },
        });

        expect(result.llmConfig).toMatchObject({
          location,
          endpoint,
        });
      });
    });

    it('should derive Vertex AI endpoint from the final location value', () => {
      process.env.GOOGLE_LOC = 'us';

      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
        },
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.1-flash-lite-preview',
        },
        addParams: {
          location: 'eu',
        },
      });

      expect(result.llmConfig).toMatchObject({
        location: 'eu',
        endpoint: 'aiplatform.eu.rep.googleapis.com',
      });
    });

    it('should preserve explicit Google Vertex AI endpoint overrides', () => {
      process.env.GOOGLE_LOC = 'us';

      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
        },
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.1-flash-lite-preview',
        },
        addParams: {
          location: 'eu',
          endpoint: 'us-central1-aiplatform.googleapis.com',
        },
      });

      expect(result.llmConfig).toMatchObject({
        location: 'eu',
        endpoint: 'us-central1-aiplatform.googleapis.com',
      });
    });

    it('should preserve explicit Google Vertex AI Private Service Connect endpoints', () => {
      process.env.GOOGLE_LOC = 'us';

      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
        },
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.1-flash-lite-preview',
        },
        addParams: {
          endpoint: 'aiplatform-genai1.p.googleapis.com',
        },
      });

      expect(result.llmConfig).toMatchObject({
        location: 'us',
        endpoint: 'aiplatform-genai1.p.googleapis.com',
      });
    });

    it('should preserve explicit Google Vertex AI restricted Private Service Connect endpoints', () => {
      process.env.GOOGLE_LOC = 'us';

      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
        },
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.1-flash-lite-preview',
        },
        addParams: {
          endpoint: 'us-central1-aiplatform-restricted.p.googleapis.com',
        },
      });

      expect(result.llmConfig).toMatchObject({
        location: 'us',
        endpoint: 'us-central1-aiplatform-restricted.p.googleapis.com',
      });
    });

    it('should ignore model option Vertex AI endpoint overrides', () => {
      process.env.GOOGLE_LOC = 'eu';

      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
        },
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.1-flash-lite-preview',
          endpoint: 'attacker.example.test',
        } as t.GoogleParameters,
      });

      expect(result.llmConfig).toMatchObject({
        location: 'eu',
        endpoint: 'aiplatform.eu.rep.googleapis.com',
      });
    });

    it('should ignore model option transport-level overrides', () => {
      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
          client_email: 'test@test-project.iam.gserviceaccount.com',
        },
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.1-flash-lite-preview',
          apiKey: 'attacker-api-key',
          authOptions: { projectId: 'attacker-project' },
          baseUrl: 'https://attacker.example.test',
          customHeaders: { Authorization: 'Bearer attacker' },
        } as t.GoogleParameters,
      });

      expect(result.llmConfig).not.toHaveProperty('apiKey', 'attacker-api-key');
      expect(result.llmConfig).not.toHaveProperty('baseUrl');
      expect(result.llmConfig).not.toHaveProperty('customHeaders');
      expect((result.llmConfig as Record<string, unknown>).authOptions).toMatchObject({
        projectId: 'test-project',
      });
    });

    it('should ignore non-Google Vertex AI endpoint overrides from additional params', () => {
      process.env.GOOGLE_LOC = 'us';

      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
        },
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.1-flash-lite-preview',
        },
        addParams: {
          location: 'eu',
          endpoint: 'attacker.example.test',
        },
      });

      expect(result.llmConfig).toMatchObject({
        location: 'eu',
        endpoint: 'aiplatform.eu.rep.googleapis.com',
      });
    });

    it('should handle service key as JSON string', () => {
      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: JSON.stringify({
          project_id: 'test-project',
          client_email: 'test@test.iam.gserviceaccount.com',
        }),
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-pro',
        },
      });

      expect(result.provider).toBe(Providers.VERTEXAI);
    });
  });

  describe('Thinking Configuration', () => {
    it('should enable thinking for Google provider with valid budget', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.0-flash-thinking-exp',
          thinking: true,
          thinkingBudget: 5000,
        },
      });

      expect(result.llmConfig).toHaveProperty('thinkingConfig');
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        thinkingBudget: 5000,
        includeThoughts: true,
      });
    });

    it('should enable thinking with dynamic budget (-1)', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.0-flash-thinking-exp',
          thinking: true,
          thinkingBudget: -1,
        },
      });

      expect(result.llmConfig).toHaveProperty('thinkingConfig');
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        thinkingBudget: -1,
        includeThoughts: true,
      });
    });

    it('should not enable thinking when thinking is false', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.0-flash',
          thinking: false,
          thinkingBudget: 5000,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('thinkingConfig');
    });

    it('should not enable thinking when budget is 0', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.0-flash',
          thinking: true,
          thinkingBudget: 0,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('thinkingConfig');
    });

    it('should enable thinking for Vertex AI provider', () => {
      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
        },
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.0-flash-thinking-exp',
          thinking: true,
          thinkingBudget: 3000,
        },
      });

      expect(result.provider).toBe(Providers.VERTEXAI);
      expect(result.llmConfig).toHaveProperty('thinkingBudget', 3000);
      expect(result.llmConfig).toHaveProperty('includeThoughts', true);
    });
  });

  describe('Gemini 3 Thinking Level', () => {
    it('should use thinkingLevel for Gemini 3 models with Google provider', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3-pro-preview',
          thinking: true,
          thinkingLevel: ThinkingLevel.high,
        },
      });

      expect(result.llmConfig).toHaveProperty('thinkingConfig');
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'HIGH',
      });
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).not.toHaveProperty(
        'thinkingBudget',
      );
    });

    it('should use thinkingLevel for Gemini 3.1 models', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.1-pro-preview',
          thinking: true,
          thinkingLevel: ThinkingLevel.medium,
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'MEDIUM',
      });
    });

    it('should preserve minimal thinkingLevel for Gemini 3 Flash models', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3-flash-preview',
          thinking: true,
          thinkingLevel: ThinkingLevel.minimal,
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'MINIMAL',
      });
    });

    it('should default Gemini 3.5 Flash to medium thinkingLevel', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.5-flash',
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'MEDIUM',
      });
    });

    it('should preserve explicit Gemini 3.5 Flash thinkingLevel', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.5-flash',
          thinkingLevel: ThinkingLevel.low,
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'LOW',
      });
    });

    it('should apply Gemini 3.5 Flash overrides to versioned aliases', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'google/gemini-3.5-flash-latest',
          temperature: 0.7,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'MEDIUM',
      });
    });

    it('should remove legacy sampling params for Gemini 3.5 Flash', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const modelOptions = {
        model: 'gemini-3.5-flash',
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        top_p: 0.9,
        top_k: 40,
        thinking_budget: 5000,
      } as unknown as t.GoogleParameters;

      const result = getGoogleConfig(credentials, {
        modelOptions,
        defaultParams: {
          temperature: 0.5,
          topP: 0.8,
          topK: 20,
        },
        addParams: {
          temperature: 0.2,
          topP: 0.6,
          topK: 10,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect(result.llmConfig).not.toHaveProperty('topP');
      expect(result.llmConfig).not.toHaveProperty('topK');
      expect(result.llmConfig).not.toHaveProperty('top_p');
      expect(result.llmConfig).not.toHaveProperty('top_k');
      expect(result.llmConfig).not.toHaveProperty('thinking_budget');
    });

    it('should respect dropParams for Gemini 3.5 Flash thinkingConfig', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.5-flash',
        },
        dropParams: ['thinkingConfig'],
      });

      expect(result.llmConfig).not.toHaveProperty('thinkingConfig');
    });

    it('should respect dropParams for Gemini 3.5 Flash includeThoughts', () => {
      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
        },
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.5-flash',
        },
        dropParams: ['includeThoughts'],
      });

      expect(result.llmConfig).not.toHaveProperty('includeThoughts');
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        thinkingLevel: 'MEDIUM',
      });
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).not.toHaveProperty(
        'includeThoughts',
      );
    });

    it('should remove empty Gemini 3.5 Flash thinkingConfig when all fields are dropped', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.5-flash',
        },
        dropParams: ['includeThoughts', 'thinkingLevel'],
      });

      expect(result.llmConfig).not.toHaveProperty('thinkingConfig');
    });

    it('should default Gemini 3.6 Flash to medium thinkingLevel', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.6-flash',
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'MEDIUM',
      });
    });

    it('should remove legacy sampling params for Gemini 3.6 Flash', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const modelOptions = {
        model: 'gemini-3.6-flash',
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        top_p: 0.9,
        top_k: 40,
        presencePenalty: 0.5,
        frequencyPenalty: 0.5,
        thinking_budget: 5000,
      } as unknown as t.GoogleParameters;

      const result = getGoogleConfig(credentials, { modelOptions });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect(result.llmConfig).not.toHaveProperty('topP');
      expect(result.llmConfig).not.toHaveProperty('topK');
      expect(result.llmConfig).not.toHaveProperty('top_p');
      expect(result.llmConfig).not.toHaveProperty('top_k');
      expect(result.llmConfig).not.toHaveProperty('presencePenalty');
      expect(result.llmConfig).not.toHaveProperty('frequencyPenalty');
      expect(result.llmConfig).not.toHaveProperty('thinking_budget');
    });

    it('should default Gemini 3.7 Flash to medium thinkingLevel', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.7-flash',
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'MEDIUM',
      });
    });

    it('should remove legacy sampling params for Gemini 3.7 Flash', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const modelOptions = {
        model: 'gemini-3.7-flash',
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        top_p: 0.9,
        top_k: 40,
        presencePenalty: 0.5,
        frequencyPenalty: 0.5,
        thinking_budget: 5000,
      } as unknown as t.GoogleParameters;

      const result = getGoogleConfig(credentials, { modelOptions });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect(result.llmConfig).not.toHaveProperty('topP');
      expect(result.llmConfig).not.toHaveProperty('topK');
      expect(result.llmConfig).not.toHaveProperty('top_p');
      expect(result.llmConfig).not.toHaveProperty('top_k');
      expect(result.llmConfig).not.toHaveProperty('presencePenalty');
      expect(result.llmConfig).not.toHaveProperty('frequencyPenalty');
      expect(result.llmConfig).not.toHaveProperty('thinking_budget');
    });

    it.each([
      [ThinkingLevel.low, 'LOW'],
      [ThinkingLevel.medium, 'MEDIUM'],
      [ThinkingLevel.high, 'HIGH'],
    ])('should preserve explicit Gemini 3.7 Flash thinkingLevel "%s"', (level, expected) => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.7-flash',
          thinkingLevel: level,
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: expected,
      });
    });

    it('should substitute minimal thinkingLevel with low for Gemini 3.7 Flash', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.7-flash',
          thinkingLevel: ThinkingLevel.minimal,
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'LOW',
      });
    });

    it('should apply Gemini 3.7 Flash handling to versioned aliases', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'models/gemini-3.7-flash-latest',
          temperature: 0.7,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'MEDIUM',
      });
    });

    it('should default Gemini 3.8 Flash to medium thinkingLevel', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.8-flash',
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'MEDIUM',
      });
    });

    it('should remove legacy sampling params for Gemini 3.8 Flash', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const modelOptions = {
        model: 'gemini-3.8-flash',
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        top_p: 0.9,
        top_k: 40,
        presencePenalty: 0.5,
        frequencyPenalty: 0.5,
        thinking_budget: 5000,
      } as unknown as t.GoogleParameters;

      const result = getGoogleConfig(credentials, { modelOptions });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect(result.llmConfig).not.toHaveProperty('topP');
      expect(result.llmConfig).not.toHaveProperty('topK');
      expect(result.llmConfig).not.toHaveProperty('top_p');
      expect(result.llmConfig).not.toHaveProperty('top_k');
      expect(result.llmConfig).not.toHaveProperty('presencePenalty');
      expect(result.llmConfig).not.toHaveProperty('frequencyPenalty');
      expect(result.llmConfig).not.toHaveProperty('thinking_budget');
    });

    it.each([
      [ThinkingLevel.low, 'LOW'],
      [ThinkingLevel.medium, 'MEDIUM'],
      [ThinkingLevel.high, 'HIGH'],
    ])('should preserve explicit Gemini 3.8 Flash thinkingLevel "%s"', (level, expected) => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.8-flash',
          thinkingLevel: level,
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: expected,
      });
    });

    it('should substitute minimal thinkingLevel with low for Gemini 3.8 Flash', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.8-flash',
          thinkingLevel: ThinkingLevel.minimal,
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'LOW',
      });
    });

    it('should apply Gemini 3.8 Flash handling to versioned aliases', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'models/gemini-3.8-flash-latest',
          temperature: 0.7,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'MEDIUM',
      });
    });

    it('should remove unsupported penalty params for Gemini 3.5 Flash-Lite', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.5-flash-lite',
          presencePenalty: 0.5,
          frequencyPenalty: 0.5,
        } as unknown as t.GoogleParameters,
        addParams: {
          presencePenalty: 0.3,
          frequencyPenalty: 0.3,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('presencePenalty');
      expect(result.llmConfig).not.toHaveProperty('frequencyPenalty');
    });

    it('should default Gemini 3.5 Flash-Lite to minimal thinkingLevel', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.5-flash-lite',
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'MINIMAL',
      });
    });

    it('should resolve Flash-Lite default over the Flash prefix for versioned aliases', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'google/gemini-3.5-flash-lite-latest',
          temperature: 0.7,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'MINIMAL',
      });
    });

    it('should preserve explicit Gemini 3.5 Flash-Lite thinkingLevel', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3.5-flash-lite',
          thinkingLevel: ThinkingLevel.high,
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'HIGH',
      });
    });

    it('should omit thinkingLevel when unset (empty string) for Gemini 3', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3-flash-preview',
          thinking: true,
          thinkingLevel: ThinkingLevel.unset,
        },
      });

      expect(result.llmConfig).toHaveProperty('thinkingConfig');
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
      });
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).not.toHaveProperty(
        'thinkingLevel',
      );
    });

    it('should not set thinkingConfig when thinking is false for Gemini 3', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3-pro-preview',
          thinking: false,
          thinkingLevel: ThinkingLevel.high,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('thinkingConfig');
    });

    it('should use thinkingLevel for Gemini 3 with Vertex AI provider', () => {
      const credentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
        },
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3-pro-preview',
          thinking: true,
          thinkingLevel: ThinkingLevel.low,
        },
      });

      expect(result.provider).toBe(Providers.VERTEXAI);
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'LOW',
      });
      expect(result.llmConfig).toHaveProperty('includeThoughts', true);
    });

    it('should send thinkingConfig by default for Gemini 3 (no thinking options set)', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3-pro-preview',
        },
      });

      expect(result.llmConfig).toHaveProperty('thinkingConfig');
      const config = (result.llmConfig as Record<string, unknown>).thinkingConfig;
      expect(config).toMatchObject({ includeThoughts: true });
      expect(config).not.toHaveProperty('thinkingLevel');
    });

    it('should ignore thinkingBudget for Gemini 3+ models', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3-pro-preview',
          thinking: true,
          thinkingBudget: 5000,
        },
      });

      const config = (result.llmConfig as Record<string, unknown>).thinkingConfig;
      expect(config).not.toHaveProperty('thinkingBudget');
      expect(config).toMatchObject({ includeThoughts: true });
    });

    it('should use thinkingLevel for Gemma 4 models', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemma-4-31b-it',
          thinking: true,
          thinkingLevel: ThinkingLevel.high,
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        includeThoughts: true,
        thinkingLevel: 'HIGH',
      });
    });

    it('should ignore thinkingBudget for Gemma 4 models', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemma-4-31b-it',
          thinking: true,
          thinkingBudget: 5000,
        },
      });

      const config = (result.llmConfig as Record<string, unknown>).thinkingConfig;
      expect(config).not.toHaveProperty('thinkingBudget');
      expect(config).toMatchObject({ includeThoughts: true });
    });

    it('should NOT classify gemini-2.9-flash as Gemini 3+', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.9-flash',
          thinking: true,
          thinkingBudget: 5000,
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        thinkingBudget: 5000,
        includeThoughts: true,
      });
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).not.toHaveProperty(
        'thinkingLevel',
      );
    });

    it('should use thinkingBudget (not thinkingLevel) for Gemini 2.5 models', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.5-flash',
          thinking: true,
          thinkingBudget: 5000,
          thinkingLevel: ThinkingLevel.high,
        },
      });

      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).toMatchObject({
        thinkingBudget: 5000,
        includeThoughts: true,
      });
      expect((result.llmConfig as Record<string, unknown>).thinkingConfig).not.toHaveProperty(
        'thinkingLevel',
      );
    });
  });

  describe('Web Search Functionality', () => {
    it('should enable web search when web_search is true', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
          web_search: true,
        },
      });

      expect(result.tools).toContainEqual({ googleSearch: {} });
    });

    it('should not include web search tools when web_search is false', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
          web_search: false,
        },
      });

      expect(result.tools).not.toContainEqual({ googleSearch: {} });
    });

    it('should enable web search via defaultParams', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
        },
        defaultParams: {
          web_search: true,
        },
      });

      expect(result.tools).toContainEqual({ googleSearch: {} });
    });

    it('should enable web search via addParams', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
        },
        addParams: {
          web_search: true,
        },
      });

      expect(result.tools).toContainEqual({ googleSearch: {} });
    });

    it('should disable web search via dropParams', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
          web_search: true,
        },
        dropParams: ['web_search'],
      });

      expect(result.tools).not.toContainEqual({ googleSearch: {} });
    });
  });

  describe('URL Context Functionality', () => {
    const credentials = {
      [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
    };

    it('should enable the urlContext tool when url_context is true', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.5-flash',
          url_context: true,
        },
      });

      expect(result.tools).toContainEqual({ urlContext: {} });
    });

    it('should not include the urlContext tool when url_context is false', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.5-flash',
          url_context: false,
        },
      });

      expect(result.tools).not.toContainEqual({ urlContext: {} });
    });

    it('should not include the urlContext tool when url_context is unset', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.5-flash',
        },
      });

      expect(result.tools).not.toContainEqual({ urlContext: {} });
    });

    it('should enable url context via defaultParams', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.5-flash',
        },
        defaultParams: {
          url_context: true,
        },
      });

      expect(result.tools).toContainEqual({ urlContext: {} });
    });

    it('should enable url context via addParams', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.5-flash',
        },
        addParams: {
          url_context: true,
        },
      });

      expect(result.tools).toContainEqual({ urlContext: {} });
    });

    it('should let addParams override a defaultParams url_context', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.5-flash',
        },
        defaultParams: {
          url_context: true,
        },
        addParams: {
          url_context: false,
        },
      });

      expect(result.tools).not.toContainEqual({ urlContext: {} });
    });

    it('should disable url context via dropParams', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.5-flash',
          url_context: true,
        },
        dropParams: ['url_context'],
      });

      expect(result.tools).not.toContainEqual({ urlContext: {} });
    });

    it('should not leak url_context into the llmConfig', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.5-flash',
          url_context: true,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('url_context');
    });

    it('should enable both googleSearch and urlContext tools together', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-2.5-flash',
          web_search: true,
          url_context: true,
        },
      });

      expect(result.tools).toContainEqual({ googleSearch: {} });
      expect(result.tools).toContainEqual({ urlContext: {} });
    });

    it('should not include the urlContext tool on models that do not support it (Gemini < 2.5)', () => {
      for (const model of ['gemini-2.0-flash', 'gemini-1.5-pro']) {
        const result = getGoogleConfig(credentials, {
          modelOptions: {
            model,
            url_context: true,
          },
        });
        expect(result.tools).not.toContainEqual({ urlContext: {} });
      }
    });

    it('should enable the urlContext tool on Gemini 3.x models', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-3-pro-preview',
          url_context: true,
        },
      });

      expect(result.tools).toContainEqual({ urlContext: {} });
    });

    it('should not include the urlContext tool on non-text modality variants', () => {
      for (const model of [
        'gemini-2.5-flash-image',
        'gemini-3-pro-image-preview',
        'gemini-3.5-flash-live',
        'gemini-2.5-flash-tts',
        'gemini-2.5-flash-preview-native-audio-dialog',
      ]) {
        const result = getGoogleConfig(credentials, {
          modelOptions: {
            model,
            url_context: true,
          },
        });
        expect(result.tools).not.toContainEqual({ urlContext: {} });
      }
    });

    it('should enable the urlContext tool for the Vertex AI provider', () => {
      const vertexCredentials = {
        [AuthKeys.GOOGLE_SERVICE_KEY]: {
          project_id: 'test-project',
        },
      };

      const result = getGoogleConfig(vertexCredentials, {
        modelOptions: {
          model: 'gemini-2.5-flash',
          url_context: true,
        },
      });

      expect(result.provider).toBe(Providers.VERTEXAI);
      expect(result.tools).toContainEqual({ urlContext: {} });
    });
  });

  describe('Default and Add Parameters', () => {
    it('should apply default parameters when fields are undefined', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
        },
        defaultParams: {
          temperature: 0.5,
          topP: 0.9,
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0.5);
      expect(result.llmConfig).toHaveProperty('topP', 0.9);
    });

    it('should NOT override existing values with default parameters', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
          temperature: 0.8,
        },
        defaultParams: {
          temperature: 0.5,
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0.8);
    });

    it('should apply addParams and override defaults', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
        },
        defaultParams: {
          temperature: 0.5,
        },
        addParams: {
          temperature: 0.9,
          seed: 42,
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0.9);
      expect(result.llmConfig).toHaveProperty('seed', 42);
    });

    it('should only apply known Google params from defaultParams', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
        },
        defaultParams: {
          temperature: 0.7,
          unknown_param: 'should_not_appear',
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0.7);
      expect(result.llmConfig).not.toHaveProperty('unknown_param');
    });
  });

  describe('Drop Parameters', () => {
    it('should drop specified parameters from llmConfig', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
          temperature: 0.7,
          topP: 0.9,
        },
        dropParams: ['temperature'],
      });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect(result.llmConfig).toHaveProperty('topP', 0.9);
    });

    it('should handle dropping multiple parameters', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
          temperature: 0.7,
          topP: 0.9,
          topK: 40,
        },
        dropParams: ['temperature', 'topK'],
      });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect(result.llmConfig).not.toHaveProperty('topK');
      expect(result.llmConfig).toHaveProperty('topP', 0.9);
    });
  });

  describe('Reverse Proxy Configuration', () => {
    it('should include reverse proxy URL when provided', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
        },
        reverseProxyUrl: 'https://custom-proxy.example.com',
      });

      expect(result.llmConfig).toHaveProperty('baseUrl', 'https://custom-proxy.example.com');
    });

    it('should include custom auth header when authHeader is true', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {
          model: 'gemini-1.5-flash',
        },
        reverseProxyUrl: 'https://custom-proxy.example.com',
        authHeader: true,
      });

      expect(result.llmConfig).toHaveProperty('customHeaders');
      expect((result.llmConfig as Record<string, unknown>).customHeaders).toMatchObject({
        Authorization: 'Bearer test-api-key',
      });
    });
  });

  describe('Error Handling', () => {
    it('should throw error when missing credentials', () => {
      expect(() => {
        getGoogleConfig(undefined, {
          modelOptions: {
            model: 'gemini-1.5-flash',
          },
        });
      }).toThrow('Invalid credentials provided');
    });

    it('should throw error when credentials are empty object', () => {
      expect(() => {
        getGoogleConfig(
          {},
          {
            modelOptions: {
              model: 'gemini-1.5-flash',
            },
          },
        );
      }).toThrow('Invalid credentials provided');
    });

    it('should throw error when JSON parsing fails', () => {
      expect(() => {
        getGoogleConfig('invalid-json', {
          modelOptions: {
            model: 'gemini-1.5-flash',
          },
        });
      }).toThrow('Error parsing string credentials');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty modelOptions', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: {},
      });

      // Empty string model is removed by removeNullishValues with removeEmptyStrings=true
      expect(result.llmConfig).not.toHaveProperty('model');
      expect(result.llmConfig).toHaveProperty('maxRetries', 2);
    });

    it('should handle undefined modelOptions', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials, {});

      // Empty string model is removed by removeNullishValues with removeEmptyStrings=true
      expect(result.llmConfig).not.toHaveProperty('model');
    });

    it('should handle no options parameter', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const result = getGoogleConfig(credentials);

      // Empty string model is removed by removeNullishValues with removeEmptyStrings=true
      expect(result.llmConfig).not.toHaveProperty('model');
      expect(result.provider).toBe(Providers.GOOGLE);
    });

    it('should handle nullish values removal', () => {
      const credentials = {
        [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
      };

      const modelOptions = {
        model: 'gemini-1.5-flash',
        temperature: undefined,
        topP: null,
        topK: 0, // Should be preserved
      };

      const result = getGoogleConfig(credentials, {
        modelOptions: modelOptions as unknown as t.GoogleParameters,
      });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect(result.llmConfig).not.toHaveProperty('topP');
      expect(result.llmConfig).toHaveProperty('topK', 0);
    });
  });
});

describe('getSafetySettings', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.GOOGLE_EXCLUDE_SAFETY_SETTINGS;
    delete process.env.GOOGLE_SAFETY_SEXUALLY_EXPLICIT;
    delete process.env.GOOGLE_SAFETY_HATE_SPEECH;
    delete process.env.GOOGLE_SAFETY_HARASSMENT;
    delete process.env.GOOGLE_SAFETY_DANGEROUS_CONTENT;
    delete process.env.GOOGLE_SAFETY_CIVIC_INTEGRITY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should return default safety settings', () => {
    const settings = getSafetySettings('gemini-1.5-flash');

    expect(settings).toHaveLength(5);
    expect(settings).toContainEqual({
      category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      threshold: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
    });
  });

  it('should return undefined when GOOGLE_EXCLUDE_SAFETY_SETTINGS is enabled', () => {
    process.env.GOOGLE_EXCLUDE_SAFETY_SETTINGS = 'true';

    const settings = getSafetySettings('gemini-1.5-flash');

    expect(settings).toBeUndefined();
  });

  it('should map OFF to BLOCK_NONE for Gemini 1.x models', () => {
    process.env.GOOGLE_SAFETY_SEXUALLY_EXPLICIT = 'OFF';

    const settings = getSafetySettings('gemini-1.5-flash');

    expect(settings).toContainEqual({
      category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      threshold: 'BLOCK_NONE',
    });
  });

  it('should use custom thresholds from environment variables', () => {
    process.env.GOOGLE_SAFETY_HATE_SPEECH = 'BLOCK_MEDIUM_AND_ABOVE';

    const settings = getSafetySettings('gemini-1.5-flash');

    expect(settings).toContainEqual({
      category: 'HARM_CATEGORY_HATE_SPEECH',
      threshold: 'BLOCK_MEDIUM_AND_ABOVE',
    });
  });
});

describe('knownGoogleParams', () => {
  it('should contain essential Google parameters', () => {
    expect(knownGoogleParams.has('model')).toBe(true);
    expect(knownGoogleParams.has('temperature')).toBe(true);
    expect(knownGoogleParams.has('maxOutputTokens')).toBe(true);
    expect(knownGoogleParams.has('topP')).toBe(true);
    expect(knownGoogleParams.has('topK')).toBe(true);
    expect(knownGoogleParams.has('apiKey')).toBe(true);
    expect(knownGoogleParams.has('endpoint')).toBe(true);
    expect(knownGoogleParams.has('safetySettings')).toBe(true);
  });

  it('should not contain non-Google parameters', () => {
    expect(knownGoogleParams.has('max_tokens')).toBe(false);
    expect(knownGoogleParams.has('frequency_penalty')).toBe(false);
    expect(knownGoogleParams.has('presence_penalty')).toBe(false);
  });

  describe('custom headers', () => {
    const credentials = { [AuthKeys.GOOGLE_API_KEY]: 'test-api-key' };

    it('attaches admin-configured headers to customHeaders, keeping placeholders intact', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: { model: 'gemini-1.5-flash' },
        headers: {
          'cf-aig-metadata': '{"user_email":"{{LIBRECHAT_USER_EMAIL}}"}',
        },
      });

      expect((result.llmConfig as GoogleClientOptions).customHeaders).toEqual({
        'cf-aig-metadata': '{"user_email":"{{LIBRECHAT_USER_EMAIL}}"}',
      });
    });

    it('does not let custom headers override the provider-managed Authorization header', () => {
      const result = getGoogleConfig(credentials, {
        modelOptions: { model: 'gemini-1.5-flash' },
        authHeader: true,
        headers: { Authorization: 'Bearer attacker', 'X-Conversation-Id': 'cid' },
      });

      expect((result.llmConfig as GoogleClientOptions).customHeaders).toEqual({
        Authorization: 'Bearer test-api-key',
        'X-Conversation-Id': 'cid',
      });
    });
  });
});
