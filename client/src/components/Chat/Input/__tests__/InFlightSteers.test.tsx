import React from 'react';
import { getDefaultStore } from 'jotai';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { PendingSteer, QueuedMessage } from '~/store/families';
import type { SteeringControls } from '~/hooks/Chat/useSteering';
import { steerOverlayHeightFamily, escalatingSteerFamily } from '~/store/steer';
import useSteerConvert from '~/hooks/Chat/useSteerConvert';
import InFlightSteers from '../InFlightSteers';
import store from '~/store';

const mockCancelMutateAsync = jest.fn();
const mockShowToast = jest.fn();
const mockQueueReclaimedSteer = jest.fn();
const mockRemoveSteer = jest.fn();
const mockRetrySteer = jest.fn();
const mockArmMutateAsync = jest.fn();
const mockSetDefaultAction = jest.fn();
const mockRestoreToComposer = jest.fn();
let convertSteersForTest: ReturnType<typeof useSteerConvert>;
let observedQueueForTest: QueuedMessage[];
let setSteersForTest: (updater: (prev: PendingSteer[]) => PendingSteer[]) => void;
let mockFileMap: Record<string, { llmDeliveryPath?: 'provider' | 'text' | 'none' }> = {};

jest.mock('~/Providers', () => ({
  useFileMapContext: () => mockFileMap,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useSteerCancel: jest.requireActual('~/hooks/Chat/useSteerCancel').default,
  useSteerReclaim: jest.requireActual('~/hooks/Chat/useSteerCancel').useSteerReclaim,
}));

jest.mock('~/../test/mockMorphIcon', () => jest.requireActual('~/../test/mockMorphIcon'));

jest.mock('@librechat/client', () => {
  const { createSteerMorphIconMock } = jest.requireActual('~/../test/mockMorphIcon');
  return {
    useToastContext: () => ({ showToast: mockShowToast }),
    /** Trigger-only stand-in: the receipt renders its marks as the hover card's
     *  custom trigger, so the mock must render children under the accessible
     *  name rather than swallowing them. */
    InfoHoverCard: ({ text, children }: { text: string; children?: React.ReactNode }) => (
      <button type="button" aria-label={text}>
        {children}
      </button>
    ),
    ESide: { Top: 'top', Bottom: 'bottom' },
    MorphIcon: createSteerMorphIconMock(),
  };
});

jest.mock('~/data-provider', () => ({
  useCancelSteerMutation: () => ({ mutateAsync: mockCancelMutateAsync }),
  useArmSteerMutation: () => ({ mutateAsync: mockArmMutateAsync }),
  getGenerationProtocolVersion: (value: unknown) =>
    value != null &&
    typeof value === 'object' &&
    (value as { generationProtocolVersion?: unknown }).generationProtocolVersion === 2
      ? 2
      : 1,
  supportsGenerationProtocolV2: (value: unknown) =>
    value != null &&
    typeof value === 'object' &&
    (value as { generationProtocolVersion?: unknown }).generationProtocolVersion === 2,
}));

jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: ({ file, onClick }: { file: { filename?: string }; onClick?: () => void }) => (
    <button type="button" data-testid="steer-file" onClick={onClick}>
      {file.filename}
    </button>
  ),
}));

/** The composer thumbnail path: a fixed-size button painted with a background
 *  image, not an <img> — assert on the url it was handed. */
jest.mock('~/components/Chat/Input/Files/ImagePreview', () => ({
  __esModule: true,
  default: ({ url, alt }: { url?: string; alt?: string }) => (
    <button type="button" data-testid="steer-image" data-url={url} aria-label={alt} />
  ),
}));

jest.mock('~/components/Chat/Messages/Content/FilePreviewDialog', () => ({
  __esModule: true,
  default: ({
    open,
    fileName,
    deliveryPath,
  }: {
    open: boolean;
    fileName: string;
    deliveryPath?: string;
  }) =>
    open ? (
      <div data-testid="steer-file-preview" data-delivery-path={deliveryPath}>
        {fileName}
      </div>
    ) : null,
}));

jest.mock('~/components/Chat/Messages/Content/MarkdownLite', () => ({
  __esModule: true,
  default: ({ content, codeExecution }: { content: string; codeExecution?: boolean }) => (
    <span data-testid="steer-markdown" data-code-execution={String(codeExecution)}>
      {content}
    </span>
  ),
}));

const CONVO_ID = 'convo-in-flight';

const steeringStub = (defaultAction: 'steer' | 'queue' = 'steer', duringRunActive = true) =>
  ({
    defaultAction,
    duringRunActive,
    pausedOnApproval: false,
    removeSteer: mockRemoveSteer,
    retrySteer: mockRetrySteer,
    setDefaultAction: mockSetDefaultAction,
    queueReclaimedSteer: mockQueueReclaimedSteer,
  }) as unknown as SteeringControls;

type RenderOptions = {
  enableUserMsgMarkdown?: boolean;
  appliedSteerIds?: string[];
  defaultAction?: 'steer' | 'queue';
  duringRunActive?: boolean;
  activeGenerationCreatedAt?: number | null;
  activeGenerationProtocolVersion?: 1 | 2;
};

/** Element builder shared by first render and rerenders — `initializeState`
 *  only applies on mount, so a rerender just swaps the steering controls. */
function steersElement(steers: PendingSteer[], options?: RenderOptions) {
  const SteerRaceProbe = () => {
    convertSteersForTest = useSteerConvert();
    observedQueueForTest = useRecoilValue(store.queuedMessagesByConvoId(CONVO_ID));
    setSteersForTest = useSetRecoilState(store.pendingSteersByConvoId(CONVO_ID));
    return null;
  };
  return (
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.pendingSteersByConvoId(CONVO_ID), steers);
        const activeGenerationCreatedAt =
          options?.activeGenerationCreatedAt === undefined ? 41 : options.activeGenerationCreatedAt;
        if (options?.appliedSteerIds != null) {
          set(store.appliedSteerIdsByConvoId(CONVO_ID), options.appliedSteerIds);
        }
        if (options?.enableUserMsgMarkdown != null) {
          set(store.enableUserMsgMarkdown, options.enableUserMsgMarkdown);
        }
        if (activeGenerationCreatedAt != null) {
          set(store.activeGenerationCreatedAtByConvoId(CONVO_ID), activeGenerationCreatedAt);
        }
        set(
          store.activeGenerationProtocolVersionByConvoId(CONVO_ID),
          options?.activeGenerationProtocolVersion ?? 2,
        );
      }}
    >
      <SteerRaceProbe />
      <InFlightSteers
        conversationId={CONVO_ID}
        steering={steeringStub(options?.defaultAction, options?.duringRunActive)}
        onRestoreToComposer={mockRestoreToComposer}
      />
    </RecoilRoot>
  );
}

function renderSteers(steers: PendingSteer[], options?: RenderOptions) {
  return render(steersElement(steers, options));
}

/** Opens a bubble's "…" menu and clicks one of its items, flushing the reclaim
 *  round-trip the action awaits before it re-homes the text. */
async function clickMenuItem(label: string) {
  fireEvent.click(screen.getByLabelText('com_ui_more_options'));
  const item = await screen.findByText(label);
  await act(async () => {
    fireEvent.click(item);
  });
}

describe('InFlightSteers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFileMap = {};
    mockCancelMutateAsync.mockResolvedValue({ removed: true });
    mockRestoreToComposer.mockReturnValue(true);
    observedQueueForTest = [];
  });

  it('renders nothing when no steer is in flight', () => {
    renderSteers([]);
    expect(screen.queryByTestId('in-flight-steers')).toBeNull();
  });

  it('anchors sending and pending steers above the composer, not in-thread', () => {
    renderSteers([
      { steerId: 's1', text: 'first correction', status: 'sending', createdAt: 1 },
      { steerId: 's2', text: 'second correction', status: 'pending', createdAt: 2 },
    ]);
    expect(screen.getAllByTestId('in-flight-steer')).toHaveLength(2);
    expect(screen.getByText('first correction')).toBeInTheDocument();
    expect(screen.getByText('second correction')).toBeInTheDocument();
    // The in-thread SteerPart is reserved for server-applied steers.
    expect(screen.queryByTestId('steer-part')).toBeNull();
  });

  it('leaves failed steers to the composer recovery rows', () => {
    renderSteers([{ steerId: 's3', text: 'never sent', status: 'failed', createdAt: 1 }]);
    expect(screen.queryByTestId('in-flight-steers')).toBeNull();
  });

  it('renders carried quotes as the same reference blocks the applied part shows', () => {
    renderSteers([
      {
        steerId: 's-quoted',
        text: 'about the selection',
        status: 'pending',
        createdAt: 1,
        quotes: ['the selected excerpt'],
      },
    ]);
    expect(screen.getByTestId('message-quotes')).toHaveTextContent('the selected excerpt');
  });

  it('shows the menu at rest on every pointer, without hover-gating', () => {
    renderSteers([
      { steerId: 's-ack', text: 'waiting on boundary', status: 'pending', createdAt: 1 },
    ]);
    // The menu is the single control now (Cancel folded in), so a label-less ⋯
    // hidden until hover would be undiscoverable — and unreachable on touch,
    // where there is no hover. It must be visible at rest.
    const controls = screen.getByTestId('steer-controls');
    expect(controls.className).not.toContain('opacity-0');
    expect(screen.getByLabelText('com_ui_more_options')).toBeInTheDocument();
  });

  it('only offers the menu once the steer is acknowledged', () => {
    renderSteers([
      { steerId: 'local-1', text: 'still posting', status: 'sending', createdAt: 1 },
      { steerId: 's-ack', text: 'waiting on boundary', status: 'pending', createdAt: 2 },
    ]);
    // A 'sending' entry has no server id yet, so there is nothing to act on —
    // cancel and the re-homing actions all need to reclaim it first.
    expect(screen.getAllByLabelText('com_ui_more_options')).toHaveLength(1);
  });

  it('cancels a pending steer from the menu and drops the bubble', async () => {
    renderSteers([
      { steerId: 's-ack', text: 'waiting on boundary', status: 'pending', createdAt: 1 },
    ]);
    await clickMenuItem('com_ui_steer_cancel');

    expect(mockCancelMutateAsync).toHaveBeenCalledWith({
      conversationId: CONVO_ID,
      steerId: 's-ack',
      generationCreatedAt: 41,
    });
    await act(async () => {});
    expect(screen.queryByText('waiting on boundary')).toBeNull();
  });

  it('fences cancel to the generation recorded on the steer', async () => {
    renderSteers(
      [
        {
          steerId: 's-epoch',
          text: 'belongs to the old turn',
          status: 'pending',
          createdAt: 1,
          generationCreatedAt: 41,
        },
      ],
      { activeGenerationCreatedAt: 99 },
    );
    await clickMenuItem('com_ui_steer_cancel');

    expect(mockCancelMutateAsync).toHaveBeenCalledWith({
      conversationId: CONVO_ID,
      steerId: 's-epoch',
      generationCreatedAt: 41,
    });
  });

  it('does not send a cancel before any generation epoch is known', async () => {
    renderSteers(
      [{ steerId: 's-no-epoch', text: 'wait for start', status: 'pending', createdAt: 1 }],
      { activeGenerationCreatedAt: null },
    );
    await clickMenuItem('com_ui_steer_cancel');

    expect(mockCancelMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText('wait for start')).toBeInTheDocument();
  });

  it('hands the words back to the composer once the cancel reclaims them', async () => {
    // Cancel is non-destructive: on a `reclaimed` outcome (removed:true) the
    // steer never reached the run, so its words return to the composer (the
    // gated restore refuses on its own when the composer is occupied).
    mockCancelMutateAsync.mockResolvedValue({ removed: true });
    renderSteers([{ steerId: 's-ack', text: 'second thoughts', status: 'pending', createdAt: 1 }]);
    await clickMenuItem('com_ui_steer_cancel');
    await act(async () => {});
    expect(mockRestoreToComposer).toHaveBeenCalledWith('second thoughts', undefined, {}, CONVO_ID);
  });

  it('queues the words when cancel reclaims but the composer refuses the restore', async () => {
    // Reclaimed (removed:true) yet the composer moved on, so the gated restore
    // refuses. The chip is already gone — queue the words like Edit rather than
    // drop them.
    mockCancelMutateAsync.mockResolvedValue({ removed: true });
    mockRestoreToComposer.mockReturnValue(false);
    const steer: PendingSteer = {
      steerId: 's-ack',
      text: 'keep me',
      status: 'pending',
      createdAt: 1,
    };
    renderSteers([steer]);
    await clickMenuItem('com_ui_steer_cancel');
    await act(async () => {});
    expect(mockQueueReclaimedSteer).toHaveBeenCalledWith(steer);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_steer_edit_queued' }),
    );
  });

  it('does not restore when the cancel loses its race (steer already reached the run)', async () => {
    // removed:false → the steer will still inject; restoring would put the same
    // words in the composer alongside the copy in the response.
    mockCancelMutateAsync.mockResolvedValue({ removed: false });
    renderSteers([{ steerId: 's-ack', text: 'too late', status: 'pending', createdAt: 1 }]);
    await clickMenuItem('com_ui_steer_cancel');
    await act(async () => {});
    expect(mockRestoreToComposer).not.toHaveBeenCalled();
    // Receiptless v1 cannot distinguish an injected steer from a terminal
    // conversion race, so keep the original metadata until an event proves
    // which path won.
    expect(mockCancelMutateAsync).toHaveBeenCalled();
    expect(screen.getByText('too late')).toBeInTheDocument();
  });

  it('does not restore when the cancel POST fails', async () => {
    // The POST failed, so the server may still inject it and the bubble is
    // restored — restoring to the composer too would duplicate the words.
    mockCancelMutateAsync.mockRejectedValue(new Error('network'));
    renderSteers([{ steerId: 's-ack', text: 'unknown fate', status: 'pending', createdAt: 1 }]);
    await clickMenuItem('com_ui_steer_cancel');
    await act(async () => {});
    expect(mockRestoreToComposer).not.toHaveBeenCalled();
  });

  it('restores the bubble when the cancel POST fails', async () => {
    mockCancelMutateAsync.mockRejectedValue(new Error('network'));
    renderSteers([{ steerId: 's-err', text: 'network flake', status: 'pending', createdAt: 1 }]);
    await clickMenuItem('com_ui_steer_cancel');
    // Optimistic remove, then the reject restores it.
    await act(async () => {});
    expect(screen.getByText('network flake')).toBeInTheDocument();
  });

  it('keeps the terminal recovery copy when an in-flight cancel POST fails', async () => {
    let rejectCancel: ((reason?: unknown) => void) | undefined;
    mockCancelMutateAsync.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectCancel = reject;
      }),
    );
    const steer = {
      steerId: 's-settled',
      clientSteerId: 'local-settled',
      text: 'already queued',
      status: 'pending' as const,
      createdAt: 1,
    };
    renderSteers([steer]);
    await clickMenuItem('com_ui_steer_cancel');

    act(() => {
      convertSteersForTest(CONVO_ID, [steer]);
    });
    expect(observedQueueForTest).toEqual([
      expect.objectContaining({
        id: steer.steerId,
        recoverySteerId: steer.steerId,
        recoveryClientSteerId: steer.clientSteerId,
      }),
    ]);

    await act(async () => {
      rejectCancel?.(new Error('network'));
      await Promise.resolve();
    });
    expect(screen.queryByText('already queued')).toBeNull();
    expect(observedQueueForTest).toHaveLength(1);
    expect(mockRestoreToComposer).not.toHaveBeenCalled();
    expect(mockQueueReclaimedSteer).not.toHaveBeenCalled();
  });

  it('keeps the terminal recovery copy when cancel reports an applied race', async () => {
    let resolveCancel: ((value: { removed: boolean }) => void) | undefined;
    mockCancelMutateAsync.mockReturnValue(
      new Promise((resolve) => {
        resolveCancel = resolve;
      }),
    );
    const steer = {
      steerId: 's-terminal-race',
      clientSteerId: 'local-terminal-race',
      text: 'terminal recovery wins',
      status: 'pending' as const,
      createdAt: 1,
    };
    renderSteers([steer]);
    await clickMenuItem('com_ui_steer_cancel');

    act(() => {
      convertSteersForTest(CONVO_ID, [steer]);
    });
    expect(observedQueueForTest).toHaveLength(1);

    await act(async () => {
      resolveCancel?.({ removed: false });
      await Promise.resolve();
    });

    expect(screen.queryByText(steer.text)).toBeNull();
    expect(observedQueueForTest).toEqual([
      expect.objectContaining({
        id: steer.steerId,
        recoverySteerId: steer.steerId,
        recoveryClientSteerId: steer.clientSteerId,
      }),
    ]);
    expect(mockRestoreToComposer).not.toHaveBeenCalled();
    expect(mockQueueReclaimedSteer).not.toHaveBeenCalled();
  });

  it('reclaims a pending steer before queueing it for after the response', async () => {
    const steer: PendingSteer = {
      steerId: 's-ack',
      text: 'do this after',
      status: 'pending',
      createdAt: 1,
    };
    renderSteers([steer]);
    await clickMenuItem('com_ui_convert_to_queue');

    // Reclaim first: the server would otherwise still inject the steer, and the
    // queued copy would say the same words a second time.
    expect(mockCancelMutateAsync).toHaveBeenCalledWith({
      conversationId: CONVO_ID,
      steerId: 's-ack',
      generationCreatedAt: 41,
    });
    // Routed through the shared conversion, which preserves the steer's id and
    // createdAt so it drains ahead of a follow-up queued after it.
    expect(mockQueueReclaimedSteer).toHaveBeenCalledWith(steer);
  });

  it('hands the whole steer to the conversion so attachments and context survive', async () => {
    const steer: PendingSteer = {
      steerId: 's-ack',
      text: 'see notes',
      status: 'pending',
      createdAt: 1,
      files: [{ file_id: 'f1', filename: 'notes.pdf', type: 'application/pdf' }],
      quotes: ['quoted line'],
      manualSkills: ['skill-1'],
    };
    renderSteers([steer]);
    await clickMenuItem('com_ui_convert_to_queue');

    expect(mockQueueReclaimedSteer).toHaveBeenCalledWith(steer);
  });

  it('reclaims a pending steer before editing it back into the composer', async () => {
    const files = [{ file_id: 'f1', filename: 'notes.pdf', type: 'application/pdf' }];
    renderSteers([
      {
        steerId: 's-ack',
        text: 'reword this',
        status: 'pending',
        createdAt: 1,
        files,
        quotes: ['quoted line'],
      },
    ]);
    await clickMenuItem('com_ui_edit_message');

    // The origin conversation rides along so a restore cannot land in whatever
    // chat the user navigated to while the reclaim was in flight.
    expect(mockRestoreToComposer).toHaveBeenCalledWith(
      'reword this',
      files,
      { quotes: ['quoted line'] },
      CONVO_ID,
    );
    expect(mockRemoveSteer).toHaveBeenCalledWith('s-ack');
  });

  it('queues a reclaimed steer instead of overwriting a composer that moved on', async () => {
    // The reclaim is a round-trip: the user can type a new draft (or navigate)
    // before it resolves. The words are already off the server, so neither the
    // steer nor the newer draft is the one to throw away.
    mockRestoreToComposer.mockReturnValue(false);
    const steer: PendingSteer = {
      steerId: 's-ack',
      text: 'reword this',
      status: 'pending',
      createdAt: 1,
    };
    renderSteers([steer]);
    await clickMenuItem('com_ui_edit_message');

    expect(mockQueueReclaimedSteer).toHaveBeenCalledWith(steer);
    expect(mockRemoveSteer).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_steer_edit_queued' }),
    );
  });

  it('removes a competing terminal recovery copy before restoring a confirmed reclaim', async () => {
    let resolveCancel: ((value: { removed: boolean }) => void) | undefined;
    mockCancelMutateAsync.mockReturnValue(
      new Promise((resolve) => {
        resolveCancel = resolve;
      }),
    );
    const steer = {
      steerId: 's-ack',
      clientSteerId: 'local-ack',
      text: 'already queued',
      status: 'pending' as const,
      createdAt: 1,
    };
    renderSteers([steer]);
    await clickMenuItem('com_ui_edit_message');

    act(() => {
      convertSteersForTest(CONVO_ID, [steer]);
    });
    expect(observedQueueForTest).toHaveLength(1);

    await act(async () => {
      resolveCancel?.({ removed: true });
      await Promise.resolve();
    });

    expect(observedQueueForTest).toEqual([]);
    expect(mockRestoreToComposer).toHaveBeenCalledWith(steer.text, undefined, {}, CONVO_ID);
    expect(mockQueueReclaimedSteer).not.toHaveBeenCalled();
  });

  it('never re-homes a steer the server already applied', async () => {
    // `removed: false` means the cancel lost its race to the injection
    // boundary: the words are in the run, so queueing them would send twice.
    mockCancelMutateAsync.mockResolvedValue({ removed: false });
    renderSteers([{ steerId: 's-ack', text: 'too late', status: 'pending', createdAt: 1 }]);
    await clickMenuItem('com_ui_convert_to_queue');

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_steer_already_applied' }),
    );
    expect(mockQueueReclaimedSteer).not.toHaveBeenCalled();
  });

  it('never re-homes a steer whose cancel failed', async () => {
    // The POST failed, so the server may still inject it — its fate is unknown,
    // so the bubble stays and the text must not also land in the composer.
    mockCancelMutateAsync.mockRejectedValue(new Error('network'));
    renderSteers([{ steerId: 's-ack', text: 'unknown fate', status: 'pending', createdAt: 1 }]);
    await clickMenuItem('com_ui_edit_message');

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_steer_cancel_failed', status: 'error' }),
    );
    expect(mockRestoreToComposer).not.toHaveBeenCalled();
    expect(mockQueueReclaimedSteer).not.toHaveBeenCalled();
    // The menu actions leave the chip alone until the outcome is known.
    expect(screen.getByText('unknown fate')).toBeInTheDocument();
  });

  it('offers the mode toggle as the action the user would switch to', async () => {
    renderSteers([{ steerId: 's-ack', text: 'waiting', status: 'pending', createdAt: 1 }], {
      defaultAction: 'steer',
    });
    await clickMenuItem('com_ui_turn_on_queueing');
    expect(mockSetDefaultAction).toHaveBeenCalledWith('queue');
  });

  it('renders images through the composer thumbnail path, not the full-size message image', () => {
    renderSteers([
      {
        steerId: 's1',
        text: 'see attached',
        status: 'pending',
        createdAt: 1,
        files: [
          { file_id: 'f2', filename: 'shot.png', type: 'image/png', filepath: '/images/shot.png' },
        ],
      },
    ]);
    // The message `Image` reserves height from the file's dimensions, so it
    // cannot be clipped down to a thumbnail; ImagePreview is fixed-size.
    expect(screen.getByTestId('steer-image')).toHaveAttribute('data-url', '/images/shot.png');
  });

  it('prefers the local preview url for an image that is still uploading', () => {
    renderSteers([
      {
        steerId: 's1',
        text: 'see attached',
        status: 'pending',
        createdAt: 1,
        files: [
          {
            file_id: 'f2',
            filename: 'shot.png',
            type: 'image/png',
            preview: 'blob:local-preview',
            filepath: '/images/shot.png',
          },
        ],
      },
    ]);
    expect(screen.getByTestId('steer-image')).toHaveAttribute('data-url', 'blob:local-preview');
  });

  it('keeps non-image attachments previewable while the steer waits', () => {
    renderSteers([
      {
        steerId: 's1',
        text: 'see attached',
        status: 'pending',
        createdAt: 1,
        files: [{ file_id: 'f1', filename: 'notes.pdf', type: 'application/pdf' }],
      },
    ]);
    expect(screen.getByTestId('steer-file')).toHaveTextContent('notes.pdf');
    expect(screen.queryByTestId('steer-file-preview')).toBeNull();

    fireEvent.click(screen.getByTestId('steer-file'));
    expect(screen.getByTestId('steer-file-preview')).toHaveTextContent('notes.pdf');
  });

  it.each(['application/pdf', 'image/png'])(
    'hydrates %s preview metadata after the steer',
    (type) => {
      const steer: PendingSteer = {
        steerId: 's1',
        text: 'see attached',
        status: 'pending',
        createdAt: 1,
        files: [{ file_id: 'f1', filename: 'notes.pdf', type }],
      };
      const rendered = renderSteers([steer]);

      mockFileMap = { f1: { llmDeliveryPath: 'text' } };
      rendered.rerender(steersElement([steer]));

      fireEvent.click(screen.getByTestId('steer-file'));
      expect(screen.getByTestId('steer-file-preview')).toHaveAttribute(
        'data-delivery-path',
        'text',
      );
    },
  );

  it('renders markdown the same way the applied part will, so text does not reflow on apply', () => {
    renderSteers([{ steerId: 's1', text: '**bold** steer', status: 'pending', createdAt: 1 }], {
      enableUserMsgMarkdown: true,
    });
    expect(screen.getByTestId('steer-markdown')).toHaveTextContent('**bold** steer');
  });

  it('disables code execution: the bubble has no message/part for Run Code to target', () => {
    renderSteers([{ steerId: 's1', text: '```js\nrun()\n```', status: 'pending', createdAt: 1 }], {
      enableUserMsgMarkdown: true,
    });
    // This component renders outside MessageContext, so an executable code
    // block would fire the tool mutation with no messageId/conversationId.
    expect(screen.getByTestId('steer-markdown')).toHaveAttribute('data-code-execution', 'false');
  });

  it('keeps the newest steer in view when the capped stack overflows', () => {
    // jsdom does no layout, so scrollHeight is 0 unless stubbed — without it
    // the assertion would pass vacuously against a scrollTop of 0.
    const scrollHeight = jest
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(600);
    try {
      const { rerender } = renderSteers([
        { steerId: 's1', text: 'first', status: 'pending', createdAt: 1 },
      ]);
      // A newly submitted steer appends BELOW the existing ones, so a stack
      // left scrolled to the top would hide it and its cancel control.
      rerender(
        <RecoilRoot
          initializeState={({ set }) => {
            set(store.pendingSteersByConvoId(CONVO_ID), [
              { steerId: 's1', text: 'first', status: 'pending', createdAt: 1 },
              { steerId: 's2', text: 'just submitted', status: 'pending', createdAt: 2 },
            ]);
          }}
        >
          <InFlightSteers
            conversationId={CONVO_ID}
            steering={steeringStub()}
            onRestoreToComposer={mockRestoreToComposer}
          />
        </RecoilRoot>,
      );
      expect(screen.getByTestId('in-flight-steers').scrollTop).toBe(600);
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('caps the stack so a long steer cannot push the composer off-screen', () => {
    renderSteers([{ steerId: 's1', text: 'x'.repeat(4000), status: 'pending', createdAt: 1 }]);
    // A steer runs to 16k chars, and a run takes up to 10 of them.
    const stack = screen.getByTestId('in-flight-steers');
    expect(stack.className).toContain('max-h-[35vh]');
    expect(stack.className).toContain('overflow-y-auto');
  });

  it('renders raw text when user-message markdown is off', () => {
    renderSteers([{ steerId: 's1', text: '**bold** steer', status: 'pending', createdAt: 1 }], {
      enableUserMsgMarkdown: false,
    });
    expect(screen.queryByTestId('steer-markdown')).toBeNull();
    expect(screen.getByText('**bold** steer')).toBeInTheDocument();
  });

  it('hugs the composer edge instead of a narrower cap of its own', () => {
    renderSteers([{ steerId: 's1', text: 'flush right', status: 'pending', createdAt: 1 }]);
    const stack = screen.getByTestId('in-flight-steers');
    // `inset-x-0` inherits the composer's width, so the stack ends where the
    // composer ends at every desktop width. A cap of its own (the old
    // `max-w-3xl`) drifts inboard the moment the composer is wider —
    // `xl:max-w-4xl`, or maximized chat space.
    expect(stack.className).toContain('inset-x-0');
    expect(stack.className).toContain('items-end');
    expect(stack.className).not.toMatch(/\bmax-w-/);
  });

  it('floats the stack over the thread instead of displacing it', () => {
    // Anchored above the composer and pulled out of flow so the messages keep
    // their full height and slide behind it when the user scrolls up.
    renderSteers([{ steerId: 's1', text: 'scroll behind me', status: 'pending', createdAt: 1 }]);
    const stack = screen.getByTestId('in-flight-steers');
    expect(stack.className).toContain('absolute');
    expect(stack.className).toContain('bottom-full');
    // Wheeling over the gaps must reach the messages behind; bubbles opt back in.
    expect(stack.className).toContain('pointer-events-none');
    expect(screen.getByTestId('in-flight-steer').className).toContain('pointer-events-auto');
  });

  it('offers show more for a long steer and expands it in place', () => {
    // jsdom does no layout, so stub scrollHeight above the collapse cap (128px)
    // to make the content read as overflowing.
    const scrollHeight = jest
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(500);
    try {
      renderSteers([
        { steerId: 's1', text: 'paragraph\n\n'.repeat(20), status: 'pending', createdAt: 1 },
      ]);
      const toggle = screen.getByRole('button', { name: 'com_ui_show_more' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle.querySelector('[data-icon="chevron-down"]')).not.toBeNull();
      fireEvent.click(toggle);
      const collapse = screen.getByRole('button', { name: 'com_ui_show_less' });
      expect(collapse).toHaveAttribute('aria-expanded', 'true');
      expect(collapse.querySelector('[data-icon="chevron-up"]')).not.toBeNull();
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('does not offer a toggle for a steer that fits the preview', () => {
    // Left unstubbed, jsdom scrollHeight is 0, i.e. never overflows.
    renderSteers([{ steerId: 's1', text: 'thank you', status: 'pending', createdAt: 1 }]);
    expect(screen.queryByRole('button', { name: 'com_ui_show_more' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'com_ui_show_less' })).toBeNull();
  });

  it('sticks the options menu so it stays reachable while scrolling long content', () => {
    renderSteers([{ steerId: 's1', text: 'x'.repeat(4000), status: 'pending', createdAt: 1 }]);
    expect(screen.getByTestId('steer-controls').className).toContain('sticky');
  });

  it('publishes its height for the messages to reserve, and clears it on unmount', () => {
    // The overlay no longer takes layout space, so it hands its measured height
    // to `steerOverlayHeightFamily`; `MessagesView` reserves an equal band of
    // bottom padding so the newest message rests clear of it.
    const jotaiStore = getDefaultStore();
    const offsetHeight = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(96);
    try {
      const { unmount } = renderSteers([
        { steerId: 's1', text: 'reserve for me', status: 'pending', createdAt: 1 },
      ]);
      expect(jotaiStore.get(steerOverlayHeightFamily(CONVO_ID))).toBe(96);
      unmount();
      expect(jotaiStore.get(steerOverlayHeightFamily(CONVO_ID))).toBe(0);
    } finally {
      offsetHeight.mockRestore();
    }
  });
});

/**
 * The bubble's "Interrupt now" escalation is ONE atomic server op: `preempt`
 * flips on the existing queued item, so its FIFO position, id, and timestamp
 * survive and no reclaim window exists to race. `armed: false` is the honest
 * answer for every "too late" interleaving (drained, cancelled, run ended or
 * replaced) and for a deployment that cannot seal mid-stream.
 */
describe('InFlightSteers — interrupt-now escalation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockArmMutateAsync.mockReset();
    mockCancelMutateAsync.mockResolvedValue({ removed: true });
    mockArmMutateAsync.mockResolvedValue({ armed: true, generationProtocolVersion: 2 });
    mockRestoreToComposer.mockReturnValue(true);
    act(() => {
      getDefaultStore().set(escalatingSteerFamily(CONVO_ID), false);
    });
  });

  it("arms the interrupt in place, keeping the steer's id and position", async () => {
    renderSteers([{ steerId: 's1', text: 'hold on', status: 'pending', createdAt: 1 }]);
    const armButton = screen.getByTestId('steer-escalate-now');
    act(() => armButton.focus());
    await act(async () => {
      fireEvent.click(armButton);
    });

    expect(mockArmMutateAsync).toHaveBeenCalledWith({
      conversationId: CONVO_ID,
      steerId: 's1',
      generationCreatedAt: 41,
    });
    /** No cancel, no resubmission: the durable item never left the queue. */
    expect(mockCancelMutateAsync).not.toHaveBeenCalled();
    expect(mockRetrySteer).not.toHaveBeenCalled();
    expect(screen.getByText('hold on')).toBeInTheDocument();

    /** The chip relabelled in place: an interrupting steer offers no further
     *  escalation, so its arrow control is gone. */
    expect(screen.queryByTestId('steer-escalate-now')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('com_ui_more_options'));
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_steer_in_flight_preempt');
    // Preempting steers use ZapOff; non-preempt uses Zap.
    expect(
      screen.getByTestId('in-flight-steer').querySelector('[data-icon="zap-off"]'),
    ).not.toBeNull();
  });

  it('flips the receipt to interrupting on the click, confirming its check only on the ACK', async () => {
    let resolveArm: (value: unknown) => void = () => {};
    mockArmMutateAsync.mockReturnValue(
      new Promise((resolve) => {
        resolveArm = resolve;
      }),
    );
    renderSteers([{ steerId: 's1', text: 'hold on', status: 'pending', createdAt: 1 }]);
    expect(screen.getByTestId('steer-receipt')).toHaveAttribute('data-receipt-state', 'delivered');

    fireEvent.click(screen.getByTestId('steer-escalate-now'));
    // The silent round trip is what reads as broken: the label and pulse react
    // on the click, while the check waits for the confirmed durable arm.
    const receipt = screen.getByTestId('steer-receipt');
    expect(receipt).toHaveAttribute('data-receipt-state', 'interrupting');
    expect(receipt.querySelector('svg')).toBeNull();

    await act(async () => {
      resolveArm({ armed: true, generationProtocolVersion: 2, preemptRevision: 1 });
    });
    expect(receipt).toHaveAttribute('data-receipt-state', 'interrupting');
    expect(receipt.querySelector('svg')).not.toBeNull();
  });

  it('returns the receipt to delivered when the arm loses its race', async () => {
    mockArmMutateAsync.mockResolvedValue({ armed: false, generationProtocolVersion: 2 });
    renderSteers([{ steerId: 's1', text: 'hold on', status: 'pending', createdAt: 1 }]);

    await act(async () => {
      fireEvent.click(screen.getByTestId('steer-escalate-now'));
    });
    expect(screen.getByTestId('steer-receipt')).toHaveAttribute('data-receipt-state', 'delivered');
  });

  it('names each escalation control with the message it will interrupt for', () => {
    renderSteers([
      { steerId: 's1', text: 'correct the city', status: 'pending', createdAt: 1 },
      { steerId: 's2', text: 'use metric units', status: 'pending', createdAt: 2 },
    ]);

    expect(
      screen.getByRole('button', {
        name: 'com_ui_interrupt_steer_now: correct the city',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'com_ui_interrupt_steer_now: use metric units',
      }),
    ).toBeInTheDocument();
  });

  it('bounds and normalizes the message suffix in an escalation control name', () => {
    renderSteers([
      {
        steerId: 's-long-label',
        text: `  one   two\n${'x'.repeat(100)}  `,
        status: 'pending',
        createdAt: 1,
      },
    ]);

    expect(screen.getByTestId('steer-escalate-now')).toHaveAccessibleName(
      `com_ui_interrupt_steer_now: one two ${'x'.repeat(71)}…`,
    );
  });

  it('fences escalation to the generation recorded on the steer', async () => {
    renderSteers(
      [
        {
          steerId: 's-epoch',
          text: 'old generation steer',
          status: 'pending',
          createdAt: 1,
          generationCreatedAt: 41,
        },
      ],
      { activeGenerationCreatedAt: 99 },
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('steer-escalate-now'));
    });

    expect(mockArmMutateAsync).toHaveBeenCalledWith({
      conversationId: CONVO_ID,
      steerId: 's-epoch',
      generationCreatedAt: 41,
    });
  });

  it('does not arm an interrupt before any generation epoch is known', async () => {
    renderSteers(
      [{ steerId: 's-no-epoch', text: 'wait for start', status: 'pending', createdAt: 1 }],
      { activeGenerationCreatedAt: null },
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('steer-escalate-now'));
    });

    expect(mockArmMutateAsync).not.toHaveBeenCalled();
  });

  it('does not offer escalation on a steer that is already interrupting', async () => {
    renderSteers([
      { steerId: 's1', text: 'already sealing', status: 'pending', createdAt: 1, preempt: true },
    ]);
    expect(screen.queryByTestId('steer-escalate-now')).toBeNull();
    fireEvent.click(screen.getByLabelText('com_ui_more_options'));
    expect(await screen.findByText('com_ui_steer_cancel')).toBeInTheDocument();
  });

  it('keeps the chip an ordinary steer when the deployment cannot seal', async () => {
    mockArmMutateAsync.mockResolvedValue({
      armed: false,
      code: 'PREEMPT_UNSUPPORTED',
      generationProtocolVersion: 2,
    });
    renderSteers([{ steerId: 's1', text: 'no seal here', status: 'pending', createdAt: 1 }]);
    await act(async () => {
      fireEvent.click(screen.getByTestId('steer-escalate-now'));
    });

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_steer_preempt_unsupported' }),
    );
    /** Still an ordinary steer: escalation stays offered. */
    expect(screen.getByTestId('steer-escalate-now')).toBeEnabled();
  });

  it('stays neutral when the arm loses its race, whatever the reason', async () => {
    /** `armed: false` covers injected, cancelled, re-homed, and run-over
     *  alike, so the toast must not claim one specific outcome. */
    mockArmMutateAsync.mockResolvedValue({ armed: false, generationProtocolVersion: 2 });
    renderSteers([{ steerId: 's1', text: 'too late', status: 'pending', createdAt: 1 }]);
    await act(async () => {
      fireEvent.click(screen.getByTestId('steer-escalate-now'));
    });

    expect(mockRetrySteer).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_steer_arm_lost_race' }),
    );
  });

  it('retries an indeterminate arm and relabels after confirmation', async () => {
    mockArmMutateAsync
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ armed: true, generationProtocolVersion: 2 });
    renderSteers([{ steerId: 's1', text: 'still queued', status: 'pending', createdAt: 1 }]);
    await act(async () => {
      fireEvent.click(screen.getByTestId('steer-escalate-now'));
    });

    expect(mockArmMutateAsync).toHaveBeenCalledTimes(2);
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(screen.queryByTestId('steer-escalate-now')).toBeNull();
  });

  it.each([400, 403, 409])('does not retry a definitive HTTP %s rejection', async (status) => {
    mockArmMutateAsync.mockRejectedValue({
      response: { status, data: { code: 'RUN_PAUSED' } },
    });
    renderSteers([{ steerId: 's1', text: 'pause conflict', status: 'pending', createdAt: 1 }]);

    await act(async () => {
      fireEvent.click(screen.getByTestId('steer-escalate-now'));
    });

    expect(mockArmMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_steer_arm_lost_race',
      status: 'info',
    });
  });

  it('does not automatically retry an indeterminate arm on protocol v1', async () => {
    mockArmMutateAsync.mockRejectedValue(new Error('response lost'));
    renderSteers([{ steerId: 's1', text: 'legacy arm', status: 'pending', createdAt: 1 }], {
      activeGenerationProtocolVersion: 1,
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('steer-escalate-now'));
    });

    expect(mockArmMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_steer_arm_unconfirmed', status: 'warning' }),
    );
  });

  it('reports an indeterminate result after two transport failures', async () => {
    mockArmMutateAsync.mockRejectedValue(new Error('network'));
    renderSteers([{ steerId: 's1', text: 'status unknown', status: 'pending', createdAt: 1 }]);
    await act(async () => {
      fireEvent.click(screen.getByTestId('steer-escalate-now'));
    });

    expect(mockArmMutateAsync).toHaveBeenCalledTimes(2);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_steer_arm_unconfirmed', status: 'warning' }),
    );
    expect(screen.getByText('status unknown')).toBeInTheDocument();
  });

  it('keeps a rejected-then-missing retry indeterminate', async () => {
    mockArmMutateAsync
      .mockRejectedValueOnce(new Error('response lost after commit'))
      .mockResolvedValueOnce({ armed: false, generationProtocolVersion: 2 });
    renderSteers([{ steerId: 's1', text: 'possibly armed', status: 'pending', createdAt: 1 }]);
    await act(async () => {
      fireEvent.click(screen.getByTestId('steer-escalate-now'));
    });

    expect(mockArmMutateAsync).toHaveBeenCalledTimes(2);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_steer_arm_unconfirmed', status: 'warning' }),
    );
    expect(screen.getByText('possibly armed')).toBeInTheDocument();
  });

  it('locks every escalation control while an arm request is in flight', async () => {
    /** The chip-derived gate cannot see an arm until its response lands, so
     *  the flag flips synchronously at click — otherwise two bubbles could
     *  both arm on a slow connection, belying the disabled controls. */
    let resolveArm: (value: {
      armed: boolean;
      generationProtocolVersion: number;
    }) => void = () => {};
    mockArmMutateAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveArm = resolve;
        }),
    );
    renderSteers([
      { steerId: 's1', text: 'first', status: 'pending', createdAt: 1 },
      { steerId: 's2', text: 'second', status: 'pending', createdAt: 2 },
    ]);
    const buttons = screen.getAllByTestId('steer-escalate-now');
    fireEvent.click(buttons[0]);

    expect(buttons[1]).toBeDisabled();
    await act(async () => {
      fireEvent.click(buttons[1]);
    });

    await act(async () => {
      resolveArm({ armed: true, generationProtocolVersion: 2 });
    });
    expect(mockArmMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockArmMutateAsync).toHaveBeenCalledWith({
      conversationId: CONVO_ID,
      steerId: 's1',
      generationCreatedAt: 41,
    });
  });

  it('warns and unlocks when arm confirmation never settles', async () => {
    jest.useFakeTimers();
    try {
      mockArmMutateAsync.mockImplementation(() => new Promise(() => undefined));
      renderSteers([
        { steerId: 's1', text: 'stalled arm', status: 'pending', createdAt: 1 },
        { steerId: 's2', text: 'still available later', status: 'pending', createdAt: 2 },
      ]);
      const buttons = screen.getAllByTestId('steer-escalate-now');
      fireEvent.click(buttons[0]);
      expect(buttons[1]).toBeDisabled();

      await act(async () => {
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
      });

      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'com_ui_steer_arm_unconfirmed', status: 'warning' }),
      );
      expect(buttons[1]).not.toBeDisabled();
      expect(mockArmMutateAsync).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('disables escalation on every bubble while an interrupt is unresolved', async () => {
    renderSteers([
      { steerId: 's1', text: 'plain steer', status: 'pending', createdAt: 1 },
      { steerId: 's2', text: 'sealing now', status: 'pending', createdAt: 2, preempt: true },
    ]);
    const button = screen.getByTestId('steer-escalate-now');
    expect(button).toBeDisabled();

    await act(async () => {
      fireEvent.click(button);
    });
    expect(mockArmMutateAsync).not.toHaveBeenCalled();
  });
});

/**
 * Answer mode (`ask_user_question`) sets `duringRunActive` false while
 * `pausedOnApproval` stays false (it only detects approval-bearing tool
 * calls). The entry disables there as a UX gate; the server-side arm is the
 * correctness backstop for states the client cannot see.
 */
describe('InFlightSteers — escalation while the run cannot accept a steer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockArmMutateAsync.mockResolvedValue({ armed: true, generationProtocolVersion: 2 });
  });

  it('disables escalation in answer mode', async () => {
    renderSteers([{ steerId: 's1', text: 'waiting', status: 'pending', createdAt: 1 }], {
      duringRunActive: false,
    });
    const button = screen.getByTestId('steer-escalate-now');
    expect(button).toBeDisabled();

    await act(async () => {
      fireEvent.click(button);
    });
    expect(mockArmMutateAsync).not.toHaveBeenCalled();
  });
});

/**
 * One-off message actions and sticky behavior changes must never read as the
 * same kind of choice: actions first (edit, cancel, queue), then a separated
 * "Preferences" section holding the two mode toggles. Escalation is not a
 * menu entry at all — it has its own always-visible arrow control.
 */
describe('InFlightSteers — menu structure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCancelMutateAsync.mockResolvedValue({ removed: true });
  });

  it('orders actions above a separated Preferences section, with no escalation entry', async () => {
    renderSteers([{ steerId: 's1', text: 'structured', status: 'pending', createdAt: 1 }]);
    fireEvent.click(screen.getByLabelText('com_ui_more_options'));
    await screen.findByText('com_ui_edit_message');

    const items = screen
      .getAllByRole('menuitem')
      .filter((item) => !item.getAttribute('aria-label')?.startsWith('com_ui_more_info:'))
      .map((item) => item.textContent);
    expect(items).toEqual([
      'com_ui_edit_message',
      'com_ui_steer_cancel',
      'com_ui_convert_to_queue',
      'com_ui_turn_on_queueing',
      'com_ui_always_interrupt',
    ]);
    const preferences = screen.getByRole('group', { name: 'com_ui_preferences' });
    expect(preferences).toContainElement(
      screen.getByRole('menuitem', { name: 'com_ui_turn_on_queueing' }),
    );
    expect(preferences).toContainElement(
      screen.getByRole('menuitem', { name: 'com_ui_always_interrupt' }),
    );
    expect(screen.queryByRole('menuitem', { name: 'com_ui_interrupt_steer_now' })).toBeNull();
  });
});

describe('InFlightSteers delivery receipts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('labels a sending steer with the muted in-progress state and no check', () => {
    renderSteers([{ steerId: 'local-1', text: 'still posting', status: 'sending', createdAt: 1 }]);
    const receipt = screen.getByTestId('steer-receipt');
    expect(receipt).toHaveAttribute('data-receipt-state', 'sending');
    expect(receipt).toHaveTextContent('com_ui_steer_sending');
    expect(receipt.querySelector('svg')).toBeNull();
  });

  it('shows the delivered check once the server durably queued the steer', () => {
    renderSteers([{ steerId: 's-ack', text: 'waiting', status: 'pending', createdAt: 1 }]);
    const receipt = screen.getByTestId('steer-receipt');
    expect(receipt).toHaveAttribute('data-receipt-state', 'delivered');
    expect(receipt.querySelector('svg')).not.toBeNull();
    expect(screen.getByLabelText('com_ui_steer_delivered_info')).toBeInTheDocument();
  });

  it('relabels to the interrupting state when the steer is armed to preempt', () => {
    renderSteers([
      { steerId: 's-armed', text: 'stop now', status: 'pending', createdAt: 1, preempt: true },
    ]);
    const receipt = screen.getByTestId('steer-receipt');
    expect(receipt).toHaveAttribute('data-receipt-state', 'interrupting');
    // A confirmed arm keeps its check alongside the pulsing dot.
    expect(receipt.querySelector('svg')).not.toBeNull();
    expect(screen.getByLabelText('com_ui_steer_interrupting_info')).toBeInTheDocument();
  });

  it('shows interrupting without a check while the preempting POST is unacknowledged', () => {
    renderSteers([
      { steerId: 'local-2', text: 'stop', status: 'sending', createdAt: 1, preempt: true },
    ]);
    const receipt = screen.getByTestId('steer-receipt');
    expect(receipt).toHaveAttribute('data-receipt-state', 'interrupting');
    // The label and pulse react instantly; the check waits for the 202.
    expect(receipt.querySelector('svg')).toBeNull();
  });

  it('honors an SSE-delivered preempt confirmation while the arm response is still pending', async () => {
    mockArmMutateAsync.mockReturnValue(new Promise(() => {}));
    renderSteers([{ steerId: 's1', text: 'hold on', status: 'pending', createdAt: 1 }]);
    fireEvent.click(screen.getByTestId('steer-escalate-now'));
    expect(screen.getByTestId('steer-receipt').querySelector('svg')).toBeNull();

    // steer_updated relabels the chip before the arm HTTP response returns:
    // that IS durable confirmation, and the check must not wait out the
    // round-trip timeout.
    await act(async () => {
      setSteersForTest((prev) =>
        prev.map((steer) => ({ ...steer, preempt: true, preemptRevision: 1 })),
      );
    });
    const receipt = screen.getByTestId('steer-receipt');
    expect(receipt).toHaveAttribute('data-receipt-state', 'interrupting');
    expect(receipt.querySelector('svg')).not.toBeNull();
  });

  it('announces receipt transitions through the polite live region', async () => {
    renderSteers([{ steerId: 's1', text: 'hold on', status: 'sending', createdAt: 1 }]);
    // Mount state is not replayed: the region starts empty.
    expect(screen.getByRole('status')).toHaveTextContent('');

    await act(async () => {
      setSteersForTest((prev) => prev.map((steer) => ({ ...steer, status: 'pending' as const })));
    });
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_steer_delivered');
  });
});
