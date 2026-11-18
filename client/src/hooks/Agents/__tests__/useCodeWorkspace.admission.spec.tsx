import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { DynamicQueryKeys, EModelEndpoint, Tools, dataService } from 'librechat-data-provider';
import type { Agent, TConversation, TCodeEnvironmentStatusResponse } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useCodeWorkspace from '../useCodeWorkspace';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, getCodeEnvironmentStatus: jest.fn() } };
});
jest.mock('../workspacePreferences', () => ({
  useWorkspacePreferences: () => ({ get: () => undefined, remember: jest.fn() }),
}));
jest.mock('~/hooks/Roles/useHasAccess', () => () => true);
const mockAgent = {
  id: 'root',
  tools: [Tools.execute_code],
  stateful_code_sessions: true,
  code_environment_id: 'machine',
} as Agent;
jest.mock('../useAgentToolPermissions', () => () => ({ agent: mockAgent }));
jest.mock('../useGetAgentsConfig', () => () => ({
  agentsConfig: {
    capabilities: ['execute_code', 'stateful_code_sessions'],
    statefulCodeSessions: {
      allowedEnvironments: ['user'],
      environments: [{ id: 'machine', type: 'attached' }],
    },
  },
}));
jest.mock('~/Providers', () => ({ useAgentsMapContext: () => ({}) }));
jest.mock('~/data-provider', () => ({
  useCodeEnvironmentStatusQueries: (...args: unknown[]) =>
    jest.requireActual('~/data-provider/CodeEnvironments').useCodeEnvironmentStatusQueries(...args),
  useGetStartupConfig: () => ({ data: { codeEnvironmentDecisionVersion: 1 } }),
  useIsReplacingConversationCodeEnvironment: () => false,
  useConversationCodeEnvironmentRecovery: () => undefined,
}));
const status: TCodeEnvironmentStatusResponse = {
  environmentId: 'machine',
  status: 'ready',
  workspaces: [{ id: 'project', name: 'Project' }],
};
const conversation = {
  conversationId: 'stored',
  endpoint: EModelEndpoint.agents,
  agent_id: 'root',
  codeEnvironmentMode: 'attached',
  codeWorkspaces: [{ environmentId: 'machine', workspaceId: 'project' }],
} as TConversation;
const denied = Object.assign(new Error('denied'), {
  isAxiosError: true,
  response: { status: 403 },
});
const getStatus = jest.mocked(dataService.getCodeEnvironmentStatus);
const key = DynamicQueryKeys.codeEnvironmentStatus('machine');
function setupClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  client.setQueryData(key, status);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
beforeEach(() => getStatus.mockReset());
afterEach(() => onlineManager.setOnline(true));

it.each(['success', 'denial', 'paused'] as const)(
  'preserves native cached-error fetch state through the workspace snapshot: %s',
  async (outcome) => {
    const { client, wrapper } = setupClient();
    client.setQueryData(key, status, { updatedAt: Date.now() - 20000 });
    await client.fetchQuery(key, () => Promise.reject(denied)).catch(() => undefined);
    let release!: (value: TCodeEnvironmentStatusResponse) => void;
    let reject!: (error: Error) => void;
    getStatus.mockImplementation(
      () =>
        new Promise((yes, no) => {
          release = yes;
          reject = no;
        }),
    );
    if (outcome === 'paused') onlineManager.setOnline(false);
    const { result } = renderHook(() => useCodeWorkspace(conversation, null, true), { wrapper });
    expect(result.current.readInputs().statuses.machine?.fetchStatus).toBe(
      outcome === 'paused' ? 'paused' : 'fetching',
    );
    if (outcome === 'paused') act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));
    await act(async () => (outcome === 'denial' ? reject(denied) : release(status)));
    await waitFor(() =>
      expect(result.current.readInputs().statuses.machine?.fetchStatus).toBe('idle'),
    );
    expect(result.current.canSubmit).toBe(outcome !== 'denial');
    expect(getStatus).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  'tracks unchanged poll/refetch progress only for a pending handoff: %s',
  async (handoff) => {
    const { client, wrapper } = setupClient();
    let renders = 0;
    const { result, rerender } = renderHook(
      ({ active }) => {
        renders++;
        return useCodeWorkspace(conversation, null, active);
      },
      { wrapper, initialProps: { active: handoff } },
    );
    expect(result.current.canSubmit).toBe(true);
    const before = renders;
    let release!: (value: TCodeEnvironmentStatusResponse) => void;
    getStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let request!: Promise<void>;
    await act(async () => {
      request = client.refetchQueries({ queryKey: key, exact: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(renders - before).toBe(handoff ? 1 : 0);
    await act(async () => {
      release(status);
      await request;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(renders - before).toBe(handoff ? 2 : 0);
    if (handoff) {
      rerender({ active: false });
      const inactive = renders;
      await act(async () => {
        request = client.refetchQueries({ queryKey: key, exact: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(renders).toBe(inactive);
      await act(async () => {
        release(status);
        await request;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(renders).toBe(inactive);
      expect(getStatus).toHaveBeenCalledTimes(2);
    }
  },
);
