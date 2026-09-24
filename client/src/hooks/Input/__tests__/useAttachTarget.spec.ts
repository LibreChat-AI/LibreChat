import { renderHook } from '@testing-library/react';
import { EModelEndpoint, mergeFileConfig } from 'librechat-data-provider';
import type { TConversation, TEndpointsConfig } from 'librechat-data-provider';
import useAttachTarget from '../useAttachTarget';

/**
 * Ports the resolution cases from the deleted `AttachFileChat` spec, which is
 * where this logic lived before the palette needed it. What an agent uploads
 * to is decided here, and every branch of it is a fallback that fires only when
 * the layer above it is missing.
 */

let mockEndpointsConfig: TEndpointsConfig = {
  [EModelEndpoint.openAI]: { userProvide: false, order: 0 },
  [EModelEndpoint.agents]: { userProvide: false, order: 1 },
  Moonshot: { type: EModelEndpoint.custom, userProvide: false, order: 9999 },
};

const defaultFileConfig = mergeFileConfig({
  endpoints: {
    Moonshot: { fileLimit: 5 },
    [EModelEndpoint.agents]: { fileLimit: 20 },
    default: { fileLimit: 10 },
  },
});

let mockFileConfig = defaultFileConfig;
let mockFileConfigLoaded = true;
/** Only the two fields the resolution reads, so a fixture stays a fixture. */
interface AgentFixture {
  provider?: string;
  model_parameters?: { useResponsesApi?: boolean };
}

let mockAgentsMap: Record<string, AgentFixture> = {};
let mockFetchedAgent: AgentFixture | undefined;
let mockAgentQueryEnabled: boolean | undefined;

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: mockEndpointsConfig }),
  useGetFileConfig: ({ select }: { select?: (data: unknown) => unknown }) => ({
    data: select != null ? select(mockFileConfig) : mockFileConfig,
    isSuccess: mockFileConfigLoaded,
  }),
  useGetAgentByIdQuery: (_id: string | undefined, options?: { enabled?: boolean }) => {
    mockAgentQueryEnabled = options?.enabled;
    return { data: options?.enabled === false ? undefined : mockFetchedAgent };
  },
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => mockAgentsMap,
}));

type ConversationFixture = Omit<Partial<TConversation>, 'endpoint'> & { endpoint?: string };

const target = (conversation: ConversationFixture | null, disableInputs = false) =>
  renderHook(() => useAttachTarget(conversation as TConversation | null, disableInputs)).result
    .current;

describe('useAttachTarget', () => {
  beforeEach(() => {
    mockFileConfig = defaultFileConfig;
    mockFileConfigLoaded = true;
    mockAgentsMap = {};
    mockFetchedAgent = undefined;
    mockAgentQueryEnabled = undefined;
    mockEndpointsConfig = {
      [EModelEndpoint.openAI]: { userProvide: false, order: 0 },
      [EModelEndpoint.agents]: { userProvide: false, order: 1 },
      Moonshot: { type: EModelEndpoint.custom, userProvide: false, order: 9999 },
    };
  });

  /* The saved flag says what the conversation chose; the request the upload
     rides may be auto-routed to Responses by policy, and the picker has to
     follow the route or Azure chats lose provider-document uploads. */
  describe('the effective responses route', () => {
    const routedAzure = {
      [EModelEndpoint.azureOpenAI]: {
        userProvide: false,
        order: 2,
        responsesApiRouting: { '*': { default: true, on: true, off: false } },
      },
    } as unknown as TEndpointsConfig;

    it('follows a routing policy that enables Responses by default', () => {
      mockEndpointsConfig = { ...mockEndpointsConfig, ...routedAzure };
      expect(
        target({ endpoint: EModelEndpoint.azureOpenAI, model: 'gpt-5.2' }).useResponsesApi,
      ).toBe(true);
    });

    it('keeps an explicit conversation opt-out off under the same policy', () => {
      mockEndpointsConfig = { ...mockEndpointsConfig, ...routedAzure };
      expect(
        target({
          endpoint: EModelEndpoint.azureOpenAI,
          model: 'gpt-5.2',
          useResponsesApi: false,
        }).useResponsesApi,
      ).toBe(false);
    });

    it('returns the saved flag when no policy applies', () => {
      expect(
        target({ endpoint: EModelEndpoint.azureOpenAI, model: 'gpt-5.2' }).useResponsesApi,
      ).toBeUndefined();
    });
  });

  describe('endpoint type behind an agent', () => {
    it('resolves a custom provider to its endpoint type', () => {
      mockAgentsMap = { 'agent-1': { provider: 'Moonshot', model_parameters: {} } };
      expect(target({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' }).endpointType).toBe(
        EModelEndpoint.custom,
      );
    });

    it('resolves a first-party provider to itself', () => {
      mockAgentsMap = { 'agent-1': { provider: EModelEndpoint.openAI, model_parameters: {} } };
      expect(target({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' }).endpointType).toBe(
        EModelEndpoint.openAI,
      );
    });

    it('stays on the agents endpoint when the agent names no provider', () => {
      mockAgentsMap = { 'agent-1': { model_parameters: {} } };
      expect(target({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' }).endpointType).toBe(
        EModelEndpoint.agents,
      );
    });

    it('fetches the agent only when the map has no parameters for it', () => {
      mockAgentsMap = { 'agent-1': { provider: 'Moonshot', model_parameters: {} } };
      target({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(mockAgentQueryEnabled).toBe(false);

      mockAgentsMap = {};
      mockFetchedAgent = { provider: 'Moonshot' };
      const resolved = target({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(mockAgentQueryEnabled).toBe(true);
      expect(resolved.endpointType).toBe(EModelEndpoint.custom);
    });

    it('falls back to the map when the fetched agent omits its provider', () => {
      mockAgentsMap = { 'agent-1': { provider: 'Moonshot' } };
      mockFetchedAgent = { model_parameters: {} };
      expect(target({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' }).endpointType).toBe(
        EModelEndpoint.custom,
      );
    });
  });

  describe('the responses API flag', () => {
    it('reads it from the fetched agent', () => {
      mockFetchedAgent = { model_parameters: { useResponsesApi: true } };
      expect(target({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' }).useResponsesApi).toBe(
        true,
      );
    });

    it('falls back to the map when the fetched agent omits it', () => {
      mockAgentsMap = { 'agent-1': { model_parameters: { useResponsesApi: true } } };
      mockFetchedAgent = { provider: EModelEndpoint.openAI };
      expect(target({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' }).useResponsesApi).toBe(
        true,
      );
    });

    it('lets the saved agent override a copied conversation flag', () => {
      mockAgentsMap = { 'agent-1': { model_parameters: { useResponsesApi: true } } };
      mockFetchedAgent = { model_parameters: { useResponsesApi: true } };
      expect(
        target({
          endpoint: EModelEndpoint.agents,
          agent_id: 'agent-1',
          useResponsesApi: false,
        }).useResponsesApi,
      ).toBe(true);
    });

    it('passes the conversation flag straight through outside the agents endpoint', () => {
      expect(
        target({ endpoint: EModelEndpoint.openAI, useResponsesApi: true }).useResponsesApi,
      ).toBe(true);
    });
  });

  describe('endpoint type without an agent', () => {
    it('resolves a custom endpoint', () => {
      expect(target({ endpoint: 'Moonshot' }).endpointType).toBe(EModelEndpoint.custom);
    });

    it('leaves a first-party endpoint alone', () => {
      expect(target({ endpoint: EModelEndpoint.openAI }).endpointType).toBe(EModelEndpoint.openAI);
    });

    /* Same endpoint, reached directly or through an agent: the destination has
       to be the same or a file would upload differently depending on the route. */
    it('agrees with the agent route for the same custom endpoint', () => {
      mockAgentsMap = { 'agent-1': { provider: 'Moonshot', model_parameters: {} } };
      expect(target({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' }).endpointType).toBe(
        target({ endpoint: 'Moonshot' }).endpointType,
      );
    });
  });

  describe('the file config the destination is scoped by', () => {
    it('reads the config of the provider behind the agent, not of the agents endpoint', () => {
      mockAgentsMap = { 'agent-1': { provider: 'Moonshot', model_parameters: {} } };
      expect(
        target({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' }).endpointFileConfig
          ?.fileLimit,
      ).toBe(5);
      expect(target({ endpoint: EModelEndpoint.agents }).endpointFileConfig?.fileLimit).toBe(20);
    });
  });

  describe('whether uploads are offered at all', () => {
    it('offers them on the agents endpoint', () => {
      expect(target({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' }).canAttach).toBe(true);
    });

    it('offers them on an endpoint that takes files', () => {
      expect(target({ endpoint: EModelEndpoint.openAI }).canAttach).toBe(true);
    });

    it('withholds them while the composer is disabled', () => {
      expect(target({ endpoint: EModelEndpoint.openAI }, true).canAttach).toBe(false);
    });

    it('withholds them when the endpoint config disables uploads', () => {
      mockFileConfig = mergeFileConfig({
        endpoints: { [EModelEndpoint.openAI]: { disabled: true }, default: { fileLimit: 10 } },
      });
      expect(target({ endpoint: EModelEndpoint.openAI }).canAttach).toBe(false);
    });
    it('withholds uploads until file policy has loaded', () => {
      mockFileConfigLoaded = false;
      expect(target({ endpoint: EModelEndpoint.openAI }).canAttach).toBe(false);
    });

    it('withholds uploads for a saved agent until its provider is known', () => {
      mockAgentsMap = { agent_1: { model_parameters: {} } };
      mockFetchedAgent = undefined;
      expect(target({ endpoint: EModelEndpoint.agents, agent_id: 'agent_1' }).canAttach).toBe(
        false,
      );
    });

    it('does not wait for provider metadata on an ephemeral agent', () => {
      expect(
        target({ endpoint: EModelEndpoint.agents, agent_id: 'ephemeral-convo-1' }).canAttach,
      ).toBe(true);
    });

    it('withholds them with no conversation at all', () => {
      expect(target(null).canAttach).toBe(false);
    });
  });
});
