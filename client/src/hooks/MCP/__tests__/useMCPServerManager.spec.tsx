import React from 'react';
import { Provider } from 'jotai';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { MCPReinitializeResponse } from 'librechat-data-provider';
import { useMCPServerManager } from '../useMCPServerManager';

const mockOpenInNewTab = jest.fn();
jest.mock('~/utils', () => ({ openInNewTab: (...args: unknown[]) => mockOpenInNewTab(...args) }));

const mockShowToast = jest.fn();
const mockSetMCPValues = jest.fn();
const mockReinitialize = jest.fn();
const mockUseMCPToolsQuery = jest.fn((_options?: unknown) => ({ data: undefined }));
const mockUseMCPConnectionStatus = jest.fn((_options?: unknown) => ({ connectionStatus: {} }));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useCatalogReady: () => true,
  useMCPSelect: () => ({ mcpValues: [], setMCPValues: mockSetMCPValues }),
  useMCPConnectionStatus: (options: unknown) => mockUseMCPConnectionStatus(options),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: {} }),
  useMCPServersQuery: () => ({ data: {}, isLoading: false }),
  useMCPToolsQuery: (options: unknown) => mockUseMCPToolsQuery(options),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useReinitializeMCPServerMutation: () => ({ mutateAsync: mockReinitialize }),
  useCancelMCPOAuthMutation: () => ({}),
  useUpdateUserPluginsMutation: () => ({}),
  useGetAllEffectivePermissionsQuery: () => ({ data: {} }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('useMCPServerManager initialization', () => {
  it.each(['response', 'http'] as const)(
    'clears the spinner after a transient %s failure and lets retry succeed without OAuth',
    async (failure) => {
      mockReinitialize.mockReset();
      mockSetMCPValues.mockClear();
      mockShowToast.mockClear();
      mockOpenInNewTab.mockClear();
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <Provider>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </Provider>
      );
      const { result, unmount } = renderHook(() => useMCPServerManager(), { wrapper });
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        if (failure === 'http') {
          mockReinitialize.mockRejectedValueOnce(new Error('Service temporarily unavailable'));
        } else {
          mockReinitialize.mockResolvedValueOnce({
            success: false,
            serverName: 'test-server',
            oauthRequired: false,
            failureReason: 'initialization_failed',
          });
        }
        await act(async () => {
          await result.current.initializeServer('test-server');
        });
        expect(result.current.isInitializing('test-server')).toBe(false);
        expect(result.current.isCancellable('test-server')).toBe(false);
        expect(mockOpenInNewTab).not.toHaveBeenCalled();
        expect(mockSetMCPValues).not.toHaveBeenCalled();
        expect(mockShowToast).toHaveBeenLastCalledWith({
          message: 'com_ui_mcp_init_failed',
          status: 'error',
        });

        mockReinitialize.mockResolvedValueOnce({
          success: true,
          serverName: 'test-server',
          oauthRequired: false,
        });
        await act(async () => {
          await result.current.initializeServer('test-server');
        });
        expect(mockReinitialize).toHaveBeenCalledTimes(2);
        expect(result.current.isInitializing('test-server')).toBe(false);
        expect(mockOpenInNewTab).not.toHaveBeenCalled();
        expect(mockSetMCPValues).toHaveBeenCalledWith(['test-server']);
        expect(mockShowToast).toHaveBeenLastCalledWith({
          message: 'com_ui_mcp_initialized_success',
          status: 'success',
        });
      } finally {
        consoleError.mockRestore();
        unmount();
        queryClient.clear();
      }
    },
  );

  it('keeps passive authorization observers opt-in for shared hook callers', () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <Provider>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </Provider>
    );

    const { unmount } = renderHook(() => useMCPServerManager(), { wrapper });

    expect(mockUseMCPToolsQuery).toHaveBeenLastCalledWith({ enabled: false });
    expect(mockUseMCPConnectionStatus).toHaveBeenLastCalledWith({ enabled: false });
    unmount();
    queryClient.clear();
  });

  it.each(['success', 'error'])(
    'finishes before a slow catalog refetch ends in %s',
    async (outcome) => {
      const connection = deferred<MCPReinitializeResponse>();
      const catalog = deferred<string[]>();
      mockReinitialize.mockReturnValue(connection.promise);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, cacheTime: 0 } },
        logger: { log: console.log, warn: console.warn, error: jest.fn() },
      });
      const catalogQuery = new QueryObserver(queryClient, {
        queryKey: [QueryKeys.mcpTools],
        queryFn: () => catalog.promise,
        initialData: [],
        staleTime: Infinity,
      });
      const unsubscribe = catalogQuery.subscribe(() => undefined);
      const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <Provider>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </Provider>
      );
      const { result, unmount } = renderHook(() => useMCPServerManager(), { wrapper });
      const initialized = jest.fn();

      try {
        act(() => {
          void result.current.initializeServer('test-server').then(initialized);
        });
        expect(result.current.isInitializing('test-server')).toBe(true);
        expect(mockShowToast).not.toHaveBeenCalled();

        const response = { success: true, message: 'Connected', serverName: 'test-server' };
        await act(async () => {
          connection.resolve(response);
        });

        expect(queryClient.getQueryState([QueryKeys.mcpTools])?.fetchStatus).toBe('fetching');
        expect(result.current.isInitializing('test-server')).toBe(false);
        expect(initialized).toHaveBeenCalledWith(response);
        expect(mockSetMCPValues).toHaveBeenCalledWith(['test-server']);
        expect(mockShowToast).toHaveBeenCalledWith({
          message: 'com_ui_mcp_initialized_success',
          status: 'success',
        });
        for (const key of [
          QueryKeys.mcpServers,
          QueryKeys.mcpTools,
          QueryKeys.mcpAuthValues,
          QueryKeys.mcpConnectionStatus,
        ]) {
          expect(invalidate).toHaveBeenCalledWith([key]);
        }

        await act(async () => {
          if (outcome === 'error') {
            catalog.reject(new Error('Catalog unavailable'));
          } else {
            catalog.resolve(['test-tool']);
          }
        });
        await waitFor(() => {
          expect(queryClient.getQueryState([QueryKeys.mcpTools])?.fetchStatus).toBe('idle');
        });
        expect(result.current.isInitializing('test-server')).toBe(false);
        expect(mockShowToast).toHaveBeenCalledTimes(1);
      } finally {
        catalog.resolve([]);
        unmount();
        unsubscribe();
        queryClient.clear();
      }
    },
  );
});
