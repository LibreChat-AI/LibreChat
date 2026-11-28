import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEventSubscriptionMutations } from '../index';

const mockUpdate = jest.fn();
const mockDelete = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      updateAgentEventSubscription: (...args: unknown[]) => mockUpdate(...args),
      deleteAgentEventSubscription: (...args: unknown[]) => mockDelete(...args),
    },
  };
});

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A watched conversation's list, cached the way the Watching row leaves it.
  queryClient.setQueryData([QueryKeys.agentEventWatches, 'convo-1'], []);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useEventSubscriptionMutations('agent-1'), { wrapper });
  const watchesStale = () =>
    queryClient.getQueryState([QueryKeys.agentEventWatches, 'convo-1'])?.isInvalidated === true;
  return { result, watchesStale };
}

describe('useEventSubscriptionMutations', () => {
  beforeEach(() => {
    mockUpdate.mockReset().mockResolvedValue({ id: 'sub_1' });
    mockDelete.mockReset().mockResolvedValue(undefined);
  });

  it('reads the watched conversations again after a subscription changes', async () => {
    const { result, watchesStale } = setup();
    expect(watchesStale()).toBe(false);
    await act(async () => {
      await result.current.update.mutateAsync({ id: 'sub_1', payload: { watch: false } });
    });
    expect(watchesStale()).toBe(true);
  });

  it('reads the watched conversations again after a subscription is removed', async () => {
    const { result, watchesStale } = setup();
    await act(async () => {
      await result.current.remove.mutateAsync('sub_1');
    });
    expect(watchesStale()).toBe(true);
  });
});
