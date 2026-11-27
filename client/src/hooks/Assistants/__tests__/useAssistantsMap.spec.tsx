import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EModelEndpoint, QueryKeys, dataService } from 'librechat-data-provider';
import { activateCatalog, resetCatalogWarmup } from '~/hooks/useCatalogWarmup';
import useAssistantsMap from '../useAssistantsMap';

/** `dataService` methods are non-configurable, so the HTTP boundary is mocked
 *  at the module seam; everything else stays the real library. */
jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      listAssistants: jest.fn(),
    },
  };
});

/**
 * Root feeds this map straight into `AssistantsMapContext.Provider`, so its
 * referential stability decides whether every consumer — message rows
 * included — re-renders on unrelated Root renders (e.g. the mobile drawer
 * toggle). Real react-query against a seeded cache; only HTTP is stubbed.
 */
describe('useAssistantsMap', () => {
  const listResponse = {
    object: 'list',
    data: [{ id: 'asst_1', name: 'Assistant One' }],
    first_id: 'asst_1',
    last_id: 'asst_1',
    has_more: false,
  };

  const setup = (isAuthenticated: boolean) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData([QueryKeys.endpoints], {
      [EModelEndpoint.assistants]: { userProvide: false },
    });
    (dataService.listAssistants as jest.Mock).mockResolvedValue(listResponse);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return renderHook(() => useAssistantsMap({ isAuthenticated }), { wrapper });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resetCatalogWarmup();
    activateCatalog('assistants');
  });

  it('keeps the composite map referentially stable across unrelated re-renders', async () => {
    const { result, rerender } = setup(true);
    await waitFor(() => expect(result.current?.[EModelEndpoint.assistants]?.asst_1).toBeDefined());

    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });

  it('keeps each endpoint map stable across re-renders (memoized select)', async () => {
    const { result, rerender } = setup(true);
    await waitFor(() => expect(result.current?.[EModelEndpoint.assistants]?.asst_1).toBeDefined());

    const firstInner = result.current[EModelEndpoint.assistants];
    rerender();

    expect(result.current[EModelEndpoint.assistants]).toBe(firstInner);
  });

  it('is stable while unauthenticated (empty maps do not churn identity)', () => {
    const { result, rerender } = setup(false);

    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });

  it('waits for idle before warming assistant catalogs', async () => {
    resetCatalogWarmup();
    const { result } = setup(true);
    expect(dataService.listAssistants).not.toHaveBeenCalled();
    act(() => activateCatalog('assistants'));
    await waitFor(() => expect(result.current[EModelEndpoint.assistants].asst_1).toBeDefined());
  });
});
