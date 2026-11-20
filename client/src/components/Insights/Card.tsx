import { useId, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import type { VersionMark } from './versions';
import { useElementSize, useLocalize } from '~/hooks';
import { tagAnchor, visibleTags } from './versions';
import { formatMetric } from './format';
import { Panel } from './Panel';
import { cn } from '~/utils';

type SparklinePoint = { date: string; value: number };

export type KpiCardData = {
  id:
    | 'conversations'
    | 'users'
    | 'messages'
    | 'tokens'
    | 'responses'
    | 'spend'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'thumbs-up'
    | 'thumbs-down';
  title: string;
  description?: string;
  value: number;
  format?: 'currency';
  sparkline: SparklinePoint[];
};

const tagAlignment = { start: '', center: '-translate-x-1/2', end: '-translate-x-full' };

function Sparkline({
  values,
  label,
  locale,
  format,
  versionMarks,
}: {
  values: SparklinePoint[];
  label: string;
  locale: string;
  format?: 'currency';
  versionMarks?: VersionMark[];
}) {
  const patternId = useId().replace(/:/g, '');
  const [activeIndex, setActiveIndex] = useState<number>();
  const { ref: chartRef, width: chartWidth } = useElementSize<HTMLDivElement>();
  const points = useMemo(() => {
    if (values.length < 2) {
      return [];
    }
    const maximum = Math.max(0, ...values.map((point) => point.value)) || 1;
    return values.map((point, index) => ({
      ...point,
      x: (index / (values.length - 1)) * 300,
      y: 52 - (point.value / maximum) * 46,
    }));
  }, [values]);

  if (points.length < 2) {
    return <div className="h-14" />;
  }

  const line = points.map((point) => `${point.x},${point.y}`).join(' ');
  const area = `M 0 56 L ${points.map((point) => `${point.x} ${point.y}`).join(' L ')} L 300 56 Z`;
  const activePoint = activeIndex == null ? undefined : points[activeIndex];
  const activeVersion = activeIndex == null ? undefined : versionMarks?.[activeIndex]?.label;
  const formatter = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const markedVersions = points.flatMap((point, index) => {
    const mark = versionMarks?.[index];
    if (!mark?.marked || !mark.label || !mark.tag) return [];
    return [
      {
        x: point.x,
        position: (point.x / 300) * 100,
        tag: mark.tag,
        description: `${formatter.format(new Date(point.date))}: ${mark.label}`,
      },
    ];
  });
  const shownTags = visibleTags(
    markedVersions.map(({ position, tag }) => ({ position, text: tag })),
    chartWidth,
  );

  return (
    <div
      dir="ltr"
      ref={chartRef}
      className={cn(
        'text-status-info relative h-14 w-full outline-hidden',
        markedVersions.length > 0 ? 'mt-7' : 'mt-2',
      )}
      role="img"
      tabIndex={0}
      aria-label={[label, ...markedVersions.map(({ description }) => description)].join('. ')}
      onFocus={() => setActiveIndex(points.length - 1)}
      onBlur={() => setActiveIndex(undefined)}
      onMouseLeave={() => setActiveIndex(undefined)}
      onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
        setActiveIndex(Math.round(ratio * (points.length - 1)));
      }}
    >
      <svg
        className="h-full w-full overflow-visible"
        viewBox="0 0 300 56"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse">
            <path
              d="M-1 1 L1 -1 M0 6 L6 0 M5 7 L7 5"
              stroke="currentColor"
              strokeWidth="0.8"
              opacity="0.22"
            />
          </pattern>
        </defs>
        <path d={area} fill={`url(#${patternId})`} />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {markedVersions.map(({ x }) => (
          <line
            key={x}
            data-testid="insights-version-marker"
            className="text-text-secondary"
            x1={x}
            x2={x}
            y1={0}
            y2={56}
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {markedVersions.map(({ x, position, tag }, index) =>
        shownTags.has(index) ? (
          <span
            key={x}
            aria-hidden="true"
            className={cn(
              'text-text-secondary pointer-events-none absolute bottom-full mb-1 text-xs whitespace-nowrap',
              tagAlignment[tagAnchor(position)],
            )}
            style={{ left: `${position}%` }}
          >
            {tag}
          </span>
        ) : null,
      )}
      {activePoint && (
        <>
          <span
            className="bg-border-medium pointer-events-none absolute top-0 h-full w-px"
            style={{ left: `${(activePoint.x / 300) * 100}%` }}
          />
          <span
            className="bg-status-info ring-surface-primary pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2"
            style={{
              left: `${(activePoint.x / 300) * 100}%`,
              top: `${(activePoint.y / 56) * 100}%`,
            }}
          />
          <span
            className="border-border-light bg-surface-primary text-text-primary pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-lg border px-2.5 py-1.5 text-xs whitespace-nowrap shadow-lg"
            style={{ left: `${Math.max(14, Math.min(86, (activePoint.x / 300) * 100))}%` }}
          >
            {formatter.format(new Date(activePoint.date))}{' '}
            <strong>{formatMetric(activePoint.value, locale, format)}</strong>
            {activeVersion && <span className="text-text-secondary block">{activeVersion}</span>}
          </span>
        </>
      )}
    </div>
  );
}

export function KpiCard({
  card,
  locale,
  headingLevel: Heading = 'h2',
  versionMarks,
}: {
  card: KpiCardData;
  locale: string;
  headingLevel?: 'h2' | 'h3';
  versionMarks?: VersionMark[];
}) {
  const localize = useLocalize();
  return (
    <Panel>
      <Heading className="text-text-muted inline-flex items-center gap-1.5 text-sm font-normal">
        {card.title}
        {card.description && (
          <TooltipAnchor
            description={card.description}
            render={
              <button
                type="button"
                aria-label={card.description}
                className="text-text-muted hover:text-text-secondary"
              >
                <Info className="size-3.5" aria-hidden="true" />
              </button>
            }
          />
        )}
      </Heading>
      <div className="text-text-primary mt-3 text-4xl leading-none font-semibold break-words tabular-nums">
        {formatMetric(card.value, locale, card.format, true)}
      </div>
      <Sparkline
        values={card.sparkline}
        label={localize('com_insights_sparkline_accessibility', { label: card.title })}
        locale={locale}
        format={card.format}
        versionMarks={versionMarks}
      />
    </Panel>
  );
}
