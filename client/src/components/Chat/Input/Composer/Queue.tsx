import { memo, useId, useRef, useMemo, useState, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { createPortal } from 'react-dom';
import * as Ariakit from '@ariakit/react';
import { useDrag, useDrop } from 'react-dnd';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Button,
  IconButton,
  TooltipAnchor,
  DropdownPopup,
  useMediaQuery,
  useToastContext,
} from '@librechat/client';
import {
  Clock,
  Trash2,
  Pencil,
  Ellipsis,
  TextQuote,
  CirclePlay,
  CirclePause,
  GripVertical,
  TriangleAlert,
  MessageSquarePlus,
} from 'lucide-react';
import type { MenuItemProps } from '@librechat/client';
import type { RestoreToComposer } from '~/Providers/ComposerRestoreContext';
import type { SteeringControls } from '~/hooks/Chat/useSteering';
import type { QueuedMessage } from '~/hooks/Chat/queue';
import { claimQueuedIntent, releaseQueuedIntent, hasQueuedIntent } from '~/utils/queueIntent';
import { useQueuedTurnPortal } from '~/components/Chat/Steering/QueuedTurnPortal';
import { escalatingSteerFamily, revealedQueuedTurnFamily } from '~/store/steer';
import EscalateNowButton from '~/components/Chat/Input/EscalateNowButton';
import { queuedMessagesByConvoId } from '~/hooks/Chat/queue';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

const DRAG_TYPE = 'queued-message';

/** One timing for a row entering or leaving the rail, so a message that sends reads as
 *  the rail closing up behind it rather than a row vanishing. */
const ROW_TRANSITION = {
  height: { duration: 0.26, ease: [0.4, 0, 0.2, 1] },
  opacity: { duration: 0.16, ease: 'easeOut' },
} as const;

interface DragItem {
  id: string;
  index: number;
  /** The order the drag started from, so abandoning it puts things back. */
  order: string[];
  /** Avoid repeating the same refusal while the pointer remains over a blocked row. */
  blockedTarget?: number;
}

interface QueueProps {
  steering: SteeringControls;
  conversationId: string;
  onRestoreToComposer: RestoreToComposer;
  /** Whether the composer would take this conversation's words right now. */
  canRestoreToComposer: (conversationId: string) => boolean;
  /** Owned by the composer host: opens a fresh chat that starts with these words. */
  onStartNewChat: (text: string) => void;
}

interface QueueRowProps {
  message: QueuedMessage;
  index: number;
  total: number;
  /** Every queued id in order, captured when a drag starts so abandoning it
   *  can put the queue back the way it was. */
  order: string[];
  /** A server-owned row is a durable ordering boundary. */
  serverOwnedIds: ReadonlySet<string>;
  steering: SteeringControls;
  conversationId: string;
  /** One interrupt at a time: an arm is already unresolved somewhere. */
  interruptPending: boolean;
  /** Owned by the rail, so the keys are stated once rather than once per row,
   *  and scoped to THIS rail, so a split view has one hint per pane. */
  reorderHintId: string;
  onRestoreToComposer: RestoreToComposer;
  canRestoreToComposer: (conversationId: string) => boolean;
  onStartNewChat: (text: string) => void;
  /** The server has revealed this row as the next user turn; only removal remains meaningful. */
  revealed?: boolean;
  /** The matching user turn owns this row's actions when its bubble is visible. */
  portalElement?: HTMLSpanElement;
  onAnnounce: (message: string) => void;
}

function QueuedIcon({ warning, hint }: { warning: boolean; hint?: string }) {
  if (warning) {
    return <TriangleAlert className="text-status-warning h-4 w-4 shrink-0" aria-hidden="true" />;
  }
  if (!hint) {
    return <Clock className="text-text-secondary h-4 w-4 shrink-0" aria-hidden="true" />;
  }
  return (
    <TooltipAnchor
      description={hint}
      render={
        <span
          role="img"
          aria-label={hint}
          tabIndex={0}
          className="focus-visible:ring-text-primary flex shrink-0 cursor-help rounded-full focus-visible:ring-2 focus-visible:outline-hidden"
        >
          <Clock className="text-text-secondary h-4 w-4" aria-hidden="true" />
        </span>
      }
    />
  );
}

function QueueRow({
  message,
  index,
  total,
  order,
  serverOwnedIds,
  steering,
  conversationId,
  interruptPending,
  reorderHintId,
  onRestoreToComposer,
  canRestoreToComposer,
  onStartNewChat,
  onAnnounce,
  revealed = false,
  portalElement,
}: QueueRowProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const rowRef = useRef<HTMLDivElement>(null);
  const gripRef = useRef<HTMLButtonElement>(null);
  const { reorderQueued, restoreQueuedOrder } = steering;
  const [actionPending, setActionPending] = useState(false);
  const isRejected = message.server?.status === 'rejected';
  const isIndeterminate = message.server?.status === 'indeterminate';
  const isUnconfirmed =
    message.server?.status === 'uncertain' && message.server.reconciliationExpired === true;
  const serverActionable =
    message.server == null ||
    isRejected ||
    (message.server.id != null && message.server.status === 'queued');
  let statusLabel:
    | 'com_ui_queued_turn_reconciliation_required'
    | 'com_ui_steer_delivery_unconfirmed'
    | 'com_ui_queued_turn_failed' = 'com_ui_queued_turn_failed';
  if (isIndeterminate) {
    statusLabel = 'com_ui_queued_turn_reconciliation_required';
  } else if (isUnconfirmed) {
    statusLabel = 'com_ui_steer_delivery_unconfirmed';
  }
  /* A server-owned row is a durable ordering boundary. Local rows may move
     only within their contiguous local segment; the client cannot persist a
     position change across an acknowledged row. */
  const canMoveTo = useCallback(
    (sourceIndex: number, target: number, sourceId: string) => {
      if (target < 0 || target >= total || target === sourceIndex || serverOwnedIds.has(sourceId)) {
        return false;
      }
      const start = Math.min(sourceIndex, target);
      const end = Math.max(sourceIndex, target);
      for (let position = start; position <= end; position++) {
        if (serverOwnedIds.has(order[position])) {
          return false;
        }
      }
      return true;
    },
    [order, serverOwnedIds, total],
  );
  const reorderable =
    message.server == null && order.some((_, target) => canMoveTo(index, target, message.id));
  /* HTML5 drag needs a hover-capable pointer; on touch it would take the
     gesture away from scrolling the rail. Arrow keys reorder either way. */
  const canDrag = useMediaQuery('(hover: hover)');
  const refuseReorder = useCallback(() => {
    const message = localize('com_ui_queue_reorder_blocked');
    showToast({ message, status: 'warning' });
    onAnnounce(message);
  }, [localize, onAnnounce, showToast]);

  const [, drop] = useDrop<DragItem>({
    accept: DRAG_TYPE,
    hover(item, monitor) {
      const bounds = rowRef.current?.getBoundingClientRect();
      const pointer = monitor.getClientOffset();
      if (item.index === index || bounds == null || pointer == null) {
        return;
      }
      /* Swap on the crossing of the midpoint rather than on entry, so a row
       * does not flip back and forth under a pointer resting on its edge. */
      const middle = (bounds.bottom - bounds.top) / 2;
      const offset = pointer.y - bounds.top;
      if (item.index < index ? offset < middle : offset > middle) {
        return;
      }
      if (!canMoveTo(item.index, index, item.id)) {
        if (item.blockedTarget !== index) {
          refuseReorder();
          item.blockedTarget = index;
        }
        return;
      }
      item.blockedTarget = undefined;
      reorderQueued(item.id, index);
      item.index = index;
    },
    /* Mark releases over the rail as successful after hover has applied the
       validated reorder; releases outside every row still restore in `end`. */
    drop: () => ({}),
  });

  const move = useCallback(
    (offset: number) => {
      const target = index + offset;
      if (target < 0 || target >= total) {
        return;
      }
      if (!canMoveTo(index, target, message.id)) {
        refuseReorder();
        return;
      }
      reorderQueued(message.id, target);
      onAnnounce(localize('com_ui_queue_moved', { 0: String(target + 1), 1: String(total) }));
      /* The row travels with its message, so the handle keeps the focus it
       * had; the position it reports is what changed. */
      gripRef.current?.focus();
    },
    [canMoveTo, index, total, reorderQueued, message.id, onAnnounce, localize, refuseReorder],
  );

  const [{ isDragging }, drag] = useDrag({
    type: DRAG_TYPE,
    canDrag: reorderable && canDrag,
    item: (): DragItem => ({ id: message.id, index, order }),
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    /* The rows are moved as the pointer crosses them, so a drag the user
       abandons (Escape, or a release outside the rail) has already changed
       the queue. Dropping nowhere puts the order back. */
    end: (item, monitor) => {
      if (!monitor.didDrop()) {
        restoreQueuedOrder(item.order);
      }
    },
  });
  /* Edit and Remove both hand this row's words somewhere else across an await
     (discarding the parked server copy) and only drop the row afterwards. The
     run-end drain can land inside that gap and send the very message being
     taken back, so the row is claimed for the whole handoff and the drain skips
     anything claimed. A second click while one is open is refused rather than
     racing it. */
  const handOff = useCallback(
    async (transfer: () => Promise<boolean>) => {
      if (!claimQueuedIntent(message.id)) {
        return;
      }
      setActionPending(true);
      let handedOff = false;
      try {
        handedOff = await transfer();
      } finally {
        releaseQueuedIntent(message.id);
        setActionPending(false);
        /* The row is going back to the queue. A run end that landed while it was
           claimed found nothing unclaimed to drain and spent its one-shot
           signal on nothing, so put one back: otherwise these words sit here
           until some later generation finishes. */
        if (!handedOff) {
          steering.rewakeDrain(conversationId);
        }
      }
    },
    [message.id, steering, conversationId],
  );

  /* The composer can change while the parked copy is being cancelled, so a
     refusal after that await would leave the words only in memory, gone on the
     next reload. Put a row that had a server copy back on the durable queue,
     in its place, instead of keeping the downgraded local one. */
  const requeueDurably = useCallback(() => {
    if (message.server == null) {
      return;
    }
    steering.removeQueued(message.id);
    steering.enqueue(message.text, {
      id: message.id,
      createdAt: message.createdAt,
      files: message.files,
      quotes: message.quotes,
      manualSkills: message.manualSkills,
      ...(message.reasoningOverride != null && { reasoningOverride: message.reasoningOverride }),
      ...(message.parentMessageId != null &&
        message.expectedPredecessorCreatedAt != null && {
          lineage: {
            parentMessageId: message.parentMessageId,
            predecessorCreatedAt: message.expectedPredecessorCreatedAt,
          },
        }),
      skipUsageMark: true,
    });
  }, [message, steering]);

  /* Edit and Remove both move the row's words into the composer; they differ
     only in what the refusal says. */
  const handToComposer = useCallback(
    (blockedKey: 'com_ui_queue_edit_blocked' | 'com_ui_queue_remove_blocked') =>
      handOff(async () => {
        /* Refuse before the parked copy is given up: once it is discarded the
           row only lives in memory, and a composer that then refused would
           leave the words to vanish on the next reload. */
        if (!canRestoreToComposer(conversationId)) {
          showToast({ message: localize(blockedKey), status: 'warning' });
          return false;
        }
        const restore = () =>
          onRestoreToComposer(
            message.text,
            message.files,
            {
              quotes: message.quotes,
              manualSkills: message.manualSkills,
              ...(message.reasoningOverride != null && {
                reasoningOverride: message.reasoningOverride,
              }),
            },
            conversationId,
          );
        /* A recovered row's only durable copy is the steer parked on the
           server, and nothing can re-create it: its run ended, so there is no
           live generation to queue behind. The composer takes the words first,
           and the parked copy is cancelled only once they are there. */
        if (message.server == null && message.recoverySteerId != null) {
          if (!restore()) {
            showToast({ message: localize(blockedKey), status: 'warning' });
            return false;
          }
          if (await steering.discardQueued(message)) {
            steering.removeQueued(message.id);
            return true;
          }
          /* The words are in the composer and the parked copy survived, so the
             row stays for the user to settle; the drain must not send it too. */
          steering.holdQueued(message.id);
          return false;
        }
        /* A server row still has a parked copy; discard it through its durable
           receipt first, or the edited words would come back as a second
           message on the next reload. */
        if (!(await steering.discardQueued(message))) {
          return false;
        }
        /* Dropped only once the words are somewhere else. A paused question
           owns the composer, and removing the row anyway would leave the
           message nowhere at all. */
        if (restore()) {
          steering.removeQueued(message.id);
          return true;
        }
        /* Refusing silently reads as a dead button: the row stays, nothing
           moves, and the reason (a draft in the box, another chat on screen)
           is somewhere the click was not. */
        requeueDurably();
        showToast({ message: localize(blockedKey), status: 'warning' });
        return false;
      }),
    [
      handOff,
      steering,
      message,
      onRestoreToComposer,
      canRestoreToComposer,
      requeueDurably,
      conversationId,
      showToast,
      localize,
    ],
  );

  const editToComposer = useCallback(
    () => handToComposer('com_ui_queue_edit_blocked'),
    [handToComposer],
  );

  const removeToComposer = useCallback(
    () => handToComposer('com_ui_queue_remove_blocked'),
    [handToComposer],
  );

  drop(rowRef);
  drag(gripRef);
  const reduceMotion = useReducedMotion();

  const fileCount = message.files?.length ?? 0;
  const quoteCount = message.quotes?.length ?? 0;
  /** Any submission-owned non-steerable state (approval pause, answer mode,
   *  Assistants still generating): `sendQueuedNow` has no immediate route and
   *  would no-op. Prefer the flag the hook already exposes over re-deriving it. */
  /* A recovered item is consumed atomically only when it starts a normal
     generation. Escalating it would leave or duplicate the parked source. */
  const isRecovered = message.recoverySteerId != null;
  const reasoningRequiresNewGeneration =
    steering.duringRunActive && message.reasoningOverride != null;
  const sendDisabled =
    actionPending ||
    !serverActionable ||
    reasoningRequiresNewGeneration ||
    !steering.canSendQueuedNow ||
    (isRecovered && steering.duringRunActive);
  /** Shown for the whole run, disabled whenever steering cannot reach it:
   *  an approval pause, or the window before the start POST installs the
   *  generation epoch. Both are states the control must sit out, and hiding it
   *  through them is the discoverability gap this button closes: the pause is
   *  exactly when cutting the reply short is wanted, and the epoch window is
   *  short enough that appearing and vanishing again just reads as a flicker. */
  const showEscalate = !isRecovered && (steering.pausedOnApproval || steering.duringRunActive);

  /** The user's own hold keeps a row out of the run-end drain; a hold placed by a
   *  rejected steer belongs to its failure surface and is not released from here. */
  const held = message.needsExplicitSend === true;
  const heldByUser = message.heldByUser === true;
  const hasExtras = fileCount > 0 || quoteCount > 0 || (message.manualSkills?.length ?? 0) > 0;
  const toggleHold = useCallback(() => {
    steering.toggleQueuedHold(message.id, !heldByUser);
    /* Releasing after the run already ended would otherwise sit until some
       later generation finishes: nothing is left to wake the drain. */
    if (heldByUser) {
      steering.rewakeDrain(conversationId);
    }
  }, [steering, message.id, heldByUser, conversationId]);
  const startInNewChat = useCallback(
    () =>
      handOff(async () => {
        if (!(await steering.discardQueued(message))) {
          return false;
        }
        steering.removeQueued(message.id);
        onStartNewChat(message.text);
        return true;
      }),
    [handOff, steering, message, onStartNewChat],
  );

  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuItems: MenuItemProps[] = [
    {
      id: `${menuId}-edit`,
      label: localize('com_ui_edit_message'),
      icon: <Pencil className="h-4 w-4" aria-hidden="true" />,
      disabled: actionPending || !serverActionable || hasQueuedIntent(message.id),
      onClick: () => void editToComposer(),
    },
    {
      id: `${menuId}-new-chat`,
      label: localize('com_ui_queue_start_new_chat'),
      icon: <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />,
      show: portalElement == null,
      disabled:
        actionPending ||
        !serverActionable ||
        isRecovered ||
        hasExtras ||
        hasQueuedIntent(message.id),
      onClick: () => void startInNewChat(),
    },
    {
      id: `${menuId}-hold`,
      label: localize(heldByUser ? 'com_ui_queue_enable' : 'com_ui_queue_disable'),
      icon: heldByUser ? (
        <CirclePlay className="h-4 w-4" aria-hidden="true" />
      ) : (
        <CirclePause className="h-4 w-4" aria-hidden="true" />
      ),
      show: portalElement == null,
      disabled: actionPending || message.server != null || (held && !heldByUser),
      onClick: toggleHold,
    },
  ];
  const optionsMenu = (
    <DropdownPopup
      portal
      focusLoop
      unmountOnHide
      menuId={menuId}
      isOpen={menuOpen}
      setIsOpen={setMenuOpen}
      items={menuItems}
      className="z-50"
      trigger={
        <Ariakit.MenuButton
          render={
            <IconButton
              label={localize('com_ui_more_options')}
              size="lg"
              shape="control"
              data-testid="queued-message-options"
              disabled={actionPending}
            />
          }
        >
          <Ellipsis className="text-text-secondary h-4 w-4" aria-hidden="true" />
        </Ariakit.MenuButton>
      }
    />
  );
  const removeDisabled =
    portalElement != null
      ? actionPending ||
        hasQueuedIntent(message.id) ||
        (!serverActionable && !(message.server?.id != null && message.server.status === 'claimed'))
      : actionPending ||
        (!serverActionable &&
          !isUnconfirmed &&
          !(message.server?.id != null && message.server.status === 'claimed' && revealed));
  const removeButton = (
    <IconButton
      label={localize(
        isUnconfirmed && portalElement == null
          ? 'com_ui_dismiss_unconfirmed_delivery'
          : 'com_ui_remove_queued',
      )}
      size="lg"
      shape="control"
      disabled={removeDisabled}
      onClick={
        isUnconfirmed && portalElement == null
          ? () => steering.removeQueued(message.id)
          : removeToComposer
      }
      className="group"
      data-testid="queued-message-remove"
    >
      <Trash2
        className="text-text-secondary group-hover:text-text-destructive h-4 w-4 transition-colors"
        aria-hidden="true"
      />
    </IconButton>
  );

  if (portalElement != null) {
    return createPortal(
      <span className="flex items-center gap-1">
        {removeButton}
        {serverActionable && optionsMenu}
      </span>,
      portalElement,
      message.id,
    );
  }

  return (
    <motion.div
      ref={rowRef}
      role="listitem"
      data-testid="queued-message-row"
      layout="position"
      initial={reduceMotion ? false : { height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: isDragging ? 0.4 : 1 }}
      exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
      transition={reduceMotion ? { duration: 0 } : ROW_TRANSITION}
      className="border-border-light overflow-hidden border-b text-sm last:border-b-0"
    >
      <div className="flex min-h-14 items-center gap-2 px-3 py-2">
        <IconButton
          ref={gripRef}
          label={localize('com_ui_queue_reorder', {
            0: String(index + 1),
            1: String(total),
          })}
          size="xs"
          data-testid="queued-message-grip"
          /* Kept even when there is nowhere to move to, rather than swapped for
           an icon: a queue that drains to one message would otherwise unmount
           the handle a keyboard user was holding, dropping focus to the top of
           the page. */
          aria-disabled={!reorderable}
          /* A handle announces what it is but not how to work it, and the keys
           are the only way through it without a pointer. */
          aria-describedby={reorderable ? reorderHintId : undefined}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
              return;
            }
            /* Both keys scroll the rail's container otherwise, which would
             chase the row the press just moved. */
            event.preventDefault();
            move(event.key === 'ArrowUp' ? -1 : 1);
          }}
          className={cn(
            'group',
            reorderable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
            canDrag && reorderable && 'touch-none',
          )}
        >
          <GripVertical
            className={cn(
              'text-text-secondary group-hover:text-text-primary h-4 w-4 transition-colors',
              !reorderable && 'opacity-40',
            )}
            aria-hidden="true"
          />
        </IconButton>
        <QueuedIcon
          warning={isRejected || isUnconfirmed || isIndeterminate}
          hint={steering.duringRunActive ? localize('com_ui_steer_queued_info') : undefined}
        />
        <span className="text-text-primary min-w-0 flex-1 truncate" title={message.text}>
          {message.text}
        </span>
        {quoteCount > 0 && (
          <span className="text-text-secondary flex shrink-0 items-center gap-0.5 text-xs">
            <TextQuote className="h-3.5 w-3.5" aria-hidden="true" />
            <span aria-hidden="true">{quoteCount}</span>
            <span className="sr-only">
              {localize('com_ui_queued_quote_count', { 0: String(quoteCount) })}
            </span>
          </span>
        )}
        {fileCount > 0 && (
          <span
            className="text-text-secondary shrink-0 text-xs"
            title={localize('com_ui_queued_attachment_count', { 0: String(fileCount) })}
          >
            <span className="sr-only">
              {localize('com_ui_queued_attachment_count', { 0: String(fileCount) })}
            </span>
            <span aria-hidden="true">
              {localize(
                fileCount === 1 ? 'com_ui_attachment_count_one' : 'com_ui_attachment_count',
                {
                  count: fileCount,
                },
              )}
            </span>
          </span>
        )}
        {(isRejected || isUnconfirmed || isIndeterminate) && (
          <span className="text-status-warning shrink-0 text-xs">{localize(statusLabel)}</span>
        )}
        {heldByUser && !revealed && (
          <span className="text-text-secondary shrink-0 text-xs">
            {localize('com_ui_queue_held')}
          </span>
        )}
        {revealed && (
          <span className="text-text-secondary shrink-0 text-xs">
            {localize('com_ui_queued_turn_starting')}
          </span>
        )}
        {!revealed && (
          <>
            <Button
              variant="outline"
              shape="theme"
              disabled={sendDisabled}
              aria-disabled={sendDisabled}
              title={
                !steering.canSendQueuedNow || reasoningRequiresNewGeneration
                  ? localize('com_ui_send_now_paused')
                  : undefined
              }
              onClick={() => steering.sendQueuedNow(message)}
              className="shrink-0 disabled:pointer-events-auto disabled:cursor-not-allowed"
            >
              <span className="text-text-primary">{localize('com_ui_send_now')}</span>
            </Button>
            {showEscalate && (
              <EscalateNowButton
                surface="queued"
                size="lg"
                shape="control"
                messageText={message.text}
                disabled={
                  !steering.canSteer ||
                  interruptPending ||
                  actionPending ||
                  reasoningRequiresNewGeneration ||
                  !serverActionable
                }
                onClick={() => steering.sendQueuedNow(message, { preempt: true })}
              />
            )}
          </>
        )}
        {removeButton}
        {!revealed && optionsMenu}
      </div>
    </motion.div>
  );
}

/**
 * Messages waiting for the current reply to finish, as a rail tucked behind
 * the composer's top edge. One row per message, its actions all visible and no
 * overflow menu: the menu is where the old design hid a global preference
 * among item actions. That preference ("steering interrupts generation") lives
 * in Settings now; what stays on the row is only what acts on THAT message.
 *
 * The rail is also the running order: whatever sits at the top is what gets
 * sent when the reply lands, so local rows can be dragged past one another by
 * the handle, or moved with the arrow keys while it holds focus. Acknowledged
 * server rows are durable boundaries and cannot be crossed by either control.
 * Only the drag is pointer-bound, which is why the keys are on the handle
 * rather than under it.
 *
 * Send-now resolves itself: `sendQueuedNow` steers into the live reply when
 * the run accepts it, or sends right away once nothing is running. While a
 * run is paused on a pending approval it would only re-queue the message at
 * the front with no visible effect, so the button disables itself for that
 * case instead of pretending to act.
 */
function Queue({
  steering,
  conversationId,
  onRestoreToComposer,
  canRestoreToComposer,
  onStartNewChat,
}: QueueProps) {
  const localize = useLocalize();
  /* A revealed server turn is already shown in the live thread. Keep its
     queue receipt visible only long enough to offer safe cancellation. */
  const revealed = useAtomValue(revealedQueuedTurnFamily(steering.queueKey));
  /* Per rail, not per module: split view mounts two composers at once, and a
     shared constant id would duplicate the element and point every handle's
     `aria-describedby` at whichever copy the document happened to keep. */
  const reorderHintId = useId();
  const queued = useAtomValue(queuedMessagesByConvoId(steering.queueKey));
  const pendingSteers = useRecoilValue(store.pendingSteersByConvoId(conversationId));
  const escalating = useAtomValue(escalatingSteerFamily(conversationId));
  /* Only one interrupt can be unresolved at a time: a second arm would seal the
     same run twice. The escalating flag covers an arm's round trip, before its
     chip can show `preempt`. */
  const interruptPending = useMemo(
    () =>
      escalating ||
      pendingSteers.some((steer) => steer.preempt === true && steer.status !== 'failed'),
    [escalating, pendingSteers],
  );
  /* Spoken only for the keys. A drag reorders on every crossing, and a reader
     narrating each one would be behind the pointer and in the way of it. */
  const [announcement, setAnnouncement] = useState('');
  const order = useMemo(() => queued.map((message) => message.id), [queued]);
  const serverOwnedIds = useMemo(
    () => new Set(queued.filter((message) => message.server != null).map((message) => message.id)),
    [queued],
  );

  /* Cleared when the rail empties or the conversation changes: the region is
     removed with the rail and re-inserted with its old text still in it, which
     readers announce on insertion, so an unrelated new message replayed the
     last move. */
  const [spokenFor, setSpokenFor] = useState(steering.queueKey);
  if (spokenFor !== steering.queueKey || (queued.length === 0 && announcement !== '')) {
    setSpokenFor(steering.queueKey);
    setAnnouncement('');
  }

  const target = useQueuedTurnPortal()?.target;
  const portaledIndex =
    target?.conversationId === conversationId &&
    revealed?.clientRequestId === target.clientRequestId
      ? queued.findIndex((message) => message.clientRequestId === target.clientRequestId)
      : -1;

  const reduceMotion = useReducedMotion();
  const showRail = queued.length > (portaledIndex >= 0 ? 1 : 0);

  const renderRow = (message: QueuedMessage, index: number, portalElement?: HTMLSpanElement) => (
    <QueueRow
      key={message.id}
      message={message}
      index={index}
      total={queued.length}
      order={order}
      serverOwnedIds={serverOwnedIds}
      steering={steering}
      conversationId={conversationId}
      interruptPending={interruptPending}
      reorderHintId={reorderHintId}
      onRestoreToComposer={onRestoreToComposer}
      canRestoreToComposer={canRestoreToComposer}
      onStartNewChat={onStartNewChat}
      revealed={
        revealed != null &&
        message.clientRequestId != null &&
        revealed.clientRequestId === message.clientRequestId
      }
      portalElement={portalElement}
      onAnnounce={setAnnouncement}
    />
  );

  return (
    <>
      <AnimatePresence initial={false}>
        {showRail && (
          /* Inset by the composer's corner radius (`mx-6`, 1.5rem) so the rail's sides land
             on the straight part of the composer's top edge instead of running down into
             its curved corners, and overlapping that edge by its 1px border so the two
             surfaces meet in one clean joint. */
          <motion.div
            key="queue-rail"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : ROW_TRANSITION}
            className="mx-6 -mb-px overflow-hidden"
          >
            <div className="border-border-light bg-surface-secondary rounded-t-2xl border border-b-0">
              <div
                role="list"
                aria-label={localize('com_ui_queued_messages')}
                data-testid="composer-queue"
                className="flex flex-col"
              >
                <AnimatePresence initial={false}>
                  {queued.map((message, index) =>
                    index === portaledIndex ? null : renderRow(message, index),
                  )}
                </AnimatePresence>
              </div>
              {queued.length > 1 && (
                <span id={reorderHintId} className="sr-only">
                  {localize('com_ui_queue_reorder_hint')}
                </span>
              )}
              <span role="status" aria-live="polite" className="sr-only">
                {announcement}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {portaledIndex >= 0 &&
        target != null &&
        renderRow(queued[portaledIndex], portaledIndex, target.element)}
    </>
  );
}

export default memo(Queue);
