import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryKeys, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Agent, TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useTargetReadiness, { getTargetReadiness } from '../ask/readiness';

const selected = (id: string): TConversation =>
  ({
    conversationId: `conversation-${id}`,
    endpoint: EModelEndpoint.agents,
    agent_id: id,
  }) as TConversation;

function setup(id = 'agent_1') {
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
  const hook = renderHook(({ conversation }) => useTargetReadiness(conversation, null), {
    wrapper,
    initialProps: { conversation: selected(id) },
  });
  return { client, ...hook };
}

it('observes delayed destination details without starting another query', async () => {
  const { client, result } = setup();
  let release: (agent: Agent) => void = () => undefined;
  const request = jest.fn(
    () =>
      new Promise<Agent>((resolve) => {
        release = resolve;
      }),
  );
  let fetched: Promise<Agent>;
  act(() => {
    fetched = client.fetchQuery([QueryKeys.agent, 'agent_1'], request);
  });
  expect(result.current).toBe('pending');
  await act(async () => {
    release({ id: 'agent_1' } as Agent);
    await fetched;
  });
  await waitFor(() => expect(result.current).toBe('ready'));
  expect(request).toHaveBeenCalledTimes(1);
});

it('exposes rejected and missing destinations as blocked, not pending', async () => {
  const { client, result } = setup();
  await act(async () => {
    await client
      .fetchQuery([QueryKeys.agent, 'agent_1'], () => Promise.reject(new Error('denied')))
      .catch(() => undefined);
  });
  await waitFor(() => expect(result.current).toBe('blocked'));
  act(() => {
    client.setQueryData([QueryKeys.agent, 'agent_1'], null);
  });
  expect(result.current).toBe('blocked');
});

it('ignores a late previous destination and unrelated query updates', async () => {
  const { client, result, rerender } = setup();
  rerender({ conversation: selected('agent_2') });
  act(() => {
    client.setQueryData([QueryKeys.agent, 'agent_1'], { id: 'agent_1' });
  });
  expect(result.current).toBe('pending');
  act(() => {
    client.setQueryData([QueryKeys.agent, 'agent_2'], { id: 'agent_2' });
  });
  await waitFor(() => expect(result.current).toBe('ready'));
  act(() => {
    client.setQueryData(['unrelated'], { data: true });
  });
  expect(result.current).toBe('ready');
});

it('blocks unavailable endpoints and invalid saved targets', () => {
  const { client } = setup();
  expect(
    getTargetReadiness(client, { ...selected('agent_1'), endpoint: EModelEndpoint.google }),
  ).toBe('blocked');
  expect(getTargetReadiness(client, { ...selected('agent_1'), agent_id: undefined })).toBe(
    'blocked',
  );
  act(() => {
    client.setQueryData([QueryKeys.agent, 'agent_1'], { id: 'different' });
  });
  expect(getTargetReadiness(client, selected('agent_1'))).toBe('blocked');
});
