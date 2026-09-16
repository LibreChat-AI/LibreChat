import { useMemo } from 'react';
import type { LocalizeFunction } from '~/common';
import { isMacPlatform, bindingDisplayString } from '~/utils/shortcuts';
import useComposerBindings from '~/hooks/Input/useComposerBindings';
import { useShortcutDisplay } from '~/hooks/useKeyboardShortcuts';
import useLocalize from '~/hooks/useLocalize';

/** The effective `submitMessage` binding, reduced to what the hints need.
 *  `customized` false means the stock modifier chord applies; a customized
 *  binding replaces it, and a cleared one leaves no chord at all. */
export interface SendBinding {
  customized: boolean;
  display: string;
}

const DEFAULT_SEND_BINDING: SendBinding = { customized: false, display: '' };

export interface ComposerHintState {
  hasText: boolean;
  isSubmitting: boolean;
  /** Enter steers or queues instead of starting a turn. */
  duringRunActive: boolean;
  /** Whether the run can be reached yet. `isSubmitting` flips as soon as the
   *  user sends, but the start POST installs the generation epoch a moment
   *  later, and until it lands every chord that touches the live run refuses.
   *  Queueing is local, so it works throughout. */
  canControlGeneration: boolean;
  /** Which action Enter takes during a run, per the effective setting. */
  duringRunAction: 'steer' | 'queue';
  /** Whether the steer route can accept input right now. A paused tool
   *  approval forces the effective action to queue and refuses steers, so the
   *  live-send alternate must not be advertised through it. */
  canSteer: boolean;
  /** The composer is the answer box for a paused `ask_user_question`. */
  answerModeActive: boolean;
  uploadingCount: number;
  /** Plain Enter submits. When off, Enter inserts a newline and the modifier
   *  chord is what submits, which inverts every shortcut named below. */
  enterToSend: boolean;
}

/**
 * `tip` is ambient discovery copy, true of the composer at all times. `state`
 * reports something happening right now. Only the first is worth permanent
 * space, so the two are distinguished here rather than at the call site.
 */
export type ComposerHintKind = 'tip' | 'state';

export interface ComposerHint {
  text: string;
  kind: ComposerHintKind;
}

const SEPARATOR = ' · ';

/**
 * Resolves the one line shown under the composer. Ordered most-specific first:
 * a paused question owns the composer outright, an in-flight upload is the most
 * urgent transient state, and the during-run modifiers only matter once there
 * is text for them to act on.
 *
 * Exported separately from the hook so the state matrix is testable without
 * rendering.
 */
export function composeHint(
  state: ComposerHintState,
  localize: LocalizeFunction,
  isMac: boolean,
  /** The live binding for `stopGenerating`, which the user can rebind or clear
   *  outright, so the stop line is built from it rather than naming a key. */
  stopShortcut: string,
  /** The live `submitMessage` binding, for the same reason: the send chords
   *  named below follow the customization instead of asserting the stock one. */
  sendBinding: SendBinding = DEFAULT_SEND_BINDING,
): ComposerHint {
  if (state.answerModeActive) {
    return { text: localize('com_ui_composer_hint_answer'), kind: 'state' };
  }

  if (state.uploadingCount > 0) {
    return {
      text: localize(
        state.uploadingCount === 1
          ? 'com_ui_composer_hint_uploading_one'
          : 'com_ui_composer_hint_uploading',
        { count: state.uploadingCount },
      ),
      kind: 'state',
    };
  }

  if (state.duringRunActive && state.hasText) {
    const mod = isMac ? '⌘⏎' : 'Ctrl+⏎';
    const alt = isMac ? '⌥⏎' : 'Alt+⏎';
    /* A customized binding replaces the stock chord as what triggers the
       default action; it also makes the modifier's alternate route unreachable
       (`resolveComposerKeyDown` only maps it with the stock binding), so the
       alternate is named only while the stock chord still works. */
    const sendChord = sendBinding.customized ? sendBinding.display : mod;
    const isSteer = state.duringRunAction === 'steer';
    /* With plain Enter bound to a newline, the chord IS the default action and
       there is no second chord left to reach the alternate one, so the hint
       names only what the composer will actually do. */
    const defaultAction = isSteer
      ? localize('com_ui_composer_hint_steer')
      : localize('com_ui_composer_hint_queue_default');
    const alternateAction = isSteer
      ? `${mod} ${localize('com_ui_composer_hint_queue')}`
      : `${mod} ${localize('com_ui_composer_hint_send_now')}`;
    const chordVerb = isSteer
      ? 'com_ui_composer_hint_steer_verb'
      : 'com_ui_composer_hint_queue_verb';
    const parts: string[] = [];
    if (state.enterToSend) {
      parts.push(defaultAction);
      /* The queue alternate is local and always lands; the send-now alternate
         rides the steer route, which a paused approval refuses. */
      if (!sendBinding.customized && (isSteer || state.canSteer)) {
        parts.push(alternateAction);
      }
    } else if (sendChord) {
      parts.push(`${sendChord} ${localize(chordVerb)}`);
    }
    /* Until the start POST installs the generation epoch, every chord that
       reaches the live run refuses; only the default action survives, because
       queueing is local. Naming the others through that window advertises keys
       that do nothing, the same failure as pointing at an unbound shortcut. */
    if (!state.canControlGeneration) {
      return {
        text: parts[0] ?? localize('com_ui_composer_hint_running'),
        kind: 'state',
      };
    }
    return {
      text: [...parts, `${alt} ${localize('com_ui_composer_hint_interrupt')}`].join(SEPARATOR),
      kind: 'state',
    };
  }

  if (state.isSubmitting) {
    /* Nothing to advertise when the binding has been cleared: the stop button
       is right there, and naming a key that does nothing is worse than saying
       only that a reply is running. */
    return {
      text: stopShortcut
        ? `${stopShortcut} ${localize('com_ui_composer_hint_stop')}`
        : localize('com_ui_composer_hint_running'),
      kind: 'state',
    };
  }

  if (state.hasText) {
    if (!state.enterToSend) {
      const mod = isMac ? '⌘⏎' : 'Ctrl+⏎';
      const sendChord = sendBinding.customized ? sendBinding.display : mod;
      /* A cleared binding leaves no key that sends, and naming one that does
         nothing is worse than the plain typing tip. */
      if (sendChord) {
        return {
          text: [
            `${sendChord} ${localize('com_ui_composer_hint_send')}`,
            `⏎ ${localize('com_ui_composer_hint_newline')}`,
          ].join(SEPARATOR),
          kind: 'tip',
        };
      }
    }
    return { text: localize('com_ui_composer_hint_typing'), kind: 'tip' };
  }

  return { text: localize('com_ui_composer_hint_idle'), kind: 'tip' };
}

export default function useComposerHint(state: ComposerHintState): ComposerHint {
  const localize = useLocalize();
  const stopShortcut = useShortcutDisplay('stopGenerating');
  const { submitOverride } = useComposerBindings();
  const sendBinding = useMemo<SendBinding>(
    () => ({
      customized: submitOverride !== undefined,
      display: submitOverride ? bindingDisplayString(submitOverride, isMacPlatform) : '',
    }),
    [submitOverride],
  );
  return composeHint(state, localize, isMacPlatform, stopShortcut, sendBinding);
}
