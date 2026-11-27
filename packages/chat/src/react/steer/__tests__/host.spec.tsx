/**
 * @jest-environment jsdom
 */
import { useLocalize } from '@librechat/client';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { SteerHost } from '../host';
import { SteerHostProvider, useOptionalSteerHost, useSteerHost } from '../host';

const createHost = (): SteerHost => ({
  useSteerMessage: () => () => undefined,
  useSteerMessageAsync: () => async () => ({
    status: 'queued',
    steerId: 'steer-1',
    position: 0,
    conversationId: 'convo-1',
  }),
  useCancelSteer: () => async () => ({ removed: true }),
  useArmSteer: () => async () => ({ armed: true }),
  useMarkFilesUsage: () => () => undefined,
  useEnqueueQueuedTurn: () => () => undefined,
  useCancelQueuedTurn: () => async () => {
    throw new Error('not queued');
  },
  useQueuedTurns: () => undefined,
  useQueuedTurnCache: () => ({ read: () => ({}), subscribe: () => () => undefined }),
  useFetchStreamStatus: () => async () => ({ active: false }),
  useRouteConversationId: () => undefined,
  useCodeApprovalInputs: () => ({ conversation: null, reachable: { agents: [], complete: true } }),
  useLocalize,
  useNotify: () => () => undefined,
  useFileMap: () => undefined,
  useClearFilesToDelete: () => () => undefined,
  useSettings: () => ({
    duringRunDefaultAction: 'steer',
    setDuringRunDefaultAction: () => {},
    getPaneConversations: () => [],
  }),
});

describe('useSteerHost', () => {
  it('reads the host the nearest provider supplies', () => {
    const provided = createHost();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SteerHostProvider host={createHost()}>
        <SteerHostProvider host={provided}>{children}</SteerHostProvider>
      </SteerHostProvider>
    );
    const { result } = renderHook(() => useSteerHost(), { wrapper });
    expect(result.current).toBe(provided);
  });

  it('throws a named error when no provider is mounted', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useSteerHost())).toThrow(
      'The steer hooks need a SteerHostProvider above them.',
    );
    consoleError.mockRestore();
  });

  it('returns null from the optional lookup when no provider is mounted', () => {
    const { result } = renderHook(() => useOptionalSteerHost());
    expect(result.current).toBeNull();
  });

  it('returns the provided host from the optional lookup', () => {
    const host = createHost();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SteerHostProvider host={host}>{children}</SteerHostProvider>
    );
    const { result } = renderHook(() => useOptionalSteerHost(), { wrapper });
    expect(result.current).toBe(host);
  });
});
