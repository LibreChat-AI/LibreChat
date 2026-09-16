import React, { forwardRef, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { useWatch } from 'react-hook-form';
import { Zap, Clock, OctagonPause, ZapOff } from 'lucide-react';
import { composerSubmitClasses, SendActions, SendIcon } from '@librechat/client';
import type { SendAction } from '@librechat/client';
import type { Control } from 'react-hook-form';
import type { ComposerKeyContext, KeyChordSource } from '~/utils/shortcuts';
import type { SteeringControls } from '~/hooks/Chat/useSteering';
import { isMacPlatform, resolveComposerKeyDown } from '~/utils/shortcuts';
import useComposerBindings from '~/hooks/Input/useComposerBindings';
import { useLocalize } from '~/hooks';
import store from '~/store';

/** The rows, the popover and the chord chips are shared with every other chat
 *  surface that can submit more than one way — see `SendActions`. */
type ActionRow = SendAction;

type DuringRunSendButtonProps = {
  control: Control<{ text: string }>;
  steering: SteeringControls;
  getText: () => string;
  onConsumed: () => void;
  /** External hold (e.g. uploads in flight), mirroring the normal send button. */
  disabled?: boolean;
};

/**
 * The send button while a run is generating: it takes over the send/stop slot
 * (and `submitButtonRef`, so Enter's synthetic click routes here) whenever the
 * composer holds text: submitting steers or queues per the effective action.
 * Hovering it reveals the full action list with its shortcuts: steer, queue
 * (⌘/Ctrl+Enter routes to the non-default action), interrupt & steer
 * (⌘/Ctrl+Shift+Enter: stops writing now but keeps what is written), and
 * interrupt & send (⌥/Alt+Enter: discards the answer and starts over).
 * Clearing the composer restores the Stop button.
 */
const DuringRunSendButton = React.memo(
  forwardRef((props: DuringRunSendButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) => {
    const localize = useLocalize();
    const steerInterruptsByDefault = useRecoilValue(store.steerInterruptsByDefault);
    const enterToSend = useRecoilValue(store.enterToSend);
    const { shortcutsEnabled, submitOverride, yieldedChords } = useComposerBindings();
    const { steering } = props;
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

    /**
     * With the preference on, plain Enter routes through `submitDuringRun`,
     * which preempts. The hint has to follow it: leaving ⏎ on the ordinary
     * Steer row would advertise a key that does something else, and that row
     * deliberately stays non-preempting when CLICKED. No key reaches it in
     * this mode, so it shows none.
     */
    const enterInterrupts = primary === 'steer' && steerInterruptsByDefault;
    /** The chord that submits the default action, if any still does. */
    let submitHint: string | undefined;
    if (verdicts.plainEnter === 'submit') {
      submitHint = '⏎';
    } else if (verdicts.modEnter === 'submit') {
      submitHint = modEnter;
    }
    const alternateHint = verdicts.modEnter === 'other' ? modEnter : undefined;
    let interruptSteerKbd: string | undefined;
    if (enterInterrupts && submitHint != null) {
      interruptSteerKbd = submitHint;
    } else if (verdicts.modShiftEnter === 'preempt') {
      interruptSteerKbd = modShiftEnter;
    }

    const runAction = (action: (text: string) => boolean | void) => {
      const text = props.getText().trim();
      if (text.length === 0) {
        return;
      }
      if (action(text) !== false) {
        props.onConsumed();
      }
    };

    let steerKbd: string | undefined = alternateHint;
    if (primary === 'steer') {
      steerKbd = enterInterrupts ? undefined : submitHint;
    }

    const steerRow: ActionRow = {
      key: 'steer',
      label: localize('com_ui_steer'),
      kbd: steerKbd,
      icon: <Zap className="h-4 w-4 text-status-warning" aria-hidden="true" />,
      // Gate on availability, not the default action: the row exists to
      // override a queue-preferring default with an explicit steer.
      disabled: !steering.canSteer,
      onClick: () => runAction((text) => steering.steerFromComposer(text)),
    };
    const queueRow: ActionRow = {
      key: 'queue',
      label: localize('com_ui_queue'),
      kbd: primary === 'queue' ? submitHint : alternateHint,
      icon: <Clock className="h-4 w-4 text-status-info" aria-hidden="true" />,
      onClick: () => runAction((text) => steering.queueFromComposer(text)),
    };
    /** Keeps the half-written answer, unlike interrupt & send below it. */
    const interruptSteerRow: ActionRow = {
      key: 'interrupt-steer',
      label: localize('com_ui_interrupt_steer'),
      kbd: interruptSteerKbd,
      icon: <ZapOff className="h-4 w-4 text-status-warning" aria-hidden="true" />,
      // Matches the standalone button's gate, and deliberately NOT
      // `!canSteer` like the steer row above: `canSteer` is also false before
      // a conversation exists, where `interruptSteer` falls back to interrupt
      // & send and this row must stay live for the whole first turn.
      disabled: steering.pausedOnApproval || !steering.canControlGeneration,
      onClick: () => runAction((text) => steering.interruptSteer(text)),
    };
    const interruptRow: ActionRow = {
      key: 'interrupt',
      label: localize('com_ui_interrupt_send'),
      kbd: verdicts.altEnter === 'interrupt' ? altEnter : undefined,
      icon: <OctagonPause className="h-4 w-4 text-status-error" aria-hidden="true" />,
      disabled: !steering.canControlGeneration,
      onClick: () => runAction((text) => steering.interruptAndSend(text)),
    };
    const rows = primary === 'steer' ? [steerRow, queueRow] : [queueRow, steerRow];
    rows.push(interruptSteerRow, interruptRow);

    const label =
      primary === 'steer' ? localize('com_ui_steer_send') : localize('com_ui_queue_send');

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
              <SendIcon size={24} />
            </span>
          </button>
        }
      />
    );
  }),
);

export default DuringRunSendButton;
