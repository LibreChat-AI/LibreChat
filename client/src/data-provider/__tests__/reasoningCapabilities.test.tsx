import { RecoilRoot } from 'recoil';
import { dataService } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useReasoningCapabilitiesQuery } from '../Endpoints/queries';
import store from '~/store';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getReasoningCapabilities: jest.fn() },
  };
});

const mockGet = dataService.getReasoningCapabilities as jest.Mock;
const capabilities = {
  capabilities: { OpenRouter: { 'a/b': { efforts: ['low'] } } },
  expiresInMs: 60_000,
};

const setup = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RecoilRoot initializeState={({ set }) => set(store.queriesEnabled, true)}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </RecoilRoot>
  );
  return { ...renderHook(() => useReasoningCapabilitiesQuery('OpenRouter'), { wrapper }), wrapper };
};

const refocus = async () => {
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
};

const reconnect = async () => {
  await act(async () => {
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
  });
};

describe('useReasoningCapabilitiesQuery expiry and retry', () => {
  beforeEach(() => {
    mockGet.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    focusManager.setFocused(undefined);
  });

  const advance = (ms: number) =>
    act(async () => {
      jest.advanceTimersByTime(ms);
    });

  it('refetches when the server entry expires', async () => {
    mockGet.mockResolvedValue(capabilities);
    const { result } = setup();
    await waitFor(() => expect(result.current.data).toEqual(capabilities));

    await advance(61_000);

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });

  it('does not refetch before the server entry expires', async () => {
    mockGet.mockResolvedValue(capabilities);
    const { result } = setup();
    await waitFor(() => expect(result.current.data).toEqual(capabilities));

    await advance(30_000);
    await refocus();

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('revalidates on focus when the entry expired while the page was in the background', async () => {
    mockGet.mockResolvedValue(capabilities);
    const { result } = setup();
    await waitFor(() => expect(result.current.data).toEqual(capabilities));
    await act(async () => {
      focusManager.setFocused(false);
    });

    await advance(120_000);
    expect(mockGet).toHaveBeenCalledTimes(1);
    await act(async () => {
      focusManager.setFocused(true);
    });

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });

  it('schedules revalidation from the remaining lifetime when a consumer remounts', async () => {
    mockGet.mockResolvedValue({ ...capabilities, expiresInMs: 3_600_000 });
    const first = setup();
    await waitFor(() => expect(first.result.current.data).toBeDefined());

    /* An unobserved query is dropped after five minutes, so the remount has to come sooner. */
    await advance(1_800_000);
    first.unmount();
    await advance(120_000);
    const second = renderHook(() => useReasoningCapabilitiesQuery('OpenRouter'), {
      wrapper: first.wrapper,
    });
    await waitFor(() => expect(second.result.current.data).toBeDefined());
    expect(mockGet).toHaveBeenCalledTimes(1);

    /* 32 minutes into a 60 minute entry: it must refresh in about 28 minutes, not 60. */
    await advance(29 * 60_000);

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });

  it('follows the expiry of the entry it just read, not a fixed window', async () => {
    mockGet
      .mockResolvedValueOnce({ ...capabilities, expiresInMs: 10_000 })
      .mockResolvedValue({ ...capabilities, expiresInMs: 3_600_000 });
    const { result } = setup();
    await waitFor(() => expect(result.current.data?.expiresInMs).toBe(10_000));

    await advance(11_000);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    await advance(600_000);

    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('retries a failed request on its own while the page stays focused', async () => {
    mockGet.mockRejectedValueOnce(new Error('503')).mockResolvedValue(capabilities);
    const { result } = setup();
    await waitFor(() => expect(result.current.isError).toBe(true));

    await advance(30_000);

    await waitFor(() => expect(result.current.data).toEqual(capabilities));
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('refetches a failed request on focus', async () => {
    mockGet.mockRejectedValueOnce(new Error('503')).mockResolvedValue(capabilities);
    const { result } = setup();
    await waitFor(() => expect(result.current.isError).toBe(true));

    await refocus();

    await waitFor(() => expect(result.current.data).toEqual(capabilities));
  });

  it('refetches a failed request on reconnect', async () => {
    mockGet.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(capabilities);
    const { result } = setup();
    await waitFor(() => expect(result.current.isError).toBe(true));

    await reconnect();

    await waitFor(() => expect(result.current.data).toEqual(capabilities));
  });

  it('does not refetch loaded data on reconnect before the server entry expires', async () => {
    mockGet.mockResolvedValue(capabilities);
    const { result } = setup();
    await waitFor(() => expect(result.current.data).toEqual(capabilities));

    await reconnect();

    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
