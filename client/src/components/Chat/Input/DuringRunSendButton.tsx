import React, { forwardRef, useMemo, useRef } from 'react';
import { useWatch } from 'react-hook-form';
import { Zap, Clock, ZapOff } from 'lucide-react';
import { composerSubmitClasses, SendActions, SendIcon } from '@librechat/client';
import type { SendAction } from '@librechat/client';
import type { Control } from 'react-hook-form';
import type { ComposerKeyContext, KeyChordSource } from '~/utils/shortcuts';
import type { SteeringControls } from '~/hooks/Chat/useSteering';
import { isMacPlatform, resolveComposerKeyDown } from '~/utils/shortcuts';
import useComposerBindings from '~/hooks/Input/useComposerBindings';
import { useLocalize } from '~/hooks';

/** The rows, the popover and the chord chips are shared with every other chat
 *  surface that can submit more than one way — see `SendActions`. */
type ActionRow = SendAction;

const ACTION_LABELS = {
  steer: 'com_ui_steer_send',
  interrupt: 'com_ui_interrupt_steer',
  queue: 'com_ui_queue_send',
} as const;

type DuringRunSendButtonProps = {
  control: Control<{ text: string }>;
  steering: SteeringControls;
  isNewConversation: boolean;
  getText: () => string;
  onConsumed: () => void;
  /** External hold (e.g. uploads in flight), mirroring the normal send button. */
  disabled?: boolean;
  /** Host-owned: whether Enter sends, so the rows advertise what the key handler does. */
  enterToSend: boolean;
};

/** The active mode owns submission; the menu overrides it for one message. */
const DuringRunSendButton = React.memo(
  forwardRef((props: DuringRunSendButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) => {
    const localize = useLocalize();
    const { shortcutsEnabled, submitOverride, yieldedChords } = useComposerBindings();
    const { steering, enterToSend } = props;
    const disabledRef = useRef(props.disabled);
    disabledRef.current = props.disabled;
    const data = useWatch({ control: props.control });
    const content = data?.text?.trim();
    const primary = steering.effectiveAction;
    const modEnter = isMacPlatform ? '⌘⏎' : 'Ctrl ⏎';
    const altEnter = isMacPlatform ? '⌥⏎' : 'Alt ⏎';
    const modShiftEnter = isMacPlatform ? '⌘⇧⏎' : 'Ctrl ⇧ ⏎';

    /**
     * What each canonical chord actually does right now, asked of the same
     * decision table the composer executes. A hint only appears on a row its
     * chord still triggers: a chord rebound to a global shortcut (or claimed
     * by a rebound submit) is dropped rather than advertised on a row it no
     * longer reaches, and with Enter-to-send off, plain Enter inserts a
     * newline during a run, so ⌘/Ctrl+Enter carries the default action.
     */
    const verdicts = useMemo(() => {
      const ctx: ComposerKeyContext = {
        isComposing: false,
        isSubmitting: true,
        allowSubmitWhileGenerating: true,
        hasDuringRunModifier: true,
        shortcutsEnabled,
        enterToSend,
        submitOverride,
        yieldedChords,
      };
      const chord = (init: Partial<KeyChordSource>) =>
        resolveComposerKeyDown(
          { key: 'Enter', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init },
          ctx,
        );
      const mod = isMacPlatform ? { metaKey: true } : { ctrlKey: true };
      return {
        plainEnter: chord({}),
        modEnter: chord(mod),
        modShiftEnter: chord({ ...mod, shiftKey: true }),
        altEnter: chord({ altKey: true }),
      };
    }, [enterToSend, shortcutsEnabled, submitOverride, yieldedChords]);

    /** The chord that submits the default action, if any still does. */
    let submitHint: string | undefined;
    if (verdicts.plainEnter === 'submit') {
      submitHint = '⏎';
    } else if (verdicts.modEnter === 'submit') {
      submitHint = modEnter;
    }
    const alternateHint = verdicts.modEnter === 'other' ? modEnter : undefined;
    let interruptSteerKbd: string | undefined;
    if (primary === 'interrupt' && submitHint != null) {
      interruptSteerKbd = submitHint;
    } else if (verdicts.modShiftEnter === 'preempt') {
      interruptSteerKbd = modShiftEnter;
    }

    const runAction = (action: (text: string) => boolean | void) => {
      if (disabledRef.current) {
        return;
      }
      const text = props.getText().trim();
      if (text.length === 0) {
        return;
      }
      if (action(text) !== false) {
        props.onConsumed();
      }
    };

    let steerKbd: string | undefined = primary === 'queue' ? alternateHint : undefined;
    if (primary === 'steer') {
      steerKbd = submitHint;
    }

    const steerRow: ActionRow = {
      key: 'steer',
      label: localize('com_ui_steer'),
      kbd: steerKbd,
      icon: <Zap className="text-status-warning h-4 w-4" aria-hidden="true" />,
      // A staged reasoning choice is a queued full turn, not a live steer.
      disabled: props.disabled || !steering.canSteer || steering.pendingReasoningOverride != null,
      onClick: () => runAction((text) => steering.steerFromComposer(text)),
    };
    const queueRow: ActionRow = {
      key: 'queue',
      label: localize('com_ui_queue'),
      kbd: primary === 'queue' ? submitHint : alternateHint,
      icon: <Clock className="text-status-info h-4 w-4" aria-hidden="true" />,
      disabled: props.disabled,
      onClick: () => runAction((text) => steering.queueFromComposer(text)),
    };
    /** Interrupt never becomes a stop-and-send fallback. */
    const interruptSteerRow: ActionRow = {
      key: 'interrupt-steer',
      label: localize('com_ui_interrupt_steer'),
      kbd: interruptSteerKbd,
      icon: <ZapOff className="text-status-warning h-4 w-4" aria-hidden="true" />,
      disabled:
        props.disabled ||
        steering.pausedOnApproval ||
        !steering.canSteer ||
        steering.pendingReasoningOverride != null,
      onClick: () => runAction((text) => steering.interruptSteer(text)),
    };
    if (interruptSteerKbd == null && verdicts.altEnter === 'interrupt') {
      interruptSteerRow.kbd = altEnter;
    }
    const rows = [steerRow, interruptSteerRow, queueRow];
    const label = localize(ACTION_LABELS[primary]);

    return (
      <SendActions
        actions={rows}
        label={localize('com_ui_during_run_actions')}
        anchor={
          <button
            ref={ref}
            aria-label={label}
            disabled={!content || props.disabled === true}
            className={composerSubmitClasses()}
            data-testid="during-run-send-button"
            data-during-run-action={primary}
            type="submit"
          >
            <span data-state="closed">
              <SendIcon className="size-6" />
            </span>
          </button>
        }
      />
    );
  }),
);

export default DuringRunSendButton;
