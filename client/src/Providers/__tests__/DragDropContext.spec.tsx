import React from 'react';
import { renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpointsConfig, Agent } from 'librechat-data-provider';
import { DragDropProvider, useDragDropContext } from '../DragDropContext';

const mockEndpointsConfig: TEndpointsConfig = {
  [EModelEndpoint.openAI]: {
    userProvide: false,
    order: 0,
    responsesApiRouting: {
      'gpt-6-sol': { default: true, on: true, off: false },
      'gpt-6-luna': { default: true, on: true, off: false },
    },
  },
  [EModelEndpoint.azureOpenAI]: {
    order: 2,
    responsesApiRouting: {
      'gpt-6-sol': { default: true, on: true, off: false },
      'gpt-6-luna': { default: true, on: true, off: false },
    },
  },
  [EModelEndpoint.agents]: { userProvide: false, order: 1 },
  [EModelEndpoint.anthropic]: { userProvide: false, order: 6 },
  Moonshot: { type: EModelEndpoint.custom, userProvide: false, order: 9999 },
  'Some Endpoint': { type: EModelEndpoint.custom, userProvide: false, order: 9999 },
};

let mockConversation: Record<string, unknown> | null = null;
let mockAgentsMap: Record<string, Partial<Agent>> = {};
let mockAgentQueryData: Partial<Agent> | undefined;

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: mockEndpointsConfig }),
  useGetAgentByIdQuery: () => ({ data: mockAgentQueryData }),
}));

jest.mock('../AgentsMapContext', () => ({
  useAgentsMapContext: () => mockAgentsMap,
}));

jest.mock('../ChatContext', () => ({
  useChatContext: () => ({ conversation: mockConversation }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return <DragDropProvider>{children}</DragDropProvider>;
}

describe('DragDropContext endpointType resolution', () => {
  it('uses the environment Azure wildcard for a discovered snapshot and carries saved web search through a proxy', () => {
    const entry = mockEndpointsConfig![EModelEndpoint.azureOpenAI]!;
    const previous = entry.responsesApiRouting;
    entry.responsesApiRouting = {
      'gpt-6-sol-*': {
        default: false,
        on: true,
        off: false,
        withWebSearch: { default: true, on: true, off: true },
      },
    };
    try {
      mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' };
      mockAgentQueryData = {
        provider: EModelEndpoint.azureOpenAI,
        model: 'gpt-6-sol-2026-09-22',
        model_parameters: { web_search: true },
      } as Partial<Agent>;
      const { result, rerender } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.useResponsesApi).toBe(true);
      mockAgentQueryData = {
        ...mockAgentQueryData,
        model_parameters: { web_search: false },
      } as Partial<Agent>;
      rerender();
      expect(result.current.useResponsesApi).toBe(false);
    } finally {
      entry.responsesApiRouting = previous;
    }
  });

  it.each([EModelEndpoint.openAI, EModelEndpoint.azureOpenAI])(
    'honors server opt-outs on %s across direct and saved-agent uploads',
    (endpoint) => {
      const entry = mockEndpointsConfig![endpoint]!;
      const previous = entry.responsesApiRouting;
      entry.responsesApiRouting = { 'gpt-6-sol': { default: false, on: false, off: false } };
      try {
        mockConversation = { endpoint, model: 'gpt-6-sol', useResponsesApi: true };
        const { result, rerender } = renderHook(() => useDragDropContext(), { wrapper });
        expect(result.current.useResponsesApi).toBe(false);
        mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' };
        mockAgentQueryData = {
          provider: endpoint,
          model: 'gpt-6-sol',
          model_parameters: {},
        } as Partial<Agent>;
        rerender();
        expect(result.current.useResponsesApi).toBe(false);
        entry.responsesApiRouting = undefined;
        rerender();
        expect(result.current.useResponsesApi).not.toBe(true);
      } finally {
        entry.responsesApiRouting = previous;
      }
    },
  );

  beforeEach(() => {
    mockConversation = null;
    mockAgentsMap = {};
    mockAgentQueryData = undefined;
  });

  describe('non-agents endpoints', () => {
    it('resolves custom endpoint type for a custom endpoint', () => {
      mockConversation = { endpoint: 'Moonshot' };
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.endpointType).toBe(EModelEndpoint.custom);
    });

    it.each([EModelEndpoint.openAI, EModelEndpoint.azureOpenAI])(
      'derives Responses for a direct %s Sol conversation but preserves false',
      (endpoint) => {
        mockConversation = { endpoint, model: 'gpt-6-sol' };
        const { result, rerender } = renderHook(() => useDragDropContext(), { wrapper });
        expect(result.current.useResponsesApi).toBe(true);
        mockConversation = { endpoint, model: 'gpt-6-sol', useResponsesApi: false };
        rerender();
        expect(result.current.useResponsesApi).toBe(false);
      },
    );

    it('resolves endpoint name for a standard endpoint', () => {
      mockConversation = { endpoint: EModelEndpoint.openAI };
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.endpointType).toBe(EModelEndpoint.openAI);
    });
  });

  describe('agents endpoint with provider from agentsMap', () => {
    it('resolves to custom for agent with Moonshot provider', () => {
      mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' };
      mockAgentsMap = {
        'agent-1': { provider: 'Moonshot', model_parameters: {} } as Partial<Agent>,
      };
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.endpointType).toBe(EModelEndpoint.custom);
    });

    it('resolves to custom for agent with custom provider with spaces', () => {
      mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' };
      mockAgentsMap = {
        'agent-1': { provider: 'Some Endpoint', model_parameters: {} } as Partial<Agent>,
      };
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.endpointType).toBe(EModelEndpoint.custom);
    });

    it('resolves to openAI for agent with openAI provider', () => {
      mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' };
      mockAgentsMap = {
        'agent-1': { provider: EModelEndpoint.openAI, model_parameters: {} } as Partial<Agent>,
      };
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.endpointType).toBe(EModelEndpoint.openAI);
    });

    it('resolves to anthropic for agent with anthropic provider', () => {
      mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' };
      mockAgentsMap = {
        'agent-1': { provider: EModelEndpoint.anthropic, model_parameters: {} } as Partial<Agent>,
      };
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.endpointType).toBe(EModelEndpoint.anthropic);
    });
  });

  describe('agents endpoint with provider from agentData query', () => {
    it('uses agentData when agent is not in agentsMap', () => {
      mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-2' };
      mockAgentsMap = {};
      mockAgentQueryData = { provider: 'Moonshot' } as Partial<Agent>;
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.endpointType).toBe(EModelEndpoint.custom);
    });

    it('falls back to agentsMap provider when agentData omits provider', () => {
      mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' };
      mockAgentsMap = {
        'agent-1': { provider: EModelEndpoint.openAI, model_parameters: {} } as Partial<Agent>,
      };
      mockAgentQueryData = {} as Partial<Agent>;
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.endpointType).toBe(EModelEndpoint.openAI);
    });
  });

  describe('useResponsesApi resolution for agents', () => {
    it('uses fetched agent model parameters when conversation does not override them', () => {
      mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' };
      mockAgentQueryData = {
        provider: EModelEndpoint.azureOpenAI,
        model_parameters: { useResponsesApi: true },
      } as Partial<Agent>;
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.useResponsesApi).toBe(true);
    });

    it('falls back to agentsMap model parameters when fetched agent omits them', () => {
      mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' };
      mockAgentsMap = {
        'agent-1': {
          provider: EModelEndpoint.azureOpenAI,
          model_parameters: { useResponsesApi: true },
        } as Partial<Agent>,
      };
      mockAgentQueryData = { provider: EModelEndpoint.azureOpenAI } as Partial<Agent>;
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.useResponsesApi).toBe(true);
    });

    it('lets the saved agent decide over the conversation', () => {
      /* Execution reads the agent's own model parameters, so predicting the conversation
       * here routes an upload the turn then resolves the other way. */
      mockConversation = {
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-1',
        useResponsesApi: false,
      };
      mockAgentQueryData = {
        provider: EModelEndpoint.azureOpenAI,
        model_parameters: { useResponsesApi: true },
      } as Partial<Agent>;
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.useResponsesApi).toBe(true);
    });

    it.each(['gpt-6-sol', 'gpt-6-luna'])(
      'derives Responses for an unset Azure %s agent without mutating its setting',
      (model) => {
        mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' };
        mockAgentQueryData = {
          provider: EModelEndpoint.azureOpenAI,
          model,
          model_parameters: {},
        } as Partial<Agent>;
        const { result } = renderHook(() => useDragDropContext(), { wrapper });
        expect(result.current.useResponsesApi).toBe(true);
        expect(mockAgentQueryData.model_parameters?.useResponsesApi).toBeUndefined();
      },
    );

    it('preserves an explicit false for an Azure Sol agent', () => {
      mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' };
      mockAgentQueryData = {
        provider: EModelEndpoint.azureOpenAI,
        model: 'gpt-6-sol',
        model_parameters: { useResponsesApi: false },
      } as Partial<Agent>;
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.useResponsesApi).toBe(false);
    });

    it('keeps the conversation setting when the agent states none', () => {
      mockConversation = {
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-1',
        useResponsesApi: true,
      };
      mockAgentQueryData = {
        provider: EModelEndpoint.azureOpenAI,
        model_parameters: {},
      } as Partial<Agent>;
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.useResponsesApi).toBe(true);
    });
  });

  describe('agents endpoint without provider', () => {
    it('falls back to agents when no agent_id', () => {
      mockConversation = { endpoint: EModelEndpoint.agents };
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.endpointType).toBe(EModelEndpoint.agents);
    });

    it('falls back to agents when agent has no provider', () => {
      mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' };
      mockAgentsMap = { 'agent-1': { model_parameters: {} } as Partial<Agent> };
      const { result } = renderHook(() => useDragDropContext(), { wrapper });
      expect(result.current.endpointType).toBe(EModelEndpoint.agents);
    });
  });

  describe('consistency: same endpoint type whether used directly or through agents', () => {
    it('Moonshot resolves to the same type as direct endpoint and as agent provider', () => {
      mockConversation = { endpoint: 'Moonshot' };
      const { result: directResult } = renderHook(() => useDragDropContext(), { wrapper });

      mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' };
      mockAgentsMap = {
        'agent-1': { provider: 'Moonshot', model_parameters: {} } as Partial<Agent>,
      };
      const { result: agentResult } = renderHook(() => useDragDropContext(), { wrapper });

      expect(directResult.current.endpointType).toBe(agentResult.current.endpointType);
    });
  });
});
