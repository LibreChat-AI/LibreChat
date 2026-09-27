import { createElement } from 'react';
import { AxiosError } from 'axios';
import { Provider, createStore } from 'jotai';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import type { AxiosResponse } from 'axios';
import type { ReactNode } from 'react';
import {
  useMoveConversationCodeEnvironmentMutation,
  useIsReplacingConversationCodeEnvironment,
  useConversationCodeEnvironmentRecovery,
  useReconcileConversationCodeEnvironmentMutation,
} from '../CodeEnvironments';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      moveConversationCodeEnvironment: jest.fn(),
      getConversationById: jest.fn(),
    },
  };
});

const mac = { environmentId: 'mac', workspaceId: 'primary' };
const vm = { environmentId: 'vm', workspaceId: 'projects' };

describe('useMoveConversationCodeEnvironmentMutation', () => {
  it.each([vm, { ...mac, workspaceId: 'replacement' }])(
    'keeps the moved decision %j when a pre-move conversation read resolves later',
    async (target) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const stored = {
        conversationId: 'convo-1',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [mac],
      } as TConversation;
      queryClient.setQueryData([QueryKeys.conversation, 'convo-1'], stored);
      jest.mocked(dataService.moveConversationCodeEnvironment).mockResolvedValue({
        conversationId: 'convo-1',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [target],
      });
      let resolveStaleRead: (conversation: TConversation) => void = () => undefined;
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);

      const { result } = renderHook(
        () => ({
          conversation: useQuery(
            [QueryKeys.conversation, 'convo-1'],
            () =>
              new Promise<TConversation>((resolve) => {
                resolveStaleRead = resolve;
              }),
            { staleTime: 0 },
          ),
          move: useMoveConversationCodeEnvironmentMutation(),
        }),
        { wrapper },
      );
      await waitFor(() => expect(result.current.conversation.isFetching).toBe(true));

      await act(async () => {
        await result.current.move.mutateAsync({
          conversationId: 'convo-1',
          from: [mac],
          to: [target],
        });
      });
      await act(async () => {
        resolveStaleRead(stored);
      });

      expect(queryClient.getQueryData([QueryKeys.conversation, 'convo-1'])).toEqual(
        expect.objectContaining({ codeEnvironmentMode: 'attached', codeWorkspaces: [target] }),
      );
    },
  );
});

describe('conversation-scoped decision recovery', () => {
  afterEach(() => jest.restoreAllMocks());
  const setup = (setConversation = jest.fn()) => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const store = createStore();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        Provider,
        { store },
        createElement(QueryClientProvider, { client: queryClient }, children),
      );
    return renderHook(
      () => ({
        change: useMoveConversationCodeEnvironmentMutation(setConversation),
        reconcile: useReconcileConversationCodeEnvironmentMutation(setConversation),
        blocked: useIsReplacingConversationCodeEnvironment('convo-1'),
        unrelated: useIsReplacingConversationCodeEnvironment('convo-2'),
        recovery: useConversationCodeEnvironmentRecovery('convo-1'),
      }),
      { wrapper },
    );
  };

  it('blocks only the conversation being changed and unblocks after settlement', async () => {
    let finish!: (value: {
      conversationId: string;
      codeEnvironmentMode: 'attached';
      codeWorkspaces: (typeof vm)[];
    }) => void;
    jest.mocked(dataService.moveConversationCodeEnvironment).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = setup();
    act(() => result.current.change.mutate({ conversationId: 'convo-1', from: [mac], to: [vm] }));
    await waitFor(() => expect(result.current.blocked).toBe(true));
    expect(result.current.unrelated).toBe(false);
    await act(async () => {
      finish({ conversationId: 'convo-1', codeEnvironmentMode: 'attached', codeWorkspaces: [vm] });
    });
    await waitFor(() => expect(result.current.blocked).toBe(false));
  });

  it.each([
    { codeEnvironmentMode: undefined, codeWorkspaces: undefined },
    { codeEnvironmentMode: 'attached' as const, codeWorkspaces: [mac] },
    { codeEnvironmentMode: 'without_attached' as const, codeWorkspaces: undefined },
  ])('reconciles both pre-persistence and persisted failures: %j', async (decision) => {
    const attempted = { codeEnvironmentMode: 'attached' as const, codeWorkspaces: [vm] };
    const current = {
      conversationId: 'convo-1',
      title: 'Keep title',
      ...attempted,
    } as TConversation;
    const persisted = { ...current, ...decision };
    jest.mocked(dataService.getConversationById).mockResolvedValueOnce(persisted);
    const setter = jest.fn();
    const { result } = setup(setter);
    await act(async () => {
      await result.current.reconcile.mutateAsync({ conversationId: 'convo-1', attempted });
    });
    const update = setter.mock.calls[0][0];
    expect(update(current)).toEqual(persisted);
    const other = { ...current, conversationId: 'convo-2' };
    expect(update(other)).toBe(other);
    const changed = {
      ...current,
      codeEnvironmentMode: 'without_attached',
      codeWorkspaces: undefined,
    };
    expect(update(changed)).toBe(changed);
  });

  it('blocks retries while the authoritative decision is being read', async () => {
    let finish!: (value: TConversation) => void;
    jest.mocked(dataService.getConversationById).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = setup();
    act(() =>
      result.current.reconcile.mutate({
        conversationId: 'convo-1',
        attempted: { codeEnvironmentMode: 'without_attached' },
      }),
    );
    await waitFor(() => expect(result.current.blocked).toBe(true));
    expect(result.current.unrelated).toBe(false);
    await act(async () => {
      finish({
        conversationId: 'convo-1',
        codeEnvironmentMode: 'without_attached',
      } as TConversation);
    });
    await waitFor(() => expect(result.current.blocked).toBe(false));
  });
  it('keeps a failed read blocked across mutation resets until a successful retry', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const attempted = { codeEnvironmentMode: 'attached' as const, codeWorkspaces: [vm] };
    const request = { conversationId: 'convo-1', attempted };
    jest.mocked(dataService.getConversationById).mockRejectedValueOnce(new Error('offline'));
    const setter = jest.fn();
    const { result } = setup(setter);
    await act(async () => {
      await expect(result.current.reconcile.mutateAsync(request)).rejects.toThrow('offline');
    });
    expect(result.current.recovery?.status).toBe('error');
    expect(result.current.blocked).toBe(true);
    expect(result.current.unrelated).toBe(false);
    expect(setter).not.toHaveBeenCalled();
    act(() => result.current.reconcile.reset());
    expect(result.current.blocked).toBe(true);

    const persisted = {
      conversationId: 'convo-1',
      codeEnvironmentMode: 'without_attached',
    } as TConversation;
    jest.mocked(dataService.getConversationById).mockResolvedValueOnce(persisted);
    await act(async () => {
      await result.current.reconcile.mutateAsync(result.current.recovery!.request);
    });
    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(result.current.recovery).toBeUndefined();
    expect(setter.mock.calls[0][0]({ conversationId: 'convo-1', ...attempted })).toEqual(persisted);
  });

  it('preserves the failed guard when leaving and remounting the conversation', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = createStore();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        Provider,
        { store },
        createElement(QueryClientProvider, { client: queryClient }, children),
      );
    jest.mocked(dataService.getConversationById).mockRejectedValueOnce(new Error('offline'));
    const first = renderHook(() => useReconcileConversationCodeEnvironmentMutation(), { wrapper });
    await act(async () => {
      await expect(
        first.result.current.mutateAsync({ conversationId: 'convo-1', attempted: {} }),
      ).rejects.toThrow('offline');
    });
    first.unmount();
    const restored = renderHook(({ id }) => useIsReplacingConversationCodeEnvironment(id), {
      wrapper,
      initialProps: { id: 'convo-2' },
    });
    expect(restored.result.current).toBe(false);
    restored.rerender({ id: 'convo-1' });
    expect(restored.result.current).toBe(true);
  });

  it('treats a mismatched conversation response as failed reconciliation', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest
      .mocked(dataService.getConversationById)
      .mockResolvedValueOnce({ conversationId: 'convo-2' } as TConversation);
    const setter = jest.fn();
    const { result } = setup(setter);
    await act(async () => {
      await expect(
        result.current.reconcile.mutateAsync({ conversationId: 'convo-1', attempted: {} }),
      ).rejects.toThrow('different conversation');
    });
    expect(result.current.recovery?.status).toBe('error');
    expect(result.current.blocked).toBe(true);
    expect(setter).not.toHaveBeenCalled();
  });

  it('does not let an older failed read replace a newer recovery attempt', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let failOld!: (reason: Error) => void;
    let resolveNew!: (value: TConversation) => void;
    jest
      .mocked(dataService.getConversationById)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failOld = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNew = resolve;
          }),
      );
    const { result } = setup();
    const older = {
      conversationId: 'convo-1',
      attempted: { codeEnvironmentMode: 'attached' as const, codeWorkspaces: [mac] },
    };
    const newer = {
      conversationId: 'convo-1',
      attempted: { codeEnvironmentMode: 'attached' as const, codeWorkspaces: [vm] },
    };
    act(() => result.current.reconcile.mutate(older));
    await waitFor(() => expect(failOld).toBeDefined());
    act(() => result.current.reconcile.mutate(newer));
    await waitFor(() => expect(resolveNew).toBeDefined());
    await act(async () => failOld(new Error('late failure')));
    expect(result.current.recovery?.request).toEqual(newer);
    expect(result.current.recovery?.status).toBe('pending');
    await act(async () =>
      resolveNew({ conversationId: 'convo-1', ...newer.attempted } as TConversation),
    );
    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(result.current.recovery).toBeUndefined();
  });
});

describe('ambiguous workspace transitions', () => {
  afterEach(() => jest.restoreAllMocks());

  const conflict = new AxiosError('stale', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 409,
    data: { reason: 'locked' },
  } as AxiosResponse);

  it.each([
    ['attach response lost', new Error('connection reset'), [], [vm]],
    ['detach response lost', new Error('connection reset'), [mac], []],
    ['competing tab', conflict, [mac], [vm]],
    [
      'server failure',
      new AxiosError('server', undefined, undefined, undefined, {
        status: 503,
      } as AxiosResponse),
      [mac],
      [vm],
    ],
  ] as const)(
    'recovers %s through the mutation even after its observer unmounts',
    async (_label, error, from, to) => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let fail!: (error: Error) => void;
      let finishRead!: (value: TConversation) => void;
      jest.mocked(dataService.moveConversationCodeEnvironment).mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      );
      jest.mocked(dataService.getConversationById).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const store = createStore();
      const stored = {
        conversationId: 'saved',
        title: 'Preserved',
        codeEnvironmentMode: from.length ? 'attached' : 'without_attached',
        codeWorkspaces: from.length ? [...from] : undefined,
      } as TConversation;
      const persisted = {
        ...stored,
        codeEnvironmentMode: to.length ? 'attached' : 'without_attached',
        codeWorkspaces: to.length ? [...to] : undefined,
      } as TConversation;
      queryClient.setQueryData([QueryKeys.conversation, 'saved'], stored);
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(
          Provider,
          { store },
          createElement(QueryClientProvider, { client: queryClient }, children),
        );
      let current = stored;
      const setter = jest.fn((update) => {
        current = update(current);
      });
      const mutation = renderHook(() => useMoveConversationCodeEnvironmentMutation(setter), {
        wrapper,
      });
      const guard = renderHook(
        () => ({
          blocked: useIsReplacingConversationCodeEnvironment('saved'),
          unrelated: useIsReplacingConversationCodeEnvironment('other'),
        }),
        { wrapper },
      );
      act(() =>
        mutation.result.current.mutate({ conversationId: 'saved', from: [...from], to: [...to] }),
      );
      await waitFor(() => expect(fail).toBeDefined());
      mutation.unmount();
      await act(async () => fail(error));
      await waitFor(() => expect(finishRead).toBeDefined());
      expect(guard.result.current.blocked).toBe(true);
      expect(guard.result.current.unrelated).toBe(false);
      await act(async () => finishRead(persisted));
      await waitFor(() => expect(guard.result.current.blocked).toBe(false));
      expect(current).toEqual(persisted);
      expect(queryClient.getQueryData([QueryKeys.conversation, 'saved'])).toEqual(persisted);
    },
  );

  it('keeps a failed transition read guarded until explicit retry, without changing another chat', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest
      .mocked(dataService.moveConversationCodeEnvironment)
      .mockRejectedValueOnce(new Error('offline'));
    jest.mocked(dataService.getConversationById).mockRejectedValueOnce(new Error('still offline'));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const store = createStore();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        Provider,
        { store },
        createElement(QueryClientProvider, { client: queryClient }, children),
      );
    const other = {
      conversationId: 'other',
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [mac],
    } as TConversation;
    let current = other;
    const setter = jest.fn((update) => {
      current = update(current);
    });
    const { result } = renderHook(
      () => ({
        mutation: useMoveConversationCodeEnvironmentMutation(setter),
        recovery: useConversationCodeEnvironmentRecovery('saved'),
        retry: useReconcileConversationCodeEnvironmentMutation(setter),
        blocked: useIsReplacingConversationCodeEnvironment('saved'),
      }),
      { wrapper },
    );
    await act(async () => {
      await expect(
        result.current.mutation.mutateAsync({ conversationId: 'saved', from: [mac], to: [] }),
      ).rejects.toThrow('offline');
    });
    expect(result.current.blocked).toBe(true);
    expect(result.current.recovery?.status).toBe('error');
    const persisted = {
      conversationId: 'saved',
      codeEnvironmentMode: 'without_attached',
    } as TConversation;
    jest.mocked(dataService.getConversationById).mockResolvedValueOnce(persisted);
    await act(async () => {
      await result.current.retry.mutateAsync(result.current.recovery!.request);
    });
    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(current).toBe(other);
  });

  it.each([400, 403, 409, 429])(
    'does not turn a definitive %s rejection into recovery',
    async (status) => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const read = jest.spyOn(dataService, 'getConversationById');
      read.mockClear();
      const error = new AxiosError('rejected', undefined, undefined, undefined, {
        status,
        data: {},
      } as AxiosResponse);
      jest.mocked(dataService.moveConversationCodeEnvironment).mockRejectedValueOnce(error);
      const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);
      const { result } = renderHook(() => useMoveConversationCodeEnvironmentMutation(), {
        wrapper,
      });
      await act(async () => {
        await expect(
          result.current.mutateAsync({ conversationId: 'saved', from: [mac], to: [] }),
        ).rejects.toBe(error);
      });
      expect(read).not.toHaveBeenCalled();
    },
  );
});
