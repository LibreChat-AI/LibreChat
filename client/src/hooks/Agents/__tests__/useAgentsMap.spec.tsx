import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EModelEndpoint, QueryKeys, dataService } from 'librechat-data-provider';
import useAgentsMap from '../useAgentsMap';

/** `dataService` methods are non-configurable, so the HTTP boundary is mocked
 *  at the module seam; everything else stays the real library. */
jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      listAgents: jest.fn(),
    },
  };
});

/**
 * Root feeds this map straight into `AgentsMapContext.Provider`, so its
 * referential stability decides whether every consumer — message rows,
 * conversation icons, subagent cards — re-renders on unrelated Root renders
 * (e.g. the mobile drawer toggle). Real react-query; only HTTP is stubbed.
 */
describe('useAgentsMap', () => {
  const setup = () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData([QueryKeys.endpoints], {
      [EModelEndpoint.agents]: {},
    });
    (dataService.listAgents as jest.Mock).mockResolvedValue({
      object: 'list',
      data: [{ id: 'agent_1', name: 'Agent One' }],
      first_id: 'agent_1',
      last_id: 'agent_1',
      has_more: false,
      after: null,
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return renderHook(() => useAgentsMap({ isAuthenticated: true }), { wrapper });
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps the agents map referentially stable across unrelated re-renders', async () => {
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current?.agent_1).toBeDefined());

    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });
});
