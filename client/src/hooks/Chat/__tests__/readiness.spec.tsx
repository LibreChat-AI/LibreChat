import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, EModelEndpoint, dataService } from 'librechat-data-provider';
import type { Agent, TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useTargetReadiness, { getTargetReadiness } from '../ask/readiness';
import { useGetAgentByIdQuery } from '~/data-provider/Agents/queries';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, getAgentById: jest.fn() } };
});
const getAgent = jest.mocked(dataService.getAgentById);
beforeEach(() => getAgent.mockReset());

const selected = (id = 'agent_1'): TConversation =>
  ({
    conversationId: `conversation-${id}`,
    endpoint: EModelEndpoint.agents,
    agent_id: id,
  }) as TConversation;
const denied = Object.assign(new Error('denied'), { status: 403 });
const detail = { id: 'agent_1' } as Agent;

function setupClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  client.setQueryData([QueryKeys.endpoints], {
    agents: {},
    openAI: {},
    assistants: { version: 'v2' },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

it('shares one delayed request with the existing agent metadata loader', async () => {
  let release!: (value: Agent) => void;
  const request = getAgent.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { wrapper } = setupClient();
  const { result } = renderHook(
    () => {
      useGetAgentByIdQuery('agent_1');
      return useTargetReadiness(selected());
    },
    { wrapper },
  );
  expect(result.current).toBe('pending');
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => release(detail));
  await waitFor(() => expect(result.current).toBe('ready'));
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(['success', 'denial'] as const)(
  'waits for the native mount refetch after a cached error: %s',
  async (outcome) => {
    const { client, wrapper } = setupClient();
    client.setQueryData([QueryKeys.agent, 'agent_1'], detail, { updatedAt: Date.now() - 10000 });
    await client
      .fetchQuery([QueryKeys.agent, 'agent_1'], () => Promise.reject(denied))
      .catch(() => undefined);
    let release!: (value: Agent) => void;
    let reject!: (reason: unknown) => void;
    const request = getAgent.mockImplementation(
      () =>
        new Promise((resolve, fail) => {
          release = resolve;
          reject = fail;
        }),
    );
    const seen: string[] = [];
    const { result } = renderHook(
      () => {
        useGetAgentByIdQuery('agent_1');
        const readiness = useTargetReadiness(selected());
        seen.push(readiness);
        return readiness;
      },
      { wrapper },
    );
    expect(seen).not.toContain('blocked');
    expect(result.current).toBe('pending');
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => (outcome === 'success' ? release(detail) : reject(denied)));
    await waitFor(() => expect(result.current).toBe(outcome === 'success' ? 'ready' : 'blocked'));
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it.each(['success', 'denial'] as const)(
  'waits for the native mount refetch after cached success: %s',
  async (outcome) => {
    const { client, wrapper } = setupClient();
    client.setQueryData([QueryKeys.agent, 'agent_1'], detail, { updatedAt: Date.now() - 10000 });
    let release!: (value: Agent) => void;
    let reject!: (reason: unknown) => void;
    const request = getAgent.mockImplementation(
      () =>
        new Promise((resolve, fail) => {
          release = resolve;
          reject = fail;
        }),
    );
    const seen: string[] = [];
    const { result } = renderHook(
      () => {
        useGetAgentByIdQuery('agent_1');
        const readiness = useTargetReadiness(selected());
        seen.push(readiness);
        return readiness;
      },
      { wrapper },
    );
    expect(seen).not.toContain('blocked');
    expect(seen).not.toContain('ready');
    expect(result.current).toBe('pending');
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => (outcome === 'success' ? release(detail) : reject(denied)));
    await waitFor(() => expect(result.current).toBe(outcome === 'success' ? 'ready' : 'blocked'));
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it('uses cached endpoint configuration after refetch fails while the agent still loads', async () => {
  const { client, wrapper } = setupClient();
  await client
    .fetchQuery([QueryKeys.endpoints], () => Promise.reject(denied))
    .catch(() => undefined);
  let release!: (value: Agent) => void;
  getAgent.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { result } = renderHook(() => useTargetReadiness(selected()), { wrapper });
  expect(result.current).toBe('pending');
  await act(async () => release(detail));
  await waitFor(() => expect(result.current).toBe('ready'));
});

it('adds no request for a fresh cached target or an inactive handoff', () => {
  const request = getAgent;
  const { client, wrapper } = setupClient();
  client.setQueryData([QueryKeys.agent, 'agent_1'], detail);
  const { result, rerender } = renderHook(
    ({ enabled, id }) => useTargetReadiness(selected(id), enabled),
    {
      wrapper,
      initialProps: { enabled: true, id: 'agent_1' },
    },
  );
  expect(result.current).toBe('ready');
  rerender({ enabled: false, id: 'agent_2' });
  expect(result.current).toBe('ready');
  expect(request).not.toHaveBeenCalled();
});

it('fences a previous destination and ignores unrelated cache updates', async () => {
  const { wrapper, client } = setupClient();
  const releases = new Map<string, (agent: Agent) => void>();
  getAgent.mockImplementation(
    ({ agent_id }) =>
      new Promise((resolve) => {
        releases.set(agent_id, resolve);
      }),
  );
  let renders = 0;
  const { result, rerender } = renderHook(
    ({ id }) => {
      renders++;
      return useTargetReadiness(selected(id));
    },
    {
      wrapper,
      initialProps: { id: 'agent_1' },
    },
  );
  rerender({ id: 'agent_2' });
  await act(async () => releases.get('agent_1')?.(detail));
  expect(result.current).toBe('pending');
  await act(async () => releases.get('agent_2')?.({ id: 'agent_2' } as Agent));
  await waitFor(() => expect(result.current).toBe('ready'));
  const settledRenders = renders;
  act(() => {
    for (let i = 0; i < 20; i++) client.setQueryData(['unrelated', i], i);
  });
  expect(result.current).toBe('ready');
  expect(renders).toBe(settledRenders);
});

it('blocks unavailable endpoints and invalid saved targets', () => {
  const { client } = setupClient();
  expect(getTargetReadiness(client, { ...selected(), endpoint: EModelEndpoint.google })).toBe(
    'blocked',
  );
  expect(getTargetReadiness(client, { ...selected(), agent_id: undefined })).toBe('blocked');
  client.setQueryData([QueryKeys.agent, 'agent_1'], { id: 'different' });
  expect(getTargetReadiness(client, selected())).toBe('blocked');
});

it.each(['success', 'failure', 'cancel'] as const)(
  'tracks external history revalidation through %s with unchanged rows',
  async (outcome) => {
    const { client, wrapper } = setupClient();
    const conversation = selected();
    const key = [QueryKeys.messages, conversation.conversationId];
    const rows = [{ messageId: 'same' }];
    client.setQueryData([QueryKeys.agent, 'agent_1'], detail);
    client.setQueryData(key, rows, { updatedAt: Date.now() - 10000 });
    await client.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
    let resolve!: (value: typeof rows) => void;
    let reject!: (error: Error) => void;
    const fetch = client
      .fetchQuery(
        key,
        () =>
          new Promise<typeof rows>((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      )
      .catch(() => undefined);
    const { result } = renderHook(() => useTargetReadiness(conversation), { wrapper });
    expect(result.current).toBe('pending');
    await act(async () => {
      if (outcome === 'success') resolve(rows);
      else if (outcome === 'failure') reject(new Error('history unavailable'));
      else await client.cancelQueries({ queryKey: key, exact: true });
      await fetch;
    });
    await waitFor(() => expect(result.current).toBe('ready'));
    expect(client.getQueryData(key)).toBe(rows);
    expect(getAgent).not.toHaveBeenCalled();
  },
);

it('follows only the current exact history key and unsubscribes when disabled', async () => {
  const { client, wrapper } = setupClient();
  client.setQueryData([QueryKeys.agent, 'agent_1'], detail);
  client.setQueryData([QueryKeys.agent, 'agent_2'], { ...detail, id: 'agent_2' });
  const first = selected();
  const key = [QueryKeys.messages, first.conversationId];
  client.setQueryData(key, [], { updatedAt: Date.now() - 10000 });
  let renders = 0;
  const { result, rerender, unmount } = renderHook(
    ({ id, enabled }) => {
      renders++;
      return useTargetReadiness(selected(id), enabled);
    },
    { wrapper, initialProps: { id: 'agent_1', enabled: true } },
  );
  expect(result.current).toBe('ready');
  await client.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
  let release!: (value: unknown[]) => void;
  const request = client.fetchQuery(
    key,
    () =>
      new Promise<unknown[]>((resolve) => {
        release = resolve;
      }),
  );
  await waitFor(() => expect(result.current).toBe('pending'));
  rerender({ id: 'agent_2', enabled: true });
  expect(result.current).toBe('ready');
  const before = renders;
  await act(async () => {
    release([]);
    await request;
  });
  expect(renders).toBe(before);
  act(() => {
    client.setQueryData([QueryKeys.messages, selected('agent_2').conversationId, 'branch'], []);
  });
  expect(renders).toBe(before);
  rerender({ id: 'agent_1', enabled: false });
  expect(result.current).toBe('ready');
  const disabled = renders;
  act(() => client.setQueryData(key, []));
  expect(renders).toBe(disabled);
  unmount();
  expect(getAgent).not.toHaveBeenCalled();
});
