import React, { useState } from 'react';
import axios from 'axios';
import { RecoilRoot } from 'recoil';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, EModelEndpoint, QueryKeys, defaultOrderQuery } from 'librechat-data-provider';
import {
  useUserKeyQuery,
  useUpdateUserKeysMutation,
  useRevokeUserKeyMutation,
  useRevokeAllUserKeysMutation,
} from 'librechat-data-provider/react-query';
import type {
  TConversation,
  Agent,
  Assistant,
  TModelsConfig,
  TEndpointsConfig,
} from 'librechat-data-provider';
import { startupConfigKey } from '~/data-provider/Endpoints/queries';
import { assistantKey, isTargetReady } from '../ask/guards';
import useTarget from '../target';

jest.mock('../../../../../packages/data-provider/src/data-service', () => ({
  ...jest.requireActual('../../../../../packages/data-provider/src/data-service'),
  getModels: (...args: unknown[]) =>
    jest.requireMock('librechat-data-provider').dataService.getModels(...args),
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider/Endpoints/queries'),
  ...jest.requireActual('~/data-provider/Agents/queries'),
  useListAssistantsQuery: jest.requireActual('~/data-provider/queries').useListAssistantsQuery,
}));

const conversation = (fields: Partial<TConversation> = {}): TConversation => ({
  conversationId: 'new',
  endpoint: EModelEndpoint.openAI,
  title: '',
  createdAt: '',
  updatedAt: '',
  ...fields,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(
  initial: TConversation | null,
  endpoints?: TEndpointsConfig,
  cacheTime = 0,
  existingClient?: QueryClient,
) {
  const client =
    existingClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false, cacheTime } },
      logger: { log: console.log, warn: console.warn, error: () => {} },
    });
  client.setQueryData(
    [QueryKeys.endpoints],
    endpoints ?? {
      [EModelEndpoint.openAI]: { order: 0 },
      [EModelEndpoint.agents]: { order: 1 },
      [EModelEndpoint.assistants]: { order: 2 },
    },
  );
  client.setQueryData(startupConfigKey(false), { appTitle: 'Test' });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </RecoilRoot>
  );
  const hook = renderHook(
    () => {
      const [value, setValue] = useState(initial);
      const target = useTarget(value, setValue);
      const update = useUpdateUserKeysMutation();
      const revoke = useRevokeUserKeyMutation(value?.endpoint ?? '');
      const revokeAll = useRevokeAllUserKeysMutation();
      return { value, setValue, target, update, revoke, revokeAll };
    },
    { wrapper },
  );
  return { ...hook, client };
}

beforeEach(() => {
  jest
    .spyOn(dataService, 'getStartupConfig')
    .mockResolvedValue({ appTitle: 'Test' } as Awaited<
      ReturnType<typeof dataService.getStartupConfig>
    >);
  jest.spyOn(dataService, 'getAIEndpoints').mockResolvedValue({
    [EModelEndpoint.openAI]: { order: 0 },
    [EModelEndpoint.agents]: { order: 1 },
    [EModelEndpoint.assistants]: { order: 2 },
  });
  jest.spyOn(dataService, 'getModels').mockImplementation(() => new Promise(() => {}));
  jest.spyOn(dataService, 'listAgents').mockImplementation(() => new Promise(() => {}));
  jest.spyOn(dataService, 'listAssistants').mockImplementation(() => new Promise(() => {}));
});

it('makes an explicit model ready without any catalog requests', async () => {
  const { result, client } = setup(conversation({ model: 'configured-model', spec: 'my-spec' }));
  await waitFor(() => expect(result.current.target.ready).toBe(true));
  expect(isTargetReady(client, result.current.value)).toBe(true);
  expect(dataService.getModels).not.toHaveBeenCalled();
  expect(dataService.listAgents).not.toHaveBeenCalled();
});

it('only discovers the selected endpoint when a model is genuinely missing', async () => {
  const response = deferred<TModelsConfig>();
  jest.spyOn(dataService, 'getModels').mockReturnValue(response.promise);
  const { result } = setup(conversation());
  await waitFor(() => expect(dataService.getModels).toHaveBeenCalledWith(EModelEndpoint.openAI));
  expect(result.current.target.ready).toBe(false);
  await act(async () => response.resolve({ openAI: ['first-model'] }));
  await waitFor(() => expect(result.current.value?.model).toBe('first-model'));
  expect(result.current.target.ready).toBe(true);
});

it('does not let a delayed model response overwrite a newer selection', async () => {
  const response = deferred<TModelsConfig>();
  jest.spyOn(dataService, 'getModels').mockReturnValue(response.promise);
  const { result } = setup(conversation());
  await waitFor(() => expect(dataService.getModels).toHaveBeenCalled());
  act(() => result.current.setValue(conversation({ model: 'chosen-while-loading' })));
  await act(async () => response.resolve({ openAI: ['old-default'] }));
  expect(result.current.value?.model).toBe('chosen-while-loading');
});

it('resolves a saved agent directly while its catalog never settles', async () => {
  const response = deferred<Agent>();
  jest.spyOn(dataService, 'getAgentById').mockReturnValue(response.promise);
  const { result, client } = setup(
    conversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_one' }),
  );
  expect(isTargetReady(client, result.current.value)).toBe(false);
  await act(async () => response.resolve({ id: 'agent_one', name: 'Selected' } as Agent));
  await waitFor(() => expect(result.current.target.ready).toBe(true));
  expect(isTargetReady(client, result.current.value)).toBe(true);
  expect(dataService.listAgents).not.toHaveBeenCalled();
});

it('keeps a denied agent selected and allows retry without opening another conversation', async () => {
  const getAgent = jest
    .spyOn(dataService, 'getAgentById')
    .mockRejectedValueOnce(Object.assign(new Error('denied'), { status: 403 }));
  const { result } = setup(
    conversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_one' }),
  );
  await waitFor(() => expect(result.current.target.failed).toBe(true));
  expect(result.current.value?.agent_id).toBe('agent_one');
  expect(result.current.target.ready).toBe(false);
  getAgent.mockResolvedValue({ id: 'agent_one' } as Agent);
  act(() => result.current.target.retry());
  await waitFor(() => expect(result.current.target.ready).toBe(true));
});

it('hydrates an assistant by id without requiring the assistant list', async () => {
  jest
    .spyOn(dataService, 'getAssistantById')
    .mockResolvedValue({ id: 'asst-one', model: 'assistant-model' } as Assistant);
  const { result } = setup(
    conversation({ endpoint: EModelEndpoint.assistants, assistant_id: 'asst-one' }),
  );
  await waitFor(() => expect(result.current.target.ready).toBe(true));
  await waitFor(() => expect(result.current.value?.model).toBe('assistant-model'));
  expect(dataService.listAssistants).not.toHaveBeenCalled();
});

it.each([403, 404])(
  'does not replace a missing or denied remembered assistant (%s) with a catalog default',
  async (status) => {
    jest
      .spyOn(dataService, 'getAssistantById')
      .mockRejectedValue(Object.assign(new Error('unavailable'), { status }));
    const { result, client } = setup(
      conversation({ endpoint: EModelEndpoint.assistants, assistant_id: 'asst_remembered' }),
    );
    client.setQueryData([QueryKeys.assistants, EModelEndpoint.assistants], {
      data: [{ id: 'asst_first', model: 'other-model' }],
    });
    await waitFor(() => expect(result.current.target.failed).toBe(true));
    expect(result.current.value?.assistant_id).toBe('asst_remembered');
    expect(result.current.target.ready).toBe(false);
    expect(dataService.listAssistants).not.toHaveBeenCalled();
  },
);

it('does not replace a remembered agent missing from a partial catalog', async () => {
  jest.spyOn(dataService, 'getAgentById').mockResolvedValue({ id: 'agent_remembered' } as Agent);
  const { result, client } = setup(
    conversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_remembered' }),
  );
  client.setQueryData([QueryKeys.agents], { data: [{ id: 'agent_first' }] });
  await waitFor(() => expect(result.current.target.ready).toBe(true));
  expect(result.current.value?.agent_id).toBe('agent_remembered');
  expect(dataService.listAgents).not.toHaveBeenCalled();
});

it('keeps a missing remembered agent selected rather than using a catalog fallback', async () => {
  jest
    .spyOn(dataService, 'getAgentById')
    .mockRejectedValue(Object.assign(new Error('missing'), { status: 404 }));
  const { result } = setup(
    conversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_missing' }),
  );
  await waitFor(() => expect(result.current.target.failed).toBe(true));
  expect(result.current.value?.agent_id).toBe('agent_missing');
  expect(dataService.listAgents).not.toHaveBeenCalled();
});

it('retries a successfully loaded catalog when the selected endpoint is absent', async () => {
  const endpoints = jest.spyOn(dataService, 'getAIEndpoints');
  const { result, client } = setup(conversation({ model: 'configured-model' }));
  await waitFor(() => expect(result.current.target.ready).toBe(true));
  act(() => client.setQueryData([QueryKeys.endpoints], {}));
  await waitFor(() => expect(result.current.target.failed).toBe(true));
  const calls = endpoints.mock.calls.length;
  act(() => result.current.target.retry());
  await waitFor(() => expect(endpoints.mock.calls.length).toBeGreaterThan(calls));
  await waitFor(() => expect(result.current.target.ready).toBe(true));
  expect(result.current.value?.model).toBe('configured-model');
});

it('refuses sends while selected assistant details are invalidated and restores readiness after refresh', async () => {
  const refresh = deferred<Assistant>();
  const retrieve = jest
    .spyOn(dataService, 'getAssistantById')
    .mockResolvedValueOnce({ id: 'asst-one', model: 'model' } as Assistant)
    .mockReturnValue(refresh.promise);
  const { result, client } = setup(
    conversation({ endpoint: EModelEndpoint.assistants, assistant_id: 'asst-one', model: 'model' }),
  );
  await waitFor(() => expect(result.current.target.ready).toBe(true));
  act(() => {
    void client.invalidateQueries([QueryKeys.assistant, EModelEndpoint.assistants, 'asst-one']);
  });
  expect(isTargetReady(client, result.current.value)).toBe(false);
  await waitFor(() => expect(result.current.target.ready).toBe(false));
  expect(result.current.value?.assistant_id).toBe('asst-one');
  await act(async () =>
    refresh.resolve({ id: 'asst-one', name: 'updated', model: 'model' } as Assistant),
  );
  await waitFor(() => expect(result.current.target.ready).toBe(true));
  expect(result.current.target.assistant?.name).toBe('updated');
  expect(retrieve).toHaveBeenCalledTimes(2);
});

it('keeps a deleted assistant unsendable even while its previous details remain cached', async () => {
  const retrieve = jest
    .spyOn(dataService, 'getAssistantById')
    .mockResolvedValueOnce({ id: 'asst-one', model: 'model' } as Assistant);
  const { result, client } = setup(
    conversation({ endpoint: EModelEndpoint.assistants, assistant_id: 'asst-one', model: 'model' }),
  );
  await waitFor(() => expect(result.current.target.ready).toBe(true));
  retrieve.mockRejectedValue(Object.assign(new Error('deleted'), { status: 404 }));
  act(() => {
    void client.invalidateQueries([QueryKeys.assistant, EModelEndpoint.assistants, 'asst-one']);
  });
  expect(isTargetReady(client, result.current.value)).toBe(false);
  await waitFor(() => expect(result.current.target.failed).toBe(true));
  expect(result.current.target.ready).toBe(false);
  expect(
    client.getQueryData(assistantKey(EModelEndpoint.assistants, 'asst-one', 2, 'model')),
  ).toBeDefined();
  expect(result.current.value?.assistant_id).toBe('asst-one');
});

describe('selected assistant credentials', () => {
  let expiry: string;
  let denied: boolean;
  let requests: string[];
  let account: string;

  const selected = (endpoint: EModelEndpoint) =>
    conversation({ endpoint, assistant_id: 'same-id', model: 'model-one' });
  const configured: NonNullable<TEndpointsConfig> = {
    [EModelEndpoint.assistants]: { order: 0, userProvide: true, version: '2' },
    [EModelEndpoint.azureAssistants]: { order: 1, userProvide: true, version: '2' },
  };

  beforeEach(() => {
    expiry = 'never';
    denied = false;
    requests = [];
    account = 'current-account';
    jest.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = String(url);
      requests.push(path);
      if (path.includes('/api/keys')) return { data: { expiresAt: expiry } };
      if (path.includes('/api/assistants/')) {
        if (denied) throw Object.assign(new Error('denied'), { status: 401 });
        return { data: { id: 'same-id', model: 'model-one', name: account } };
      }
      throw new Error(`Unexpected transport: ${path}`);
    });
    jest.spyOn(axios, 'put').mockImplementation(async () => {
      expiry = 'never';
      denied = false;
      return { data: {} };
    });
    jest.spyOn(axios, 'delete').mockImplementation(async () => {
      expiry = '';
      return { data: {} };
    });
  });

  const details = () => requests.filter((url) => url.includes('/api/assistants/'));

  it.each([EModelEndpoint.assistants, EModelEndpoint.azureAssistants])(
    'recovers a failed selected %s automatically after saving a key',
    async (endpoint) => {
      denied = true;
      const { result, client } = setup(selected(endpoint), configured);
      await waitFor(() => expect(result.current.target.failed).toBe(true));
      expect(details()).toHaveLength(1);
      await act(async () => {
        await result.current.update.mutateAsync({
          name: endpoint,
          value: 'replacement',
          expiresAt: '',
        });
      });
      await waitFor(() => expect(result.current.target.ready).toBe(true));
      expect(isTargetReady(client, result.current.value)).toBe(true);
      expect(details()).toHaveLength(2);
      expect(result.current.value?.assistant_id).toBe('same-id');
    },
  );

  it.each([
    [EModelEndpoint.assistants, ''],
    [EModelEndpoint.azureAssistants, ''],
    [EModelEndpoint.assistants, '2000-01-01T00:00:00.000Z'],
    [EModelEndpoint.azureAssistants, '2000-01-01T00:00:00.000Z'],
  ])(
    'does not fetch %s details with missing or expired credentials (%s), even on Retry',
    async (endpoint, initialExpiry) => {
      expiry = initialExpiry;
      const { result, client } = setup(selected(endpoint as EModelEndpoint), configured);
      await waitFor(() => expect(requests.some((url) => url.includes('/api/keys'))).toBe(true));
      await act(async () => {
        result.current.target.retry();
      });
      expect(details()).toHaveLength(0);
      expect(result.current.target.ready).toBe(false);
      await act(async () => {
        await result.current.update.mutateAsync({ name: endpoint, value: 'usable', expiresAt: '' });
      });
      await waitFor(() => expect(result.current.target.ready).toBe(true));
      expect(details()).toHaveLength(1);
      expect(isTargetReady(client, result.current.value)).toBe(true);
    },
  );

  it.each([
    ['save missing', '', 'never'],
    ['save expired', '2000-01-01T00:00:00.000Z', 'never'],
    ['single revoke', 'never', ''],
    ['bulk revoke', 'never', ''],
  ] as const)(
    'discards pending initial key metadata across %s',
    async (operation, oldExpiry, expectedExpiry) => {
      const initial = deferred<{ data: { expiresAt: string } }>();
      const get = jest.spyOn(axios, 'get');
      const transport = get.getMockImplementation()!;
      let keyRequests = 0;
      get.mockImplementation((url, options) => {
        if (String(url).includes('/api/keys?name=assistants') && ++keyRequests === 1) {
          return initial.promise;
        }
        return transport(url, options);
      });
      const { result, client } = setup(selected(EModelEndpoint.assistants), configured);
      await waitFor(() => expect(keyRequests).toBe(1));
      const key = [QueryKeys.name, EModelEndpoint.assistants];
      expect(client.getQueryData(key)).toBeUndefined();
      const onSuccess = jest.fn();
      const onSettled = jest.fn();
      const callbacks = { onSuccess, onSettled };
      const saved = { name: EModelEndpoint.assistants, value: 'new', expiresAt: '' };
      const revoked = { request: operation };
      let mutation!: Promise<unknown>;
      await act(async () => {
        if (operation.startsWith('save')) {
          mutation = result.current.update.mutateAsync(saved, callbacks);
        } else if (operation === 'single revoke') {
          mutation = result.current.revoke.mutateAsync(revoked, callbacks);
        } else {
          mutation = result.current.revokeAll.mutateAsync(revoked, callbacks);
        }
      });
      expect(operation.startsWith('save') ? axios.put : axios.delete).toHaveBeenCalledTimes(1);
      await act(async () => {
        initial.resolve({ data: { expiresAt: oldExpiry } });
        await mutation;
      });
      await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
      const input = operation.startsWith('save') ? saved : revoked;
      expect(onSuccess).toHaveBeenCalledWith({}, input, undefined);
      expect(onSettled).toHaveBeenCalledWith({}, null, input, undefined);
      expect(client.getQueryData(key)).toEqual({ expiresAt: expectedExpiry });
      expect(keyRequests).toBe(2);
      await waitFor(() => expect(result.current.target.ready).toBe(operation.startsWith('save')));
      expect(details()).toHaveLength(operation.startsWith('save') ? 1 : 0);
      expect(isTargetReady(client, result.current.value)).toBe(operation.startsWith('save'));
    },
  );

  it('does not cancel another endpoint initial expiry request when saving a scoped key', async () => {
    const initial = deferred<{ data: { expiresAt: string } }>();
    const otherInitial = deferred<{ data: { expiresAt: string } }>();
    const get = jest.spyOn(axios, 'get');
    const transport = get.getMockImplementation()!;
    let keyRequests = 0;
    let otherRequests = 0;
    get.mockImplementation((url, options) => {
      const path = String(url);
      if (path.includes('/api/keys?name=assistants') && ++keyRequests === 1) return initial.promise;
      if (path.includes('/api/keys?name=azureAssistants') && ++otherRequests === 1)
        return otherInitial.promise;
      return transport(url, options);
    });
    const { result, client } = setup(selected(EModelEndpoint.assistants), configured);
    const other = renderHook(() => useUserKeyQuery(EModelEndpoint.azureAssistants), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect([keyRequests, otherRequests]).toEqual([1, 1]));
    let mutation!: Promise<unknown>;
    await act(async () => {
      mutation = result.current.update.mutateAsync({
        name: EModelEndpoint.assistants,
        value: 'new',
        expiresAt: '',
      });
    });
    await act(async () => {
      initial.resolve({ data: { expiresAt: '' } });
      await mutation;
    });
    expect(client.getQueryState([QueryKeys.name, EModelEndpoint.azureAssistants])).toMatchObject({
      fetchStatus: 'fetching',
      isInvalidated: false,
      data: undefined,
    });
    await act(async () => {
      otherInitial.resolve({ data: { expiresAt: 'other-account-expiry' } });
    });
    await waitFor(() =>
      expect(other.result.current.data).toEqual({ expiresAt: 'other-account-expiry' }),
    );
    expect([keyRequests, otherRequests]).toEqual([2, 1]);
    other.unmount();
  });

  it.each([EModelEndpoint.assistants, EModelEndpoint.azureAssistants])(
    'refreshes inactive invalidated %s key metadata when the target mounts',
    async (endpoint) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, cacheTime: 0 } },
      });
      const key = [QueryKeys.name, endpoint];
      client.setQueryData(key, { expiresAt: 'never' });
      client.setQueryData(assistantKey(endpoint, 'same-id', '2', 'model-one'), {
        id: 'same-id',
        model: 'model-one',
      });
      expect(client.getQueryCache().find(key)?.getObserversCount()).toBe(0);
      await client.invalidateQueries(key, { refetchType: 'none' });
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      const refresh = deferred<{ data: { expiresAt: string } }>();
      const get = jest.spyOn(axios, 'get');
      const transport = get.getMockImplementation()!;
      get.mockImplementation((url, options) =>
        String(url).includes(`/api/keys?name=${endpoint}`)
          ? refresh.promise
          : transport(url, options),
      );
      const { result } = setup(selected(endpoint), configured, 0, client);
      expect(result.current.target.ready).toBe(false);
      await waitFor(() => expect(get).toHaveBeenCalledWith(`/api/keys?name=${endpoint}`, {}));
      expect(result.current.target.ready).toBe(false);
      expect(details()).toHaveLength(0);
      await act(async () => {
        refresh.resolve({ data: { expiresAt: 'never' } });
      });
      await waitFor(() => expect(result.current.target.ready).toBe(true));
      expect(client.getQueryState(key)?.isInvalidated).toBe(false);
      expect(isTargetReady(client, result.current.value)).toBe(true);
      expect(details()).toHaveLength(1);
    },
  );

  it.each([EModelEndpoint.assistants, EModelEndpoint.azureAssistants])(
    'keeps usable ordinary-stale %s key metadata ready during background freshness',
    async (endpoint) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, cacheTime: 0 } },
      });
      const key = [QueryKeys.name, endpoint];
      client.setQueryData(key, { expiresAt: 'never' }, { updatedAt: Date.now() - 60_000 });
      client.setQueryData(assistantKey(endpoint, 'same-id', '2', 'model-one'), {
        id: 'same-id',
        model: 'model-one',
      });
      expect(client.getQueryCache().find(key)?.isStaleByTime(0)).toBe(true);
      expect(client.getQueryState(key)?.isInvalidated).toBe(false);
      const refresh = deferred<{ data: { expiresAt: string } }>();
      const get = jest.spyOn(axios, 'get');
      const transport = get.getMockImplementation()!;
      get.mockImplementation((url, options) =>
        String(url).includes(`/api/keys?name=${endpoint}`)
          ? refresh.promise
          : transport(url, options),
      );
      const { result } = setup(selected(endpoint), configured, 0, client);
      expect(result.current.target.ready).toBe(true);
      await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('fetching'));
      expect(client.getQueryCache().find(key)?.isStale()).toBe(true);
      expect(result.current.target.ready).toBe(true);
      expect(isTargetReady(client, result.current.value)).toBe(true);
      await act(async () => {
        refresh.resolve({ data: { expiresAt: 'never' } });
      });
      await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('idle'));
      expect(result.current.target.ready).toBe(true);
    },
  );

  it('accepts an unexpired finite key', async () => {
    expiry = new Date(Date.now() + 60_000).toISOString();
    const { result } = setup(selected(EModelEndpoint.assistants), configured);
    await waitFor(() => expect(result.current.target.ready).toBe(true));
    expect(details()).toHaveLength(1);
  });

  it.each(['one', 'all'] as const)(
    'blocks cached details after revoking %s key scope without refetching',
    async (scope) => {
      const { result, client } = setup(selected(EModelEndpoint.assistants), configured);
      await waitFor(() => expect(result.current.target.ready).toBe(true));
      await act(async () => {
        if (scope === 'one') await result.current.revoke.mutateAsync({});
        else await result.current.revokeAll.mutateAsync({});
      });
      await waitFor(() => expect(result.current.target.ready).toBe(false));
      expect(result.current.target.assistant).toBeUndefined();
      expect(isTargetReady(client, result.current.value)).toBe(false);
      expect(details()).toHaveLength(1);
      await act(async () => {
        result.current.target.retry();
      });
      expect(details()).toHaveLength(1);
    },
  );

  it('keeps detail readiness invalidated until both credential and detail refresh finish', async () => {
    const { result, client } = setup(selected(EModelEndpoint.assistants), configured);
    await waitFor(() => expect(result.current.target.ready).toBe(true));
    const keyRefresh = deferred<{ data: { expiresAt: string } }>();
    const detailRefresh = deferred<{ data: Assistant }>();
    jest
      .spyOn(axios, 'get')
      .mockImplementation((url) =>
        String(url).includes('/api/keys') ? keyRefresh.promise : detailRefresh.promise,
      );
    let saved!: Promise<unknown>;
    await act(async () => {
      saved = result.current.update.mutateAsync({
        name: EModelEndpoint.assistants,
        value: 'new',
        expiresAt: '',
      });
    });
    await waitFor(() => expect(result.current.target.ready).toBe(false));
    expect(isTargetReady(client, result.current.value)).toBe(false);
    await act(async () => {
      keyRefresh.resolve({ data: { expiresAt: 'never' } });
    });
    expect(result.current.target.ready).toBe(false);
    expect(isTargetReady(client, result.current.value)).toBe(false);
    await act(async () => {
      detailRefresh.resolve({ data: { id: 'same-id', model: 'model-one' } as Assistant });
      await saved;
    });
    await waitFor(() => expect(result.current.target.ready).toBe(true));
  });

  it.each(['save', 'revoke'] as const)(
    'preserves the original %s scope when selection changes during the mutation',
    async (operation) => {
      const { result, client } = setup(selected(EModelEndpoint.assistants), configured, Infinity);
      await waitFor(() => expect(result.current.target.ready).toBe(true));
      const response = deferred<{ data: object }>();
      if (operation === 'save') jest.spyOn(axios, 'put').mockReturnValue(response.promise);
      else jest.spyOn(axios, 'delete').mockReturnValue(response.promise);
      let mutation!: Promise<unknown>;
      await act(async () => {
        mutation =
          operation === 'save'
            ? result.current.update.mutateAsync({
                name: EModelEndpoint.assistants,
                value: 'new',
                expiresAt: '',
              })
            : result.current.revoke.mutateAsync({});
      });
      act(() => result.current.setValue(selected(EModelEndpoint.azureAssistants)));
      await waitFor(() => expect(result.current.target.ready).toBe(true));
      const azureKey = assistantKey(EModelEndpoint.azureAssistants, 'same-id', '2', 'model-one');
      const azureState = client.getQueryState(azureKey);
      await act(async () => {
        response.resolve({ data: {} });
        await mutation;
      });
      expect(client.getQueryState(azureKey)?.dataUpdatedAt).toBe(azureState?.dataUpdatedAt);
      expect(client.getQueryState(azureKey)?.isInvalidated).toBe(false);
      expect(
        client.getQueryState(assistantKey(EModelEndpoint.assistants, 'same-id', '2', 'model-one'))
          ?.isInvalidated,
      ).toBe(true);
      expect(result.current.target.ready).toBe(true);
      expect(requests.filter((url) => url.includes('name=azureAssistants'))).toHaveLength(1);
      client.clear();
    },
  );

  it.each(['mutate', 'mutateAsync'] as const)(
    'keeps %s bound to the original name before the first request',
    async (method) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData([QueryKeys.endpoints], configured);
      const originalKey = assistantKey(EModelEndpoint.assistants, 'same-id', '2', 'model-one');
      const nextKey = assistantKey(EModelEndpoint.azureAssistants, 'same-id', '2', 'model-one');
      client.setQueryData(originalKey, { id: 'same-id' });
      client.setQueryData(nextKey, { id: 'same-id' });
      const response = deferred<{ data: object }>();
      const transport = jest.spyOn(axios, 'delete').mockReturnValue(response.promise);
      const { result, rerender, unmount } = renderHook(
        ({ name }: { name: string }) => useRevokeUserKeyMutation(name),
        {
          initialProps: { name: EModelEndpoint.assistants },
          wrapper: ({ children }: { children: React.ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
          ),
        },
      );
      const input = { request: 'original' };
      const onSuccess = jest.fn();
      let mutation: Promise<unknown> | void = undefined;
      act(() => {
        mutation = result.current[method](input, { onSuccess });
        rerender({ name: EModelEndpoint.azureAssistants });
      });
      expect(transport).not.toHaveBeenCalled();
      await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
      const requestedName = transport.mock.calls[0][0];
      await act(async () => {
        response.resolve({ data: {} });
        await mutation;
      });
      await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({}, input, undefined));
      expect(result.current.variables).toBe(input);
      const originalInvalidated = client.getQueryState(originalKey)?.isInvalidated;
      const nextInvalidated = client.getQueryState(nextKey)?.isInvalidated;
      unmount();
      client.clear();
      expect({ requestedName, originalInvalidated, nextInvalidated }).toEqual({
        requestedName: '/api/keys/assistants',
        originalInvalidated: true,
        nextInvalidated: false,
      });
    },
  );

  it('does not reuse Azure details across deployment models or API versions', async () => {
    const { result, client } = setup(selected(EModelEndpoint.azureAssistants), configured);
    await waitFor(() => expect(result.current.target.ready).toBe(true));
    act(() =>
      result.current.setValue({ ...selected(EModelEndpoint.azureAssistants), model: 'model-two' }),
    );
    await waitFor(() => expect(details()).toHaveLength(2));
    expect(details()[1]).toContain('model=model-two');
    act(() =>
      client.setQueryData([QueryKeys.endpoints], {
        ...configured,
        [EModelEndpoint.azureAssistants]: {
          ...configured[EModelEndpoint.azureAssistants],
          version: '1',
        },
      }),
    );
    await waitFor(() => expect(details()).toHaveLength(3));
    expect(details()[2]).toContain('/v1/');
  });

  it('does not request detail, discovery, or key transports for an unconfigured endpoint, including Retry', async () => {
    const { result } = setup(selected(EModelEndpoint.azureAssistants), {});
    await waitFor(() => expect(result.current.target.failed).toBe(true));
    await act(async () => {
      result.current.target.retry();
    });
    expect(requests).toHaveLength(0);
    expect(result.current.target.ready).toBe(false);
  });

  it('waits for credentials before discovering a missing assistant', async () => {
    expiry = '';
    const { result } = setup(conversation({ endpoint: EModelEndpoint.assistants }), configured);
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    await act(async () => {
      result.current.target.retry();
    });
    expect(dataService.listAssistants).not.toHaveBeenCalled();
    expect(details()).toHaveLength(0);
  });

  it.each([EModelEndpoint.openAI, EModelEndpoint.azureOpenAI])(
    'does not confuse the %s key with the separate assistant credential',
    async (name) => {
      const { result } = setup(selected(EModelEndpoint.assistants), configured);
      await waitFor(() => expect(result.current.target.ready).toBe(true));
      await act(async () => {
        await result.current.update.mutateAsync({ name, value: 'other-provider', expiresAt: '' });
      });
      expect(details()).toHaveLength(1);
      expect(result.current.target.ready).toBe(true);
    },
  );

  it('requires a user-provided assistant URL even with a deployment key', async () => {
    expiry = '';
    const { result } = setup(selected(EModelEndpoint.assistants), {
      [EModelEndpoint.assistants]: { order: 0, userProvide: false, userProvideURL: true },
    });
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(details()).toHaveLength(0);
    expect(result.current.target.ready).toBe(false);
  });

  it('does not hydrate a missing selection from cached discovery with unusable credentials', async () => {
    expiry = '';
    const { result, client } = setup(
      conversation({ endpoint: EModelEndpoint.assistants }),
      configured,
    );
    act(() =>
      client.setQueryData([QueryKeys.assistants, EModelEndpoint.assistants, defaultOrderQuery], {
        data: [{ id: 'old-account', model: 'old-model' }],
      }),
    );
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(result.current.value?.assistant_id).toBeUndefined();
    expect(result.current.value?.model).toBeUndefined();
    expect(result.current.target.failed).toBe(false);
    expect(dataService.listAssistants).not.toHaveBeenCalled();
  });

  it('invalidates previously loaded details when credentials are found expired', async () => {
    const { result, client } = setup(selected(EModelEndpoint.assistants), configured);
    await waitFor(() => expect(result.current.target.ready).toBe(true));
    expiry = '2000-01-01T00:00:00.000Z';
    await act(async () => {
      await client.invalidateQueries([QueryKeys.name, EModelEndpoint.assistants]);
    });
    await waitFor(() => expect(result.current.target.ready).toBe(false));
    expect(isTargetReady(client, result.current.value)).toBe(false);
    expect(details()).toHaveLength(1);
  });

  it('retries credential transport failures before requesting assistant details', async () => {
    jest.spyOn(axios, 'get').mockRejectedValueOnce(new Error('offline'));
    const { result } = setup(selected(EModelEndpoint.assistants), configured);
    await waitFor(() => expect(result.current.target.failed).toBe(true));
    expect(details()).toHaveLength(0);
    act(() => result.current.target.retry());
    await waitFor(() => expect(result.current.target.ready).toBe(true));
    expect(details()).toHaveLength(1);
  });

  it('does not accept the previous credential response after a key rotation', async () => {
    const stale = deferred<{ data: Assistant }>();
    const get = jest.spyOn(axios, 'get');
    const transport = get.getMockImplementation()!;
    let first = true;
    get.mockImplementation((url, config) => {
      if (String(url).includes('/api/assistants/') && first) {
        first = false;
        requests.push(String(url));
        return stale.promise;
      }
      return transport(url, config);
    });
    const { result } = setup(selected(EModelEndpoint.assistants), configured);
    await waitFor(() => expect(details()).toHaveLength(1));
    await act(async () => {
      await result.current.update.mutateAsync({
        name: EModelEndpoint.assistants,
        value: 'rotated',
        expiresAt: '',
      });
    });
    await waitFor(() => expect(result.current.target.ready).toBe(true));
    expect(result.current.target.assistant?.name).toBe('current-account');
    await act(async () => {
      stale.resolve({
        data: { id: 'same-id', model: 'old-model', name: 'previous-account' } as Assistant,
      });
    });
    expect(result.current.target.assistant?.name).toBe('current-account');
    expect(result.current.value?.model).toBe('model-one');
    expect(details()).toHaveLength(2);
  });

  it('does not share assistant detail data between account query clients', async () => {
    const first = setup(selected(EModelEndpoint.assistants), configured);
    await waitFor(() => expect(first.result.current.target.ready).toBe(true));
    first.unmount();
    first.client.clear();
    account = 'another-account';
    const second = setup(selected(EModelEndpoint.assistants), configured);
    expect(second.result.current.target.assistant).toBeUndefined();
    await waitFor(() => expect(second.result.current.target.ready).toBe(true));
    expect(second.result.current.target.assistant?.name).toBe('another-account');
    expect(details()).toHaveLength(2);
  });
});
