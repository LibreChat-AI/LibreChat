import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCallPhase } from '~/utils/toolCallPhase';
import { useLocalize } from '~/hooks';

/** A command-local clock. Historical calls without timing metadata remain untimed. */
export default function CommandTime({
  phase,
  durationMs,
}: {
  phase: ToolCallPhase;
  durationMs?: number;
}) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
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
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
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
