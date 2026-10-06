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
const capabilities = { OpenRouter: { 'a/b': { efforts: ['low'] } } };

const setup = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RecoilRoot initializeState={({ set }) => set(store.queriesEnabled, true)}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </RecoilRoot>
  );
  return renderHook(() => useReasoningCapabilitiesQuery('OpenRouter'), { wrapper });
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

describe('useReasoningCapabilitiesQuery recovery', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('refetches on window focus after a failed request, so the list can recover', async () => {
    mockGet.mockRejectedValueOnce(new Error('503')).mockResolvedValue(capabilities);
    const { result } = setup();
    await waitFor(() => expect(result.current.isError).toBe(true));

    await refocus();

    await waitFor(() => expect(result.current.data).toEqual(capabilities));
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('refetches on reconnect after a failed request', async () => {
    mockGet.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(capabilities);
    const { result } = setup();
    await waitFor(() => expect(result.current.isError).toBe(true));

    await reconnect();

    await waitFor(() => expect(result.current.data).toEqual(capabilities));
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('does not refetch on focus or reconnect once the capabilities have loaded', async () => {
    mockGet.mockResolvedValue(capabilities);
    const { result } = setup();
    await waitFor(() => expect(result.current.data).toEqual(capabilities));

    await refocus();
    await reconnect();

    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
