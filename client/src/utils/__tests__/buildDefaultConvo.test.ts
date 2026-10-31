import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import buildDefaultConvo from '../buildDefaultConvo';

jest.mock('../localStorage', () => ({
  getLocalStorageItems: jest.fn(() => ({
    lastSelectedModel: {},
    lastSelectedTools: [],
    lastConversationSetup: {},
  })),
}));

const baseConversation: TConversation = {
  conversationId: 'test-convo-id',
  title: 'Test Conversation',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  endpoint: null,
};

describe('buildDefaultConvo - defaultParamsEndpoint', () => {
  describe('custom endpoint with defaultParamsEndpoint: anthropic', () => {
    const models = ['anthropic/claude-opus-4.5', 'anthropic/claude-sonnet-4'];

    it('should preserve maxOutputTokens from model spec preset', () => {
      const preset: TConversation = {
        ...baseConversation,
        endpoint: 'AnthropicClaude' as EModelEndpoint,
        endpointType: EModelEndpoint.custom,
        model: 'anthropic/claude-opus-4.5',
        temperature: 0.7,
        maxOutputTokens: 8192,
        topP: 0.9,
        maxContextTokens: 50000,
      };

      const result = buildDefaultConvo({
        models,
        conversation: baseConversation,
        endpoint: 'AnthropicClaude' as EModelEndpoint,
        lastConversationSetup: preset,
        defaultParamsEndpoint: EModelEndpoint.anthropic,
      });

      expect(result.maxOutputTokens).toBe(8192);
      expect(result.topP).toBe(0.9);
      expect(result.temperature).toBe(0.7);
      expect(result.maxContextTokens).toBe(50000);
      expect(result.model).toBe('anthropic/claude-opus-4.5');
    });

    it('should strip maxOutputTokens without defaultParamsEndpoint', () => {
      const preset: TConversation = {
        ...baseConversation,
        endpoint: 'AnthropicClaude' as EModelEndpoint,
        endpointType: EModelEndpoint.custom,
        model: 'anthropic/claude-opus-4.5',
        temperature: 0.7,
        maxOutputTokens: 8192,
      };

      const result = buildDefaultConvo({
        models,
        conversation: baseConversation,
        endpoint: 'AnthropicClaude' as EModelEndpoint,
        lastConversationSetup: preset,
      });

      expect(result.maxOutputTokens).toBeUndefined();
      expect(result.temperature).toBe(0.7);
    });

    it('should strip OpenAI-specific fields when using anthropic params', () => {
      const preset: TConversation = {
        ...baseConversation,
        endpoint: 'AnthropicClaude' as EModelEndpoint,
        endpointType: EModelEndpoint.custom,
        model: 'anthropic/claude-opus-4.5',
        max_tokens: 4096,
        top_p: 0.9,
        presence_penalty: 0.5,
        frequency_penalty: 0.3,
      };

      const result = buildDefaultConvo({
        models,
        conversation: baseConversation,
        endpoint: 'AnthropicClaude' as EModelEndpoint,
        lastConversationSetup: preset,
        defaultParamsEndpoint: EModelEndpoint.anthropic,
      });

      expect(result.max_tokens).toBeUndefined();
      expect(result.top_p).toBeUndefined();
      expect(result.presence_penalty).toBeUndefined();
      expect(result.frequency_penalty).toBeUndefined();
    });
  });

  describe('custom endpoint without defaultParamsEndpoint (OpenAI default)', () => {
    const models = ['gpt-4o', 'gpt-4.1'];

    it('should preserve OpenAI fields and strip anthropic fields', () => {
      const preset: TConversation = {
        ...baseConversation,
        endpoint: 'MyOpenRouterEndpoint' as EModelEndpoint,
        endpointType: EModelEndpoint.custom,
        model: 'gpt-4o',
        temperature: 0.7,
        max_tokens: 4096,
        top_p: 0.9,
        maxOutputTokens: 8192,
      };

      const result = buildDefaultConvo({
        models,
        conversation: baseConversation,
        endpoint: 'MyOpenRouterEndpoint' as EModelEndpoint,
        lastConversationSetup: preset,
      });

      expect(result.max_tokens).toBe(4096);
      expect(result.top_p).toBe(0.9);
      expect(result.temperature).toBe(0.7);
      expect(result.maxOutputTokens).toBeUndefined();
    });
  });

  describe('custom endpoint with defaultParamsEndpoint: google', () => {
    const models = ['gemini-pro', 'gemini-1.5-pro'];

    it('should preserve Google-specific fields', () => {
      const preset: TConversation = {
        ...baseConversation,
        endpoint: 'MyGoogleEndpoint' as EModelEndpoint,
        endpointType: EModelEndpoint.custom,
        model: 'gemini-pro',
        temperature: 0.7,
        maxOutputTokens: 8192,
        topP: 0.9,
        topK: 40,
      };

      const result = buildDefaultConvo({
        models,
        conversation: baseConversation,
        endpoint: 'MyGoogleEndpoint' as EModelEndpoint,
        lastConversationSetup: preset,
        defaultParamsEndpoint: EModelEndpoint.google,
      });

      expect(result.maxOutputTokens).toBe(8192);
      expect(result.topP).toBe(0.9);
      expect(result.topK).toBe(40);
    });
  });

  describe('cross-endpoint field isolation', () => {
    it('should not carry bedrock region to a custom endpoint', () => {
      const preset: TConversation = {
        ...baseConversation,
        endpoint: 'MyChatEndpoint' as EModelEndpoint,
        endpointType: EModelEndpoint.custom,
        model: 'gpt-4o',
        temperature: 0.7,
        region: 'us-east-1',
      };

      const result = buildDefaultConvo({
        models: ['gpt-4o'],
        conversation: baseConversation,
        endpoint: 'MyChatEndpoint' as EModelEndpoint,
        lastConversationSetup: preset,
      });

      expect(result.region).toBeUndefined();
      expect(result.temperature).toBe(0.7);
    });

    it('should not carry bedrock region even with anthropic defaultParamsEndpoint', () => {
      const preset: TConversation = {
        ...baseConversation,
        endpoint: 'MyChatEndpoint' as EModelEndpoint,
        endpointType: EModelEndpoint.custom,
        model: 'claude-3-opus',
        region: 'us-east-1',
        maxOutputTokens: 8192,
      };

      const result = buildDefaultConvo({
        models: ['claude-3-opus'],
        conversation: baseConversation,
        endpoint: 'MyChatEndpoint' as EModelEndpoint,
        lastConversationSetup: preset,
        defaultParamsEndpoint: EModelEndpoint.anthropic,
      });

      expect(result.region).toBeUndefined();
      expect(result.maxOutputTokens).toBe(8192);
    });
  });
});

describe('selection independent of model discovery', () => {
  const selected = {
    conversationId: 'new',
    endpoint: EModelEndpoint.openAI,
    model: 'explicit-model',
    createdAt: '',
    updatedAt: '',
    title: '',
  } as TConversation;

  it('preserves an explicit model even when a different catalog default arrives', () => {
    expect(
      buildDefaultConvo({
        conversation: selected,
        endpoint: EModelEndpoint.openAI,
        lastConversationSetup: selected,
        models: ['another-model'],
      }).model,
    ).toBe('explicit-model');
  });

  it('leaves an unresolved model undecided rather than selecting a placeholder', () => {
    expect(
      buildDefaultConvo({
        conversation: { ...selected, model: undefined },
        endpoint: EModelEndpoint.openAI,
        lastConversationSetup: null,
      }).model,
    ).toBeUndefined();
  });
});
