import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCallPhase } from '@librechat/chat';
import { useLocalize } from '~/hooks';

/**
 * A command-local clock: ticks while the call runs, then settles on the reported
 * duration, or on the measured time when the step carries none. Owned by the card
 * rather than the display, so moving the time from the row into the panel when a
 * generated title takes over does not reset it. Historical calls without timing
 * metadata stay untimed.
 */
export function useCommandClock(phase: ToolCallPhase, durationMs?: number): number | null {
  const started = useRef(phase === 'running' ? Date.now() : null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (phase !== 'running') {
      if (started.current != null) setElapsed(Math.max(0, Date.now() - started.current));
      return;
    }
    started.current ??= Date.now();
    const tick = () => setElapsed(Math.max(0, Date.now() - (started.current ?? Date.now())));
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [phase]);
  const ms = phase === 'running' ? elapsed : (durationMs ?? elapsed);
  return ms == null || !Number.isFinite(ms) || ms < 0 ? null : ms;
}

export default function CommandTime({ phase, ms }: { phase: ToolCallPhase; ms: number | null }) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  if (ms == null) {
    return null;
  }
  const seconds = Math.round(ms / 100) / 10;
  const value = new Intl.NumberFormat(i18n.language || undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(seconds);
  return (
    <span className="text-text-secondary shrink-0 text-xs tabular-nums" data-testid="command-time">
      <span aria-hidden="true">{localize('com_ui_duration_seconds', { 0: value })}</span>
      <span className="sr-only">
        {localize(
          phase === 'running'
            ? 'com_ui_elapsed_announced_seconds'
            : 'com_ui_duration_announced_seconds',
          { count: seconds, value },
        )}
      </span>
    </span>
  );
}
