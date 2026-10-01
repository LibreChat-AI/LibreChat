import { forwardRef, useState } from 'react';
import type {
  ForwardRefExoticComponent,
  KeyboardEvent,
  ReactNode,
  Ref,
  RefAttributes,
} from 'react';
import type { SendAction } from './SendActions';
import {
  composerSubmitClasses,
  composerSurfaceClasses,
  composerSurfaceShadow,
} from '~/utils/composer';
import { TextareaAutosize } from './TextareaAutosize';
import { SendActions } from './SendActions';
import { TooltipAnchor } from './Tooltip';
import { SendIcon } from '~/svgs';
import { cn } from '~/utils';

/** What a key press means to the composer. Mirrors the main chat form's own
 *  verdicts: `block` is "swallow it, do nothing", `newline` and `none` both
 *  leave the key to the field. */
export type ComposerKeyVerdict = 'submit' | 'block' | 'newline' | 'none';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Given the key event that asked for the submission, or nothing when a
   *  pointer asked. Hosts that vary the action by chord resolve it from this
   *  event rather than from state left behind by an earlier keypress. */
  onSubmit: (event?: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Blocks submission without disabling the field, so a reader can still type
   *  and read back a draft the surface is not ready to accept. */
  canSubmit: boolean;
  submitLabel: string;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
  minRows?: number;
  maxRows?: number;
  /** Secondary controls, laid out inline-start of the send button. */
  actions?: ReactNode;
  /**
   * Alternate submissions, revealed from the send control on hover or focus —
   * the same trade main chat's during-run send button makes, so the field is
   * never lined with controls that repeat what submitting already does. The
   * primary submission stays the button's own click.
   */
  submitActions?: SendAction[];
  submitActionsLabel?: string;

  /**
   * The reader's "Press Enter to send" preference. When false, Enter inserts a
   * newline and ⌘/Ctrl+Enter submits — the same bargain the main chat composer
   * strikes, so a reader who turned the preference off cannot steer a run or
   * leave for a continued chat by reaching for a line break.
   */
  submitOnEnter?: boolean;
  /**
   * The host's own key policy, so a reader who rebound (or unbound) the submit
   * shortcut gets the same contract they get in the main chat form, and chords
   * claimed by global shortcuts are left for the window handler. Given the
   * event and whether an IME is mid-composition. Without it, `submitOnEnter`
   * drives a plain Enter / ⌘-Ctrl+Enter contract.
   */
  resolveKeyVerdict?: (
    event: KeyboardEvent<HTMLTextAreaElement>,
    isComposing: boolean,
  ) => ComposerKeyVerdict;
  className?: string;
}

/**
 * Stops whatever this surface is running. When supplied, an empty field shows
 * main chat's Stop in the send button's place — the same trade the main
 * composer makes, so "nothing to send" and "stop what is running" never need
 * two separate controls. The label travels with the handler so the control can
 * never render without an accessible name.
 */
export type ComposerStopProps =
  | { onStop: () => void; stopLabel: string }
  | { onStop?: undefined; stopLabel?: undefined };

export type ComposerPropsWithStop = ComposerProps & ComposerStopProps;

/** Main chat's send/stop button shape, shared by both states of the slot. */
const CONTROL_CLASS = composerSubmitClasses();

/**
 * The chat composer at panel scale: one persistent surface with a text field, a
 * stable action row, and the same send affordance the main chat form uses.
 *
 * It is deliberately state-free. Every surface that hosts a conversation beside
 * the main thread (a subagent thread, a side chat) owns what Enter means for it
 * and passes that in as `onSubmit`, so the affordance never has to be swapped
 * out for a different control when a run settles — which is what makes the
 * footer shift under the reader.
 */
const Composer: ForwardRefExoticComponent<
  ComposerPropsWithStop & RefAttributes<HTMLTextAreaElement>
> = forwardRef(function Composer(
  {
    value,
    onChange,
    onSubmit,
    canSubmit,
    submitLabel,
    ariaLabel,
    placeholder,
    disabled = false,
    maxLength,
    minRows = 1,
    maxRows = 6,
    actions,
    submitActions,
    submitActionsLabel,
    onStop,
    stopLabel,
    submitOnEnter = true,
    resolveKeyVerdict,
    className,
  }: ComposerPropsWithStop,
  ref: Ref<HTMLTextAreaElement>,
) {
  const [isComposing, setIsComposing] = useState(false);
  /** Nothing to send and something to stop: main chat swaps the same slot
   *  rather than standing a second control beside it. */
  const showStop = onStop != null && value.trim() === '';
  const offeredActions = canSubmit ? (submitActions ?? []) : [];
  const sendButton = (
    <button
      type="button"
      aria-label={submitLabel}
      disabled={disabled || !canSubmit}
      onClick={() => onSubmit()}
      data-testid="composer-send-button"
      className={cn(CONTROL_CLASS, offeredActions.length > 0 && 'ml-auto')}
    >
      <SendIcon size={24} />
    </button>
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    /**
     * `isComposing` alone does not settle the IME question: Safari reports it
     * as false on the very Enter that commits a candidate, so the tracked
     * composition state and the legacy `Process`/229 signals stand in for it,
     * as the main chat composer's own guard does. Committed here rather than
     * left to the host so every caller inherits it.
     */
    const composing =
      isComposing ||
      event.nativeEvent.isComposing ||
      event.key === 'Process' ||
      event.keyCode === 229;

    const defaultVerdict = (): ComposerKeyVerdict => {
      if (composing || event.key !== 'Enter' || event.shiftKey) return 'none';
      if (!submitOnEnter && !(event.metaKey || event.ctrlKey)) return 'newline';
      return 'submit';
    };

    const verdict = resolveKeyVerdict?.(event, composing) ?? defaultVerdict();
    if (verdict === 'newline' || verdict === 'none') return;
    event.preventDefault();
    /** An empty field never submits, even where the surface would accept it:
     *  a caller whose action needs no text (continuing a settled thread)
     *  still wants that to be a deliberate press of the button, not a stray
     *  Enter that navigates the reader somewhere. */
    if (verdict === 'block' || !canSubmit || value.trim() === '') return;
    onSubmit(event);
  };

  return (
    <div
      className={cn(
        'rounded-theme-surface-lg flex w-full flex-col gap-1.5 p-2.5',
        composerSurfaceClasses(),
        composerSurfaceShadow.within,
        className,
      )}
    >
      <TextareaAutosize
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        maxLength={maxLength}
        minRows={minRows}
        maxRows={maxRows}
        disabled={disabled}
        /** Main chat's own field metrics (`ChatForm`'s `baseClasses`), so the
         *  two composers stand the same height and their surfaces line up
         *  when this panel is open beside the thread. */
        className="text-text-primary placeholder:text-text-tertiary m-0 w-full resize-none bg-transparent px-3 py-[13px] focus:outline-hidden disabled:cursor-not-allowed md:py-3.5"
      />
      {/* The row holds its height whether or not it carries secondary actions,
          so the surface cannot resize as a run changes what it offers. */}
      <div className="flex min-h-9 flex-wrap items-center gap-1.5">
        {actions}
        {showStop ? (
          <TooltipAnchor
            description={stopLabel}
            className="ml-auto"
            render={
              <button
                type="button"
                aria-label={stopLabel}
                onClick={onStop}
                data-testid="composer-stop-button"
                className={CONTROL_CLASS}
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  className="icon-lg text-surface-primary"
                  aria-hidden="true"
                >
                  <rect x="7" y="7" width="10" height="10" rx="1.25" fill="currentColor" />
                </svg>
              </button>
            }
          />
        ) : (
          <SendActions
            actions={offeredActions}
            label={submitActionsLabel ?? submitLabel}
            anchor={
              /** One popup over this control. With actions to offer, the list
               *  names them and carries the primary; a tooltip would open on
               *  the same focus, above the same button, and at a higher
               *  z-index than the list it would cover. */
              offeredActions.length > 0 ? (
                sendButton
              ) : (
                <TooltipAnchor description={submitLabel} className="ml-auto" render={sendButton} />
              )
            }
          />
        )}
      </div>
    </div>
  );
});

export default Composer;
