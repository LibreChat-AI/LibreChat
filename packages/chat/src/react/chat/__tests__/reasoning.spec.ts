import { QueryClient } from '@tanstack/react-query';
import {
  QueryKeys,
  Providers,
  ReasoningEffort,
  ReasoningParameterFormat,
  EModelEndpoint,
} from 'librechat-data-provider';
import type {
  Agent,
  TConversation,
  TEndpointsConfig,
  TReasoningCapabilitiesResponse,
} from 'librechat-data-provider';
import { resolveSubmittedReasoning } from '../reasoning';

const high = { key: 'reasoning_effort', value: ReasoningEffort.high } as const;
const gpt5 = { provider: EModelEndpoint.openAI, model: 'gpt-5' } as Agent;
const base = {
  conversationId: 'c1',
  title: null,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
};
const agentConversation: TConversation = {
  ...base,
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent-1',
};
const openRouterConversation: TConversation = {
  ...base,
  endpoint: EModelEndpoint.custom,
  model: 'openai/gpt-5',
};

const openRouterConfig: TEndpointsConfig = {
  [EModelEndpoint.custom]: {
    type: EModelEndpoint.custom,
    userProvide: false,
    order: 0,
    customParams: {
      defaultParamsEndpoint: Providers.OPENROUTER,
      reasoningFormat: ReasoningParameterFormat.reasoningObject,
    },
  },
};

const catalog = (efforts: string[]): TReasoningCapabilitiesResponse => ({
  expiresInMs: 60_000,
  capabilities: { [EModelEndpoint.custom]: { 'openai/gpt-5': { efforts } } },
});

const resolveAgent = (queryClient: QueryClient, agentsMap?: Record<string, Agent>) =>
  resolveSubmittedReasoning({
    queryClient,
    agentsMap,
    endpoint: EModelEndpoint.agents,
    conversation: agentConversation,
    reasoningOverride: high,
    drainedReasoning: true,
    stagedReasoning: high,
  });

const resolveOpenRouter = (queryClient: QueryClient, drainedReasoning = true) =>
  resolveSubmittedReasoning({
    queryClient,
    endpoint: EModelEndpoint.custom,
    conversation: openRouterConversation,
    endpointsConfig: openRouterConfig,
    reasoningOverride: high,
    drainedReasoning,
    stagedReasoning: high,
  });

describe('resolveSubmittedReasoning', () => {
  it.each([
    ['production-west', high],
    ['production-chat', undefined],
  ])('checks an Azure override against the declaration of %s', (model, reasoningOverride) => {
    expect(
      resolveSubmittedReasoning({
        queryClient: new QueryClient(),
        endpoint: EModelEndpoint.azureOpenAI,
        conversation: { ...base, endpoint: EModelEndpoint.azureOpenAI, model },
        endpointsConfig: {
          [EModelEndpoint.azureOpenAI]: {
            userProvide: false,
            order: 0,
            modelReasoningEfforts: { 'production-west': ['low', 'high'] },
          },
        },
        reasoningOverride: high,
        drainedReasoning: true,
        stagedReasoning: high,
      }),
    ).toEqual({ reasoningOverride, restoreStaged: false });
  });

  it('keeps an override the target supports', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.agent, 'agent-1'], gpt5);
    expect(resolveAgent(queryClient)).toEqual({ reasoningOverride: high, restoreStaged: false });
  });

  it('drops an override the target does not support without restoring it', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.agent, 'agent-1'], { ...gpt5, model: 'gpt-4o' });
    expect(resolveAgent(queryClient)).toEqual({
      reasoningOverride: undefined,
      restoreStaged: false,
    });
  });

  it('restores a drained override while the catalog is unknown', () => {
    const queryClient = new QueryClient();
    expect(resolveOpenRouter(queryClient)).toEqual({
      reasoningOverride: undefined,
      restoreStaged: true,
    });
    expect(resolveOpenRouter(queryClient, false).restoreStaged).toBe(false);
  });

  it('keeps an override the loaded catalog lists and drops one it does not', () => {
    const queryClient = new QueryClient();
    const key = [QueryKeys.reasoningCapabilities, EModelEndpoint.custom];
    queryClient.setQueryData(key, catalog([ReasoningEffort.low, ReasoningEffort.high]));
    expect(resolveOpenRouter(queryClient).reasoningOverride).toEqual(high);
    queryClient.setQueryData(key, catalog([ReasoningEffort.low]));
    expect(resolveOpenRouter(queryClient)).toEqual({
      reasoningOverride: undefined,
      restoreStaged: false,
    });
  });

  it('prefers the cached agent and falls back to the agents map', () => {
    const queryClient = new QueryClient();
    const agentsMap = { 'agent-1': gpt5 };
    expect(resolveAgent(queryClient, agentsMap).reasoningOverride).toEqual(high);
    queryClient.setQueryData([QueryKeys.agent, 'agent-1'], { ...gpt5, model: 'gpt-4o' });
    expect(resolveAgent(queryClient, agentsMap).reasoningOverride).toBeUndefined();
  });

  it('resolves nothing for a saved agent that has not loaded', () => {
    expect(resolveAgent(new QueryClient()).reasoningOverride).toBeUndefined();
  });

  it('counts a fetching or errored capabilities query as unknown', () => {
    const key = [QueryKeys.reasoningCapabilities, EModelEndpoint.custom];
    for (const state of [{ fetchStatus: 'fetching' }, { status: 'error' }] as const) {
      const queryClient = new QueryClient();
      queryClient.setQueryData(key, catalog([ReasoningEffort.high]));
      queryClient.getQueryCache().find(key)?.setState(state);
      expect(resolveOpenRouter(queryClient)).toEqual({
        reasoningOverride: undefined,
        restoreStaged: true,
      });
    }
  });
});
