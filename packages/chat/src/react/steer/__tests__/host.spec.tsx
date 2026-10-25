/**
 * @jest-environment jsdom
 */
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { SteerHost } from '../host';
import { SteerHostProvider, useSteerHost } from '../host';

const createHost = (label: string): SteerHost => ({
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
  useLatestMessage: () => null,
  useCodeApprovalMode: () => undefined,
  useLocalize: () => (key) => `${label}:${key}`,
  useNotify: () => () => undefined,
  useFileMap: () => undefined,
  useClearFilesToDelete: () => () => undefined,
  useSettings: () => ({
    duringRunDefaultAction: 'steer',
    setDuringRunDefaultAction: () => {},
    getPaneConversations: () => [],
  }),
});

const translate = (host: SteerHost) => host.useLocalize()('com_ui_steer_cancel_failed');

describe('useSteerHost', () => {
  it('reads the host the nearest provider supplies', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SteerHostProvider host={createHost('outer')}>
        <SteerHostProvider host={createHost('provided')}>{children}</SteerHostProvider>
      </SteerHostProvider>
    );
    const { result } = renderHook(() => translate(useSteerHost()), { wrapper });
    expect(result.current).toBe('provided:com_ui_steer_cancel_failed');
  });

  it('throws a named error when no provider is mounted', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useSteerHost())).toThrow(
      'The steer hooks need a SteerHostProvider above them.',
    );
    consoleError.mockRestore();
  });
});
