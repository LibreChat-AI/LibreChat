import { memo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getRunStepDurationLabels } from '~/utils';
import { useLocalize } from '~/hooks';

const TICK_MS = 1_000;

/**
 * One clock for every running row. It ticks only while something reads it, and what reads it is
 * the text that shows a duration: a second passing redraws those few words and nothing around
 * them, where a clock held by the rail would redraw every row each second.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let current = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer == null) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const read = (): number => current;

/** How long something took, or has taken so far. */
export const Duration = memo(function Duration({ ms }: { ms: number }) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const duration = getRunStepDurationLabels(Math.max(0, ms), i18n.language);
  return (
    <span
      className="tabular-nums"
      aria-label={localize(duration.announcedKey, duration.announcedValues)}
    >
      {localize(duration.key, duration.values)}
    </span>
  );
});

/** The time since `startedAt`, counted as it passes. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const now = useSyncExternalStore(subscribe, read, read);
  return <Duration ms={now - startedAt} />;
}

export default memo(Elapsed);
