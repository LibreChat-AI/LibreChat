import { memo, useMemo, useRef, useState, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { createPortal } from 'react-dom';
import { TooltipAnchor, useToastContext } from '@librechat/client';
import {
  X,
  Zap,
  Send,
  Clock,
  Pencil,
  Trash2,
  Paperclip,
  RotateCcw,
  TextQuote,
  TriangleAlert,
} from 'lucide-react';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { SteeringControls, QueuedMessageContext } from '~/hooks/Chat/useSteering';
import type { PendingSteer, QueuedMessage } from '~/store/families';
import type { RestoreToComposer } from './InFlightSteers';
import type { MenuEntry } from './SteerMenu';
import {
  RowMenu,
  ICON_BTN_CLASS,
  PRIMARY_BTN_CLASS,
  EscalateNowButton,
  useDefaultToggleEntry,
  useInterruptToggleEntry,
} from './SteerMenu';
import {
  recoveryDispositionsFamily,
  recoveryDisposition,
} from '~/components/Chat/Steering/recovery';
import { useQueuedTurnPortal } from '~/components/Chat/Steering/QueuedTurnPortal';
import { escalatingSteerFamily, revealedQueuedTurnFamily } from '~/store/steer';
import { QUEUE_ICON, STEER_ICON } from '~/components/Chat/Steering/identity';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

const ROW_CLASS =
  'flex w-full items-center gap-2 rounded-xl border border-border-light bg-surface-secondary px-3 py-2 text-sm text-text-primary';

function ContextCount({
  icon,
  count,
  label,
}: {
  icon: React.ReactNode;
  count: number;
  label: string;
}) {
  if (count === 0) {
    return null;
  }
  return (
    <span className="flex shrink-0 items-center gap-0.5 text-xs text-text-secondary">
      {icon}
      {count}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function AttachmentCount({ count, label }: { count: number; label: string }) {
  return (
    <ContextCount
      icon={<Paperclip className="h-3.5 w-3.5" aria-hidden="true" />}
      count={count}
      label={label}
    />
  );
}

function QuoteCount({ count, label }: { count: number; label: string }) {
  return (
    <ContextCount
      icon={<TextQuote className="h-3.5 w-3.5" aria-hidden="true" />}
      count={count}
      label={label}
    />
  );
}

/**
 * The one fact a queued row needs to convey ("did my message vanish?" it did
 * not) rides the clock as a hover hint and its accessible name while a run is
 * pending, instead of a caption row that costs composer height at rest. The
 * anchor is a tab stop with a visible ring so keyboard users reach the same
 * hint: the tooltip opens on focus-visible as well as on hover.
 */
function QueuedIcon({ warning, hint }: { warning: boolean; hint?: string }) {
  if (warning) {
    return <TriangleAlert className="h-4 w-4 shrink-0 text-text-warning" aria-hidden="true" />;
  }
  if (!hint) {
    return <Clock className={cn('h-4 w-4 shrink-0', QUEUE_ICON)} aria-hidden="true" />;
  }
  return (
    <TooltipAnchor
      description={hint}
      role="img"
      aria-label={hint}
      tabIndex={0}
      className="flex shrink-0 cursor-help rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy"
    >
      <Clock className={cn('h-4 w-4', QUEUE_ICON)} aria-hidden="true" />
    </TooltipAnchor>
  );
}

function QueuedRow({
  message,
  steering,
  conversationId,
  interruptPending,
  inTurn = false,
  starting = false,
  actionPending,
  afterDiscard,
  onEditToComposer,
  onRestoreToComposer,
}: {
  message: QueuedMessage;
  steering: SteeringControls;
  conversationId: string;
  interruptPending: boolean;
  /** A visible pending turn takes the place of this queue row. */
  inTurn?: boolean;
  starting?: boolean;
  actionPending: boolean;
  afterDiscard: (message: QueuedMessage, action: () => boolean) => void;
  onEditToComposer: (
    text: string,
    files?: TMessage['files'],
    context?: QueuedMessageContext,
  ) => void;
  onRestoreToComposer: RestoreToComposer;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const toggleEntry = useDefaultToggleEntry(steering);
  const interruptToggle = useInterruptToggleEntry();
  const fileCount = message.files?.length ?? 0;
  const quoteCount = message.quotes?.length ?? 0;
  const dispositions = useAtomValue(recoveryDispositionsFamily(steering.queueKey));
  const disposition = recoveryDisposition(dispositions, message);
  const recoveryHeld = disposition != null;
  const recoveryBlocked = disposition === 'blocked' || disposition === 'cancelled';
  const recoveryPending = disposition === 'cancelling';
  actionPending = actionPending || recoveryPending;
  const isRecovered = message.recoverySteerId != null;
  const isRejected = message.server?.status === 'rejected';
  const isIndeterminate = message.server?.status === 'indeterminate';
  const isUnconfirmed =
    message.server?.status === 'uncertain' && message.server.reconciliationExpired === true;
  let statusLabel:
    | 'com_ui_queued_turn_reconciliation_required'
    | 'com_ui_steer_delivery_unconfirmed'
    | 'com_ui_queued_turn_failed'
    | 'com_ui_steer_recovery_held' = 'com_ui_queued_turn_failed';
  if (recoveryHeld) {
    statusLabel = 'com_ui_steer_recovery_held';
  } else if (isIndeterminate) {
    statusLabel = 'com_ui_queued_turn_reconciliation_required';
  } else if (isUnconfirmed) {
    statusLabel = 'com_ui_steer_delivery_unconfirmed';
  }
  const requiresDiscard = isRecovered || message.server?.id != null;
  const serverActionable =
    message.server == null ||
    message.server.status === 'rejected' ||
    (message.server.id != null && message.server.status === 'queued');
  // A recovered item is consumed atomically only when it starts a normal
  // generation. Re-steering it would leave or duplicate the parked source;
  // Edit/remove are safe because `afterDiscard` tombstones that source first.
  const canSteerNow = steering.duringRunActive && steering.canSteer && !isRecovered;
  const showPrimary =
    !starting &&
    !recoveryHeld &&
    serverActionable &&
    (canSteerNow || (!steering.duringRunActive && steering.canSendQueuedNow));
  /** `canSteer` is defined as false while paused on approval, but the
   *  escalation control must stay visible-and-disabled there — hiding it
   *  during the pause is exactly the discoverability gap this button fixes. */
  const showEscalate =
    !starting &&
    !isRecovered &&
    (steering.pausedOnApproval || (steering.duringRunActive && steering.canSteer));

  const edit = () => {
    const context = { quotes: message.quotes, manualSkills: message.manualSkills };
    if (!requiresDiscard) {
      steering.removeQueued(message.id);
      onEditToComposer(message.text, message.files, context);
      return;
    }
    afterDiscard(message, () => {
      const restored = onRestoreToComposer(message.text, message.files, context, conversationId);
      if (!restored) {
        showToast({ message: localize('com_ui_steer_edit_queued'), status: 'info' });
        return false;
      }
      steering.removeQueued(message.id);
      return true;
    });
  };
  const remove = () => {
    if (isUnconfirmed) {
      steering.removeQueued(message.id);
      return;
    }
    const finish = () => {
      onRestoreToComposer(
        message.text,
        message.files,
        { quotes: message.quotes, manualSkills: message.manualSkills },
        conversationId,
      );
      steering.removeQueued(message.id);
      return true;
    };
    if (!requiresDiscard) {
      finish();
      return;
    }
    afterDiscard(message, finish);
  };
  const removeDisabled =
    actionPending ||
    (!serverActionable &&
      !isUnconfirmed &&
      !(message.server?.id != null && message.server.status === 'claimed'));
  if (inTurn) {
    const actionClass = cn(ICON_BTN_CLASS, 'disabled:cursor-not-allowed disabled:opacity-50');
    return (
      <>
        {message.server?.status === 'queued' && (
          <button
            type="button"
            className={actionClass}
            aria-label={localize('com_ui_edit_message')}
            disabled={actionPending}
            onClick={edit}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        {!removeDisabled || actionPending ? (
          <button
            type="button"
            className={actionClass}
            aria-label={localize('com_ui_remove_queued')}
            disabled={removeDisabled}
            onClick={remove}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </>
    );
  }

  const entries: MenuEntry[] = [
    {
      key: 'edit',
      label: localize('com_ui_edit_message'),
      icon: <Pencil className="h-4 w-4" aria-hidden="true" />,
      disabled: actionPending || !serverActionable,
      onClick: edit,
    },
  ];
  if (recoveryBlocked) {
    entries.push(
      {
        key: 'copy-recovery',
        label: localize('com_ui_steer_copy_to_composer'),
        icon: <Pencil className="h-4 w-4" aria-hidden="true" />,
        disabled: actionPending,
        onClick: () => {
          const copied = onRestoreToComposer(
            message.text,
            message.files,
            {
              quotes: message.quotes,
              manualSkills: message.manualSkills,
            },
            conversationId,
          );
          showToast(
            copied
              ? { message: localize('com_ui_steer_recovery_review'), status: 'info' }
              : { message: localize('com_ui_steer_recovery_copy_refused'), status: 'error' },
          );
        },
      },
      {
        key: 'dismiss-recovery',
        label: localize('com_ui_steer_dismiss_recovery'),
        icon: <X className="h-4 w-4" aria-hidden="true" />,
        disabled: actionPending,
        onClick: () => steering.dismissRecovery(message),
      },
    );
  }
  const preferences: MenuEntry[] = [toggleEntry, interruptToggle];

  return (
    <div role="listitem" className={ROW_CLASS} data-testid="queued-message-row">
      <QueuedIcon
        warning={recoveryHeld || isRejected || isUnconfirmed || isIndeterminate}
        hint={steering.duringRunActive ? localize('com_ui_steer_queued_info') : undefined}
      />
      <span className="min-w-0 flex-1 truncate" title={message.text}>
        {message.text}
      </span>
      <QuoteCount
        count={quoteCount}
        label={localize('com_ui_queued_quote_count', { 0: String(quoteCount) })}
      />
      <AttachmentCount
        count={fileCount}
        label={localize('com_ui_queued_attachment_count', {
          0: String(fileCount),
        })}
      />
      {(recoveryHeld || isRejected || isUnconfirmed || isIndeterminate) && (
        <span
          className="shrink-0 text-xs text-text-warning"
          title={recoveryHeld ? localize('com_ui_steer_recovery_review') : undefined}
        >
          {localize(statusLabel)}
        </span>
      )}
      {showPrimary && (
        <button
          type="button"
          className={PRIMARY_BTN_CLASS}
          disabled={actionPending || !serverActionable}
          onClick={() => steering.sendQueuedNow(message)}
        >
          {canSteerNow ? (
            <>
              <Zap className={cn('h-4 w-4', STEER_ICON)} aria-hidden="true" />
              {localize('com_ui_steer')}
            </>
          ) : (
            <>
              <Send className="h-4 w-4" aria-hidden="true" />
              {localize('com_ui_send_now')}
            </>
          )}
        </button>
      )}
      {showEscalate && (
        <EscalateNowButton
          surface="queued"
          messageText={message.text}
          disabled={
            steering.pausedOnApproval || interruptPending || actionPending || !serverActionable
          }
          onClick={() => steering.sendQueuedNow(message, { preempt: true })}
        />
      )}
      <button
        type="button"
        aria-label={localize(
          isUnconfirmed ? 'com_ui_dismiss_unconfirmed_delivery' : 'com_ui_remove_queued',
        )}
        disabled={removeDisabled}
        onClick={remove}
        className={ICON_BTN_CLASS}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </button>
      <RowMenu
        label={localize('com_ui_more_options')}
        entries={entries}
        preferences={preferences}
      />
    </div>
  );
}

function FailedSteerRow({
  steer,
  steering,
  onEditToComposer,
}: {
  steer: PendingSteer;
  steering: SteeringControls;
  onEditToComposer: (
    text: string,
    files?: TMessage['files'],
    context?: QueuedMessageContext,
  ) => void;
}) {
  const localize = useLocalize();
  const toggleEntry = useDefaultToggleEntry(steering);
  const interruptToggle = useInterruptToggleEntry();
  const canRetry = !steer.deliveryUncertain || steer.generationProtocolVersion === 2;

  const entries: MenuEntry[] = steer.deliveryUncertain
    ? []
    : [
        {
          key: 'edit',
          label: localize('com_ui_edit_message'),
          icon: <Pencil className="h-4 w-4" aria-hidden="true" />,
          onClick: () => {
            steering.removeSteer(steer.steerId);
            onEditToComposer(steer.text, steer.files, {
              quotes: steer.quotes,
              manualSkills: steer.manualSkills,
            });
          },
        },
        {
          key: 'queue',
          label: localize('com_ui_convert_to_queue'),
          icon: <Clock className={cn('h-4 w-4', QUEUE_ICON)} aria-hidden="true" />,
          onClick: () =>
            steering.convertSteerToQueue(
              steer.steerId,
              steer.text,
              steer.files,
              { quotes: steer.quotes, manualSkills: steer.manualSkills },
              steer.queuedOrigin,
            ),
        },
      ];
  const preferences: MenuEntry[] = [toggleEntry, interruptToggle];

  return (
    <div
      role="listitem"
      className={cn(ROW_CLASS, 'border-border-destructive')}
      data-testid="steer-message-row"
    >
      <Zap className="h-4 w-4 shrink-0 text-text-destructive" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={steer.text}>
        {steer.text}
      </span>
      <QuoteCount
        count={steer.quotes?.length ?? 0}
        label={localize('com_ui_queued_quote_count', {
          0: String(steer.quotes?.length ?? 0),
        })}
      />
      <span className="shrink-0 text-xs text-text-destructive">
        {localize(
          steer.deliveryUncertain ? 'com_ui_steer_delivery_unconfirmed' : 'com_ui_steer_failed',
        )}
      </span>
      {canRetry && (
        <button
          type="button"
          className={PRIMARY_BTN_CLASS}
          onClick={() =>
            steering.retrySteer(
              steer.steerId,
              steer.text,
              steer.files,
              { quotes: steer.quotes, manualSkills: steer.manualSkills },
              {
                preempt: steer.preempt === true,
                createdAt: steer.createdAt,
                generationProtocolVersion: steer.generationProtocolVersion,
                ...(steer.generationCreatedAt != null && {
                  generationCreatedAt: steer.generationCreatedAt,
                }),
                ...(steer.queuedOrigin && { queuedOrigin: steer.queuedOrigin }),
              },
            )
          }
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          {localize('com_ui_steer_retry')}
        </button>
      )}
      {!steer.deliveryUncertain && (
        <button
          type="button"
          aria-label={localize('com_ui_remove_queued')}
          onClick={() => steering.removeSteer(steer.steerId)}
          className={ICON_BTN_CLASS}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      <RowMenu
        label={localize('com_ui_more_options')}
        entries={entries}
        preferences={preferences}
      />
    </div>
  );
}

/**
 * Stacked rows above the composer for during-run messages, mirroring the
 * reference UI: each row shows the message, a primary action, delete, and an
 * overflow menu with Edit message + the default-mode toggle.
 * (In-flight steers read as messages, not controls — `InFlightSteers` renders
 * them as bubbles anchored above the composer box.)
 * - Failed steer rows (Zap, red): the POST failed, so the text never entered
 *   the thread — kept recoverable with retry / edit / queue actions.
 * - Queued rows (Clock): client-side follow-ups auto-sent after the run.
 */
function PendingSteerChips({
  conversationId,
  steering,
  onEditToComposer,
  onRestoreToComposer,
}: {
  conversationId: string;
  steering: SteeringControls;
  onEditToComposer: (
    text: string,
    files?: TMessage['files'],
    context?: QueuedMessageContext,
  ) => void;
  onRestoreToComposer: RestoreToComposer;
}) {
  const localize = useLocalize();
  const steers = useRecoilValue(store.pendingSteersByConvoId(conversationId));
  const queued = useRecoilValue(store.queuedMessagesByConvoId(steering.queueKey));
  const revealed = useAtomValue(revealedQueuedTurnFamily(steering.queueKey));
  const portal = useQueuedTurnPortal();
  const actionLocks = useRef(new Set<string>());
  const [pendingActions, setPendingActions] = useState<ReadonlySet<string>>(new Set());
  /** The lock lives with the composer, not the row: reparenting an action
   * during a cancellation cannot open a second request window. */
  const afterDiscard = useCallback(
    (message: QueuedMessage, action: () => boolean) => {
      const key = `${steering.queueKey}\u0000${message.id}`;
      if (actionLocks.current.has(key)) return;
      actionLocks.current.add(key);
      setPendingActions(new Set(actionLocks.current));
      void (async () => {
        try {
          if (await steering.discardQueued(message)) action();
        } catch {
          // The steering hook reports failures; leave the row available for retry.
        } finally {
          actionLocks.current.delete(key);
          setPendingActions(new Set(actionLocks.current));
        }
      })();
    },
    [steering],
  );
  const failedSteers = useMemo(() => steers.filter((steer) => steer.status === 'failed'), [steers]);
  /** Only one interrupt can be in flight: a second preempt while one is
   *  unresolved would arm a second seal, so escalation buttons disable. The
   *  escalating flag covers a bubble arm's round trip, before its chip
   *  relabels for the chip-derived check to see. */
  const escalating = useAtomValue(escalatingSteerFamily(conversationId));
  const interruptPending = useMemo(
    () => escalating || steers.some((steer) => steer.preempt === true && steer.status !== 'failed'),
    [escalating, steers],
  );

  const queuedRows: ReactNode[] = [];
  const portaledActions: ReactNode[] = [];
  const target = portal?.target;
  for (const message of queued) {
    const starting =
      revealed != null &&
      message.clientRequestId != null &&
      revealed.clientRequestId === message.clientRequestId;
    const inTurn =
      starting &&
      target != null &&
      target.conversationId === conversationId &&
      target.clientRequestId === message.clientRequestId;
    const actionKey = `${steering.queueKey}\u0000${message.id}`;
    const row = (
      <QueuedRow
        key={message.id}
        message={message}
        steering={steering}
        conversationId={conversationId}
        interruptPending={interruptPending}
        starting={starting}
        inTurn={inTurn}
        actionPending={pendingActions.has(actionKey)}
        afterDiscard={afterDiscard}
        onEditToComposer={onEditToComposer}
        onRestoreToComposer={onRestoreToComposer}
      />
    );
    if (inTurn && target != null) {
      portaledActions.push(createPortal(row, target.element, message.id));
    } else {
      queuedRows.push(row);
    }
  }
  if (failedSteers.length === 0 && queuedRows.length === 0 && portaledActions.length === 0) {
    return null;
  }

  return (
    <>
      {(failedSteers.length > 0 || queuedRows.length > 0) && (
        <div className="flex flex-col gap-1.5 px-2 pt-2" data-testid="pending-steer-chips">
          <div
            className="flex flex-col gap-1.5"
            role="list"
            aria-label={localize('com_ui_queued_messages')}
          >
            {failedSteers.map((steer) => (
              <FailedSteerRow
                key={steer.steerId}
                steer={steer}
                steering={steering}
                onEditToComposer={onEditToComposer}
              />
            ))}
            {queuedRows}
          </div>
        </div>
      )}
      {portaledActions}
    </>
  );
}

export default memo(PendingSteerChips);
