import { memo, useId, useRef, useMemo, useState, useEffect, useCallback } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { TraceModel, TraceScale, TraceWindow } from './model';
import {
  spanOf,
  boundsOf,
  turnSpan,
  ZOOM_STEP,
  zoomWindow,
  panWindow,
  assignLanes,
  clampWindow,
  minimumSpan,
  sequenceLane,
} from './model';
import { useTraceFormat } from './format';
import { appearanceOf } from './kinds';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const LANE_COUNT = 8;
const LANE_HEIGHT = 5;
const LANE_GAP = 1;
const TOP_PADDING = 6;
const DRAG_THRESHOLD_PX = 3;
const TICKS = [0, 0.25, 0.5, 0.75, 1];

type Drag = { origin: number; current: number; moved: boolean; pointerId: number };

const percent = (fraction: number) => `${Math.min(Math.max(fraction, 0), 1) * 100}%`;

/**
 * The pinned overview of the whole trace. It always draws every shown record
 * at full scale; the focused interval is an overlay the ledger follows. On the
 * sequence scale every record is one equal block, so a quick tool call beside a
 * long model call stays visible.
 */
function Timeline({
  model,
  scale,
  view,
  onViewChange,
}: {
  model: TraceModel;
  scale: TraceScale;
  view: TraceWindow | null;
  onViewChange: (view: TraceWindow | null) => void;
}) {
  const localize = useLocalize();
  const format = useTraceFormat();
  const hintId = useId();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<{ from: number; to: number } | null>(null);

  const bounds = useMemo(() => boundsOf(model, scale), [model, scale]);
  const span = Math.max(bounds.end - bounds.start, 1);
  const minSpan = minimumSpan(bounds, scale);
  const lanes = useMemo(
    () => (scale === 'time' ? assignLanes(model, LANE_COUNT) : null),
    [model, scale],
  );
  const records = useMemo(() => [...model.nodes.values()].filter((node) => node.shown), [model]);
  const toFraction = useCallback(
    (position: number) => (position - bounds.start) / span,
    [bounds.start, span],
  );
  const tick = (fraction: number) =>
    scale === 'sequence' ? String(Math.round(span * fraction)) : format.duration(span * fraction);

  const fractionAt = (clientX: number): number => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) {
      return 0;
    }
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  };

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) {
      return;
    }
    /** Registered natively: React's wheel listener is passive and cannot stop page scroll. */
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) {
        return;
      }
      event.preventDefault();
      const rect = surface.getBoundingClientRect();
      const fraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
      const anchor = bounds.start + Math.min(Math.max(fraction, 0), 1) * span;
      const factor = event.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
      onViewChange(zoomWindow(bounds, view, factor, anchor, minSpan));
    };
    surface.addEventListener('wheel', handleWheel, { passive: false });
    return () => surface.removeEventListener('wheel', handleWheel);
  }, [bounds, span, minSpan, view, onViewChange]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const origin = fractionAt(event.clientX);
    dragRef.current = { origin, current: origin, moved: false, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const width = surfaceRef.current?.getBoundingClientRect().width ?? 0;
    drag.current = fractionAt(event.clientX);
    drag.moved = drag.moved || Math.abs(drag.current - drag.origin) * width > DRAG_THRESHOLD_PX;
    if (drag.moved) {
      setDraft({
        from: Math.min(drag.origin, drag.current),
        to: Math.max(drag.origin, drag.current),
      });
    }
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDraft(null);
    if (!drag || drag.pointerId !== event.pointerId || !drag.moved) {
      return;
    }
    const from = Math.min(drag.origin, drag.current);
    const to = Math.max(drag.origin, drag.current);
    onViewChange(
      clampWindow(
        { start: bounds.start + from * span, end: bounds.start + to * span },
        bounds,
        minSpan,
      ),
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      onViewChange(zoomWindow(bounds, view, ZOOM_STEP, undefined, minSpan));
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      onViewChange(zoomWindow(bounds, view, 1 / ZOOM_STEP, undefined, minSpan));
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      onViewChange(panWindow(bounds, view, event.key === 'ArrowLeft' ? -1 : 1, minSpan));
    } else if (event.key === 'Escape' && view != null) {
      event.preventDefault();
      event.stopPropagation();
      onViewChange(null);
    }
  };

  const selection =
    draft ?? (view ? { from: toFraction(view.start), to: toFraction(view.end) } : null);

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={surfaceRef}
        role="group"
        tabIndex={0}
        aria-label={localize('com_ui_trace_overview')}
        aria-describedby={hintId}
        data-testid="trace-overview"
        data-scale={scale}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onDoubleClick={() => onViewChange(null)}
        onContextMenu={(event) => {
          if (view != null) {
            event.preventDefault();
            onViewChange(null);
          }
        }}
        className="relative h-[60px] cursor-crosshair touch-none select-none overflow-hidden rounded-lg border border-border-light bg-surface-primary-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
      >
        <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
          {model.turns.map((turn) => (
            <rect
              key={turn.key}
              x={percent(toFraction(turnSpan(turn, scale).start))}
              y={0}
              width={1}
              height="100%"
              className="fill-border-medium"
            />
          ))}
          {records.map((node) => {
            const { record } = node;
            const lane = lanes?.get(record.id) ?? sequenceLane(record);
            const y = TOP_PADDING + lane * (LANE_HEIGHT + LANE_GAP);
            const fill =
              record.status === 'error' ? 'fill-status-error' : appearanceOf(record).fill;
            if (scale === 'time' && node.end == null) {
              return (
                <rect
                  key={record.id}
                  x={percent(toFraction(node.start))}
                  y={y - 1}
                  width={3}
                  height={LANE_HEIGHT + 2}
                  className={fill}
                />
              );
            }
            const recordSpan = spanOf(node, scale);
            return (
              <rect
                key={record.id}
                x={percent(toFraction(recordSpan.start))}
                y={y}
                width={`${Math.max(((recordSpan.end - recordSpan.start) / span) * 100, 0.15)}%`}
                height={LANE_HEIGHT}
                rx={1}
                className={fill}
              />
            );
          })}
        </svg>
        {selection && (
          <>
            <div
              className="pointer-events-none absolute inset-y-0 left-0 bg-presentation/60"
              style={{ width: percent(selection.from) }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 right-0 bg-presentation/60"
              style={{ width: percent(1 - selection.to) }}
            />
            <div
              data-testid="trace-overview-selection"
              className={cn(
                'pointer-events-none absolute inset-y-0 border-x-2 border-border-xheavy',
                draft != null && 'border-dashed',
              )}
              style={{
                left: percent(selection.from),
                width: percent(selection.to - selection.from),
              }}
            />
          </>
        )}
      </div>
      <div
        className="flex justify-between text-[11px] tabular-nums text-text-secondary"
        aria-hidden="true"
      >
        {TICKS.map((fraction) => (
          <span key={fraction}>{tick(fraction)}</span>
        ))}
      </div>
      <p id={hintId} className="sr-only">
        {localize('com_ui_trace_overview_hint')}
      </p>
    </div>
  );
}

export default memo(Timeline);
