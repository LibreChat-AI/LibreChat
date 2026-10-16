/**
 * @jest-environment jsdom
 */
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { SteerHost } from '../host';
import { SteerHostProvider, setDefaultSteerHost, useSteerHost } from '../host';

const createHost = (label: string): SteerHost => ({
  useSteerMessage: () => () => undefined,
  useCancelSteer: () => async () => ({ removed: true }),
  useArmSteer: () => async () => ({ armed: true }),
  useMarkFilesUsage: () => () => undefined,
  useEnqueueQueuedTurn: () => () => undefined,
  useCancelQueuedTurn: () => async () => {
    throw new Error('not queued');
  },
  useQueuedTurns: () => undefined,
  useFetchStreamStatus: () => async () => ({ active: false }),
  useLatestMessage: () => null,
  useCodeApprovalMode: () => undefined,
  useLocalize: () => (key) => `${label}:${key}`,
  useNotify: () => () => undefined,
  useFileMap: () => undefined,
  useClearFilesToDelete: () => () => undefined,
  useSettings: () => ({ duringRunDefaultAction: 'steer', setDuringRunDefaultAction: () => {} }),
});

const translate = (host: SteerHost) => host.useLocalize()('com_ui_steer_cancel_failed');

describe('useSteerHost', () => {
  it('reads the host a provider supplies over the registered default', () => {
    setDefaultSteerHost(createHost('default'));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SteerHostProvider host={createHost('provided')}>{children}</SteerHostProvider>
    );
    const { result } = renderHook(() => translate(useSteerHost()), { wrapper });
    expect(result.current).toBe('provided:com_ui_steer_cancel_failed');
  });

  it('falls back to the registered default outside a provider', () => {
    setDefaultSteerHost(createHost('default'));
    const { result } = renderHook(() => translate(useSteerHost()));
    expect(result.current).toBe('default:com_ui_steer_cancel_failed');
  });
});
