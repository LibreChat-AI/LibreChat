import { memo } from 'react';
import type { ComposerHintState } from '~/hooks/Input/useComposerHint';
import useComposerHint from '~/hooks/Input/useComposerHint';

/** Scoped per pane: split view mounts one composer per index, and a shared id
 *  would point every textarea's `aria-describedby` at the first pane's hint. */
export const composerHintId = (index: number) => `composer-hint-${index}`;

/**
 * The composer's accessible description: whatever the current state affords
 * (during-run modifiers, upload progress, a paused question). It is visually
 * hidden and the textarea points at it via `aria-describedby`; no visible row is
 * rendered under the composer. An `aria-live` region here would re-announce on
 * every keystroke as the hint flips between idle and typing, so the description
 * channel carries it instead.
 */
function Hints({ index, enterToSend, ...state }: ComposerHintState & { index: number }) {
  const hint = useComposerHint({ ...state, enterToSend });

  return (
    <span id={composerHintId(index)} className="sr-only">
      {hint.text}
    </span>
  );
}

export default memo(Hints);
