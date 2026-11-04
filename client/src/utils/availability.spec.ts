import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelSpec, TConversation } from 'librechat-data-provider';
import {
  isProviderAvailable,
  isModelSpecAvailable,
  isConversationModelAvailable,
} from './availability';

describe('provider visibility', () => {
  it('waits for discovery, hides an empty provider, and restores it on the next response', () => {
    expect(isProviderAvailable('gateway', undefined, {})).toBe(true);
    expect(isProviderAvailable('gateway', { gateway: [] }, {})).toBe(false);
    expect(isProviderAvailable('gateway', { gateway: ['model'] }, {})).toBe(true);
  });
  it('keeps personal-key setup and agent and Assistant groups reachable', () => {
    expect(
      isProviderAvailable('gateway', { gateway: [] }, { gateway: { userProvide: true, order: 1 } }),
    ).toBe(true);
    for (const endpoint of [
      EModelEndpoint.agents,
      EModelEndpoint.assistants,
      EModelEndpoint.azureAssistants,
    ]) {
      expect(isProviderAvailable(endpoint, {}, {})).toBe(true);
    }
  });
  it('filters unavailable model specs without changing their saved preset', () => {
    const spec = {
      name: 'saved',
      preset: { endpoint: 'gateway', model: 'saved-model' },
    } as TModelSpec;
    expect(isModelSpecAvailable(spec, undefined)).toBe(true);
    expect(isModelSpecAvailable(spec, { gateway: [] })).toBe(false);
    expect(isModelSpecAvailable(spec, { gateway: ['other'] })).toBe(false);
    expect(isModelSpecAvailable(spec, { gateway: ['saved-model'] })).toBe(true);
    expect(spec.preset.model).toBe('saved-model');
  });
});

describe('conversation model availability', () => {
  const endpoints = { openAI: { order: 0 }, agents: { order: 1 }, assistants: { order: 2 } };
  const conversation: TConversation = {
    endpoint: EModelEndpoint.openAI,
    model: 'saved',
    conversationId: 'saved-chat',
    title: 'Saved',
    createdAt: '',
    updatedAt: '',
  };
  const available = (models: Record<string, string[]> | undefined, selection = conversation) =>
    isConversationModelAvailable({ conversation: selection, models, endpoints });

  it('blocks missing, loading, empty and removed models without changing the saved selection', () => {
    expect(available(undefined)).toBe(false);
    expect(available({ openAI: [] })).toBe(false);
    expect(available({ openAI: ['other'] })).toBe(false);
    expect(available({ openAI: ['saved'] }, { ...conversation, model: '' })).toBe(false);
    expect(
      available({ openAI: ['saved'] }, { ...conversation, endpoint: EModelEndpoint.anthropic }),
    ).toBe(false);
    expect(conversation).toMatchObject({ endpoint: EModelEndpoint.openAI, model: 'saved' });
    expect(available({ openAI: ['saved'] })).toBe(true);
  });

  it('preserves the existing personal-key model exception', () => {
    expect(
      isConversationModelAvailable({
        conversation,
        models: { openAI: [] },
        endpoints: { openAI: { order: 0, userProvide: true } },
      }),
    ).toBe(true);
    expect(
      isConversationModelAvailable({
        conversation: { ...conversation, model: '' },
        models: {},
        endpoints: { openAI: { order: 0, userProvide: true } },
      }),
    ).toBe(false);
  });

  it('leaves saved agent validation to the existing server checks', () => {
    const selection = {
      ...conversation,
      endpoint: EModelEndpoint.agents,
      model: null,
      agent_id: 'agent_saved',
    };
    expect(
      isConversationModelAvailable({ conversation: selection, endpoints, models: { openAI: [] } }),
    ).toBe(true);
  });

  it('resolves an ephemeral agent to its actual provider and model', () => {
    const selection = {
      ...conversation,
      endpoint: EModelEndpoint.agents,
      model: null,
      agent_id: 'openAI__saved',
    };
    expect(
      isConversationModelAvailable({ conversation: selection, endpoints, models: { openAI: [] } }),
    ).toBe(false);
    expect(
      isConversationModelAvailable({
        conversation: selection,
        endpoints,
        models: { openAI: ['saved'] },
      }),
    ).toBe(true);
  });
});
