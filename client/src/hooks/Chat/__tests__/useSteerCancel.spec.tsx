import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { ReasoningEffort } from 'librechat-data-provider';
import type { RestoreToComposer } from '~/Providers/ComposerRestoreContext';
import type { PendingSteer } from '~/store/families';
import {
  ComposerRestoreProvider,
  useComposerRestoreHost,
} from '~/Providers/ComposerRestoreContext';
import useSteerCancel, { useSteerMoveToQueue } from '../useSteerCancel';
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

/** Publishes a composer restore the way `ChatForm` does, so the cancel path
 *  runs against the real registry rather than a mocked module. */
function Publisher({
  restore,
  children,
}: {
  restore: RestoreToComposer;
  children: React.ReactNode;
}) {
  const { publish } = useComposerRestoreHost();
  React.useEffect(() => {
    publish(restore);
    return () => publish(null);
  }, [publish, restore]);
  return <>{children}</>;
}

function setupCancel(steer: PendingSteer, restore: RestoreToComposer) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.activeGenerationCreatedAtByConvoId(CONVO_ID), 100);
        set(store.pendingSteersByConvoId(CONVO_ID), [steer]);
      }}
    >
      <ComposerRestoreProvider>
        <Publisher restore={restore}>{children}</Publisher>
      </ComposerRestoreProvider>
    </RecoilRoot>
  );
  return renderHook(
    () => ({
      cancel: useSteerCancel(CONVO_ID),
      chips: useRecoilValue(store.pendingSteersByConvoId(CONVO_ID)),
      queue: useRecoilValue(store.queuedMessagesByConvoId(CONVO_ID)),
    }),
    { wrapper },
  );
}

describe('useSteerCancel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('hands the whole reclaimed steer back to the composer, not just its text', async () => {
    mockCancelAsync.mockResolvedValue({ removed: true });
    const restore = jest.fn().mockReturnValue(true);
    const reasoningOverride = {
      key: 'reasoning_effort',
      value: ReasoningEffort.high,
    } as const;
    const steer = pending({
      files: [{ file_id: 'file-1', filename: 'notes.txt' }],
      reasoningOverride,
    });
    const { result } = setupCancel(steer, restore);

    await act(async () => {
      await result.current.cancel(steer);
    });

    expect(restore).toHaveBeenCalledWith(
      'move this later',
      [{ file_id: 'file-1', filename: 'notes.txt' }],
      { quotes: ['quoted context'], manualSkills: ['skill-1'], reasoningOverride },
      CONVO_ID,
    );
    expect(result.current.chips).toEqual([]);
    expect(result.current.queue).toEqual([]);
  });

  it('queues the whole steer when the composer refuses it', async () => {
    mockCancelAsync.mockResolvedValue({ removed: true });
    const restore = jest.fn().mockReturnValue(false);
    const steer = pending();
    const { result } = setupCancel(steer, restore);

    await act(async () => {
      await result.current.cancel(steer);
    });

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

  it('leaves an applied steer alone instead of recovering it', async () => {
    mockCancelAsync.mockResolvedValue({ removed: false });
    const restore = jest.fn().mockReturnValue(true);
    const steer = pending();
    const { result } = setupCancel(steer, restore);

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.cancel(steer);
    });

    expect(outcome).toBe('applied');
    expect(restore).not.toHaveBeenCalled();
    expect(result.current.chips).toEqual([steer]);
    expect(result.current.queue).toEqual([]);
  });
});
