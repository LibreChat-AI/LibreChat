import { useState, useRef, useEffect } from 'react';
import { useAtom } from 'jotai';
import { Minus, Plus } from 'lucide-react';
import { Button, clampUiScale } from '@librechat/client';
import { uiScaleAtom } from '~/store/uiScale';
import { useLocalize } from '~/hooks';

/** The stops browsers themselves step through for Ctrl -/+. */
const SCALE_STOPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
const EPSILON = 0.001;
/**
 * Rescaling the app moves this control, since it lives inside the panel it
 * resizes. Holding the reflow until clicks stop keeps the buttons under the
 * pointer while stepping, so a second click cannot miss a button that moved.
 */
const REFLOW_DELAY_MS = 260;

export default function UiScaleSelector() {
  const localize = useLocalize();
  const [uiScale, setUiScale] = useAtom(uiScaleAtom);
  const [pending, setPending] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<number | null>(null);
  const applyRef = useRef(setUiScale);
  applyRef.current = setUiScale;

  useEffect(() => {
    const flushPending = () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (pendingRef.current != null) {
        const next = pendingRef.current;
        pendingRef.current = null;
        applyRef.current(next);
      }
    };
    const handlePageHide = () => {
      flushPending();
      setPending(null);
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      flushPending();
    };
  }, []);

  const scale = clampUiScale(pending ?? uiScale);
  const percent = Math.round(scale * 100);
  const nextUp = SCALE_STOPS.find((stop) => stop > scale + EPSILON);
  const nextDown = [...SCALE_STOPS].reverse().find((stop) => stop < scale - EPSILON);
  const labelId = 'ui-scale-selector-label';

  const step = (next: number | undefined): void => {
    if (next == null) {
      return;
    }
    setPending(next);
    pendingRef.current = next;
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      pendingRef.current = null;
      setPending(null);
      applyRef.current(next);
    }, REFLOW_DELAY_MS);
  };

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div id={labelId}>{localize('com_nav_ui_scale')}</div>
      <div
        className="flex max-w-full flex-wrap items-center gap-2"
        role="group"
        aria-labelledby={labelId}
      >
        <Button
          variant="outline"
          size="icon"
          className="size-9"
          onClick={() => step(nextDown)}
          disabled={nextDown == null}
          aria-label={localize('com_nav_ui_scale_decrease')}
          data-testid="ui-scale-decrease"
        >
          <Minus className="size-4" aria-hidden="true" />
        </Button>
        <span
          className="text-text-primary w-12 text-center text-sm tabular-nums"
          aria-live="polite"
        >
          {percent}%
        </span>
        <Button
          variant="outline"
          size="icon"
          className="size-9"
          onClick={() => step(nextUp)}
          disabled={nextUp == null}
          aria-label={localize('com_nav_ui_scale_increase')}
          data-testid="ui-scale-increase"
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
