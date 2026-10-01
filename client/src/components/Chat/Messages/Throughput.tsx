import { memo, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { Constants } from 'librechat-data-provider';
import {
  formatRate,
  windowedRate,
  averageRate,
  formatSeconds,
  appendBounded,
  sparklinePoints,
  THROUGHPUT_HISTORY_LENGTH,
} from '~/utils';
import { throughputSamplesFamily, settledThroughputAtom } from '~/store/usage';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

const TICK_MS = 500;
const SPARKLINE_WIDTH = 48;
const SPARKLINE_HEIGHT = 12;

interface ThroughputProps {
  conversationId?: string | null;
  messageId: string;
  /** True under the latest assistant row while its generation streams. */
  streaming: boolean;
}

/**
 * Live tokens-per-second reading with a sparkline, sampled on a fixed tick
 * from the flush-driven readings so a stalled stream decays toward zero. The
 * tick is component-local state, so parents that re-render per streaming token
 * never re-render on its account. Nothing renders until the first token lands.
 */
function LiveThroughput({ conversationKey }: { conversationKey: string }) {
  const localize = useLocalize();
  const samples = useAtomValue(throughputSamplesFamily(conversationKey));
  const samplesRef = useRef(samples);
  samplesRef.current = samples;
  const [rate, setRate] = useState(0);
  const [history, setHistory] = useState<number[]>([]);

  useEffect(() => {
    const tick = () => {
      const next = windowedRate(samplesRef.current, Date.now());
      setRate(next);
      setHistory((prev) => appendBounded(prev, next, THROUGHPUT_HISTORY_LENGTH));
    };
    const intervalId = setInterval(tick, TICK_MS);
    return () => clearInterval(intervalId);
  }, []);

  if (samples.length === 0) {
    return null;
  }

  const reading = formatRate(rate);
  return (
    <span className="flex items-center gap-1.5 text-text-secondary" data-testid="stream-throughput">
      <svg
        aria-hidden="true"
        width={SPARKLINE_WIDTH}
        height={SPARKLINE_HEIGHT}
        viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
        className="shrink-0 overflow-visible"
      >
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={sparklinePoints(history, SPARKLINE_WIDTH, SPARKLINE_HEIGHT)}
        />
      </svg>
      <span aria-hidden="true" className="shimmer tabular-nums">
        {localize('com_ui_throughput_rate', { 0: reading })}
      </span>
      <span className="sr-only">
        {localize('com_ui_throughput_live_announced', { 0: reading })}
      </span>
    </span>
  );
}

/** Settled average for the response the turn just produced; session-scoped. */
function SettledThroughputReading({ messageId }: { messageId: string }) {
  const localize = useLocalize();
  const settled = useAtomValue(settledThroughputAtom).get(messageId);
  if (settled == null) {
    return null;
  }
  const reading = formatRate(averageRate(settled.outputTokens, settled.durationMs));
  const parts = [
    localize('com_ui_throughput_settled_label', {
      0: reading,
      1: String(settled.outputTokens),
      2: formatSeconds(settled.durationMs),
    }),
  ];
  if (settled.ttftMs != null) {
    parts.push(localize('com_ui_throughput_ttft', { 0: formatSeconds(settled.ttftMs) }));
  }
  if (settled.estimated) {
    parts.push(localize('com_ui_throughput_estimated'));
  }
  const label = parts.join(' ');
  return (
    <span className="flex items-center text-text-tertiary" title={label}>
      <span aria-hidden="true" className="tabular-nums" data-testid="settled-throughput">
        {localize(
          settled.estimated ? 'com_ui_throughput_rate_estimated' : 'com_ui_throughput_rate',
          { 0: reading },
        )}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Config gate kept outside the readings so disabled deployments mount nothing. */
const Throughput = memo(function Throughput({
  conversationId,
  messageId,
  streaming,
}: ThroughputProps) {
  const { data: startupConfig } = useGetStartupConfig();
  if (startupConfig?.interface?.tokenThroughput !== true) {
    return null;
  }
  if (streaming) {
    return <LiveThroughput conversationKey={conversationId ?? Constants.NEW_CONVO} />;
  }
  return <SettledThroughputReading messageId={messageId} />;
});

export default Throughput;
