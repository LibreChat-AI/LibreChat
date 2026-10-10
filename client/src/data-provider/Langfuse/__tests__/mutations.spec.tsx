import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TLangfuseConnectionStatus } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useUpdateLangfuseConnectionMutation, useUpdateLangfusePromptSyncMutation } from '../index';

const mockUpdateLangfuseConnection = jest.fn();
const mockUpdateLangfusePromptSync = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      updateLangfuseConnection: (...args: unknown[]) => mockUpdateLangfuseConnection(...args),
      updateLangfusePromptSync: (...args: unknown[]) => mockUpdateLangfusePromptSync(...args),
    },
  };
});

function connectionStatus(overrides: Partial<TLangfuseConnectionStatus> = {}) {
  return {
    configured: true,
    enabled: true,
    destinations: [{ key: 'us', baseUrl: 'https://us.cloud.langfuse.com' }],
    destination: 'us',
    publicKey: 'pk-lf-new',
    promptSync: { available: true, enabled: true },
    ...overrides,
  } as TLangfuseConnectionStatus;
}

/** Seeds the always-mounted prompts dialog's cached list/get results, the way a real
 *  submit of its list/get forms would, so a test can assert they are gone afterward. */
function seedCachedPrompts(queryClient: QueryClient) {
  queryClient.setQueryData([QueryKeys.langfusePrompts, { page: 1 }, 1], {
    items: [{ name: 'greeting' }],
    meta: { page: 1, limit: 10, totalItems: 1, totalPages: 1 },
  });
  queryClient.setQueryData([QueryKeys.langfusePrompt, { name: 'greeting' }, 1], {
    name: 'greeting',
    version: 1,
    labels: [],
    prompt: 'Hello',
  });
}

function cachedPromptKeys(queryClient: QueryClient) {
  return queryClient
    .getQueryCache()
    .findAll()
    .map((query) => query.queryKey[0]);
}

describe('Langfuse prompt cache invalidation', () => {
  let queryClient: QueryClient;
  let wrapper: ({ children }: { children: ReactNode }) => JSX.Element;

  beforeEach(() => {
    jest.resetAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  });

  it('removes cached prompt list/get results once the prompt-sync mutation succeeds', async () => {
    seedCachedPrompts(queryClient);
    expect(cachedPromptKeys(queryClient)).toEqual(
      expect.arrayContaining([QueryKeys.langfusePrompts, QueryKeys.langfusePrompt]),
    );

    mockUpdateLangfusePromptSync.mockResolvedValueOnce(connectionStatus());
    const { result } = renderHook(() => useUpdateLangfusePromptSyncMutation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ enabled: false });
    });

    expect(cachedPromptKeys(queryClient)).not.toEqual(
      expect.arrayContaining([QueryKeys.langfusePrompts]),
    );
    expect(cachedPromptKeys(queryClient)).not.toEqual(
      expect.arrayContaining([QueryKeys.langfusePrompt]),
    );
  });

  it('removes cached prompt list/get results once the connection update mutation succeeds', async () => {
    seedCachedPrompts(queryClient);

    mockUpdateLangfuseConnection.mockResolvedValueOnce(connectionStatus());
    const { result } = renderHook(() => useUpdateLangfuseConnectionMutation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        enabled: true,
        destination: 'us',
        publicKey: 'pk-lf-new',
        secretKey: 'sk-lf-new',
      });
    });

    expect(cachedPromptKeys(queryClient)).not.toEqual(
      expect.arrayContaining([QueryKeys.langfusePrompts]),
    );
    expect(cachedPromptKeys(queryClient)).not.toEqual(
      expect.arrayContaining([QueryKeys.langfusePrompt]),
    );
  });

  it('leaves other cached queries untouched', async () => {
    seedCachedPrompts(queryClient);
    queryClient.setQueryData([QueryKeys.langfuseConnection], connectionStatus());

    mockUpdateLangfusePromptSync.mockResolvedValueOnce(connectionStatus());
    const { result } = renderHook(() => useUpdateLangfusePromptSyncMutation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ enabled: true });
    });

    expect(queryClient.getQueryData([QueryKeys.langfuseConnection])).toEqual(connectionStatus());
  });
});
