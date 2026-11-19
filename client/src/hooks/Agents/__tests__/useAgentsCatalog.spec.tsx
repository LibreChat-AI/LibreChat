import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { QueryKeys, EModelEndpoint, PermissionBits, dataService } from 'librechat-data-provider';
import type { AgentListResponse } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { activateCatalog, resetCatalogWarmup } from '~/hooks/useCatalogWarmup';
import useAgentsMap, { useAgentsCatalog } from '../useAgentsMap';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, listAgents: jest.fn() } };
});
const list = jest.mocked(dataService.listAgents);
const page = (id: string, after: string | null = null): AgentListResponse =>
  ({
    object: 'list',
    data: [{ id, name: id }],
    first_id: id,
    last_id: id,
    has_more: after != null,
    after,
  }) as AgentListResponse;
const denied = Object.assign(new Error('denied'), {
  isAxiosError: true,
  response: { status: 403 },
});
function setup({
  enabled,
  available = true,
  authenticated = true,
  client: supplied,
}: { enabled?: boolean; available?: boolean; authenticated?: boolean; client?: QueryClient } = {}) {
  const client =
    supplied ??
    new QueryClient({
      defaultOptions: { queries: { retry: false } },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
  client.setQueryData([QueryKeys.endpoints], available ? { [EModelEndpoint.agents]: {} } : {});
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    client,
    ...renderHook(
      () => ({
        catalog: useAgentsCatalog({ isAuthenticated: authenticated, enabled }),
        legacy: useAgentsMap({ isAuthenticated: authenticated, enabled }),
      }),
      { wrapper },
    ),
  };
}
beforeEach(() => {
  list.mockReset();
  resetCatalogWarmup();
  activateCatalog('agents');
});
afterEach(() => onlineManager.setOnline(true));

it.each(['present', 'missing', 'failure'] as const)(
  'keeps incremental metadata pending until the next page settles: %s',
  async (outcome) => {
    let release!: (value: AgentListResponse) => void;
    let reject!: (error: Error) => void;
    list.mockResolvedValueOnce(page('root', 'next')).mockImplementationOnce(
      () =>
        new Promise((yes, no) => {
          release = yes;
          reject = no;
        }),
    );
    const { result, rerender } = setup();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(result.current.catalog.agentsMap?.root).toBeDefined();
    expect(result.current.catalog.agentsMap?.child).toBeUndefined();
    expect(result.current.catalog.pending).toBe(true);
    expect(result.current.legacy).toEqual(result.current.catalog.agentsMap);
    const first = result.current.catalog.agentsMap;
    const legacy = result.current.legacy;
    rerender();
    expect(result.current.catalog.agentsMap).toBe(first);
    expect(result.current.legacy).toBe(legacy);
    await act(async () =>
      outcome === 'failure'
        ? reject(denied)
        : release(page(outcome === 'present' ? 'child' : 'other')),
    );
    await waitFor(() => expect(result.current.catalog.pending).toBe(false));
    expect(Boolean(result.current.catalog.agentsMap?.child)).toBe(outcome === 'present');
    expect(result.current.catalog.agentsMap?.root).toBeDefined();
    expect(list).toHaveBeenCalledTimes(2);
  },
);

it('settles an initial failure instead of preserving unknown metadata forever', async () => {
  list.mockRejectedValue(denied);
  const { result } = setup();
  await waitFor(() => expect(result.current.catalog.pending).toBe(false));
  expect(result.current.catalog.agentsMap).toBeUndefined();
  expect(list).toHaveBeenCalledTimes(1);
});
it('keeps an offline query pending until its native owner resumes', async () => {
  onlineManager.setOnline(false);
  list.mockResolvedValue(page('root'));
  const { result } = setup();
  expect(result.current.catalog.pending).toBe(true);
  expect(list).not.toHaveBeenCalled();
  act(() => onlineManager.setOnline(true));
  await waitFor(() => expect(result.current.catalog.pending).toBe(false));
  expect(list).toHaveBeenCalledTimes(1);
});
it.each([{ enabled: false }, { available: false }, { authenticated: false }])(
  'does not wait for a disabled or unavailable owner: %j',
  (options) => {
    const { result } = setup(options);
    expect(result.current.catalog.pending).toBe(false);
    expect(list).not.toHaveBeenCalled();
  },
);
it('retains a warmup wait without starting an eager request', async () => {
  resetCatalogWarmup();
  list.mockResolvedValue(page('root'));
  const { result } = setup();
  expect(result.current.catalog.pending).toBe(true);
  expect(list).not.toHaveBeenCalled();
  act(() => activateCatalog('agents'));
  await waitFor(() => expect(result.current.catalog.pending).toBe(false));
  expect(list).toHaveBeenCalledTimes(1);
});

it.each(['complete', 'error'] as const)(
  'keeps unreleased warmup pending with stale cached %s data',
  async (cached) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    const key = [QueryKeys.agents, { requiredPermission: PermissionBits.VIEW }];
    client.setQueryData(
      key,
      { pages: [page('old-root')], pageParams: [undefined] },
      { updatedAt: Date.now() - 10000 },
    );
    if (cached === 'error')
      await client.fetchInfiniteQuery(key, () => Promise.reject(denied)).catch(() => undefined);
    resetCatalogWarmup();
    list.mockResolvedValue(page('new-child'));
    const { result } = setup({ client });
    expect(result.current.catalog.pending).toBe(true);
    expect(list).not.toHaveBeenCalled();
    act(() => activateCatalog('agents'));
    await waitFor(() => expect(result.current.catalog.pending).toBe(false));
    expect(result.current.catalog.agentsMap?.['new-child']).toBeDefined();
    expect(list).toHaveBeenCalledTimes(1);
  },
);
