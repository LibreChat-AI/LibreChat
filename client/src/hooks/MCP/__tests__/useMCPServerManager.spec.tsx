import React from 'react';
import { Provider, createStore } from 'jotai';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type {
  MCPServersResponse,
  MCPReinitializeResponse,
  MCPServerStatus,
} from 'librechat-data-provider';
import { resetMCPStateAtom, mcpConnectResultsAtom } from '~/store/mcp';
import { useMCPServerManager } from '../useMCPServerManager';

let mockServers = {
  'test-server': {
    type: 'streamable-http',
    url: 'https://mcp.example.test',
    requiresOAuth: false,
    updatedAt: undefined as number | undefined,
  },
};
const mockOpenInNewTab = jest.fn();
jest.mock('~/utils', () => ({ openInNewTab: (...args: unknown[]) => mockOpenInNewTab(...args) }));

const mockUser = { id: 'user', tenantId: 'tenant-a' };
const mockShowToast = jest.fn();
const mockSetMCPValues = jest.fn();
const mockReinitialize = jest.fn();
const mockCancelOAuth = jest.fn();
const mockGetOAuthStatus = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getMCPOAuthStatus: (...args: unknown[]) => mockGetOAuthStatus(...args),
    },
  };
});
const mockUseMCPToolsQuery = jest.fn((_options?: unknown): { data?: MCPServersResponse } => ({
  data: undefined,
}));
const mockUseMCPConnectionStatus = jest.fn(
  (
    _options?: unknown,
  ): { connectionStatus: Record<string, MCPServerStatus>; readStartedAt?: number } => ({
    connectionStatus: {},
  }),
);

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: mockUser }),
  useHasAccess: () => true,
  useCatalogReady: () => true,
  useMCPSelect: () => ({ mcpValues: [], setMCPValues: mockSetMCPValues }),
  useMCPConnectionStatus: (options: unknown) => mockUseMCPConnectionStatus(options),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: {} }),
  useMCPServersQuery: () => ({ data: mockServers, isLoading: false }),
  useMCPToolsQuery: (options: unknown) => mockUseMCPToolsQuery(options),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useReinitializeMCPServerMutation: () => ({ mutateAsync: mockReinitialize }),
  useCancelMCPOAuthMutation: () => ({ mutate: mockCancelOAuth }),
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

  it('keeps a server this browser is authorizing connecting when rediscovery outdates a cached connection', async () => {
    jest.useFakeTimers();
    const serverName = 'clickhouse';
    /** Stored tokens the server rejects: status reports a durable connection, discovery a reauth. */
    const connectionStatus = {
      [serverName]: {
        requiresOAuth: true,
        connectionState: 'connected' as const,
        authorizationState: 'authorized' as const,
        authorizationGeneration: 'generation-1',
      },
    };
    const catalog = (authorizationGeneration: string) => ({
      data: {
        servers: {
          [serverName]: {
            name: serverName,
            icon: '',
            authenticated: false,
            authorizationState: 'reauth_required' as const,
            authorizationGeneration,
            authConfig: [],
            tools: [],
          },
        },
      },
    });
    mockUseMCPConnectionStatus.mockImplementation(() => ({ connectionStatus }));
    mockUseMCPToolsQuery.mockImplementation(() => catalog('generation-1'));
    mockReinitialize.mockReset();
    mockReinitialize.mockResolvedValueOnce({
      success: true,
      serverName,
      oauthRequired: true,
      oauthUrl: 'https://auth.example.test/authorize',
      flowId: `user:${serverName}`,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <Provider>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </Provider>
    );
    const { result, rerender, unmount } = renderHook(() => useMCPServerManager(), { wrapper });

    try {
      expect(result.current.connectionStatus?.[serverName]?.connectionState).toBe('disconnected');

      await act(async () => {
        await result.current.initializeServer(serverName, false);
      });
      /** Reinitialize refetches the catalog, which reports a newer generation than cached status. */
      mockUseMCPToolsQuery.mockImplementation(() => catalog('generation-2'));
      rerender();

      expect(result.current.connectionStatus?.[serverName]).toMatchObject({
        connectionState: 'connecting',
        authorizationState: 'authorizing',
      });
      expect(result.current.getServerStatusIconProps(serverName)).toMatchObject({
        isInitializing: true,
        canCancel: true,
      });
    } finally {
      unmount();
      queryClient.clear();
      jest.clearAllTimers();
      jest.useRealTimers();
      mockUseMCPConnectionStatus.mockImplementation(() => ({ connectionStatus: {} }));
      mockUseMCPToolsQuery.mockImplementation(() => ({ data: undefined }));
    }
  });
});

describe('replica-independent Connect results', () => {
  const name = 'test-server';
  const cold: MCPServerStatus = {
    requiresOAuth: false,
    authorizationState: 'not_required',
    connectionState: 'disconnected',
    connectionStateSource: 'unobserved',
    authorizationGeneration: 'generation-2',
  };
  const success = {
    success: true,
    serverName: name,
    oauthRequired: false,
    authorizationGeneration: 'generation-2',
  };
  beforeEach(() => {
    mockReinitialize.mockReset();
    mockSetMCPValues.mockClear();
    mockShowToast.mockClear();
    mockUseMCPToolsQuery.mockReturnValue({ data: undefined });
    mockUseMCPConnectionStatus.mockReturnValue({ connectionStatus: { [name]: cold } });
  });
  afterEach(() => {
    mockUseMCPConnectionStatus.mockReturnValue({ connectionStatus: {} });
  });
  function setup() {
    const session = createStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <Provider store={session}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </Provider>
    );
    const hook = renderHook(() => useMCPServerManager(), { wrapper });
    const cleanup = () => {
      hook.unmount();
      queryClient.clear();
    };
    return { ...hook, session, queryClient, cleanup };
  }

  it('keeps Connect on A successful when a fresh poll on B has no local client', async () => {
    mockReinitialize.mockResolvedValueOnce(success);
    const hook = setup();
    try {
      await act(async () => {
        await hook.result.current.initializeServer(name);
      });
      mockUseMCPConnectionStatus.mockReturnValue({ connectionStatus: { [name]: { ...cold } } });
      hook.rerender();
      expect(hook.result.current.connectionStatus?.[name].connectionState).toBe('connected');
      expect(hook.result.current.isInitializing(name)).toBe(false);
    } finally {
      hook.cleanup();
    }
  });

  it('keeps a failed Connect visible against cold polling and replaces it on retry', async () => {
    mockReinitialize.mockResolvedValueOnce({
      ...success,
      success: false,
      failureReason: 'initialization_failed',
    });
    const hook = setup();
    try {
      await act(async () => {
        await hook.result.current.initializeServer(name);
      });
      expect(hook.result.current.connectionStatus?.[name].connectionState).toBe('error');
      mockReinitialize.mockResolvedValueOnce(success);
      await act(async () => {
        await hook.result.current.initializeServer(name);
      });
      expect(hook.result.current.connectionStatus?.[name].connectionState).toBe('connected');
    } finally {
      hook.cleanup();
    }
  });

  it('clears a retained failure on fresh transport recovery and keeps it through a later cold poll', async () => {
    mockReinitialize.mockResolvedValueOnce({ ...success, success: false });
    const hook = setup();
    try {
      await act(async () => {
        await hook.result.current.initializeServer(name);
      });
      const readStartedAt =
        (hook.session.get(mcpConnectResultsAtom)[name].settledAt ?? Date.now()) + 1;
      mockUseMCPConnectionStatus.mockReturnValue({
        connectionStatus: {
          [name]: { ...cold, connectionState: 'connected', connectionStateSource: 'transport' },
        },
        readStartedAt,
      });
      hook.rerender();
      expect(hook.result.current.connectionStatus?.[name].connectionState).toBe('connected');
      mockUseMCPConnectionStatus.mockReturnValue({
        connectionStatus: { [name]: cold },
        readStartedAt: readStartedAt + 1,
      });
      hook.rerender();
      expect(hook.result.current.connectionStatus?.[name].connectionState).toBe('connected');
    } finally {
      hook.cleanup();
    }
  });

  it('retains failed Connect against an older connected status read', async () => {
    mockReinitialize.mockResolvedValueOnce({ ...success, success: false });
    const hook = setup();
    try {
      await act(async () => {
        await hook.result.current.initializeServer(name);
      });
      const readStartedAt =
        (hook.session.get(mcpConnectResultsAtom)[name].settledAt ?? Date.now()) - 1;
      mockUseMCPConnectionStatus.mockReturnValue({
        connectionStatus: {
          [name]: { ...cold, connectionState: 'connected', connectionStateSource: 'transport' },
        },
        readStartedAt,
      });
      hook.rerender();
      expect(hook.result.current.connectionStatus?.[name].connectionState).toBe('error');
    } finally {
      hook.cleanup();
    }
  });

  it('keeps a recovered outcome at its used revision and rejects a later edit', async () => {
    const original = mockServers;
    mockServers = { [name]: { ...original[name], updatedAt: 100 } };
    mockReinitialize.mockResolvedValueOnce({ ...success, configurationUpdatedAt: 200 });
    const hook = setup();
    try {
      await act(async () => {
        await hook.result.current.initializeServer(name);
      });
      mockServers = { [name]: { ...original[name], updatedAt: 200 } };
      hook.rerender();
      expect(hook.result.current.connectionStatus?.[name].connectionState).toBe('connected');
      mockServers = { [name]: { ...original[name], updatedAt: 300 } };
      hook.rerender();
      expect(hook.result.current.connectionStatus?.[name].connectionState).toBe('disconnected');
    } finally {
      mockServers = original;
      hook.cleanup();
    }
  });

  it('discards a late Connect response after a different configuration revision is loaded', async () => {
    const original = mockServers;
    mockServers = { [name]: { ...original[name], updatedAt: 100 } };
    const pending = deferred<MCPReinitializeResponse>();
    mockReinitialize.mockReturnValueOnce(pending.promise);
    const hook = setup();
    try {
      let request: Promise<unknown>;
      act(() => {
        request = hook.result.current.initializeServer(name);
      });
      mockServers = { [name]: { ...original[name], updatedAt: 300 } };
      hook.rerender();
      await act(async () => {
        pending.resolve({ ...success, configurationUpdatedAt: 100 });
        await request;
      });
      expect(hook.result.current.isInitializing(name)).toBe(false);
      expect(mockShowToast).not.toHaveBeenCalled();
      expect(mockSetMCPValues).not.toHaveBeenCalled();
    } finally {
      mockServers = original;
      hook.cleanup();
    }
  });

  it('does not mask a real transport error on B', async () => {
    mockReinitialize.mockResolvedValueOnce(success);
    const hook = setup();
    try {
      await act(async () => {
        await hook.result.current.initializeServer(name);
      });
      mockUseMCPConnectionStatus.mockReturnValue({
        readStartedAt:
          (hook.session.get(mcpConnectResultsAtom)[name].settledAt ?? performance.now()) + 1,
        connectionStatus: {
          [name]: {
            ...cold,
            connectionState: 'error',
            connectionStateSource: 'transport',
          },
        },
      });
      hook.rerender();
      expect(hook.result.current.connectionStatus?.[name].connectionState).toBe('error');
    } finally {
      hook.cleanup();
    }
  });

  it('ignores an older successful response after the latest attempt failed', async () => {
    const first = deferred<MCPReinitializeResponse>();
    const second = deferred<MCPReinitializeResponse>();
    mockReinitialize.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const hook = setup();
    try {
      let oldRequest: Promise<unknown>;
      let newRequest: Promise<unknown>;
      act(() => {
        oldRequest = hook.result.current.initializeServer(name);
      });
      act(() => {
        newRequest = hook.result.current.initializeServer(name);
      });
      await act(async () => {
        second.resolve({ ...success, success: false });
        await newRequest;
      });
      await act(async () => {
        first.resolve(success);
        await oldRequest;
      });
      expect(hook.result.current.connectionStatus?.[name].connectionState).toBe('error');
      expect(mockShowToast).toHaveBeenCalledTimes(1);
      expect(mockSetMCPValues).not.toHaveBeenCalled();
    } finally {
      hook.cleanup();
    }
  });

  it('discards a pending result when the tenant changes without changing the server definition', async () => {
    const pending = deferred<MCPReinitializeResponse>();
    mockReinitialize.mockReturnValueOnce(pending.promise);
    const hook = setup();
    try {
      let request: Promise<unknown>;
      act(() => {
        request = hook.result.current.initializeServer(name);
      });
      mockUser.tenantId = 'tenant-b';
      hook.rerender();
      await act(async () => {
        pending.resolve(success);
        await request;
      });
      expect(hook.result.current.connectionStatus?.[name].connectionState).toBe('disconnected');
      expect(hook.result.current.isInitializing(name)).toBe(false);
      expect(mockShowToast).not.toHaveBeenCalled();
    } finally {
      mockUser.tenantId = 'tenant-a';
      hook.cleanup();
    }
  });

  it('discards the result when the authorization generation changes', async () => {
    mockReinitialize.mockResolvedValueOnce(success);
    const hook = setup();
    try {
      await act(async () => {
        await hook.result.current.initializeServer(name);
      });
      mockUseMCPConnectionStatus.mockReturnValue({
        connectionStatus: {
          [name]: {
            ...cold,
            authorizationGeneration: 'revoked-generation',
          },
        },
      });
      hook.rerender();
      expect(hook.result.current.connectionStatus?.[name].connectionState).toBe('disconnected');
    } finally {
      hook.cleanup();
    }
  });

  it('does not let a late response restore state after logout', async () => {
    const pending = deferred<MCPReinitializeResponse>();
    mockReinitialize.mockReturnValueOnce(pending.promise);
    const hook = setup();
    try {
      let request: Promise<unknown>;
      act(() => {
        request = hook.result.current.initializeServer(name);
      });
      act(() => {
        hook.session.set(resetMCPStateAtom);
      });
      await act(async () => {
        pending.resolve(success);
        await request;
      });
      expect(hook.result.current.connectionStatus?.[name].connectionState).toBe('disconnected');
      expect(hook.result.current.isInitializing(name)).toBe(false);
      expect(mockShowToast).not.toHaveBeenCalled();
      expect(mockSetMCPValues).not.toHaveBeenCalled();
    } finally {
      hook.cleanup();
    }
  });
});

describe('OAuth polling ownership across managers', () => {
  const name = 'test-server';
  const oauth = {
    success: true,
    serverName: name,
    oauthRequired: true,
    oauthUrl: 'https://oauth.example.test',
    flowId: 'flow',
    oauthTimeout: 60000,
  };
  beforeEach(() => {
    jest.useFakeTimers();
    mockReinitialize.mockReset().mockResolvedValue(oauth);
    mockGetOAuthStatus.mockReset();
    mockCancelOAuth.mockReset().mockImplementation((_name, callbacks) => callbacks.onSuccess());
    mockUseMCPConnectionStatus.mockReturnValue({ connectionStatus: {} });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  function setup() {
    const session = createStore();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <Provider store={session}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </Provider>
    );
    const hook = renderHook(() => ({ card: useMCPServerManager(), panel: useMCPServerManager() }), {
      wrapper,
    });
    return {
      ...hook,
      cleanup: () => {
        hook.unmount();
        client.clear();
      },
    };
  }
  it('polls a retry after cancellation from another manager', async () => {
    const poll = mockGetOAuthStatus.mockResolvedValue({
      status: 'PENDING',
      completed: false,
      failed: false,
    });
    const hook = setup();
    try {
      await act(async () => {
        await hook.result.current.card.initializeServer(name, false);
      });
      act(() => hook.result.current.panel.cancelOAuthFlow(name));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });
      await act(async () => {
        await hook.result.current.card.initializeServer(name, false);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });
      expect(poll).toHaveBeenCalledTimes(1);
    } finally {
      hook.cleanup();
    }
  });
  it('continues polling when cancellation fails', async () => {
    mockCancelOAuth.mockImplementation((_name, callbacks) =>
      callbacks.onError(new Error('offline')),
    );
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetOAuthStatus.mockResolvedValue({ status: 'COMPLETED', completed: true, failed: false });
    const hook = setup();
    try {
      await act(async () => {
        await hook.result.current.card.initializeServer(name, false);
      });
      act(() => hook.result.current.panel.cancelOAuthFlow(name));
      mockReinitialize.mockResolvedValue({ success: true, serverName: name, oauthRequired: false });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(6000);
      });
      expect(hook.result.current.card.isInitializing(name)).toBe(false);
    } finally {
      hook.cleanup();
    }
  });
  it('keeps the new timer when an older in-flight poll returns', async () => {
    const oldPoll = deferred<{ status: 'PENDING'; completed: false; failed: false }>();
    mockGetOAuthStatus
      .mockReturnValueOnce(oldPoll.promise)
      .mockResolvedValue({ status: 'PENDING', completed: false, failed: false });
    const hook = setup();
    try {
      await act(async () => {
        await hook.result.current.card.initializeServer(name, false);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });
      await act(async () => {
        await hook.result.current.card.initializeServer(name, false);
      });
      await act(async () => {
        oldPoll.resolve({ status: 'PENDING', completed: false, failed: false });
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });
      expect(mockGetOAuthStatus).toHaveBeenCalledTimes(2);
      expect(hook.result.current.card.isInitializing(name)).toBe(true);
    } finally {
      hook.cleanup();
    }
  });

  it('does not let an older cancellation stop a newer attempt', async () => {
    let finishCancel = () => undefined;
    mockCancelOAuth.mockImplementation((_name, callbacks) => {
      finishCancel = callbacks.onSuccess;
    });
    const poll = mockGetOAuthStatus.mockResolvedValue({
      status: 'PENDING',
      completed: false,
      failed: false,
    });
    const hook = setup();
    try {
      await act(async () => {
        await hook.result.current.card.initializeServer(name, false);
      });
      act(() => hook.result.current.panel.cancelOAuthFlow(name));
      await act(async () => {
        await hook.result.current.card.initializeServer(name, false);
      });
      act(() => finishCancel());
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });
      expect(hook.result.current.card.isInitializing(name)).toBe(true);
      expect(poll).toHaveBeenCalledTimes(1);
    } finally {
      hook.cleanup();
    }
  });
});
