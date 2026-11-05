import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelSpec, TModelsConfig, TConversation } from 'librechat-data-provider';
import {
  isProviderAvailable,
  isModelSpecAvailable,
  isConversationModelAvailable,
} from './availability';

describe('provider visibility', () => {
  it('waits for discovery, hides an empty provider, and restores it on the next response', () => {
    expect(isProviderAvailable('gateway', undefined)).toBe(true);
    expect(isProviderAvailable('gateway', { gateway: [] })).toBe(false);
    expect(isProviderAvailable('gateway', { gateway: ['model'] })).toBe(true);
  });
  it('keeps agent and Assistant groups reachable', () => {
    for (const endpoint of [
      EModelEndpoint.agents,
      EModelEndpoint.assistants,
      EModelEndpoint.azureAssistants,
    ]) {
      expect(isProviderAvailable(endpoint, {})).toBe(true);
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

  it('allows unknown availability but blocks missing, empty and removed models', () => {
    expect(available(undefined)).toBe(true);
    expect(available({ openAI: [] })).toBe(false);
    expect(available({ openAI: ['other'] })).toBe(false);
    expect(available({ openAI: ['saved'] }, { ...conversation, model: '' })).toBe(false);
    expect(
      available({ openAI: ['saved'] }, { ...conversation, endpoint: EModelEndpoint.anthropic }),
    ).toBe(false);
    expect(conversation).toMatchObject({ endpoint: EModelEndpoint.openAI, model: 'saved' });
    expect(available({ openAI: ['saved'] })).toBe(true);
  });

  it('preserves the legacy Assistants personal-key exception', () => {
    expect(
      isConversationModelAvailable({
        conversation: { ...conversation, endpoint: EModelEndpoint.assistants },
        models: { assistants: [] },
        endpoints: { assistants: { order: 0, userProvide: true } },
      }),
    ).toBe(true);
    expect(
      isConversationModelAvailable({
        conversation: { ...conversation, endpoint: EModelEndpoint.assistants, model: '' },
        models: {},
        endpoints: { assistants: { order: 0, userProvide: true } },
      }),
    ).toBe(false);
  });

  it.each(['personal' as EModelEndpoint, EModelEndpoint.agents])(
    'blocks unavailable personal-key models on the %s chat path and recovers after discovery',
    (endpoint) => {
      const selection = {
        ...conversation,
        endpoint,
        agent_id: 'personal__saved',
      };
      const personalEndpoints = {
        agents: { order: 0 },
        personal: { order: 1, userProvide: true },
      };
      const catalogs: TModelsConfig[] = [{}, { personal: [] }, { personal: ['other'] }];
      for (const models of catalogs) {
        expect(
          isConversationModelAvailable({
            conversation: selection,
            models,
            endpoints: personalEndpoints,
          }),
        ).toBe(false);
      }
      expect(
        isConversationModelAvailable({
          conversation: selection,
          models: { personal: ['saved'] },
          endpoints: personalEndpoints,
        }),
      ).toBe(true);
      expect(selection.model).toBe('saved');
    },
  );

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
