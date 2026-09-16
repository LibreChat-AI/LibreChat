import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { getDefaultStore, useAtomValue } from 'jotai';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { MutableSnapshot } from 'recoil';
import type { PendingSteer } from '~/store/families';
import { escalatingSteerFamily } from '~/store/steer';
import useSteerEscalate from '../useSteerEscalate';
import store from '~/store';

const mockArmMutateAsync = jest.fn();
const mockShowToast = jest.fn();

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/data-provider', () => ({
  useArmSteerMutation: () => ({ mutateAsync: mockArmMutateAsync }),
  supportsGenerationProtocolV2: (value: unknown) =>
    value != null &&
    typeof value === 'object' &&
    (value as { generationProtocolVersion?: unknown }).generationProtocolVersion === 2,
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

const CONVO_ID = 'convo-steer-escalate';

interface SetupOptions {
  activeGenerationCreatedAt?: number | null;
  activeGenerationProtocolVersion?: 1 | 2;
  steers?: PendingSteer[];
}

const pending = (over: Partial<PendingSteer> = {}): PendingSteer => ({
  steerId: 'steer-1',
  text: 'change direction',
  status: 'pending',
  createdAt: 1,
  ...over,
});

function setup({
  activeGenerationCreatedAt = 41,
  activeGenerationProtocolVersion = 2,
  steers = [pending()],
}: SetupOptions = {}) {
  const initializeState = (snapshot: MutableSnapshot) => {
    snapshot.set(store.pendingSteersByConvoId(CONVO_ID), steers);
    if (activeGenerationCreatedAt != null) {
      snapshot.set(store.activeGenerationCreatedAtByConvoId(CONVO_ID), activeGenerationCreatedAt);
    }
    snapshot.set(
      store.activeGenerationProtocolVersionByConvoId(CONVO_ID),
      activeGenerationProtocolVersion,
    );
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot initializeState={initializeState}>{children}</RecoilRoot>
  );

  return renderHook(
    () => ({
      escalate: useSteerEscalate(CONVO_ID),
      steers: useRecoilValue(store.pendingSteersByConvoId(CONVO_ID)),
      escalating: useAtomValue(escalatingSteerFamily(CONVO_ID)),
    }),
    { wrapper },
  );
}

describe('useSteerEscalate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    act(() => getDefaultStore().set(escalatingSteerFamily(CONVO_ID), false));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not arm before a generation epoch is known', () => {
    const { result } = setup({ activeGenerationCreatedAt: null });

    act(() => result.current.escalate({ steerId: 'steer-1' }));

    expect(mockArmMutateAsync).not.toHaveBeenCalled();
    expect(result.current.escalating).toBe(false);
  });

  it('arms the existing steer in place and calls the success callback', async () => {
    const onArmed = jest.fn();
    mockArmMutateAsync.mockResolvedValue({
      armed: true,
      preemptRevision: 3,
      generationProtocolVersion: 2,
    });
    const { result } = setup();

    act(() => result.current.escalate({ steerId: 'steer-1', generationCreatedAt: 37 }, onArmed));

    expect(mockArmMutateAsync).toHaveBeenCalledWith({
      conversationId: CONVO_ID,
      steerId: 'steer-1',
      generationCreatedAt: 37,
    });
    await waitFor(() =>
      expect(result.current.steers).toEqual([
        expect.objectContaining({ steerId: 'steer-1', preempt: true, preemptRevision: 3 }),
      ]),
    );
    expect(onArmed).toHaveBeenCalledTimes(1);
    expect(result.current.escalating).toBe(false);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('does not let an older confirmation overwrite a newer preempt revision', async () => {
    mockArmMutateAsync.mockResolvedValue({
      armed: true,
      preemptRevision: 4,
      generationProtocolVersion: 2,
    });
    const { result } = setup({
      steers: [pending({ preempt: false, preemptRevision: 5 })],
    });

    act(() => result.current.escalate({ steerId: 'steer-1' }));

    await waitFor(() => expect(result.current.escalating).toBe(false));
    expect(result.current.steers).toEqual([
      expect.objectContaining({ steerId: 'steer-1', preempt: false, preemptRevision: 5 }),
    ]);
  });

  it('reports an unsupported preempt without relabelling the steer', async () => {
    mockArmMutateAsync.mockResolvedValue({
      armed: false,
      code: 'PREEMPT_UNSUPPORTED',
      generationProtocolVersion: 2,
    });
    const { result } = setup();

    act(() => result.current.escalate({ steerId: 'steer-1' }));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_ui_steer_preempt_unsupported',
        status: 'info',
      }),
    );
    expect(result.current.steers[0]).not.toHaveProperty('preempt', true);
  });

  it('reports a known lost race without retrying', async () => {
    mockArmMutateAsync.mockResolvedValue({
      armed: false,
      generationProtocolVersion: 2,
    });
    const { result } = setup();

    act(() => result.current.escalate({ steerId: 'steer-1' }));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_ui_steer_arm_lost_race',
        status: 'info',
      }),
    );
    expect(mockArmMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('retries one ambiguous protocol-v2 transport failure', async () => {
    mockArmMutateAsync.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({
      armed: true,
      preemptRevision: 1,
      generationProtocolVersion: 2,
    });
    const { result } = setup();

    act(() => result.current.escalate({ steerId: 'steer-1' }));

    await waitFor(() => expect(mockArmMutateAsync).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.steers[0]).toHaveProperty('preempt', true));
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it.each([400, 403, 409])('does not retry a definitive HTTP %s rejection', async (status) => {
    mockArmMutateAsync.mockRejectedValue({
      response: { status, data: { code: 'RUN_PAUSED' } },
    });
    const { result } = setup();

    act(() => result.current.escalate({ steerId: 'steer-1' }));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_ui_steer_arm_lost_race',
        status: 'info',
      }),
    );
    expect(mockArmMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('does not retry an ambiguous failure under protocol v1', async () => {
    mockArmMutateAsync.mockRejectedValue(new Error('response lost'));
    const { result } = setup({ activeGenerationProtocolVersion: 1 });

    act(() => result.current.escalate({ steerId: 'steer-1' }));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_ui_steer_arm_unconfirmed',
        status: 'warning',
      }),
    );
    expect(mockArmMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps a rejected-then-missing retry indeterminate', async () => {
    mockArmMutateAsync
      .mockRejectedValueOnce(new Error('response lost after commit'))
      .mockResolvedValueOnce({ armed: false, generationProtocolVersion: 2 });
    const { result } = setup();

    act(() => result.current.escalate({ steerId: 'steer-1' }));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_ui_steer_arm_unconfirmed',
        status: 'warning',
      }),
    );
    expect(mockArmMutateAsync).toHaveBeenCalledTimes(2);
    expect(result.current.steers[0]).not.toHaveProperty('preempt', true);
  });

  it('rejects an unversioned success under negotiated protocol v2', async () => {
    mockArmMutateAsync.mockResolvedValue({ armed: true, preemptRevision: 1 });
    const { result } = setup();

    act(() => result.current.escalate({ steerId: 'steer-1' }));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_ui_steer_arm_unconfirmed',
        status: 'warning',
      }),
    );
    expect(result.current.steers[0]).not.toHaveProperty('preempt', true);
  });

  it('warns and unlocks when arm confirmation times out', async () => {
    jest.useFakeTimers();
    mockArmMutateAsync.mockReturnValue(new Promise(() => undefined));
    const { result } = setup();

    act(() => result.current.escalate({ steerId: 'steer-1' }));
    expect(result.current.escalating).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_steer_arm_unconfirmed',
      status: 'warning',
    });
    expect(result.current.escalating).toBe(false);
    expect(mockArmMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('does not start a detached retry when the first request rejects after timeout', async () => {
    jest.useFakeTimers();
    let rejectArm: (reason?: unknown) => void = () => undefined;
    mockArmMutateAsync.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectArm = reject;
      }),
    );
    const { result } = setup();

    act(() => result.current.escalate({ steerId: 'steer-1' }));
    await act(async () => {
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      rejectArm(new Error('late network failure'));
      await Promise.resolve();
    });

    expect(mockArmMutateAsync).toHaveBeenCalledTimes(1);
    expect(result.current.escalating).toBe(false);
  });
});
