import { cn } from '~/utils';

const SIZE = 20;
const STROKE_WIDTH = 2.5;
const RADIUS = (SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface GaugeProps {
  /** 0–100, clamped by the caller */
  percent: number;
  /** Max context unknown — render an empty track only */
  indeterminate: boolean;
}

function getStrokeClass(percent: number, indeterminate: boolean): string {
  if (indeterminate) {
    return 'stroke-text-secondary';
  }
  if (percent > 90) {
    return 'stroke-status-error';
  }
  if (percent > 75) {
    return 'stroke-status-warning';
  }
  return 'stroke-text-secondary';
}

export default function Gauge({ percent, indeterminate }: GaugeProps) {
  const offset = CIRCUMFERENCE - (percent / 100) * CIRCUMFERENCE;

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="size-5 -rotate-90"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="transparent"
        strokeWidth={STROKE_WIDTH}
        className="stroke-border-heavy"
        strokeDasharray={indeterminate ? '2 4' : undefined}
      />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="transparent"
        strokeWidth={STROKE_WIDTH}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={indeterminate ? CIRCUMFERENCE : offset}
        strokeLinecap="round"
        className={cn('transition-all duration-300', getStrokeClass(percent, indeterminate))}
      />
    </svg>
  );
}
