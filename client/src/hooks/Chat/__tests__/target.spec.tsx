import React, { useState } from 'react';
import { RecoilRoot } from 'recoil';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import type { TConversation, Agent, Assistant, TModelsConfig } from 'librechat-data-provider';
import { startupConfigKey } from '~/data-provider/Endpoints/queries';
import { isTargetReady } from '../ask/guards';
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
function setup(initial: TConversation | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 } },
    logger: { log: console.log, warn: console.warn, error: () => {} },
  });
  client.setQueryData([QueryKeys.endpoints], {
    [EModelEndpoint.openAI]: { order: 0 },
    [EModelEndpoint.agents]: { order: 1 },
    [EModelEndpoint.assistants]: { order: 2 },
  });
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
      return { value, setValue, target };
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
