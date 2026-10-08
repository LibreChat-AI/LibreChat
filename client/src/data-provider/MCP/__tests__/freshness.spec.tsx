import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryKeys, dataService } from 'librechat-data-provider';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import type { MCPServersResponse, MCPConnectionStatusResponse } from 'librechat-data-provider';
import { useMCPConnectionStatusQuery } from '../../Tools/queries';
import { useMCPRefresh } from '~/hooks/MCP/useMCPRefresh';
import { useMCPToolsQuery } from '../queries';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

const mockRefreshConfig = { statusRefreshInterval: 30_000, toolsRefreshInterval: 300_000 };

jest.mock('~/data-provider/Endpoints/queries', () => ({
  useGetStartupConfig: () => ({ data: { interface: { mcpServers: mockRefreshConfig } } }),
}));

const catalog: MCPServersResponse = { servers: {} };
const connected: MCPConnectionStatusResponse = {
  success: true,
  connectionStatus: { test: { requiresOAuth: false, connectionState: 'connected' } },
};
const disconnected: MCPConnectionStatusResponse = {
  success: true,
  connectionStatus: { test: { requiresOAuth: false, connectionState: 'disconnected' } },
};
const changedCatalog: MCPServersResponse = {
  servers: {
    test: { name: 'test', icon: '', authenticated: true, authConfig: [], tools: [] },
  },
};

function useCatalogQueries(enabled = true) {
  useMCPRefresh({ enabled, tools: true });
}

describe('MCP cache freshness', () => {
  let client: QueryClient;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    jest.useFakeTimers();
    mockRefreshConfig.statusRefreshInterval = 30_000;
    mockRefreshConfig.toolsRefreshInterval = 300_000;
    focusManager.setFocused(true);
    onlineManager.setOnline(true);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData([QueryKeys.mcpTools], catalog);
    client.setQueryData([QueryKeys.mcpConnectionStatus], connected);
    jest.spyOn(dataService, 'getMCPTools').mockResolvedValue(changedCatalog);
    jest.spyOn(dataService, 'getMCPConnectionStatus').mockResolvedValue(disconnected);
  });

  afterEach(() => {
    client.clear();
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
    jest.useRealTimers();
  });

  it('keeps always-mounted cache observers free of polling', async () => {
    const { unmount } = renderHook(
      () => {
        useMCPToolsQuery();
        useMCPConnectionStatusQuery();
      },
      { wrapper },
    );
    await act(async () => {
      jest.advanceTimersByTime(600_000);
    });
    expect(dataService.getMCPTools).not.toHaveBeenCalled();
    expect(dataService.getMCPConnectionStatus).not.toHaveBeenCalled();
    unmount();
  });

  it('starts polling when a surface opens and stops when it closes', async () => {
    const { rerender, unmount } = renderHook(
      ({ visible }) => {
        useMCPToolsQuery();
        useMCPConnectionStatusQuery();
        useMCPRefresh({ enabled: visible, tools: true });
      },
      { wrapper, initialProps: { visible: false } },
    );
    await act(async () => {
      jest.advanceTimersByTime(600_000);
    });
    expect(dataService.getMCPTools).not.toHaveBeenCalled();
    expect(dataService.getMCPConnectionStatus).not.toHaveBeenCalled();
    await act(async () => {
      rerender({ visible: true });
    });
    expect(dataService.getMCPTools).toHaveBeenCalledTimes(1);
    expect(dataService.getMCPConnectionStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(dataService.getMCPConnectionStatus).toHaveBeenCalledTimes(2);
    rerender({ visible: false });
    await act(async () => {
      jest.advanceTimersByTime(600_000);
    });
    expect(dataService.getMCPTools).toHaveBeenCalledTimes(1);
    expect(dataService.getMCPConnectionStatus).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('shares the polling cadence across staggered surfaces and keeps polling after one closes', async () => {
    mockRefreshConfig.toolsRefreshInterval = 60_000;
    const { rerender, unmount } = renderHook(
      ({ panel, dialog }) => {
        useMCPRefresh({ enabled: panel, tools: true });
        useMCPRefresh({ enabled: dialog, tools: true });
      },
      { wrapper, initialProps: { panel: true, dialog: false } },
    );
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    rerender({ panel: true, dialog: true });
    await act(async () => {
      jest.advanceTimersByTime(25_000);
    });
    expect(dataService.getMCPConnectionStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(dataService.getMCPConnectionStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(25_000);
    });
    expect(dataService.getMCPConnectionStatus).toHaveBeenCalledTimes(2);
    expect(dataService.getMCPTools).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(dataService.getMCPConnectionStatus).toHaveBeenCalledTimes(2);
    expect(dataService.getMCPTools).toHaveBeenCalledTimes(1);
    rerender({ panel: false, dialog: true });
    await act(async () => {
      jest.advanceTimersByTime(25_000);
    });
    expect(dataService.getMCPConnectionStatus).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('honors configured polling intervals and zero to disable', async () => {
    mockRefreshConfig.statusRefreshInterval = 60_000;
    mockRefreshConfig.toolsRefreshInterval = 0;
    const { unmount } = renderHook(() => useCatalogQueries(), { wrapper });
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(dataService.getMCPConnectionStatus).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(dataService.getMCPConnectionStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(300_000);
    });
    expect(dataService.getMCPTools).not.toHaveBeenCalled();
    unmount();
  });

  it('reconciles server-side changes at bounded intervals without sending messages', async () => {
    const { rerender, unmount } = renderHook(() => useCatalogQueries(), { wrapper });
    rerender();
    expect(dataService.getMCPTools).not.toHaveBeenCalled();
    expect(dataService.getMCPConnectionStatus).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(dataService.getMCPConnectionStatus).toHaveBeenCalledTimes(1);
    expect(client.getQueryData([QueryKeys.mcpConnectionStatus])).toEqual(disconnected);
    expect(dataService.getMCPTools).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(270_000);
    });
    expect(dataService.getMCPTools).toHaveBeenCalledTimes(1);
    expect(client.getQueryData([QueryKeys.mcpTools])).toEqual(changedCatalog);
    unmount();
  });

  it('does not poll while the browser is hidden and refreshes stale data on focus', async () => {
    focusManager.setFocused(false);
    const { unmount } = renderHook(() => useCatalogQueries(), { wrapper });
    await act(async () => {
      jest.advanceTimersByTime(300_001);
    });
    expect(dataService.getMCPTools).not.toHaveBeenCalled();
    expect(dataService.getMCPConnectionStatus).not.toHaveBeenCalled();

    await act(async () => {
      focusManager.setFocused(true);
    });
    expect(dataService.getMCPTools).toHaveBeenCalledTimes(1);
    expect(dataService.getMCPConnectionStatus).toHaveBeenCalledTimes(1);
    unmount();
  });

  it.each(['mount', 'reconnect'] as const)('refreshes stale data on %s', async (event) => {
    jest.advanceTimersByTime(300_001);
    if (event === 'reconnect') {
      onlineManager.setOnline(false);
    }
    const { unmount } = renderHook(() => useCatalogQueries(), { wrapper });
    await act(async () => {
      onlineManager.setOnline(true);
    });
    expect(dataService.getMCPTools).toHaveBeenCalledTimes(1);
    expect(dataService.getMCPConnectionStatus).toHaveBeenCalledTimes(1);
    expect(client.getQueryData([QueryKeys.mcpTools])).toEqual(changedCatalog);
    expect(client.getQueryData([QueryKeys.mcpConnectionStatus])).toEqual(disconnected);
    unmount();
  });

  it('keeps disabled queries idle across polling, focus, and reconnect', async () => {
    const { unmount } = renderHook(() => useCatalogQueries(false), { wrapper });
    await act(async () => {
      jest.advanceTimersByTime(600_000);
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    expect(dataService.getMCPTools).not.toHaveBeenCalled();
    expect(dataService.getMCPConnectionStatus).not.toHaveBeenCalled();
    unmount();
  });
});
