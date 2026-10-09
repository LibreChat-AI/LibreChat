import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TToolFavorite } from 'librechat-data-provider';
import useToolFavorites from '../useToolFavorites';

const mockShowToast = jest.fn();
const mockGetToolFavorites = jest.fn();
const mockAddToolFavorite = jest.fn();
const mockRemoveToolFavorite = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getToolFavorites: (...args: unknown[]) => mockGetToolFavorites(...args),
      addToolFavorite: (...args: unknown[]) => mockAddToolFavorite(...args),
      removeToolFavorite: (...args: unknown[]) => mockRemoveToolFavorite(...args),
    },
  };
});

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('../useLocalize', () => ({
  __esModule: true,
  default:
    () =>
    (key: string, options?: Record<string, unknown>): string =>
      options ? `${key}[${Object.values(options).join(',')}]` : key,
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const seeded: TToolFavorite[] = [
  { itemType: 'tool', itemId: 'dalle' },
  { itemType: 'mcp', itemId: 'everything' },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetToolFavorites.mockResolvedValue(seeded);
  mockAddToolFavorite.mockImplementation((favorite) => Promise.resolve(favorite));
  mockRemoveToolFavorite.mockResolvedValue({ ok: true });
});

describe('useToolFavorites', () => {
  test('exposes favorites as compound kind:id keys', async () => {
    const { result } = renderHook(() => useToolFavorites(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.favoriteKeys).toEqual(new Set(['tool:dalle', 'mcp:everything']));
    expect(result.current.isFavorite({ kind: 'tool', id: 'dalle' })).toBe(true);
    expect(result.current.isFavorite({ kind: 'skill', id: 'dalle' })).toBe(false);
  });

  test('toggle adds an unfavorited item and removes a favorited one', async () => {
    const { result } = renderHook(() => useToolFavorites(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.toggle({ kind: 'skill', id: 's1' });
    });
    expect(mockAddToolFavorite).toHaveBeenCalledWith({ itemType: 'skill', itemId: 's1' });
    await waitFor(() => expect(result.current.isFavorite({ kind: 'skill', id: 's1' })).toBe(true));

    await act(async () => {
      await result.current.toggle({ kind: 'tool', id: 'dalle' });
    });
    expect(mockRemoveToolFavorite).toHaveBeenCalledWith({ itemType: 'tool', itemId: 'dalle' });
    await waitFor(() =>
      expect(result.current.isFavorite({ kind: 'tool', id: 'dalle' })).toBe(false),
    );
  });

  test('never favorites actions', async () => {
    const { result } = renderHook(() => useToolFavorites(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.toggle({ kind: 'action', id: 'a1' });
    });
    expect(mockAddToolFavorite).not.toHaveBeenCalled();
    expect(result.current.isFavorite({ kind: 'action', id: 'a1' })).toBe(false);
  });

  test('starring before the list loads refetches instead of hiding existing favorites', async () => {
    mockGetToolFavorites
      .mockImplementationOnce(() => new Promise<TToolFavorite[]>(() => undefined))
      .mockResolvedValueOnce([...seeded, { itemType: 'skill', itemId: 's1' }]);

    const { result } = renderHook(() => useToolFavorites(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.toggle({ kind: 'skill', id: 's1' });
    });

    await waitFor(() =>
      expect(result.current.favoriteKeys).toEqual(
        new Set(['tool:dalle', 'mcp:everything', 'skill:s1']),
      ),
    );
    expect(mockGetToolFavorites).toHaveBeenCalledTimes(2);
  });

  test('shows the item-worded cap toast and rolls back on rejection', async () => {
    mockAddToolFavorite.mockRejectedValue({
      response: { data: { code: 'MAX_FAVORITES_EXCEEDED', limit: 100 } },
    });
    const { result } = renderHook(() => useToolFavorites(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.toggle({ kind: 'skill', id: 's1' });
    });
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_max_favorites_reached_items[100]',
      status: 'error',
    });
    await waitFor(() => expect(result.current.isFavorite({ kind: 'skill', id: 's1' })).toBe(false));
  });
});
