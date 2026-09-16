import React from 'react';
import { DndProvider } from 'react-dnd';
import { getDefaultStore } from 'jotai';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { ReasoningEffort } from 'librechat-data-provider';
import { act, render, screen, within, fireEvent } from '@testing-library/react';
import type { SteeringControls } from '~/hooks/Chat/useSteering';
import type { QueuedMessage } from '~/store/families';
import { hasQueuedIntent, releaseQueuedIntent } from '~/utils/queueIntent';
import Queue from '../Queue';
import store from '~/store';
import { revealedQueuedTurnFamily } from '~/store/steer';
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, string | number>) => {
    if (!options) {
      return key;
    }
    const value = options.count ?? options['0'];
    return `${key}:${value}`;
  },
}));

const mockShowToast = jest.fn();
jest.mock('@librechat/client', () => {
  const ReactActual = jest.requireActual('react') as typeof React;
  const IconButton = ReactActual.forwardRef(
    (
      {
        label,
        children,
        ...props
      }: { label?: string; children?: React.ReactNode } & Record<string, unknown>,
      ref: React.Ref<HTMLButtonElement>,
    ) =>
      ReactActual.createElement(
        'button',
        { ...props, ref, type: 'button', 'aria-label': label },
        children,
      ),
  );
  IconButton.displayName = 'IconButton';
  return {
    Button: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
      ReactActual.createElement('button', { type: 'button', ...props }, children),
    IconButton,
    TooltipAnchor: ({
      children,
      ...props
    }: { children?: React.ReactNode } & Record<string, unknown>) =>
      ReactActual.createElement('span', props, children),
    useMediaQuery: () => true,
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

const CONVO_ID = 'convo-1';
const mockSendQueuedNow = jest.fn();
const mockRemoveQueued = jest.fn();
const mockReorderQueued = jest.fn();
const mockRestoreQueuedOrder = jest.fn();
const mockDiscardQueued = jest.fn().mockResolvedValue(true);
const mockRewakeDrain = jest.fn();

/** Only what the rail reads, filled out against the real type so a change to
 *  the contract breaks compilation rather than passing quietly. */
const steeringWith = (over: Partial<SteeringControls> = {}): SteeringControls =>
  ({
    queueKey: CONVO_ID,
    duringRunActive: true,
    canSteer: true,
    canSendQueuedNow: true,
    sendQueuedNow: mockSendQueuedNow,
    removeQueued: mockRemoveQueued,
    reorderQueued: mockReorderQueued,
    restoreQueuedOrder: mockRestoreQueuedOrder,
    discardQueued: mockDiscardQueued,
    rewakeDrain: mockRewakeDrain,
    ...over,
  }) as SteeringControls;

const steering = steeringWith();
const pausedSteering = steeringWith({ canSteer: false, canSendQueuedNow: false });
/** Paused on a tool approval: steering is unavailable, but the escalation
 *  control stays visible-and-disabled rather than vanishing mid-pause. */
const approvalPausedSteering = steeringWith({
  canSteer: false,
  canSendQueuedNow: false,
  pausedOnApproval: true,
});

const queued = (over: Partial<QueuedMessage> = {}): QueuedMessage =>
  ({
    id: 'q1',
    text: 'follow up on this',
    files: [],
    quotes: [],
    manualSkills: [],
    ...over,
  }) as QueuedMessage;

function renderQueue(
  items: QueuedMessage[],
  steeringOverride: SteeringControls = steering,
  handlers: {
    onEditToComposer?: jest.Mock;
    onRestoreToComposer?: jest.Mock;
  } = {},
) {
  return render(
    <RecoilRoot initializeState={({ set }) => set(store.queuedMessagesByConvoId(CONVO_ID), items)}>
      {/* Mirrors `App`, which mounts the provider around the whole tree. */}
      <DndProvider backend={HTML5Backend}>
        <Queue
          steering={steeringOverride}
          conversationId={CONVO_ID}
          onRestoreToComposer={
            handlers.onRestoreToComposer ?? handlers.onEditToComposer ?? jest.fn()
          }
        />
      </DndProvider>
    </RecoilRoot>,
  );
}

describe('Queue', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders nothing when the queue is empty', () => {
    const { container } = renderQueue([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a row per queued message with every action visible, none behind a menu', () => {
    renderQueue([queued({ id: 'q1' }), queued({ id: 'q2' })]);
    const rows = screen.getAllByTestId('queued-message-row');
    expect(rows).toHaveLength(2);

    const firstRow = within(rows[0]);
    expect(firstRow.getByText('com_ui_send_now')).toBeInTheDocument();
    expect(firstRow.getByTestId('queued-interrupt-now')).toBeInTheDocument();
    expect(firstRow.getByLabelText('com_ui_edit_message')).toBeInTheDocument();
    expect(firstRow.getByLabelText('com_ui_remove_queued')).toBeInTheDocument();
    expect(firstRow.queryByLabelText('com_ui_more_options')).not.toBeInTheDocument();
  });

  it('sends the row that was clicked, not the first one', () => {
    renderQueue([queued({ id: 'q1' }), queued({ id: 'q2', text: 'the second one' })]);
    fireEvent.click(screen.getAllByText('com_ui_send_now')[1]);
    expect(mockSendQueuedNow).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'q2', text: 'the second one' }),
    );
  });

  it('disables send now while the run is paused on approval', () => {
    renderQueue([queued()], pausedSteering);
    const sendButton = screen.getByText('com_ui_send_now');
    expect(sendButton).toBeDisabled();
    expect(sendButton).toHaveAttribute('title', 'com_ui_send_now_paused');

    fireEvent.click(sendButton);
    expect(mockSendQueuedNow).not.toHaveBeenCalled();
  });

  /* Answer mode (and Assistants still generating) leave duringRunActive false
     while isSubmitting is true; sendQueuedNow would no-op, so the control must
     not look actionable. */
  it('disables send now when no immediate send route exists', () => {
    renderQueue(
      [queued()],
      steeringWith({ duringRunActive: false, canSteer: false, canSendQueuedNow: false }),
    );
    const sendButton = screen.getByText('com_ui_send_now');
    expect(sendButton).toBeDisabled();
    fireEvent.click(sendButton);
    expect(mockSendQueuedNow).not.toHaveBeenCalled();
  });

  it('disables send now for a receipt-bound recovery during a live run', () => {
    renderQueue([queued({ recoverySteerId: 'srv-1' })]);
    const sendButton = screen.getByText('com_ui_send_now');

    expect(sendButton).toBeDisabled();
    fireEvent.click(sendButton);
    expect(mockSendQueuedNow).not.toHaveBeenCalled();
  });

  it.each([
    ['local', {}],
    ['server-owned', { server: { id: 'server-q1', status: 'queued' as const, revision: 1 } }],
  ])('disables live actions for a reasoning override on a %s row', (_kind, row) => {
    renderQueue([
      queued({
        ...row,
        reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
      }),
    ]);
    const sendButton = screen.getByText('com_ui_send_now');
    const interruptButton = screen.getByTestId('queued-interrupt-now');

    expect(sendButton).toBeDisabled();
    expect(interruptButton).toBeDisabled();
    expect(sendButton).toHaveAttribute('title', 'com_ui_send_now_paused');
    fireEvent.click(sendButton);
    fireEvent.click(interruptButton);
    expect(mockSendQueuedNow).not.toHaveBeenCalled();
  });

  it('allows a reasoning override to start a new generation while idle', () => {
    renderQueue(
      [
        queued({
          reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
        }),
      ],
      steeringWith({ duringRunActive: false, canSteer: false, canSendQueuedNow: true }),
    );
    const sendButton = screen.getByText('com_ui_send_now');

    expect(sendButton).toBeEnabled();
    fireEvent.click(sendButton);
    expect(mockSendQueuedNow).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
      }),
    );
  });

  it('moves a message down the queue with the arrow keys', () => {
    renderQueue([queued({ id: 'q1' }), queued({ id: 'q2' })]);
    const grips = screen.getAllByTestId('queued-message-grip');

    fireEvent.keyDown(grips[0], { key: 'ArrowDown' });
    expect(mockReorderQueued).toHaveBeenCalledWith('q1', 1);

    fireEvent.keyDown(grips[1], { key: 'ArrowUp' });
    expect(mockReorderQueued).toHaveBeenCalledWith('q2', 0);
  });

  it('refuses to move a message past either end of the queue', () => {
    renderQueue([queued({ id: 'q1' }), queued({ id: 'q2' })]);
    const grips = screen.getAllByTestId('queued-message-grip');

    fireEvent.keyDown(grips[0], { key: 'ArrowUp' });
    fireEvent.keyDown(grips[1], { key: 'ArrowDown' });
    expect(mockReorderQueued).not.toHaveBeenCalled();
  });

  it('announces where a moved message landed', () => {
    renderQueue([queued({ id: 'q1' }), queued({ id: 'q2' })]);
    fireEvent.keyDown(screen.getAllByTestId('queued-message-grip')[0], { key: 'ArrowDown' });
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_queue_moved:2');
  });

  /* Swapping the handle out from under a keyboard user is how focus gets
     dropped to the top of the page when a drain shrinks the queue. */
  it('keeps the handle when the only message has nowhere to go, and refuses to move it', () => {
    renderQueue([queued()]);
    const grip = screen.getByTestId('queued-message-grip');
    expect(grip).toHaveAttribute('aria-disabled', 'true');

    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    expect(mockReorderQueued).not.toHaveBeenCalled();
  });

  it('keeps the live region and the hint out of the list itself', () => {
    renderQueue([queued({ id: 'q1' }), queued({ id: 'q2' })]);
    const list = screen.getByTestId('composer-queue');
    expect(within(list).queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    /* Every child of the list is one of its items. */
    for (const child of Array.from(list.children)) {
      expect(child).toHaveAttribute('role', 'listitem');
    }
  });

  it('returns a trashed message to the composer before dropping it', async () => {
    const onRestore = jest.fn().mockReturnValue(true);
    renderQueue(
      [
        queued({
          id: 'q1',
          files: [{ file_id: 'f1' }] as never,
          reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
        }),
      ],
      steering,
      { onRestoreToComposer: onRestore },
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('com_ui_remove_queued'));
    });
    expect(onRestore).toHaveBeenCalledWith(
      'follow up on this',
      [{ file_id: 'f1' }],
      {
        quotes: [],
        manualSkills: [],
        reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
      },
      CONVO_ID,
    );
    expect(mockRemoveQueued).toHaveBeenCalledWith('q1');
  });

  /* The composer refuses when it is occupied or the user has moved on. Dropping
     the message anyway is the only path here that can destroy text outright. */
  it('keeps the message queued when the composer refuses to take it back', async () => {
    const onRestore = jest.fn().mockReturnValue(false);
    renderQueue([queued({ id: 'q1' })], steering, { onRestoreToComposer: onRestore });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('com_ui_remove_queued'));
    });
    expect(onRestore).toHaveBeenCalled();
    expect(mockRemoveQueued).not.toHaveBeenCalled();
    /* Keeping the words is right; saying nothing about it is not. Without this
       the row simply does not react and the button reads as broken. */
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_queue_remove_blocked' }),
    );
    /* A run end that landed while this row was claimed had no unclaimed row to
       drain and spent its one-shot signal. The row is back in the queue, so a
       signal has to go back with it or these words wait for another run. */
    expect(mockRewakeDrain).toHaveBeenCalledWith(CONVO_ID);
  });

  it('hands the whole message to the composer to edit', async () => {
    const onEdit = jest.fn().mockReturnValue(true);
    renderQueue(
      [
        queued({
          id: 'q1',
          quotes: ['a quote'],
          manualSkills: ['writer'],
          reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
        }),
      ],
      steering,
      { onEditToComposer: onEdit },
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('com_ui_edit_message'));
    });
    expect(onEdit).toHaveBeenCalledWith(
      'follow up on this',
      [],
      {
        quotes: ['a quote'],
        manualSkills: ['writer'],
        reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
      },
      CONVO_ID,
    );
    expect(mockRemoveQueued).toHaveBeenCalledWith('q1');
  });

  /* Edit used to drop the row first and hand the words over second, so a
     composer that refuses (a paused question owns it) destroyed the message
     outright. Same restore-then-remove order as the trash. */
  it('keeps the message queued when the composer refuses to take it for editing', async () => {
    const onEdit = jest.fn().mockReturnValue(false);
    renderQueue([queued({ id: 'q1' })], steering, { onEditToComposer: onEdit });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('com_ui_edit_message'));
    });
    expect(onEdit).toHaveBeenCalled();
    expect(mockRemoveQueued).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_queue_edit_blocked' }),
    );
  });

  it('waits for discard before using the conversation-guarded edit restore', async () => {
    let settleDiscard: (value: boolean) => void = () => undefined;
    mockDiscardQueued.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        settleDiscard = resolve;
      }),
    );
    const onRestore = jest.fn().mockReturnValue(true);
    renderQueue([queued({ id: 'q1' })], steering, { onRestoreToComposer: onRestore });

    fireEvent.click(screen.getByLabelText('com_ui_edit_message'));
    expect(onRestore).not.toHaveBeenCalled();

    await act(async () => settleDiscard(true));
    expect(onRestore).toHaveBeenCalledWith(
      'follow up on this',
      [],
      { quotes: [], manualSkills: [] },
      CONVO_ID,
    );
  });

  /* The drain takes the head at run end, and both handoffs above span an await
     before the row is dropped. Claiming the row for the whole handoff is what
     stops the drain sending a message the user is taking back. */
  describe('claiming a row for the handoff', () => {
    afterEach(() => releaseQueuedIntent('q1'));

    it.each(['com_ui_edit_message', 'com_ui_remove_queued'] as const)(
      'holds the row across %s and lets it go afterwards',
      async (label) => {
        let settleDiscard: (value: boolean) => void = () => undefined;
        mockDiscardQueued.mockReturnValueOnce(
          new Promise<boolean>((resolve) => {
            settleDiscard = resolve;
          }),
        );
        renderQueue([queued({ id: 'q1' })], steering, {
          onRestoreToComposer: jest.fn().mockReturnValue(true),
        });

        fireEvent.click(screen.getByLabelText(label));
        expect(hasQueuedIntent('q1')).toBe(true);

        await act(async () => settleDiscard(true));
        expect(hasQueuedIntent('q1')).toBe(false);
        expect(mockRemoveQueued).toHaveBeenCalledWith('q1');
      },
    );

    it('lets the row go when the handoff is refused', async () => {
      renderQueue([queued({ id: 'q1' })], steering, {
        onRestoreToComposer: jest.fn().mockReturnValue(false),
      });
      await act(async () => {
        fireEvent.click(screen.getByLabelText('com_ui_remove_queued'));
      });
      expect(hasQueuedIntent('q1')).toBe(false);
    });
  });

  /* Split view mounts two composers at once. A module-global id duplicated the
     hint element and pointed every handle at whichever copy won. */
  it('scopes the reorder hint to its own rail', () => {
    render(
      <DndProvider backend={HTML5Backend}>
        <RecoilRoot
          initializeState={({ set }) =>
            set(store.queuedMessagesByConvoId(CONVO_ID), [
              queued({ id: 'q1' }),
              queued({ id: 'q2' }),
            ])
          }
        >
          <Queue steering={steering} conversationId={CONVO_ID} onRestoreToComposer={jest.fn()} />
        </RecoilRoot>
        <RecoilRoot
          initializeState={({ set }) =>
            set(store.queuedMessagesByConvoId(CONVO_ID), [
              queued({ id: 'q3' }),
              queued({ id: 'q4' }),
            ])
          }
        >
          <Queue steering={steering} conversationId={CONVO_ID} onRestoreToComposer={jest.fn()} />
        </RecoilRoot>
      </DndProvider>,
    );

    const hints = screen.getAllByText('com_ui_queue_reorder_hint');
    expect(hints).toHaveLength(2);
    expect(hints[0].id).not.toBe(hints[1].id);

    const rails = screen.getAllByTestId('composer-queue');
    for (const [railIndex, rail] of rails.entries()) {
      for (const grip of within(rail).getAllByTestId('queued-message-grip')) {
        expect(grip).toHaveAttribute('aria-describedby', hints[railIndex].id);
      }
    }
  });

  /* The region is removed with the rail and re-inserted with its old text
     still in it, which readers announce on insertion. */
  it('forgets its last announcement once the queue empties', () => {
    let setQueue: (items: QueuedMessage[]) => void = () => undefined;
    const Driver = () => {
      setQueue = useSetRecoilState(store.queuedMessagesByConvoId(CONVO_ID));
      return null;
    };
    render(
      <RecoilRoot
        initializeState={({ set }) =>
          set(store.queuedMessagesByConvoId(CONVO_ID), [queued({ id: 'q1' }), queued({ id: 'q2' })])
        }
      >
        <Driver />
        <DndProvider backend={HTML5Backend}>
          <Queue steering={steering} conversationId={CONVO_ID} onRestoreToComposer={jest.fn()} />
        </DndProvider>
      </RecoilRoot>,
    );

    fireEvent.keyDown(screen.getAllByTestId('queued-message-grip')[0], { key: 'ArrowDown' });
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_queue_moved:2');

    act(() => setQueue([]));
    act(() => setQueue([queued({ id: 'q3', text: 'a new message' })]));
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  /* The rows move as the pointer crosses them, so the queue has already changed
     by the time a drag ends. Only a drag that never landed anywhere puts it
     back; and `didDrop` reports a landing even though the rows declare no
     `drop` handler, which is what makes the plain `hover` sortable work. */
  describe('drag reordering', () => {
    /* The handle only drags on a hover-capable pointer, and the suite's
       `matchMedia` answers `false` to everything, which is the touch device
       the rail deliberately refuses to drag on. */
    const realMatchMedia = window.matchMedia;
    beforeEach(() => {
      window.matchMedia = ((query: string) =>
        ({
          matches: query === '(hover: hover)',
          media: query,
          onchange: null,
          addListener: jest.fn(),
          removeListener: jest.fn(),
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
          dispatchEvent: jest.fn(),
        }) as unknown as MediaQueryList) as typeof window.matchMedia;
    });
    afterEach(() => {
      window.matchMedia = realMatchMedia;
    });

    /* jsdom has no DataTransfer, and the HTML5 backend reads one off every
       event it handles. */
    const dataTransfer = () => ({
      dropEffect: 'move',
      effectAllowed: 'move',
      files: [],
      items: [],
      types: [],
      setData: () => undefined,
      getData: () => '',
      setDragImage: () => undefined,
    });

    const dragFirstRowOntoSecond = (drop: boolean) => {
      renderQueue([queued({ id: 'q1' }), queued({ id: 'q2' })]);
      const grip = screen.getAllByTestId('queued-message-grip')[0];
      const secondRow = screen.getAllByTestId('queued-message-row')[1];
      const dt = dataTransfer();

      fireEvent.dragStart(grip, { dataTransfer: dt });
      fireEvent.dragOver(secondRow, { dataTransfer: dt });
      if (drop) {
        fireEvent.drop(secondRow, { dataTransfer: dt });
      }
      fireEvent.dragEnd(grip, { dataTransfer: dt });
    };

    it('keeps the new order when the drag is dropped on the rail', () => {
      dragFirstRowOntoSecond(true);
      expect(mockRestoreQueuedOrder).not.toHaveBeenCalled();
    });

    it('puts the order back when the drag is abandoned', () => {
      dragFirstRowOntoSecond(false);
      expect(mockRestoreQueuedOrder).toHaveBeenCalledWith(['q1', 'q2']);
    });
  });

  it('shows an attachment count when files ride along', () => {
    renderQueue([queued({ files: [{ file_id: 'f1' }, { file_id: 'f2' }] as never })]);
    const attachmentLabel = screen.getByText('com_ui_attachment_count:2');
    expect(attachmentLabel).toBeInTheDocument();
    expect(attachmentLabel.parentElement).toHaveAttribute(
      'title',
      'com_ui_queued_attachment_count:2',
    );
    expect(attachmentLabel.parentElement).not.toHaveAttribute('aria-label');
    expect(screen.getByText('com_ui_queued_attachment_count:2')).toHaveClass('sr-only');
  });

  it('shows a quoted-excerpt count when quotes ride along', () => {
    renderQueue([queued({ quotes: ['first', 'second'] })]);

    expect(screen.getByText('2')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('com_ui_queued_quote_count:2')).toHaveClass('sr-only');
  });

  it('puts the during-run hint on each queued row', () => {
    renderQueue([queued({ id: 'q1' }), queued({ id: 'q2' })]);

    const rows = screen.getAllByTestId('queued-message-row');
    expect(screen.getAllByRole('img', { name: 'com_ui_steer_queued_info' })).toHaveLength(2);
    rows.forEach((row) => {
      expect(within(row).getByRole('img', { name: 'com_ui_steer_queued_info' })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('queued-caption')).not.toBeInTheDocument();
  });

  it('hides the queued hint after the run ends', () => {
    renderQueue([queued()], steeringWith({ duringRunActive: false }));
    expect(screen.queryByRole('img', { name: 'com_ui_steer_queued_info' })).not.toBeInTheDocument();
  });
  it('reveals an admitted claimed row with only cancellation available', () => {
    const jotaiStore = getDefaultStore();
    jotaiStore.set(revealedQueuedTurnFamily(CONVO_ID), {
      clientRequestId: 'req-1',
      parentMessageId: 'response-1',
      text: 'follow up on this',
      revealedAt: '2024-01-01T00:00:00.000Z',
    });

    try {
      renderQueue(
        [
          queued({
            id: 'q1',
            clientRequestId: 'req-1',
            server: { id: 'server-q1', status: 'claimed' },
          }),
          queued({ id: 'q2' }),
        ],
        steeringWith({ canSendQueuedNow: false, canSteer: false }),
      );

      const firstRow = within(screen.getAllByTestId('queued-message-row')[0]);
      expect(firstRow.getByText('com_ui_queued_turn_starting')).toBeInTheDocument();
      expect(firstRow.queryByText('com_ui_send_now')).not.toBeInTheDocument();
      expect(firstRow.queryByLabelText('com_ui_edit_message')).not.toBeInTheDocument();
      expect(firstRow.getByLabelText('com_ui_remove_queued')).toBeEnabled();
    } finally {
      jotaiStore.set(revealedQueuedTurnFamily(CONVO_ID), null);
    }
  });

  describe('server-owned queue states', () => {
    it.each(['sending', 'claimed', 'uncertain'] as const)(
      'disables local actions while a %s row remains server-owned',
      (status) => {
        renderQueue([queued({ server: { id: 'server-q1', status } })]);

        expect(screen.getByText('com_ui_send_now')).toBeDisabled();
        expect(screen.getByLabelText('com_ui_edit_message')).toBeDisabled();
        expect(screen.getByLabelText('com_ui_remove_queued')).toBeDisabled();
        expect(screen.getByTestId('queued-interrupt-now')).toBeDisabled();
      },
    );

    it('keeps a rejected row actionable and labels its failure', () => {
      renderQueue([queued({ server: { status: 'rejected' } })]);

      expect(screen.getByText('com_ui_queued_turn_failed')).toBeInTheDocument();
      expect(screen.getByText('com_ui_send_now')).toBeEnabled();
      expect(screen.getByLabelText('com_ui_edit_message')).toBeEnabled();
      expect(screen.getByLabelText('com_ui_remove_queued')).toBeEnabled();
    });

    it('keeps an acknowledged queued server row actionable', () => {
      renderQueue([queued({ server: { id: 'server-q1', status: 'queued' } })]);

      expect(screen.getByText('com_ui_send_now')).toBeEnabled();
      expect(screen.getByLabelText('com_ui_edit_message')).toBeEnabled();
      expect(screen.getByLabelText('com_ui_remove_queued')).toBeEnabled();
    });

    it('requires reconciliation and blocks removal for an indeterminate row', () => {
      renderQueue([queued({ server: { id: 'server-q1', status: 'indeterminate' } })]);

      expect(screen.getByText('com_ui_queued_turn_reconciliation_required')).toBeInTheDocument();
      expect(screen.getByText('com_ui_send_now')).toBeDisabled();
      expect(screen.getByLabelText('com_ui_edit_message')).toBeDisabled();
      expect(screen.getByLabelText('com_ui_remove_queued')).toBeDisabled();
    });

    it('dismisses an expired uncertain row without discarding or restoring it', () => {
      const onRestore = jest.fn();
      renderQueue(
        [
          queued({
            server: {
              id: 'server-q1',
              status: 'uncertain',
              reconciliationExpired: true,
            },
          }),
        ],
        steering,
        { onRestoreToComposer: onRestore },
      );

      expect(screen.getByText('com_ui_steer_delivery_unconfirmed')).toBeInTheDocument();
      expect(screen.getByText('com_ui_send_now')).toBeDisabled();
      expect(screen.getByLabelText('com_ui_edit_message')).toBeDisabled();

      fireEvent.click(screen.getByLabelText('com_ui_dismiss_unconfirmed_delivery'));
      expect(mockRemoveQueued).toHaveBeenCalledWith('q1');
      expect(mockDiscardQueued).not.toHaveBeenCalled();
      expect(onRestore).not.toHaveBeenCalled();
    });
  });

  /* Escalation is the only way to make a waiting message interrupt the reply
     rather than wait for its next tool step. Send now sends it as an ordinary
     steer; this sends it as an interrupt. */
  describe('interrupt escalation', () => {
    it('escalates the row that was clicked, as a preempt', () => {
      renderQueue([queued({ id: 'q1' }), queued({ id: 'q2', text: 'the second one' })]);
      fireEvent.click(screen.getAllByTestId('queued-interrupt-now')[1]);
      expect(mockSendQueuedNow).toHaveBeenCalledWith(expect.objectContaining({ id: 'q2' }), {
        preempt: true,
      });
    });

    it('leaves Send now as an ordinary steer', () => {
      renderQueue([queued({ id: 'q1' })]);
      fireEvent.click(screen.getByText('com_ui_send_now'));
      expect(mockSendQueuedNow).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1' }));
    });

    /* Hiding it during the pause is the discoverability gap this button
       closes: the pause is exactly when a user wants to cut the reply short. */
    it('stays visible but disabled while paused on an approval', () => {
      renderQueue([queued()], approvalPausedSteering);
      expect(screen.getByTestId('queued-interrupt-now')).toBeDisabled();
    });

    /* The drain starts the next run before its epoch lands, so a control that
       hid itself here would appear and vanish between queued sends. */
    it('stays visible but disabled before the generation epoch lands', () => {
      renderQueue([queued()], steeringWith({ canSteer: false }));
      expect(screen.getByTestId('queued-interrupt-now')).toBeDisabled();
    });

    it('offers nothing once the run is over', () => {
      renderQueue([queued()], steeringWith({ duringRunActive: false, canSteer: false }));
      expect(screen.queryByTestId('queued-interrupt-now')).not.toBeInTheDocument();
    });

    /* A recovered row is consumed atomically only by a normal generation, so
       escalating it would leave or duplicate its parked server copy. */
    it('offers nothing on a recovered row', () => {
      renderQueue([queued({ recoverySteerId: 'srv-1' })]);
      expect(screen.queryByTestId('queued-interrupt-now')).not.toBeInTheDocument();
    });
  });
});
