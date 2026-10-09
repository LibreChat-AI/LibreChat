import React from 'react';
import { Constants } from 'librechat-data-provider';
import { useAtomValue, useSetAtom, getDefaultStore } from 'jotai';
import { act, renderHook, waitFor } from '@testing-library/react';
import { RecoilRoot, useSetRecoilState, useRecoilValue } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TSubmission, TConversation } from 'librechat-data-provider';
import type { DrainAfterAbort, RunEnd } from '~/hooks/Chat/queue';
import { drainAfterAbortByIndex, runEndByIndex, resetQueueFamilies } from '~/hooks/Chat/queue';
import useChatHelpers from '../useChatHelpers';
import { useAbortCleanup } from '../abort';
import store from '~/store';

const mockAbortMutateAsync = jest.fn();
const mockConvertSteersToQueued = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: undefined }),
  useAbortStreamMutation: () => ({ mutateAsync: mockAbortMutateAsync }),
  supportsGenerationProtocolV2: (value: unknown) =>
    value != null &&
    typeof value === 'object' &&
    (value as { generationProtocolVersion?: unknown }).generationProtocolVersion === 2,
}));

jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useLatestMessage: () => null,
  useLatestMessageId: () => null,
}));

jest.mock('~/hooks/Chat/useChatFunctions', () => ({
  __esModule: true,
  default: () => ({ ask: jest.fn(), regenerate: jest.fn() }),
}));

jest.mock('~/hooks/useNewConvo', () => ({
  __esModule: true,
  default: () => ({ newConversation: jest.fn() }),
}));

jest.mock('~/hooks/Chat/useSteerConvert', () => ({
  __esModule: true,
  default: () => mockConvertSteersToQueued,
}));

const INDEX = 0;
const OTHER_INDEX = 1;

const submission = (id: string) =>
  ({ userMessage: { messageId: id, text: id } }) as unknown as TSubmission;

function setup() {
  const handles: {
    captureSubmission?: ReturnType<typeof useAbortCleanup>['captureSubmission'];
    clearSubmissionsUnlessReplaced?: ReturnType<
      typeof useAbortCleanup
    >['clearSubmissionsUnlessReplaced'];
    setSubmission?: (value: TSubmission | null) => void;
    setOtherSubmission?: (value: TSubmission | null) => void;
  } = {};
  const current: { submission: TSubmission | null; otherSubmission: TSubmission | null } = {
    submission: null,
    otherSubmission: null,
  };

  function Harness() {
    const cleanup = useAbortCleanup(INDEX);
    handles.captureSubmission = cleanup.captureSubmission;
    handles.clearSubmissionsUnlessReplaced = cleanup.clearSubmissionsUnlessReplaced;
    handles.setSubmission = useSetRecoilState(store.submissionByIndex(INDEX));
    handles.setOtherSubmission = useSetRecoilState(store.submissionByIndex(OTHER_INDEX));
    current.submission = useRecoilValue(store.submissionByIndex(INDEX));
    current.otherSubmission = useRecoilValue(store.submissionByIndex(OTHER_INDEX));
    return null;
  }

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot
      initializeState={({ set }) => {
        // clearAllSubmissions iterates the registered conversation keys.
        set(store.conversationKeysAtom, [INDEX, OTHER_INDEX]);
      }}
    >
      <Harness />
      {children}
    </RecoilRoot>
  );
  renderHook(() => null, { wrapper });
  return { handles, current };
}

beforeEach(() => resetQueueFamilies());

describe('useAbortCleanup', () => {
  it('clears all submissions when the captured submission is still current', async () => {
    const { handles, current } = setup();
    const aborted = submission('aborted-run');

    act(() => {
      handles.setSubmission!(aborted);
      handles.setOtherSubmission!(submission('added-pane'));
    });

    const captured = handles.captureSubmission!();
    expect(captured).toBe(aborted);

    act(() => {
      handles.clearSubmissionsUnlessReplaced!(captured);
    });

    await waitFor(() => expect(current.submission).toBeNull());
    expect(current.otherSubmission).toBeNull();
  });

  it('keeps a submission that replaced the aborted one while the abort was in flight', async () => {
    const { handles, current } = setup();
    const aborted = submission('aborted-run');
    const nextRun = submission('interrupt-follow-up');

    act(() => {
      handles.setSubmission!(aborted);
    });
    const captured = handles.captureSubmission!();

    // The final SSE fired the interrupt drain and started the next run
    // before the abort HTTP response resolved.
    act(() => {
      handles.setSubmission!(nextRun);
    });
    act(() => {
      handles.clearSubmissionsUnlessReplaced!(captured);
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(current.submission).toBe(nextRun);
  });

  it('keeps a new submission even when the abort started with none captured', async () => {
    const { handles, current } = setup();
    const nextRun = submission('drained-after-abort');

    const captured = handles.captureSubmission!();
    expect(captured).toBeNull();

    act(() => {
      handles.setSubmission!(nextRun);
    });
    act(() => {
      handles.clearSubmissionsUnlessReplaced!(captured);
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(current.submission).toBe(nextRun);
  });

  it('still clears when the submission was already nulled elsewhere', async () => {
    const { handles, current } = setup();
    const aborted = submission('aborted-run');

    act(() => {
      handles.setSubmission!(aborted);
      handles.setOtherSubmission!(submission('added-pane'));
    });
    const captured = handles.captureSubmission!();

    act(() => {
      handles.setSubmission!(null);
    });
    act(() => {
      handles.clearSubmissionsUnlessReplaced!(captured);
    });

    await waitFor(() => expect(current.otherSubmission).toBeNull());
    expect(current.submission).toBeNull();
  });
});

describe('useChatHelpers stopGenerating (abort steer targeting)', () => {
  const observed: { runEnd: RunEnd | null; drainAfterAbort: DrainAfterAbort | false } = {
    runEnd: null,
    drainAfterAbort: false,
  };
  let currentSubmission: TSubmission | null = null;

  function setupStop(conversationId: string, generationCreatedAt: number | null = 41) {
    let setDrainAfterAbort: ((value: DrainAfterAbort | false) => void) | undefined;
    const stoppedSubmission = submission('stopped-run');
    function RunEndProbe() {
      currentSubmission = useRecoilValue(store.submissionByIndex(INDEX));
      observed.runEnd = useAtomValue(runEndByIndex(INDEX));
      observed.drainAfterAbort = useAtomValue(drainAfterAbortByIndex(INDEX));
      setDrainAfterAbort = useSetAtom(drainAfterAbortByIndex(INDEX));
      return null;
    }
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <RecoilRoot
          initializeState={({ set }) => {
            set(store.conversationKeysAtom, [INDEX]);
            set(store.submissionByIndex(INDEX), stoppedSubmission);
            set(store.conversationByIndex(INDEX), {
              conversationId,
              endpoint: 'agents',
            } as TConversation);
            // Arm interrupt & send so the abort response writes the drain signal.
            getDefaultStore().set(drainAfterAbortByIndex(INDEX), {
              conversationId,
              generationCreatedAt: 41,
            });
            if (generationCreatedAt != null) {
              set(store.activeGenerationCreatedAtByConvoId(conversationId), generationCreatedAt);
              set(store.activeGenerationProtocolVersionByConvoId(conversationId), 2);
            }
          }}
        >
          <RunEndProbe />
          {children}
        </RecoilRoot>
      </QueryClientProvider>
    );
    return {
      ...renderHook(() => useChatHelpers(INDEX), { wrapper }),
      stoppedSubmission,
      setDrainAfterAbort: (value: DrainAfterAbort | false) => setDrainAfterAbort?.(value),
    };
  }

  beforeEach(() => {
    observed.runEnd = null;
    observed.drainAfterAbort = false;
    mockAbortMutateAsync.mockReset();
    mockConvertSteersToQueued.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([String(Constants.NEW_CONVO), 'convo-held'])(
    'keeps the stopped submission attached for terminal reconciliation in %s',
    async (conversationId) => {
      mockAbortMutateAsync.mockResolvedValue({
        success: true,
        aborted: 'convo-resolved',
        generationProtocolVersion: 2,
      });
      const { result, stoppedSubmission } = setupStop(conversationId);

      await act(async () => {
        await result.current.stopGenerating();
      });

      expect(currentSubmission).toBe(stoppedSubmission);
      expect(observed.runEnd).toBeNull();
      expect(observed.drainAfterAbort).toEqual({ conversationId, generationCreatedAt: 41 });
    },
  );

  it('keeps chips on the new composer while waiting for FINAL to drain', async () => {
    const pendingSteers = [{ steerId: 's1', text: 'leftover words' }];
    mockAbortMutateAsync.mockResolvedValue({
      success: true,
      aborted: 'convo-resolved',
      pendingSteers,
      generationProtocolVersion: 2,
    });

    const { result } = setupStop(String(Constants.NEW_CONVO));
    await act(async () => {
      await result.current.stopGenerating();
    });

    expect(mockAbortMutateAsync).toHaveBeenCalledWith({
      conversationId: String(Constants.NEW_CONVO),
      generationCreatedAt: 41,
    });
    // The user is still on /c/new (nothing navigated), so the chips and the
    // drain signal key under NEW_CONVO — but the parked server copy lives
    // under the RESOLVED job id and must be claimed there.
    expect(mockConvertSteersToQueued).toHaveBeenCalledWith(
      String(Constants.NEW_CONVO),
      pendingSteers,
      {
        claimParked: true,
        claimConversationId: 'convo-resolved',
        generationProtocolVersion: 2,
      },
    );
    expect(observed.runEnd).toBeNull();
  });

  it('prefers the response resolved id over the client-held id for an existing conversation', async () => {
    const pendingSteers = [{ steerId: 's2', text: 'other leftover' }];
    mockAbortMutateAsync.mockResolvedValue({
      success: true,
      aborted: 'convo-resolved',
      pendingSteers,
      generationProtocolVersion: 2,
    });

    const { result } = setupStop('convo-held');
    await act(async () => {
      await result.current.stopGenerating();
    });

    expect(mockConvertSteersToQueued).toHaveBeenCalledWith('convo-resolved', pendingSteers, {
      claimParked: true,
      claimConversationId: 'convo-resolved',
      generationProtocolVersion: 2,
    });
    expect(observed.runEnd).toBeNull();
  });

  it('fences abort to the attached generation epoch', async () => {
    mockAbortMutateAsync.mockResolvedValue({ success: true, aborted: 'convo-held' });

    const { result } = setupStop('convo-held', 41);
    await act(async () => {
      await result.current.stopGenerating();
    });

    expect(mockAbortMutateAsync).toHaveBeenCalledWith({
      conversationId: 'convo-held',
      generationCreatedAt: 41,
    });
  });

  it('does not arm a run-end drain when abort targets a replaced generation', async () => {
    mockAbortMutateAsync.mockRejectedValue({
      response: {
        status: 409,
        data: { code: 'RUN_REPLACED', generationProtocolVersion: 2 },
      },
    });

    const { result } = setupStop('convo-held', 41);
    await act(async () => {
      await result.current.stopGenerating();
    });

    expect(observed.runEnd).toBeNull();
    expect(mockConvertSteersToQueued).not.toHaveBeenCalled();
  });

  it('keeps Stop inert before the generation epoch is known', async () => {
    const { result } = setupStop('convo-held', null);

    await act(async () => {
      await result.current.stopGenerating();
    });

    expect(mockAbortMutateAsync).not.toHaveBeenCalled();
    expect(mockConvertSteersToQueued).not.toHaveBeenCalled();
    expect(observed.runEnd).toBeNull();
    expect(observed.drainAfterAbort).toEqual({
      conversationId: 'convo-held',
      generationCreatedAt: 41,
    });
  });

  it('waits for SSE reconciliation when abort persistence fails', async () => {
    mockAbortMutateAsync.mockResolvedValue({
      success: true,
      aborted: 'convo-held',
      persistenceFailed: true,
      generationProtocolVersion: 2,
    });
    const { result } = setupStop('convo-held');

    await act(async () => {
      await result.current.stopGenerating();
    });

    expect(mockAbortMutateAsync).toHaveBeenCalledWith({
      conversationId: 'convo-held',
      generationCreatedAt: 41,
    });
    expect(mockConvertSteersToQueued).not.toHaveBeenCalled();
    expect(observed.runEnd).toBeNull();
    expect(observed.drainAfterAbort).toBe(false);
  });

  it('does not release the abort-drain queue when natural completion already settled the run', async () => {
    mockAbortMutateAsync.mockResolvedValue({
      success: false,
      settled: true,
      code: 'RUN_ALREADY_SETTLED',
      streamId: 'convo-held',
      terminalStatus: 'complete',
      generationProtocolVersion: 2,
    });
    const { result, stoppedSubmission } = setupStop('convo-held');

    await act(async () => {
      await result.current.stopGenerating();
    });

    expect(currentSubmission).toBe(stoppedSubmission);
    expect(mockConvertSteersToQueued).not.toHaveBeenCalled();
    expect(observed.runEnd).toBeNull();
    expect(observed.drainAfterAbort).toBe(false);
  });

  it('does not let a late abort response clear another conversation epoch', async () => {
    let resolveAbort: ((value: unknown) => void) | undefined;
    mockAbortMutateAsync.mockReturnValue(
      new Promise((resolve) => {
        resolveAbort = resolve;
      }),
    );
    const { result, setDrainAfterAbort } = setupStop('convo-a');

    let stopPromise: Promise<void> | undefined;
    act(() => {
      stopPromise = result.current.stopGenerating();
    });
    act(() => {
      setDrainAfterAbort({ conversationId: 'convo-b', generationCreatedAt: 22 });
    });
    await act(async () => {
      resolveAbort?.({
        success: false,
        settled: true,
        code: 'RUN_ALREADY_SETTLED',
        generationProtocolVersion: 2,
      });
      await stopPromise;
    });

    expect(observed.drainAfterAbort).toEqual({
      conversationId: 'convo-b',
      generationCreatedAt: 22,
    });
  });

  it('does not release the armed queue for an unknown abort outcome', async () => {
    mockAbortMutateAsync.mockRejectedValue({ response: { status: 503 } });
    const { result } = setupStop('convo-held');

    await act(async () => {
      await result.current.stopGenerating();
    });

    expect(mockConvertSteersToQueued).not.toHaveBeenCalled();
    expect(observed.runEnd).toBeNull();
    expect(observed.drainAfterAbort).toEqual({
      conversationId: 'convo-held',
      generationCreatedAt: 41,
    });
  });

  it('releases the armed queue only when abort authoritatively returns 404', async () => {
    mockAbortMutateAsync.mockRejectedValue({ response: { status: 404 } });
    const { result } = setupStop('convo-held');

    await act(async () => {
      await result.current.stopGenerating();
    });

    expect(observed.runEnd).toMatchObject({
      conversationId: 'convo-held',
      outcome: 'aborted',
      generationCreatedAt: 41,
    });
  });

  it('falls back to the client-held id when the response carries no resolved id', async () => {
    mockAbortMutateAsync.mockResolvedValue({
      success: true,
      pendingSteers: [],
      generationProtocolVersion: 2,
    });

    const { result } = setupStop('convo-held');
    await act(async () => {
      await result.current.stopGenerating();
    });

    expect(mockConvertSteersToQueued).toHaveBeenCalledWith('convo-held', [], {
      claimParked: true,
      claimConversationId: 'convo-held',
      generationProtocolVersion: 2,
    });
    expect(observed.runEnd).toBeNull();
  });
});
