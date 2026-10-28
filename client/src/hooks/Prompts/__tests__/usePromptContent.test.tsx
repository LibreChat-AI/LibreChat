import { createElement } from 'react';
import { dataService } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TPromptGroup, TResolvedPromptResponse } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import usePromptContent, { usePromptContentResolver } from '../usePromptContent';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      resolvePromptGroup: jest.fn(),
    },
  };
});

const resolvePromptGroup = dataService.resolvePromptGroup as jest.MockedFunction<
  typeof dataService.resolvePromptGroup
>;

function makeGroup(overrides: Partial<TPromptGroup> = {}): TPromptGroup {
  return {
    _id: 'group-1',
    name: 'Example Group',
    author: 'author-1',
    authorName: 'Author',
    source: 'native',
    productionPrompt: { prompt: 'Native production text' },
    ...overrides,
  } as TPromptGroup;
}

function langfuseResolved(
  overrides: Partial<TResolvedPromptResponse> = {},
): TResolvedPromptResponse {
  return {
    source: 'langfuse',
    groupId: 'group-1',
    prompt: 'Live Langfuse text',
    type: 'text',
    version: 1,
    labels: ['production'],
    sourceUrl: 'https://cloud.langfuse.test/project/project-1/prompts/greeting',
    ...overrides,
  } as TResolvedPromptResponse;
}

const createQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('usePromptContent', () => {
  it('returns the production prompt synchronously for a native group, with no request', () => {
    const queryClient = createQueryClient();
    const group = makeGroup();

    const { result } = renderHook(() => usePromptContent(group), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.text).toBe('Native production text');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(result.current.resolved).toBeUndefined();
    expect(resolvePromptGroup).not.toHaveBeenCalled();
  });

  it('fetches and returns the resolved prompt for a Langfuse group', async () => {
    const queryClient = createQueryClient();
    const resolved = langfuseResolved();
    resolvePromptGroup.mockResolvedValue(resolved);
    const group = makeGroup({ source: 'langfuse', productionPrompt: null });

    const { result } = renderHook(() => usePromptContent(group), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(resolvePromptGroup).toHaveBeenCalledWith('group-1');
    expect(result.current.text).toBe('Live Langfuse text');
    expect(result.current.resolved).toEqual(resolved);
    // React Query reports "no error" as `null`, not `undefined`, once a query has run.
    expect(result.current.error).toBeNull();
  });

  it('passes a resolve error through', async () => {
    const queryClient = createQueryClient();
    const error = new Error('resolve failed');
    resolvePromptGroup.mockRejectedValue(error);
    const group = makeGroup({ source: 'langfuse', productionPrompt: null });

    const { result } = renderHook(() => usePromptContent(group), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe(error);
    expect(result.current.text).toBe('');
  });

  it('issues a second resolve request when refetch is called after an error', async () => {
    const queryClient = createQueryClient();
    const error = new Error('resolve failed');
    resolvePromptGroup.mockRejectedValueOnce(error).mockResolvedValueOnce(langfuseResolved());
    const group = makeGroup({ source: 'langfuse', productionPrompt: null });

    const { result } = renderHook(() => usePromptContent(group), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.error).toBe(error));
    expect(resolvePromptGroup).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.text).toBe('Live Langfuse text'));
    expect(resolvePromptGroup).toHaveBeenCalledTimes(2);
  });

  it('never requests when disabled, even for a Langfuse group', () => {
    const queryClient = createQueryClient();
    const group = makeGroup({ source: 'langfuse', productionPrompt: null });

    const { result } = renderHook(() => usePromptContent(group, { enabled: false }), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.isLoading).toBe(false);
    expect(resolvePromptGroup).not.toHaveBeenCalled();
  });
});

describe('usePromptContentResolver', () => {
  it('resolves a native group synchronously with no request', async () => {
    const queryClient = createQueryClient();
    const group = makeGroup();

    const { result } = renderHook(() => usePromptContentResolver(), {
      wrapper: createWrapper(queryClient),
    });

    let text: string | undefined;
    await act(async () => {
      text = await result.current(group);
    });

    expect(text).toBe('Native production text');
    expect(resolvePromptGroup).not.toHaveBeenCalled();
  });

  it('resolves a Langfuse group with one request', async () => {
    const queryClient = createQueryClient();
    const resolved = langfuseResolved({ prompt: 'Fetched text' });
    resolvePromptGroup.mockResolvedValue(resolved);
    const group = makeGroup({ source: 'langfuse', productionPrompt: null });

    const { result } = renderHook(() => usePromptContentResolver(), {
      wrapper: createWrapper(queryClient),
    });

    let text: string | undefined;
    await act(async () => {
      text = await result.current(group);
    });

    expect(text).toBe('Fetched text');
    expect(resolvePromptGroup).toHaveBeenCalledTimes(1);
    expect(resolvePromptGroup).toHaveBeenCalledWith('group-1');
  });

  it('does not retry a failed resolve, even with a QueryClient that retries by default', async () => {
    // Uses the QueryClient's own defaults (unlike `createQueryClient`, which
    // already sets `retry: false`), so this only passes because the
    // imperative fetch itself passes `retry: false`.
    const queryClient = new QueryClient();
    const error = new Error('resolve failed');
    resolvePromptGroup.mockRejectedValue(error);
    const group = makeGroup({ source: 'langfuse', productionPrompt: null });

    const { result } = renderHook(() => usePromptContentResolver(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await expect(result.current(group)).rejects.toThrow('resolve failed');
    });

    expect(resolvePromptGroup).toHaveBeenCalledTimes(1);
  });
});
