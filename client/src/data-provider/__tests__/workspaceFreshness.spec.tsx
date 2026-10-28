import { createElement } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager, useQueries } from '@tanstack/react-query';
import {
  dataService,
  DynamicQueryKeys,
  EModelEndpoint,
  PermissionBits,
  QueryKeys,
} from 'librechat-data-provider';
import type {
  Agent,
  AgentListResponse,
  TCodeEnvironmentStatusResponse,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  useCodeWorkspaceRefresh,
  useCodeEnvironmentStatusQueries,
  useCodeEnvironmentStatusQuery,
} from '../CodeEnvironments';
import { useGetAgentByIdQuery, useListAgentsQuery } from '../Agents/queries';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

const ready: TCodeEnvironmentStatusResponse = {
  environmentId: 'vm',
  status: 'ready',
  workspaces: [{ id: 'project' }],
};
const agent = {
  id: 'agent_primary',
  code_environment_id: 'vm',
  code_workspace_id: 'project',
} as Agent;
const agentList = { object: 'list', data: [agent], has_more: false } as AgentListResponse;

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0, cacheTime: Infinity } },
  });
  client.setQueryData([QueryKeys.endpoints], { [EModelEndpoint.agents]: {} });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

describe('workspace query lifecycle', () => {
  afterEach(() => focusManager.setFocused(undefined));

  it.each(['single', 'multiple'] as const)(
    'retries a transient %s status request without a reload',
    async (kind) => {
      const request = jest
        .spyOn(dataService, 'getCodeEnvironmentStatus')
        .mockRejectedValueOnce({ status: 503 })
        .mockResolvedValue(ready);
      const { client, wrapper } = setup();
      const { result, unmount } = renderHook(
        () =>
          kind === 'single'
            ? useCodeEnvironmentStatusQuery('vm')
            : useCodeEnvironmentStatusQueries(['vm'])[0],
        { wrapper },
      );
      await waitFor(() => expect(result.current.data).toEqual(ready));
      expect(request).toHaveBeenCalledTimes(2);
      unmount();
      client.clear();
    },
  );

  it.each([401, 403, 404, 429])('does not retry status HTTP %s', async (status) => {
    const request = jest
      .spyOn(dataService, 'getCodeEnvironmentStatus')
      .mockRejectedValue({ status });
    const { client, wrapper } = setup();
    const { result, unmount } = renderHook(() => useCodeEnvironmentStatusQuery('vm'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(request).toHaveBeenCalledTimes(1);
    unmount();
    client.clear();
  });

  it('bounds transient retries instead of fetching indefinitely', async () => {
    const request = jest
      .spyOn(dataService, 'getCodeEnvironmentStatus')
      .mockRejectedValue({ status: 503 });
    const { client, wrapper } = setup();
    const { result, unmount } = renderHook(() => useCodeEnvironmentStatusQuery('vm'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(request).toHaveBeenCalledTimes(3);
    unmount();
    client.clear();
  });

  it('refreshes discovery but not saved conversation or expanded editor snapshots', async () => {
    const { client, wrapper } = setup();
    const keys = [
      [QueryKeys.endpoints],
      [QueryKeys.agents],
      [QueryKeys.agent, agent.id],
      DynamicQueryKeys.codeEnvironmentStatus('vm'),
      [QueryKeys.agent, agent.id, 'expanded'],
      [QueryKeys.conversation, 'saved-chat'],
    ];
    const requests = keys.map(() => jest.fn().mockResolvedValue({ loaded: true }));
    const { result, unmount } = renderHook(
      () => {
        useQueries({
          queries: keys.map((queryKey, i) => ({
            queryKey,
            queryFn: requests[i],
            staleTime: Infinity,
          })),
        });
        return useCodeWorkspaceRefresh();
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    const before = requests.map((request) => request.mock.calls.length);
    await act(async () => {
      await result.current.refresh();
    });
    requests.forEach((request, i) => {
      expect(request).toHaveBeenCalledTimes(before[i] + (i < 4 ? 1 : 0));
    });
    unmount();
    client.clear();
  });

  it('shares a fresh status between composer, submit hook and settings observers', async () => {
    const request = jest.spyOn(dataService, 'getCodeEnvironmentStatus').mockResolvedValue(ready);
    const { client, wrapper } = setup();
    const first = renderHook(() => useCodeEnvironmentStatusQuery('vm'), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    const second = renderHook(() => useCodeEnvironmentStatusQueries(['vm']), { wrapper });
    await act(async () => {});
    expect(second.result.current[0].data).toEqual(ready);
    expect(request).toHaveBeenCalledTimes(1);
    first.unmount();
    second.unmount();
    client.clear();
  });

  it('revalidates stale agent defaults on mount and focus', async () => {
    const request = jest.spyOn(dataService, 'getAgentById').mockResolvedValue(agent);
    const { client, wrapper } = setup();
    client.setQueryData(
      [QueryKeys.agent, agent.id],
      { ...agent, code_workspace_id: 'old' },
      { updatedAt: 1 },
    );
    const { result, unmount } = renderHook(() => useGetAgentByIdQuery(agent.id), { wrapper });
    await waitFor(() => expect(result.current.data?.code_workspace_id).toBe('project'));
    act(() => {
      client.setQueryData(
        [QueryKeys.agent, agent.id],
        { ...agent, code_workspace_id: 'old' },
        { updatedAt: 1 },
      );
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    unmount();
    client.clear();
  });

  it('starts agent discovery from cached endpoint configuration without Recoil or a duplicate request', async () => {
    const request = jest.spyOn(dataService, 'listAgents').mockResolvedValue(agentList);
    const getEndpoints = jest.spyOn(dataService, 'getAIEndpoints');
    const { client, wrapper } = setup();
    client.removeQueries([QueryKeys.endpoints]);
    const { result, unmount } = renderHook(() => useListAgentsQuery(), { wrapper });
    expect(request).not.toHaveBeenCalled();
    act(() => {
      client.setQueryData([QueryKeys.endpoints], { [EModelEndpoint.agents]: {} });
    });
    await waitFor(() => expect(result.current.data?.data).toEqual([agent]));
    expect(request).toHaveBeenCalledTimes(1);
    expect(getEndpoints).not.toHaveBeenCalled();
    unmount();
    client.clear();
  });

  it('revalidates stale reachable-agent metadata on mount', async () => {
    const request = jest.spyOn(dataService, 'listAgents').mockResolvedValue(agentList);
    const { client, wrapper } = setup();
    const params = { requiredPermission: PermissionBits.VIEW, limit: 100 };
    client.setQueryData([QueryKeys.agents, params], { ...agentList, data: [] }, { updatedAt: 1 });
    const { result, unmount } = renderHook(() => useListAgentsQuery(params), { wrapper });
    await waitFor(() => expect(result.current.data?.data).toEqual([agent]));
    expect(request).toHaveBeenCalledTimes(1);
    unmount();
    client.clear();
  });

  it('retains a previous status while a background request retries', async () => {
    const request = jest
      .spyOn(dataService, 'getCodeEnvironmentStatus')
      .mockRejectedValueOnce(new Error('Network interrupted'))
      .mockResolvedValue(ready);
    const { client, wrapper } = setup();
    client.setQueryData(DynamicQueryKeys.codeEnvironmentStatus('vm'), ready, { updatedAt: 1 });
    const { result, unmount } = renderHook(() => useCodeEnvironmentStatusQuery('vm'), { wrapper });
    expect(result.current.data).toEqual(ready);
    expect(result.current.isFetching).toBe(true);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.isSuccess).toBe(true);
    unmount();
    client.clear();
  });
});
