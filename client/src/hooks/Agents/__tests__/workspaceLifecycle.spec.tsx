import { createElement } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { dataService, DynamicQueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TCodeEnvironmentStatusResponse, TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useCodeWorkspace from '../useCodeWorkspace';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider/CodeEnvironments'),
  useGetStartupConfig: () => ({ data: { codeEnvironmentDecisionVersion: 1 } }),
}));
jest.mock('../workspacePreferences', () => ({
  useWorkspacePreferences: () => ({ get: () => undefined, remember: jest.fn() }),
}));
jest.mock('~/hooks/Roles/useHasAccess', () => () => true);
jest.mock('~/Providers', () => ({ useAgentsMapContext: () => ({}) }));
jest.mock('../useAgentToolPermissions', () => (id: string) => ({
  agent: id
    ? { id, stateful_code_sessions: true, code_environment_id: 'vm', tools: ['execute_code'] }
    : undefined,
}));
jest.mock('../useGetAgentsConfig', () => () => ({
  agentsConfig: {
    capabilities: ['execute_code', 'stateful_code_sessions'],
    statefulCodeSessions: { environments: [{ id: 'vm', name: 'VM', type: 'attached' }] },
  },
}));

const selected = { environmentId: 'vm', workspaceId: 'project' };
const ready: TCodeEnvironmentStatusResponse = {
  environmentId: 'vm',
  status: 'ready',
  workspaces: [{ id: 'project' }],
};
const saved = {
  conversationId: 'saved-chat',
  endpoint: 'agents',
  agent_id: 'agent_primary',
  codeEnvironmentMode: 'attached',
  codeWorkspaces: [selected],
} as TConversation;

function setup(conversation: TConversation = saved) {
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0, cacheTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const render = jest.fn();
  return {
    client,
    render,
    ...renderHook(
      () => {
        render();
        return useCodeWorkspace(conversation);
      },
      { wrapper },
    ),
  };
}

describe('workspace status recovery', () => {
  it('restores the saved selection when a delayed initial status request resolves', async () => {
    let resolve = (_status: TCodeEnvironmentStatusResponse) => {};
    jest.spyOn(dataService, 'getCodeEnvironmentStatus').mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { result, client, unmount } = setup();
    expect(result.current.state).toBe('loading');
    expect(result.current.canSubmit).toBe(false);
    await act(async () => resolve(ready));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.selections).toEqual([selected]);
    expect(result.current.locked).toBe(true);
    expect(result.current.resolveSubmission(saved.codeWorkspaces, 'attached')).toEqual({
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [selected],
    });
    unmount();
    client.clear();
  });

  it('keeps unchanged status refreshes out of the composer render path', async () => {
    const request = jest.spyOn(dataService, 'getCodeEnvironmentStatus').mockResolvedValue(ready);
    const { result, client, render, unmount } = setup();
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const renders = render.mock.calls.length;
    let resolve = (_status: TCodeEnvironmentStatusResponse) => {};
    request.mockReturnValueOnce(new Promise((done) => (resolve = done)));

    let refresh: Promise<void>;
    await act(async () => {
      refresh = client.invalidateQueries(DynamicQueryKeys.codeEnvironmentStatus('vm'));
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(renders);
    await act(async () => {
      resolve({ ...ready, workspaces: [{ id: 'project' }] });
      await refresh;
    });
    expect(render).toHaveBeenCalledTimes(renders);
    expect(result.current.canSubmit).toBe(true);

    request.mockResolvedValue({ ...ready, workspaces: [] });
    await act(async () => {
      await client.invalidateQueries(DynamicQueryKeys.codeEnvironmentStatus('vm'));
    });
    await waitFor(() => expect(result.current.state).toBe('missing'));
    expect(result.current.canSubmit).toBe(false);
    unmount();
    client.clear();
  });

  it('recovers an exhausted background failure without replacing the saved selection', async () => {
    const request = jest.spyOn(dataService, 'getCodeEnvironmentStatus').mockResolvedValue(ready);
    const { result, client, unmount } = setup();
    await waitFor(() => expect(result.current.state).toBe('ready'));
    request.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await client.invalidateQueries(DynamicQueryKeys.codeEnvironmentStatus('vm'));
    });
    await waitFor(() => expect(result.current.state).toBe('unavailable'));
    expect(result.current.canSubmit).toBe(false);
    expect(result.current.environments[0].selected).toEqual(selected);
    request.mockResolvedValue(ready);
    await act(async () => {
      await client.invalidateQueries(DynamicQueryKeys.codeEnvironmentStatus('vm'));
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.selections).toEqual([selected]);
    unmount();
    client.clear();
  });

  it('recovers an empty first response into the sole workspace without a reload', async () => {
    const request = jest
      .spyOn(dataService, 'getCodeEnvironmentStatus')
      .mockResolvedValue({ ...ready, workspaces: [] });
    const { result, client, unmount } = setup({
      ...saved,
      conversationId: 'new',
      codeEnvironmentMode: undefined,
      codeWorkspaces: undefined,
    });
    await waitFor(() => expect(result.current.state).toBe('unavailable'));
    expect(result.current.resolveSubmission(undefined, 'attached')).toBeUndefined();
    request.mockResolvedValue(ready);
    await act(async () => {
      await client.invalidateQueries(DynamicQueryKeys.codeEnvironmentStatus('vm'));
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.selections).toEqual([selected]);
    unmount();
    client.clear();
  });
});
