import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGetEndpointModelsQuery } from 'librechat-data-provider/react-query';
import { dataService, QueryKeys, EModelEndpoint, getConfigDefaults } from 'librechat-data-provider';
import type { TModelsConfig, TEndpointsConfig, TStartupConfig } from 'librechat-data-provider';
import { activateCatalog, resetCatalogWarmup } from '~/hooks/useCatalogWarmup';
import useEndpoints from '~/hooks/Endpoint/useEndpoints';
import { startupConfigKey } from '../queries';
import { useModelCatalog } from '../models';
import store from '~/store';

jest.mock('../../../../../packages/data-provider/src/data-service', () => ({
  ...jest.requireActual('../../../../../packages/data-provider/src/data-service'),
  getModels: jest.fn(),
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getModels: jest.requireMock('../../../../../packages/data-provider/src/data-service')
        .getModels,
    },
  };
});

jest.mock('~/hooks', () => ({
  useHasAccess: () => true,
  useShowMarketplace: () => false,
}));

const getModels = jest.mocked(dataService.getModels);
const endpointsConfig: TEndpointsConfig = {
  [EModelEndpoint.openAI]: { order: 0 },
  [EModelEndpoint.anthropic]: { order: 1 },
  [EModelEndpoint.agents]: { order: 2 },
};
const startupConfig: TStartupConfig = {
  appTitle: 'Test',
  discordLoginEnabled: false,
  facebookLoginEnabled: false,
  githubLoginEnabled: false,
  googleLoginEnabled: false,
  openidLoginEnabled: false,
  appleLoginEnabled: false,
  samlLoginEnabled: false,
  passkeyLoginEnabled: false,
  openidLabel: '',
  openidImageUrl: '',
  openidAutoRedirect: false,
  samlLabel: '',
  samlImageUrl: '',
  serverDomain: '',
  emailLoginEnabled: false,
  registrationEnabled: false,
  socialLoginEnabled: false,
  passwordResetEnabled: false,
  emailEnabled: false,
  allowEmailChange: false,
  showBirthdayIcon: false,
  helpAndFaqURL: '',
  sharedLinksEnabled: false,
  publicSharedLinksEnabled: false,
  allowAccountDeletion: false,
  interface: getConfigDefaults().interface,
};

function setup(startup = startupConfig) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: console.log, warn: console.warn, error: () => {} },
  });
  client.setQueryData([QueryKeys.endpoints], endpointsConfig);
  client.setQueryData(startupConfigKey(false), startup);
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <RecoilRoot initializeState={({ set }) => set(store.queriesEnabled, true)}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </RecoilRoot>
    );
  }
  return { client, wrapper: Wrapper };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('useModelCatalog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCatalogWarmup();
  });

  afterEach(() => {
    act(() => resetCatalogWarmup());
  });

  it('waits for idle and never starts the aggregate models query', async () => {
    getModels.mockImplementation(async (endpoint) => ({ [endpoint!]: ['model'] }));
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useModelCatalog(), { wrapper });
    expect(getModels).not.toHaveBeenCalled();
    expect(result.current.data).toEqual({});

    act(() => activateCatalog('models'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getModels).toHaveBeenCalledTimes(2);
    expect(getModels.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      EModelEndpoint.openAI,
      EModelEndpoint.anthropic,
    ]);
    expect(client.getQueryData([QueryKeys.models])).toBeUndefined();
  });

  it('publishes one endpoint while another is pending and keeps data references stable', async () => {
    const pending = deferred<TModelsConfig>();
    getModels.mockImplementation((endpoint) =>
      endpoint === EModelEndpoint.openAI
        ? Promise.resolve({ [EModelEndpoint.openAI]: ['gpt-4o'] })
        : pending.promise,
    );
    activateCatalog('models');
    const { wrapper } = setup();
    const { result, rerender } = renderHook(() => useModelCatalog(), { wrapper });

    await waitFor(() => expect(result.current.data.openAI).toEqual(['gpt-4o']));
    expect(result.current.data.anthropic).toBeUndefined();
    expect(result.current.endpointQueries.anthropic.isLoading).toBe(true);
    expect(result.current.isLoading).toBe(false);
    const first = result.current.data;
    rerender();
    expect(result.current.data).toBe(first);

    await act(async () => pending.resolve({ [EModelEndpoint.anthropic]: ['claude'] }));
    await waitFor(() => expect(result.current.data.anthropic).toEqual(['claude']));
    expect(result.current.data.openAI).toBe(first.openAI);
  });

  it('keeps available models on failure and retries only the unavailable endpoint', async () => {
    const failure = Object.assign(new Error('Unavailable'), { status: 403 });
    getModels.mockImplementation((endpoint) =>
      endpoint === EModelEndpoint.openAI
        ? Promise.resolve({ [EModelEndpoint.openAI]: ['gpt-4o'] })
        : Promise.reject(failure),
    );
    activateCatalog('models');
    const { wrapper } = setup();
    const { result } = renderHook(() => useModelCatalog(), { wrapper });

    await waitFor(() => expect(result.current.endpointQueries.anthropic.isError).toBe(true));
    expect(result.current.data.openAI).toEqual(['gpt-4o']);
    expect(result.current.data.anthropic).toBeUndefined();
    getModels.mockResolvedValueOnce({ [EModelEndpoint.anthropic]: ['claude'] });
    await act(async () => {
      await result.current.endpointQueries.anthropic.refetch();
    });
    await waitFor(() => expect(result.current.data.anthropic).toEqual(['claude']));
    expect(
      getModels.mock.calls.filter(([endpoint]) => endpoint === EModelEndpoint.openAI),
    ).toHaveLength(1);
  });

  it('shares endpoint-scoped cache data with the selected-target observer', async () => {
    getModels.mockResolvedValue({ [EModelEndpoint.openAI]: ['gpt-4o'] });
    activateCatalog('models');
    const { client, wrapper } = setup({
      ...startupConfig,
      modelSpecs: {
        enforce: false,
        prioritize: true,
        list: [],
        addedEndpoints: [EModelEndpoint.openAI],
      },
    });
    const { result } = renderHook(
      () => ({
        selected: useGetEndpointModelsQuery(EModelEndpoint.openAI),
        catalog: useModelCatalog(),
      }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.catalog.data.openAI).toEqual(['gpt-4o']));
    expect(getModels).toHaveBeenCalledTimes(1);
    expect(client.getQueryData([QueryKeys.models, EModelEndpoint.openAI])).toEqual({
      openAI: ['gpt-4o'],
    });
  });

  it('can request one needed endpoint before idle without fetching hidden catalogs', async () => {
    getModels.mockResolvedValue({ [EModelEndpoint.openAI]: ['gpt-4o'] });
    const { wrapper } = setup();
    const { result } = renderHook(
      () =>
        useModelCatalog(undefined, {
          eager: true,
          endpoints: [EModelEndpoint.openAI],
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data.openAI).toEqual(['gpt-4o']));
    expect(getModels).toHaveBeenCalledTimes(1);
    expect(getModels).toHaveBeenCalledWith(EModelEndpoint.openAI);
  });

  it('keeps endpoints visible while their independent model lists are unresolved', async () => {
    const pending = deferred<TModelsConfig>();
    getModels.mockImplementation((endpoint) =>
      endpoint === EModelEndpoint.openAI
        ? Promise.resolve({ [EModelEndpoint.openAI]: ['gpt-4o'] })
        : pending.promise,
    );
    activateCatalog('models');
    const { wrapper } = setup();
    const { result } = renderHook(
      () =>
        useEndpoints({
          agents: [],
          endpointsConfig,
          startupConfig,
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.mappedEndpoints[0]?.models).toEqual([
        { name: 'gpt-4o', isGlobal: false },
      ]),
    );
    const unresolved = result.current.mappedEndpoints.find(
      (endpoint) => endpoint.value === EModelEndpoint.anthropic,
    );
    expect(unresolved).toMatchObject({ hasModels: true, isLoading: true, isUnavailable: false });
    expect(unresolved?.models).toBeUndefined();
    await act(async () => pending.resolve({ [EModelEndpoint.anthropic]: [] }));
    await waitFor(() => expect(result.current.mappedEndpoints[1]?.isLoading).toBe(false));
  });
});
