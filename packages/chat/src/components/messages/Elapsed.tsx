import { memo, useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useLocalize, useLanguage } from '@librechat/client';
import type { NamedExoticComponent } from 'react';
import { submissionStartFamily } from '../../react/generation';
import { getElapsedDurationLabels } from './duration';

const elapsedSeconds = (start: number): number =>
  Math.max(0, Math.floor((Date.now() - start) / 1000));

type ElapsedVisibility = {
  isSubmitting: boolean;
  isLatestMessage: boolean;
  isCreatedByUser?: boolean;
  siblingIdx?: number;
  siblingCount?: number;
};

/**
 * Whether the elapsed indicator belongs under a row: the latest assistant row
 * while its generation streams — but only at the newest sibling position.
 * `latestMessageId` follows the SELECTED branch, so during a regeneration a
 * settled older sibling the reader paged to mid-stream would otherwise satisfy
 * the same latest+submitting gate the withheld hover actions use, and a
 * counting timer under settled content misleads in a way hidden buttons don't.
 */
export const shouldShowElapsed = ({
  isSubmitting,
  isLatestMessage,
  isCreatedByUser,
  siblingIdx,
  siblingCount,
}: ElapsedVisibility): boolean =>
  isSubmitting &&
  isLatestMessage &&
  isCreatedByUser !== true &&
  (siblingIdx ?? 0) === (siblingCount ?? 1) - 1;

/**
 * Elapsed generation time under the actively streaming response, in the footer
 * slot the hover actions occupy once the answer lands. The once-per-second tick
 * is component-local state, so parents that re-render per streaming token never
 * re-render on its account. The compact reading is hidden from assistive
 * technology in favor of a spoken equivalent; neither is an `aria-live` region,
 * so the tick never announces.
 *
 * The reading carries the same shimmer a running tool call's label carries. It
 * only ever renders mid-generation (see `shouldShowElapsed`), so there is no
 * settled state for the animation to misrepresent.
 */
const Elapsed: NamedExoticComponent<{ index: number }> = memo(function Elapsed({
  index,
}: {
  index: number;
}) {
  const submissionStart = useAtomValue(submissionStartFamily(index));
  return <ElapsedTimer start={submissionStart ?? undefined} />;
});

/** The bare ticker behind `Elapsed`, for surfaces whose start time does not
 *  come from the chat submission store (e.g. subagent turns started by their
 *  trigger). Falls back to mount time when no start is known. */
export const ElapsedTimer: NamedExoticComponent<{ start?: number }> = memo(function ElapsedTimer({
  start: startAt,
}: {
  start?: number;
}) {
  const localize = useLocalize();
  const language = useLanguage();
  const [mountTime] = useState(() => Date.now());
  const start = startAt ?? mountTime;
  const [seconds, setSeconds] = useState(() => elapsedSeconds(start));

  useEffect(() => {
    setSeconds(elapsedSeconds(start));
    const intervalId = setInterval(() => setSeconds(elapsedSeconds(start)), 1000);
    return () => clearInterval(intervalId);
  }, [start]);

  const labels = getElapsedDurationLabels(seconds * 1000, language);
  /** `ps-1.5` puts the reading on the column everything else in this slot
   *  shares: the streaming dot pads the same 6px to center on the size-6
   *  header icon's axis (see `EmptyTextPart`), and the hover-button glyphs
   *  that replace the timer sit behind the same `p-1.5`. Inline-start, so
   *  the alignment holds in RTL. */
  return (
    <span className="text-text-secondary flex items-center ps-1.5">
      <span aria-hidden="true" className="shimmer tabular-nums" data-testid="stream-elapsed">
        {localize(labels.key, labels.values)}
      </span>
      <span className="sr-only">{localize(labels.announcedKey, labels.announcedValues)}</span>
    </span>
  );
});

export default Elapsed;
