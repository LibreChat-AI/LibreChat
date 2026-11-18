import React from 'react';
import { RecoilRoot } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import { dataService, PermissionBits, QueryKeys, EModelEndpoint } from 'librechat-data-provider';
import type { AgentListResponse, TStartupConfig } from 'librechat-data-provider';
import { activateCatalog, resetCatalogWarmup } from '~/hooks/useCatalogWarmup';
import useModelSpecs from '../specs';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, listAgents: jest.fn() } };
});

const config = {
  modelSpecs: {
    list: [
      { name: 'plain', preset: { endpoint: EModelEndpoint.openAI } },
      { name: 'view-only', preset: { endpoint: EModelEndpoint.agents, agent_id: 'agent_view' } },
      { name: 'later-page', preset: { endpoint: EModelEndpoint.agents, agent_id: 'agent_later' } },
      {
        name: 'inaccessible',
        preset: { endpoint: EModelEndpoint.agents, agent_id: 'agent_hidden' },
      },
      { name: 'ephemeral', preset: { endpoint: EModelEndpoint.agents, agent_id: 'ephemeral' } },
    ],
  },
} as TStartupConfig;
const response = (ids: string[], after?: string): AgentListResponse => ({
  object: 'list',
  data: ids.map((id) => ({ id, isEditable: false })) as AgentListResponse['data'],
  has_more: !!after,
  after,
  first_id: ids[0] ?? '',
  last_id: ids[ids.length - 1] ?? '',
});
const listAgents = jest.mocked(dataService.listAgents);
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 } },
    logger: { log: console.log, warn: console.warn, error: () => {} },
  });
  client.setQueryData([QueryKeys.endpoints], { agents: { order: 0 } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </RecoilRoot>
  );
  return { client, ...renderHook(() => useModelSpecs(config), { wrapper }) };
}
beforeEach(() => {
  jest.clearAllMocks();
  resetCatalogWarmup();
});
afterEach(() => {
  cleanup();
  resetCatalogWarmup();
});

it('does not fetch or hide specs before idle warmup', () => {
  const { result } = setup();
  expect(result.current).toBe(config.modelSpecs?.list);
  expect(listAgents).not.toHaveBeenCalled();
});
it('keeps later-page specs while pending, then filters against VIEW rather than EDIT access', async () => {
  let resolve!: (value: AgentListResponse) => void;
  listAgents.mockResolvedValueOnce(response(['agent_view'], 'next')).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  activateCatalog('agents');
  const { result } = setup();
  await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(2));
  expect(result.current).toBe(config.modelSpecs?.list);
  expect(listAgents.mock.calls[0][0].requiredPermission).toBe(PermissionBits.VIEW);
  await act(async () => resolve(response(['agent_later'])));
  await waitFor(() =>
    expect(result.current.map((spec) => spec.name)).toEqual([
      'plain',
      'view-only',
      'later-page',
      'ephemeral',
    ]),
  );
});
it('does not infer denial from a failed continuation page', async () => {
  listAgents
    .mockResolvedValueOnce(response(['agent_view'], 'next'))
    .mockRejectedValue(Object.assign(new Error('denied'), { status: 403 }));
  activateCatalog('agents');
  const { result, client } = setup();
  await waitFor(() =>
    expect(
      client.getQueryState([QueryKeys.agents, { requiredPermission: PermissionBits.VIEW }])?.status,
    ).toBe('error'),
  );
  expect(result.current).toBe(config.modelSpecs?.list);
});
it('removes inaccessible saved-agent specs after a genuinely empty VIEW catalog settles', async () => {
  listAgents.mockResolvedValue(response([]));
  activateCatalog('agents');
  const { result } = setup();
  await waitFor(() =>
    expect(result.current.map((spec) => spec.name)).toEqual(['plain', 'ephemeral']),
  );
});
