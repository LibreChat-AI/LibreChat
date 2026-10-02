import React from 'react';
import { getDefaultStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import type { PendingSteer, QueuedMessage } from '~/store/families';
import type { SteeringControls } from '~/hooks/Chat/useSteering';
import { recoveryDispositionsFamily } from '~/components/Chat/Steering/recovery';
import { escalatingSteerFamily, revealedQueuedTurnFamily } from '~/store/steer';
import PendingSteerChips from '../PendingSteerChips';
import store from '~/store';

const mockRemoveQueued = jest.fn();
const mockDismissRecovery = jest.fn();
const mockDiscardQueued = jest.fn(async (_message: QueuedMessage) => true);
const mockSendQueuedNow = jest.fn();
const mockRetrySteer = jest.fn();
const mockRestoreToComposer = jest.fn(() => true);
const mockEditToComposer = jest.fn();
const mockShowToast = jest.fn();

// SteerMenu (rendered under PendingSteerChips) uses MorphIcon; map icon
// identity so inverted Zap/Clock ternaries fail tests instead of going silent.
jest.mock('@librechat/client', () => {
  const { createSteerMorphIconMock } = jest.requireActual('~/../test/mockMorphIcon');
  return {
    useToastContext: () => ({ showToast: mockShowToast }),
    TooltipAnchor: jest.requireActual('@librechat/client').TooltipAnchor,
    MorphIcon: createSteerMorphIconMock(),
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const CONVO_ID = 'convo-q';
let updateQueueForTest:
  | ((updater: (current: QueuedMessage[]) => QueuedMessage[]) => void)
  | undefined;

function QueueState() {
  const queue = useRecoilValue(store.queuedMessagesByConvoId(CONVO_ID));
  const setQueue = useSetRecoilState(store.queuedMessagesByConvoId(CONVO_ID));
  updateQueueForTest = (updater) => setQueue(updater);
  return <output data-testid="queue-state">{JSON.stringify(queue)}</output>;
}

function PreferenceState() {
  const defaultAction = useRecoilValue(store.duringRunDefaultAction);
  const interrupts = useRecoilValue(store.steerInterruptsByDefault);
  return (
    <>
      <output data-testid="default-action-state">{defaultAction}</output>
      <output data-testid="interrupts-state">{String(interrupts)}</output>
    </>
  );
}

const steeringStub = (overrides: Partial<SteeringControls> = {}) =>
  ({
    queueKey: CONVO_ID,
    defaultAction: 'steer',
    duringRunActive: false,
    canSendQueuedNow: true,
    canSteer: false,
    pausedOnApproval: false,
    removeQueued: mockRemoveQueued,
    discardQueued: mockDiscardQueued,
    dismissRecovery: mockDismissRecovery,
    sendQueuedNow: mockSendQueuedNow,
    retrySteer: mockRetrySteer,
    setDefaultAction: jest.fn(),
    ...overrides,
  }) as unknown as SteeringControls;

function renderChips(
  queued: QueuedMessage[],
  options?: {
    steering?: Partial<SteeringControls>;
    steers?: PendingSteer[];
    interrupts?: boolean;
  },
) {
  return render(
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), queued);
        set(store.duringRunDefaultAction, options?.steering?.defaultAction ?? 'steer');
        set(store.steerInterruptsByDefault, options?.interrupts ?? false);
        if (options?.steers != null) {
          set(store.pendingSteersByConvoId(CONVO_ID), options.steers);
        }
      }}
    >
      <PendingSteerChips
        conversationId={CONVO_ID}
        steering={steeringStub(options?.steering)}
        onEditToComposer={mockEditToComposer}
        onRestoreToComposer={mockRestoreToComposer}
      />
      <PreferenceState />
      <QueueState />
    </RecoilRoot>,
  );
}

describe('PendingSteerChips — ambiguous delivery retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('hides same-id Retry for a legacy ambiguous delivery', () => {
    renderChips([], {
      steers: [
        {
          steerId: 'legacy-uncertain',
          text: 'may already be queued',
          status: 'failed',
          deliveryUncertain: true,
          generationProtocolVersion: 1,
          createdAt: 1,
        },
      ],
    });

    expect(screen.queryByText('com_ui_steer_retry')).toBeNull();
  });

  it('offers same-id Retry only after protocol v2 was negotiated', () => {
    renderChips([], {
      steers: [
        {
          steerId: 'v2-uncertain',
          text: 'dedupe this retry',
          status: 'failed',
          deliveryUncertain: true,
          generationProtocolVersion: 2,
          createdAt: 1,
        },
      ],
    });

    fireEvent.click(screen.getByText('com_ui_steer_retry'));
    expect(mockRetrySteer).toHaveBeenCalledWith(
      'v2-uncertain',
      'dedupe this retry',
      undefined,
      { quotes: undefined, manualSkills: undefined },
      { preempt: false, createdAt: 1, generationProtocolVersion: 2 },
    );
  });

  it('uses semantic destructive roles for a failed steer', () => {
    renderChips([], {
      steers: [
        {
          steerId: 'failed-steer',
          text: 'failed message',
          status: 'failed',
          createdAt: 1,
        },
      ],
    });

    const row = screen.getByTestId('steer-message-row');
    expect(row).toHaveClass('border-border-destructive');
    expect(row.querySelector('svg')).toHaveClass('text-text-destructive');
    expect(screen.getByText('com_ui_steer_failed')).toHaveClass('text-text-destructive');
  });
});

describe('PendingSteerChips — queued primary availability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not offer Send now while answer mode owns the submission slot', () => {
    renderChips([{ id: 'answer-queued', text: 'wait until the answer resumes', createdAt: 1 }], {
      steering: {
        duringRunActive: false,
        canSendQueuedNow: false,
        canSteer: false,
        pausedOnApproval: true,
      },
    });

    expect(screen.queryByText('com_ui_send_now')).toBeNull();
    expect(screen.getByTestId('queued-interrupt-now')).toBeDisabled();
    expect(mockSendQueuedNow).not.toHaveBeenCalled();
  });
});

describe('PendingSteerChips — terminal server state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows a durable rejection as failed work', () => {
    renderChips([
      {
        id: 'rejected-turn',
        text: 'could not be admitted',
        createdAt: 1,
        server: { status: 'rejected', errorCode: 'ADMISSION_FAILED' },
      },
    ]);

    expect(screen.getByText('com_ui_queued_turn_failed')).toBeInTheDocument();
  });

  it('shows indeterminate admission as non-actionable reconciliation work', () => {
    renderChips([
      {
        id: 'indeterminate-turn',
        text: 'external result unknown',
        createdAt: 1,
        server: {
          id: 'server-indeterminate-1',
          status: 'indeterminate',
          errorCode: 'ADMISSION_INDETERMINATE',
        },
      },
    ]);

    expect(screen.getByText('com_ui_queued_turn_reconciliation_required')).toBeInTheDocument();
    expect(screen.getByLabelText('com_ui_remove_queued')).toBeDisabled();
    expect(screen.queryByText('com_ui_send_now')).toBeNull();
  });

  it('dismisses an expired ambiguous receipt without restoring or resending it', () => {
    renderChips([
      {
        id: 'uncertain-turn',
        text: 'delivery outcome unknown',
        createdAt: 1,
        server: {
          status: 'uncertain',
          uncertainSince: 1,
          reconciliationExpired: true,
        },
      },
    ]);

    expect(screen.getByText('com_ui_steer_delivery_unconfirmed')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('com_ui_dismiss_unconfirmed_delivery'));

    expect(mockRemoveQueued).toHaveBeenCalledWith('uncertain-turn');
    expect(mockDiscardQueued).not.toHaveBeenCalled();
    expect(mockRestoreToComposer).not.toHaveBeenCalled();
    expect(mockSendQueuedNow).not.toHaveBeenCalled();
  });
});

describe('PendingSteerChips — queued trash', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it('returns the words to the composer when removing a queued message', async () => {
    // The trash is non-destructive: it hands the text (and its carried context)
    // to the gated restore once removal succeeds, so the words are not gone forever.
    renderChips([
      {
        id: 'q1',
        text: 'later thought',
        createdAt: 1,
        quotes: ['a quote'],
        manualSkills: ['a-skill'],
      },
    ]);
    fireEvent.click(screen.getByLabelText('com_ui_remove_queued'));

    await waitFor(() => {
      expect(mockRestoreToComposer).toHaveBeenCalledWith(
        'later thought',
        undefined,
        { quotes: ['a quote'], manualSkills: ['a-skill'] },
        CONVO_ID,
      );
      expect(mockRemoveQueued).toHaveBeenCalledWith('q1');
    });
  });

  it('still removes the message even when the composer refuses the restore', async () => {
    // Occupied composer / other chat: the gated restore returns false, but the
    // trash must reliably remove either way.
    mockRestoreToComposer.mockReturnValueOnce(false);
    renderChips([{ id: 'q2', text: 'drop me', createdAt: 1 }]);
    fireEvent.click(screen.getByLabelText('com_ui_remove_queued'));

    await waitFor(() => {
      expect(mockRestoreToComposer).toHaveBeenCalled();
      expect(mockRemoveQueued).toHaveBeenCalledWith('q2');
    });
  });

  it('discards a recovered source before restoring and removing its queued row', async () => {
    let confirmDiscard: ((discarded: boolean) => void) | undefined;
    mockDiscardQueued.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          confirmDiscard = resolve;
        }),
    );
    const recovered = {
      id: 'q-recovered',
      text: 'recovered words',
      createdAt: 1,
      recoverySteerId: 'server-source',
      recoveryClientSteerId: 'client-source',
    };
    renderChips([recovered]);

    fireEvent.click(screen.getByLabelText('com_ui_remove_queued'));
    expect(mockDiscardQueued).toHaveBeenCalledWith(recovered);
    expect(mockRestoreToComposer).not.toHaveBeenCalled();

    await act(async () => {
      confirmDiscard?.(true);
    });
    expect(mockRestoreToComposer).toHaveBeenCalledWith(
      'recovered words',
      undefined,
      { quotes: undefined, manualSkills: undefined },
      CONVO_ID,
    );
    expect(mockRemoveQueued).toHaveBeenCalledWith('q-recovered');
  });

  it('discards a dead server row before restoring and removing it', async () => {
    const dead = {
      id: 'q-dead',
      text: 'recover dead work',
      createdAt: 1,
      clientRequestId: 'client-dead',
      server: {
        id: 'server-dead',
        status: 'rejected' as const,
        errorCode: 'ADMISSION_FAILED',
      },
    };
    renderChips([dead]);

    fireEvent.click(screen.getByLabelText('com_ui_remove_queued'));

    await waitFor(() => expect(mockDiscardQueued).toHaveBeenCalledWith(dead));
    expect(mockRestoreToComposer).toHaveBeenCalledWith(
      'recover dead work',
      undefined,
      { quotes: undefined, manualSkills: undefined },
      CONVO_ID,
    );
    expect(mockRemoveQueued).toHaveBeenCalledWith('q-dead');
  });

  it('offers Edit for a recovered row and leaves it untouched when discard is refused', async () => {
    const user = userEvent.setup();
    mockDiscardQueued.mockResolvedValueOnce(false);
    const recovered = {
      id: 'q-recovered',
      text: 'safe to edit only after discard',
      createdAt: 1,
      recoverySteerId: 'server-source',
      recoveryClientSteerId: 'client-source',
    };
    renderChips([recovered]);

    await user.click(screen.getByLabelText('com_ui_more_options'));
    await user.click(await screen.findByRole('menuitem', { name: 'com_ui_edit_message' }));

    await waitFor(() => expect(mockDiscardQueued).toHaveBeenCalledWith(recovered));
    expect(mockRestoreToComposer).not.toHaveBeenCalled();
    expect(mockEditToComposer).not.toHaveBeenCalled();
    expect(mockRemoveQueued).not.toHaveBeenCalled();
    expect(screen.getByText('safe to edit only after discard')).toBeInTheDocument();
  });

  it('uses the guarded composer restore only after recovered Edit confirms discard', async () => {
    const user = userEvent.setup();
    let confirmDiscard: ((discarded: boolean) => void) | undefined;
    mockDiscardQueued.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          confirmDiscard = resolve;
        }),
    );
    const recovered = {
      id: 'q-recovered-edit',
      text: 'edit recovered words',
      createdAt: 1,
      recoverySteerId: 'server-source',
      recoveryClientSteerId: 'client-source',
      quotes: ['kept quote'],
      manualSkills: ['kept skill'],
    };
    renderChips([recovered]);

    await user.click(screen.getByLabelText('com_ui_more_options'));
    await user.click(await screen.findByRole('menuitem', { name: 'com_ui_edit_message' }));
    expect(mockEditToComposer).not.toHaveBeenCalled();

    await act(async () => {
      confirmDiscard?.(true);
    });
    expect(mockRestoreToComposer).toHaveBeenCalledWith(
      'edit recovered words',
      undefined,
      { quotes: ['kept quote'], manualSkills: ['kept skill'] },
      CONVO_ID,
    );
    expect(mockEditToComposer).not.toHaveBeenCalled();
    expect(mockRemoveQueued).toHaveBeenCalledWith('q-recovered-edit');
  });

  it('keeps a safely discarded Edit queued when live composer state changes during cancel', async () => {
    const user = userEvent.setup();
    let confirmDiscard: (() => void) | undefined;
    const recovered = {
      id: 'q-recovered-race',
      text: 'preserve after async race',
      createdAt: 1,
      clientRequestId: 'recovery-attempt',
      recoverySteerId: 'server-source',
      recoveryClientSteerId: 'client-source',
      quotes: ['kept quote'],
    };
    mockDiscardQueued.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          confirmDiscard = () => {
            updateQueueForTest?.((current) =>
              current.map((item) => {
                if (item.id !== recovered.id) {
                  return item;
                }
                const {
                  clientRequestId: _clientRequestId,
                  recoverySteerId: _recoverySteerId,
                  recoveryClientSteerId: _recoveryClientSteerId,
                  ...ordinary
                } = item;
                return ordinary;
              }),
            );
            resolve(true);
          };
        }),
    );
    renderChips([recovered]);

    await user.click(screen.getByLabelText('com_ui_more_options'));
    await user.click(await screen.findByRole('menuitem', { name: 'com_ui_edit_message' }));
    expect(mockDiscardQueued).toHaveBeenCalledWith(recovered);
    expect(mockRestoreToComposer).not.toHaveBeenCalled();

    // The live guard can change while the durable cancel request is pending.
    mockRestoreToComposer.mockReturnValueOnce(false);
    await act(async () => {
      confirmDiscard?.();
    });

    expect(mockRestoreToComposer).toHaveBeenCalledWith(
      'preserve after async race',
      undefined,
      { quotes: ['kept quote'], manualSkills: undefined },
      CONVO_ID,
    );
    expect(mockEditToComposer).not.toHaveBeenCalled();
    expect(mockRemoveQueued).not.toHaveBeenCalled();
    expect(screen.getByText('preserve after async race')).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('queue-state').textContent ?? 'null')).toEqual([
      {
        id: 'q-recovered-race',
        text: 'preserve after async race',
        createdAt: 1,
        quotes: ['kept quote'],
      },
    ]);
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_steer_edit_queued',
      status: 'info',
    });
  });
});

/**
 * The queued row's escalation: interrupt & steer this one message now, at the
 * next safe token boundary, instead of waiting for the run to end. Offered
 * only while a live run can accept a steer; disabled while another interrupt
 * is unresolved or the run is paused on approval, since a second preempt
 * would race the same seal (or draw the server's 409).
 */
describe('PendingSteerChips — queued interrupt-now', () => {
  const liveRun = { duringRunActive: true, canSteer: true };
  const queuedMessage: QueuedMessage = { id: 'q1', text: 'urgent one', createdAt: 1 };

  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it('escalates a queued message as an interrupt steer', () => {
    renderChips([queuedMessage], { steering: liveRun });
    fireEvent.click(screen.getByTestId('queued-interrupt-now'));

    expect(mockSendQueuedNow).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1' }), {
      preempt: true,
    });
  });

  it('offers no escalation outside a steerable run', () => {
    renderChips([queuedMessage]);
    expect(screen.queryByTestId('queued-interrupt-now')).toBeNull();
  });

  it('disables escalation while another interrupt is unresolved', () => {
    renderChips([queuedMessage], {
      steering: liveRun,
      steers: [{ steerId: 'p1', text: 'sealing', status: 'pending', createdAt: 1, preempt: true }],
    });
    const button = screen.getByTestId('queued-interrupt-now');
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(mockSendQueuedNow).not.toHaveBeenCalled();
  });

  it('disables escalation while a bubble arm request is in flight', () => {
    const jotai = getDefaultStore();
    act(() => {
      jotai.set(escalatingSteerFamily(CONVO_ID), true);
    });
    try {
      renderChips([queuedMessage], { steering: liveRun });
      expect(screen.getByTestId('queued-interrupt-now')).toBeDisabled();
    } finally {
      act(() => {
        jotai.set(escalatingSteerFamily(CONVO_ID), false);
      });
    }
  });

  it('stays visible but disabled while the run is paused on approval', () => {
    /** The real hook invariant: `canSteer = hasRealConvoId && !pausedOnApproval`,
     *  so a paused run always reads `canSteer: false`. The control must remain
     *  discoverable-but-disabled there, not vanish with the primary. */
    renderChips([queuedMessage], {
      steering: { duringRunActive: true, canSteer: false, pausedOnApproval: true },
    });
    const button = screen.getByTestId('queued-interrupt-now');
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(mockSendQueuedNow).not.toHaveBeenCalled();
  });

  it('stays visible but disabled while ask-user answer mode owns the composer', () => {
    renderChips([queuedMessage], {
      steering: { duringRunActive: false, canSteer: false, pausedOnApproval: true },
    });
    const button = screen.getByTestId('queued-interrupt-now');
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(mockSendQueuedNow).not.toHaveBeenCalled();
  });

  it('makes the hovered row the only advertised shortcut target', () => {
    renderChips([queuedMessage, { id: 'q2', text: 'urgent two', createdAt: 2 }], {
      steering: liveRun,
    });
    const [first, second] = screen.getAllByTestId('queued-interrupt-now');

    expect(first).not.toHaveAttribute('aria-keyshortcuts');
    expect(second).not.toHaveAttribute('aria-keyshortcuts');

    fireEvent.pointerEnter(first);
    expect(first).toHaveAttribute('data-escalate-steer-active', 'true');
    expect(first).toHaveAttribute('aria-keyshortcuts');
    expect(second).not.toHaveAttribute('data-escalate-steer-active');
    expect(second).not.toHaveAttribute('aria-keyshortcuts');

    fireEvent.pointerEnter(second);
    expect(first).not.toHaveAttribute('data-escalate-steer-active');
    expect(first).not.toHaveAttribute('aria-keyshortcuts');
    expect(second).toHaveAttribute('data-escalate-steer-active', 'true');
    expect(second).toHaveAttribute('aria-keyshortcuts');
  });

  it('names each queued escalation control with its target message', () => {
    renderChips([queuedMessage, { id: 'q2', text: 'urgent two', createdAt: 2 }], {
      steering: liveRun,
    });

    expect(
      screen.getByRole('button', { name: 'com_ui_interrupt_steer_now: urgent one' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'com_ui_interrupt_steer_now: urgent two' }),
    ).toBeInTheDocument();
  });

  it.each(['pointer', 'keyboard'] as const)(
    'keeps preference help visibly open after %s activation',
    async (activation) => {
      const user = userEvent.setup();
      renderChips([queuedMessage], { steering: liveRun });
      const menuButton = screen.getByLabelText('com_ui_more_options');
      await user.click(menuButton);

      const preference = await screen.findByRole('menuitem', {
        name: 'com_ui_turn_on_queueing',
      });
      expect(preference).toHaveAccessibleDescription('com_nav_info_during_run_action');
      const help = screen.getByRole('menuitem', {
        name: 'com_ui_more_info: com_ui_turn_on_queueing',
      });

      if (activation === 'pointer') {
        await user.click(help);
      } else {
        act(() => help.focus());
        expect(document.activeElement).toBe(help);
        await user.keyboard('{Enter}');
      }

      const menu = screen.getByRole('menu');
      const description = screen.getByText('com_nav_info_during_run_action');
      expect(menuButton).toHaveAttribute('aria-expanded', 'true');
      expect(menu).toBeVisible();
      expect(help).toHaveAttribute('aria-expanded', 'true');
      expect(description).not.toHaveClass('sr-only');
      expect(description).toBeVisible();
    },
  );

  it.each([false, true])(
    'makes steering the default when enabling always-interrupt from queue mode (latent=%s)',
    async (interrupts) => {
      renderChips([queuedMessage], {
        steering: { ...liveRun, defaultAction: 'queue' },
        interrupts,
      });
      fireEvent.click(screen.getByLabelText('com_ui_more_options'));
      const preference = await screen.findByRole('menuitem', { name: 'com_ui_always_interrupt' });
      expect(preference).toHaveAccessibleDescription('com_ui_steer_interrupts_enable_info');
      fireEvent.click(preference);

      expect(screen.getByTestId('default-action-state')).toHaveTextContent('steer');
      expect(screen.getByTestId('interrupts-state')).toHaveTextContent('true');

      fireEvent.click(screen.getByLabelText('com_ui_more_options'));
      expect(await screen.findByText('com_ui_wait_for_tool_steps')).toBeInTheDocument();
    },
  );
});

describe('PendingSteerChips — queued hint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const queuedItem = { id: 'q1', text: 'follow up later', createdAt: 1 };
  const hintName = 'com_ui_steer_queued_info';

  it('explains when a queued message will send as a hover hint on its clock icon', async () => {
    renderChips([queuedItem], { steering: { duringRunActive: true } });
    const clock = screen.getByRole('img', { name: hintName });
    fireEvent.mouseEnter(clock);
    /** Ariakit only counts a pointer as moving when consecutive events differ
     *  in screen coordinates (its NODE_ENV=test shortcut is off under CI's
     *  NODE_ENV), and it opens the tooltip on a timer after that. */
    fireEvent.mouseMove(clock, { screenX: 10, screenY: 10 });
    fireEvent.mouseMove(clock, { screenX: 20, screenY: 20 });
    const tooltip = await screen.findByRole('tooltip', {}, { timeout: 3000 });
    expect(tooltip).toHaveTextContent(hintName);
  });

  it('reaches the same hint from the keyboard: the clock is a tab stop and opens on focus', async () => {
    const user = userEvent.setup();
    renderChips([queuedItem], { steering: { duringRunActive: true } });
    const clock = screen.getByRole('img', { name: hintName });
    await user.tab();
    expect(clock).toHaveFocus();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(hintName);
  });

  it('renders no always-visible caption, so the hint costs no composer height at rest', () => {
    renderChips([queuedItem], { steering: { duringRunActive: true } });
    expect(screen.queryByText(hintName)).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps the hint inside each queued row as its icon, never as a stray child of the list', () => {
    renderChips([queuedItem, { id: 'q2', text: 'and another', createdAt: 2 }], {
      steering: { duringRunActive: true },
    });
    const rows = screen.getAllByTestId('queued-message-row');
    const clocks = screen.getAllByRole('img', { name: hintName });
    expect(clocks).toHaveLength(2);
    rows.forEach((row, index) => expect(row).toContainElement(clocks[index]));
  });

  it('omits the hint once the run is over, when rows drain on their own terms', () => {
    renderChips([queuedItem], { steering: { duringRunActive: false } });
    expect(screen.queryByRole('img', { name: hintName })).toBeNull();
  });
});

describe('PendingSteerChips — revealed queued turn', () => {
  const revealedFamily = () => revealedQueuedTurnFamily(CONVO_ID);

  beforeEach(() => {
    jest.clearAllMocks();
    act(() => {
      getDefaultStore().set(revealedFamily(), null);
    });
  });

  afterEach(() => {
    act(() => {
      getDefaultStore().set(revealedFamily(), null);
    });
  });

  const serverRow = (clientRequestId: string): QueuedMessage => ({
    id: `q-${clientRequestId}`,
    text: `queued ${clientRequestId}`,
    createdAt: 1,
    clientRequestId,
    server: { id: `server-${clientRequestId}`, status: 'queued', revision: 1 },
  });

  it('keeps an ordinary queue row when no matching pending message is visible', () => {
    getDefaultStore().set(revealedFamily(), {
      clientRequestId: 'req-1',
      parentMessageId: 'response-1',
      text: 'queued req-1',
      revealedAt: '2026-09-14T00:00:00.000Z',
    });
    renderChips([serverRow('req-1'), serverRow('req-2')], {
      steering: { duringRunActive: true, canSendQueuedNow: false, canSteer: false },
    });

    const rows = screen.getAllByTestId('queued-message-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveTextContent('com_ui_queued_turn_starting');
    expect(
      within(rows[0]).getByRole('button', { name: 'com_ui_more_options' }),
    ).toBeInTheDocument();
    expect(within(rows[0]).getByRole('button', { name: /com_ui_remove/ })).toBeInTheDocument();
    expect(rows[1]).not.toHaveTextContent('com_ui_queued_turn_starting');
    expect(
      within(rows[1]).getByRole('button', { name: 'com_ui_more_options' }),
    ).toBeInTheDocument();
  });
  it.each([true, false])(
    'attempts claimed cancellation and respects acceptance=%s',
    async (accepted) => {
      const message = serverRow('req-1');
      message.server!.status = 'claimed';
      getDefaultStore().set(revealedFamily(), {
        clientRequestId: 'req-1',
        parentMessageId: 'response-1',
        text: message.text,
        revealedAt: new Date().toISOString(),
      });
      mockDiscardQueued.mockResolvedValueOnce(accepted);
      renderChips([message], { steering: { duringRunActive: true, canSendQueuedNow: false } });
      const remove = screen.getByRole('button', { name: /com_ui_remove/ });
      expect(remove).toBeEnabled();
      await userEvent.click(remove);
      await waitFor(() => expect(mockDiscardQueued).toHaveBeenCalledWith(message));
      expect(mockRemoveQueued).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect(mockRestoreToComposer).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect(mockSendQueuedNow).not.toHaveBeenCalled();
    },
  );
});

describe('held steer recovery controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDefaultStore().set(recoveryDispositionsFamily(CONVO_ID), { source: 'blocked' });
  });
  afterEach(() => {
    act(() => {
      getDefaultStore().set(recoveryDispositionsFamily(CONVO_ID), {});
    });
  });

  const item: QueuedMessage = {
    id: 'held',
    text: 'original words',
    createdAt: 1,
    recoverySteerId: 'source',
    quotes: ['original excerpt'],
    files: [{ file_id: 'file' }],
  };

  it('shows a held state and no automatic or manual send shortcut', () => {
    renderChips([item]);
    expect(screen.getByText('com_ui_steer_recovery_held')).toBeTruthy();
    expect(screen.queryByText('com_ui_send_now')).toBeNull();
    expect(screen.queryByText('com_ui_steer')).toBeNull();
  });

  it('copies the original context for review without cancelling or sending it', async () => {
    mockRestoreToComposer.mockReturnValueOnce(true);
    const user = userEvent.setup();
    renderChips([item]);
    await user.click(screen.getByRole('button', { name: 'com_ui_more_options' }));
    await user.click(screen.getByText('com_ui_steer_copy_to_composer'));
    expect(mockRestoreToComposer).toHaveBeenCalledWith(
      item.text,
      item.files,
      {
        quotes: item.quotes,
        manualSkills: undefined,
      },
      CONVO_ID,
    );
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_steer_recovery_review',
      status: 'info',
    });
    expect(mockSendQueuedNow).not.toHaveBeenCalled();
    expect(mockDiscardQueued).not.toHaveBeenCalled();
    expect(mockRemoveQueued).not.toHaveBeenCalled();
  });

  it('leaves the recovery untouched and explains a refused copy to the occupied composer', async () => {
    mockRestoreToComposer.mockReturnValueOnce(false);
    const user = userEvent.setup();
    renderChips([item]);
    await user.click(screen.getByRole('button', { name: 'com_ui_more_options' }));
    await user.click(screen.getByText('com_ui_steer_copy_to_composer'));
    expect(mockRestoreToComposer).toHaveBeenCalledWith(
      item.text,
      item.files,
      { quotes: item.quotes, manualSkills: undefined },
      CONVO_ID,
    );
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_steer_recovery_copy_refused',
      status: 'error',
    });
    expect(mockShowToast).not.toHaveBeenCalledWith({
      message: 'com_ui_steer_recovery_review',
      status: 'info',
    });
    expect(screen.getByText('com_ui_steer_recovery_held')).toBeTruthy();
    expect(mockDismissRecovery).not.toHaveBeenCalled();
    expect(mockSendQueuedNow).not.toHaveBeenCalled();
    expect(mockRemoveQueued).not.toHaveBeenCalled();
  });

  it('labels dismissal as tab-local and does not claim to cancel server work', async () => {
    const user = userEvent.setup();
    renderChips([item]);
    await user.click(screen.getByRole('button', { name: 'com_ui_more_options' }));
    await user.click(screen.getByText('com_ui_steer_dismiss_recovery'));
    expect(mockDismissRecovery).toHaveBeenCalledWith(item);
    expect(mockDiscardQueued).not.toHaveBeenCalled();
    expect(mockSendQueuedNow).not.toHaveBeenCalled();
  });
});
