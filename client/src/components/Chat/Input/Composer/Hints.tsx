import { memo } from 'react';
import type { ComposerHintState } from '~/hooks/Input/useComposerHint';
import useComposerHint from '~/hooks/Input/useComposerHint';

/** Scoped per pane: split view mounts one composer per index, and a shared id
 *  would point every textarea's `aria-describedby` at the first pane's hint. */
export const composerHintId = (index: number) => `composer-hint-${index}`;

/**
 * The dim line under the composer carrying whatever the current state affords:
 * most importantly the during-run modifiers (`⌘⏎` queue, `⌥⏎` interrupt & send),
 * which had no on-screen presence at all before.
 *
 * Ambient tips are opt-in and off by default: they are discovery copy, and the
 * row they sit on costs the thread height on every turn. A paused question and
 * the during-run modifiers report themselves either way. Upload progress is
 * already visible on the file chips, so uploads update the accessible description
 * and any existing hint row without mounting another row that moves the textarea.
 *
 * The visible line is `aria-hidden`; the current hint or upload status lives in a
 * visually-hidden node that the textarea points at via `aria-describedby`, which
 * is why hiding the line costs a screen reader nothing. An `aria-live` region
 * here would re-announce on every keystroke as the hint flips between idle and
 * typing, so the description channel carries it instead.
 */
function Hints({
  index,
  enterToSend,
  showTips,
  ...state
}: ComposerHintState & { index: number; showTips: boolean }) {
  const hint = useComposerHint({ ...state, enterToSend });
  const visible =
    showTips ||
    (hint.kind === 'state' &&
      (state.uploadingCount === 0 ||
        state.answerModeActive ||
        state.isSubmitting ||
        (state.duringRunActive && state.hasText)));

  return (
    <>
      {visible && (
        <div
          aria-hidden="true"
          data-testid="composer-hints"
          className="text-text-secondary pointer-events-none px-3 pt-1.5 text-center text-xs leading-4 select-none"
        >
          {hint.text}
        </div>
      )}
      <span id={composerHintId(index)} className="sr-only">
        {hint.text}
      </span>
    </>
  );
}

export default memo(Hints);
