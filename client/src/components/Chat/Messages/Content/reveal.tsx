import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { TriangleAlert } from 'lucide-react';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * A request to show the failed calls under a header, travelling DOWN the fold
 * tree. Expansion otherwise flows up (`onToolExpand` opens the group around a
 * row a reader clicked), so a header that wants to open a failed row three
 * disclosures below it needs its own channel. The value is a counter: each
 * request is a new number, and a consumer opens once per number it has not
 * seen. Zero is the resting value and never opens anything.
 */
export type FailedReveal = {
  tick: number;
  /** One row per request takes scroll and focus: the first failed row in
   *  document order to ask. Every other failed row still opens its panel.
   *  Null outside any provider. */
  claimFocus: (() => boolean) | null;
};

export const FailedRevealContext = createContext<FailedReveal>({ tick: 0, claimFocus: null });

/**
 * Issues requests to the consumers below. A request made while the body is
 * still unmounted waits for `ready`: a collapsed card mounts its rows in the
 * same commit that opens it, and a row that mounts under an already-advanced
 * counter would take it as the resting value and never open. Deferring the
 * increment to the commit after the rows exist is what lets one click on a
 * closed card reach an error three disclosures down.
 *
 * A provider nested under another (a group inside a phase) relays the outer
 * focus claim, so one click on the phase focuses one row across all of its
 * groups rather than one per group.
 */
export function useFailedRevealTrigger(ready: boolean): {
  value: FailedReveal;
  requestReveal: () => void;
} {
  const outer = useContext(FailedRevealContext);
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState(false);
  const claimedRef = useRef(false);
  const requestReveal = useCallback(() => {
    claimedRef.current = false;
    setPending(true);
  }, []);
  const ownClaim = useCallback(() => {
    if (claimedRef.current) {
      return false;
    }
    claimedRef.current = true;
    return true;
  }, []);
  useEffect(() => {
    if (!pending || !ready) {
      return;
    }
    setPending(false);
    setTick((previous) => previous + 1);
  }, [pending, ready]);
  const claimFocus = outer.claimFocus ?? ownClaim;
  const value = useMemo(() => ({ tick, claimFocus }), [tick, claimFocus]);
  return { value, requestReveal };
}

/**
 * Runs `onReveal` once for each request above this consumer, when the
 * consumer holds a failure, handing it the request's focus claim. The seen
 * counter is a ref, so a call that fails AFTER an earlier request does not
 * open itself on that stale request.
 */
export function useFailedReveal(
  hasFailure: boolean,
  onReveal: (claimFocus: () => boolean) => void,
): void {
  const { tick, claimFocus } = useContext(FailedRevealContext);
  const seenRef = useRef(tick);
  useEffect(() => {
    if (tick === seenRef.current) {
      return;
    }
    seenRef.current = tick;
    if (hasFailure) {
      onReveal(claimFocus ?? (() => true));
    }
  }, [tick, hasFailure, onReveal, claimFocus]);
}

/**
 * The header's failure count as the control that reaches the failures. It sits
 * BESIDE the disclosure button, never inside it: a button cannot contain a
 * button, and its name says what it does rather than repeating the count the
 * header already carries.
 */
export function FailedRevealPill({
  count,
  total,
  onReveal,
  className,
}: {
  count: number;
  total: number;
  onReveal: () => void;
  className?: string;
}) {
  const localize = useLocalize();
  if (count === 0) {
    return null;
  }
  let showFailedKey: TranslationKeys = 'com_ui_show_failed_n_of_n';
  if (count === 1 && total === 1) {
    showFailedKey = 'com_ui_show_failed_one_of_one';
  } else if (count === 1) {
    showFailedKey = 'com_ui_show_failed_one_of_n';
  }
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-transparent bg-status-error-subtle px-2 text-[11.5px] font-semibold leading-none text-status-error',
        'hover:border-status-error-border focus-visible:border-status-error focus-visible:outline-none',
        className,
      )}
      onClick={onReveal}
      aria-label={localize(showFailedKey, { 0: String(count), 1: String(total) })}
      data-testid="failed-reveal-pill"
    >
      <TriangleAlert size={12} aria-hidden="true" />
      {localize('com_ui_n_of_n_actions_failed', { 0: String(count), 1: String(total) })}
    </button>
  );
}
