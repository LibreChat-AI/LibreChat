import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import type { PendingSteer } from '~/store/families';
import { useSteerMoveToQueue } from '../useSteerCancel';
import store from '~/store';

const mockCancelAsync = jest.fn();

jest.mock('~/data-provider', () => ({
  useCancelSteerMutation: () => ({ mutateAsync: mockCancelAsync }),
  fetchStreamStatus: jest.fn(),
  getGenerationProtocolVersion: jest.fn(),
}));

const CONVO_ID = 'convo-steer-cancel';

const pending = (overrides: Partial<PendingSteer> = {}): PendingSteer => ({
  steerId: 'srv-1',
  clientSteerId: 'local-1',
  text: 'move this later',
  status: 'pending',
  createdAt: 10,
  generationCreatedAt: 100,
  generationProtocolVersion: 2,
  quotes: ['quoted context'],
  manualSkills: ['skill-1'],
  ...overrides,
});

function setup(steer: PendingSteer) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.activeGenerationCreatedAtByConvoId(CONVO_ID), 100);
        set(store.pendingSteersByConvoId(CONVO_ID), [steer]);
      }}
    >
      {children}
    </RecoilRoot>
  );
  return renderHook(
    () => ({
      moveToQueue: useSteerMoveToQueue(CONVO_ID),
      chips: useRecoilValue(store.pendingSteersByConvoId(CONVO_ID)),
      queue: useRecoilValue(store.queuedMessagesByConvoId(CONVO_ID)),
    }),
    { wrapper },
  );
}

describe('useSteerMoveToQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('moves only a confirmed reclaim into an ordinary queue row', async () => {
    mockCancelAsync.mockResolvedValue({ removed: true });
    const steer = pending();
    const { result } = setup(steer);

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.moveToQueue(steer);
    });

    expect(outcome).toBe('reclaimed');
    expect(result.current.chips).toEqual([]);
    expect(result.current.queue).toEqual([
      {
        id: 'srv-1',
        text: 'move this later',
        createdAt: 10,
        quotes: ['quoted context'],
        manualSkills: ['skill-1'],
      },
    ]);
  });

  it('restores a reclaimed queued origin without recovery fields', async () => {
    mockCancelAsync.mockResolvedValue({ removed: true });
    const original = {
      id: 'queue-original',
      text: 'move this later',
      createdAt: 5,
      priority: true,
    };
    const steer = pending({
      queuedOrigin: { item: original, beforeIds: [], afterIds: [] },
    });
    const { result } = setup(steer);

    await act(async () => {
      await result.current.moveToQueue(steer);
    });

    expect(result.current.queue).toEqual([original]);
  });

  it('leaves an already applied steer under server ownership', async () => {
    mockCancelAsync.mockResolvedValue({ removed: false });
    const steer = pending();
    const { result } = setup(steer);

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.moveToQueue(steer);
    });

    expect(outcome).toBe('applied');
    expect(result.current.chips).toEqual([steer]);
    expect(result.current.queue).toEqual([]);
  });
});
