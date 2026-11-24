import * as React from 'react';
import { Check, X } from 'lucide-react';
import { cn } from '~/utils';

export type FlowState = 'idle' | 'active' | 'done' | 'failed';

export interface FlowNode {
  id: string;
  label: string;
  /** Shown before the label: an avatar or glyph. */
  icon?: React.ReactNode;
  /** Where the node is in a run. Leave unset on every node for a graph that is not running. */
  state?: FlowState;
}

export interface FlowEdge {
  from: string | readonly string[];
  to: string | readonly string[];
}

export interface FlowLayout {
  /** Node ids by column, left to right: a node sits one column past its furthest source. */
  columns: string[][];
  links: { from: string; to: string }[];
}

const list = (value: string | readonly string[]): readonly string[] =>
  typeof value === 'string' ? [value] : value;

/**
 * Places nodes in columns by how far they are from a starting node, so every connection runs
 * left to right. Connections that name an unknown node are dropped, and nodes caught in a cycle
 * (a draft can hold one) take the column after the last placed one rather than vanishing.
 */
export function layoutFlow(ids: readonly string[], edges: readonly FlowEdge[]): FlowLayout {
  const known = new Set(ids);
  const links: FlowLayout['links'] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    for (const from of list(edge.from)) {
      for (const to of list(edge.to)) {
        const key = `${from}\u0000${to}`;
        if (from === to || !known.has(from) || !known.has(to) || seen.has(key)) continue;
        seen.add(key);
        links.push({ from, to });
      }
    }
  }
  const incoming = new Map<string, number>(ids.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const { from, to } of links) {
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
    outgoing.get(from)?.push(to);
  }
  const column = new Map<string, number>();
  const ready = ids.filter((id) => incoming.get(id) === 0);
  for (const id of ready) column.set(id, 0);
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index];
    for (const next of outgoing.get(id) ?? []) {
      column.set(next, Math.max(column.get(next) ?? 0, (column.get(id) ?? 0) + 1));
      const left = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  const last = Math.max(-1, ...column.values());
  const columns: string[][] = [];
  for (const id of ids) {
    const at = ready.includes(id) ? (column.get(id) ?? 0) : last + 1;
    (columns[at] ??= []).push(id);
  }
  return { columns: columns.filter((entries) => entries != null), links };
}

const SIZES = {
  /** Named pills: a team as it is edited or read. */
  md: { width: 136, height: 28, gapX: 36, gapY: 8 },
  /** Dots only: a team at a glance, beside a title. */
  sm: { width: 8, height: 8, gapX: 12, gapY: 5 },
} as const;

export interface FlowGraphProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  nodes: readonly FlowNode[];
  edges: readonly FlowEdge[];
  /** The node a run starts at and the one whose answer it returns. */
  entry?: string;
  result?: string;
  size?: keyof typeof SIZES;
  /** What the drawing is of, for a reader who cannot see it. */
  label: string;
  /** The order the drawing shows, in words, read after `label`. Build it with `describeFlow`. */
  description?: string;
}

/**
 * The drawing in words: each column's names, one column after another, as `layoutFlow` places
 * them. `then` is the localized word between columns.
 */
export function describeFlow(
  nodes: readonly Pick<FlowNode, 'id' | 'label'>[],
  edges: readonly FlowEdge[],
  then: string,
): string {
  const names = new Map(nodes.map((node) => [node.id, node.label]));
  return layoutFlow(
    nodes.map((node) => node.id),
    edges,
  )
    .columns.map((ids) => ids.map((id) => names.get(id) ?? id).join(', '))
    .join(`; ${then} `);
}

const STATE_CLASS: Record<FlowState, string> = {
  idle: 'border-border-light text-text-tertiary',
  active: 'border-series-6 text-text-primary motion-safe:animate-pulse',
  done: 'border-border-medium text-text-primary',
  failed: 'border-status-error-border text-status-error',
};

/**
 * A directed graph drawn left to right: who starts, who runs beside whom, who answers. Read-only;
 * the drawing is one image to assistive technology, named by `label` and described by
 * `description`.
 *
 * A connection between neighbouring columns is a curve. One that skips a column would run under
 * the nodes between, so it bows over the top of the drawing instead, each in its own lane.
 */
export function FlowGraph({
  nodes,
  edges,
  entry,
  result,
  size = 'md',
  label,
  description,
  className,
  ...props
}: FlowGraphProps): React.ReactElement | null {
  const descriptionId = React.useId();
  const { width, height, gapX, gapY } = SIZES[size];
  const layout = React.useMemo(
    () =>
      layoutFlow(
        nodes.map((node) => node.id),
        edges,
      ),
    [nodes, edges],
  );
  if (nodes.length === 0) return null;
  const columnOf = new Map<string, number>();
  layout.columns.forEach((entries, col) => entries.forEach((id) => columnOf.set(id, col)));
  const skips = layout.links.filter(
    ({ from, to }) => (columnOf.get(to) ?? 0) - (columnOf.get(from) ?? 0) > 1,
  );
  const lane = Math.max(4, gapY);
  const top = skips.length * lane;
  const rows = Math.max(...layout.columns.map((entries) => entries.length));
  const totalWidth = layout.columns.length * width + (layout.columns.length - 1) * gapX;
  const totalHeight = top + rows * height + (rows - 1) * gapY;
  const position = new Map<string, { x: number; y: number }>();
  layout.columns.forEach((entries, col) => {
    const offset = top + ((rows - entries.length) * (height + gapY)) / 2;
    entries.forEach((id, row) => {
      position.set(id, { x: col * (width + gapX), y: offset + row * (height + gapY) });
    });
  });
  const running = nodes.some((node) => node.state != null);
  const path = (from: string, to: string): string | null => {
    const a = position.get(from);
    const b = position.get(to);
    if (a == null || b == null) return null;
    const x1 = a.x + width;
    const y1 = a.y + height / 2;
    const x2 = b.x;
    const y2 = b.y + height / 2;
    const skip = skips.findIndex((link) => link.from === from && link.to === to);
    if (skip === -1) {
      const bend = (x2 - x1) / 2;
      return `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
    }
    /** Up out of the source, along its lane above every node, and down into the target. */
    const y = (skip + 0.5) * lane;
    const turn = gapX / 2;
    return `M${x1} ${y1}C${x1 + turn} ${y1} ${x1 + turn} ${y} ${x1 + turn * 2} ${y}L${x2 - turn * 2} ${y}C${x2 - turn} ${y} ${x2 - turn} ${y2} ${x2} ${y2}`;
  };
  return (
    <div
      role="img"
      aria-label={label}
      aria-describedby={description ? descriptionId : undefined}
      className={cn('relative shrink-0', className)}
      style={{ width: totalWidth, height: totalHeight }}
      {...props}
    >
      {description && (
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
      )}
      <svg
        aria-hidden="true"
        className="text-border-heavy absolute inset-0"
        width={totalWidth}
        height={totalHeight}
        fill="none"
      >
        {layout.links.map(({ from, to }) => {
          const d = path(from, to);
          if (d == null) return null;
          return (
            <path
              key={`${from}\u0000${to}`}
              d={d}
              stroke="currentColor"
              strokeWidth={size === 'md' ? 1.5 : 1}
            />
          );
        })}
      </svg>
      {nodes.map((node) => {
        const at = position.get(node.id);
        if (at == null) return null;
        const state = node.state ?? (running ? 'idle' : 'done');
        if (size === 'sm') {
          return (
            <span
              key={node.id}
              className={cn(
                'absolute rounded-full border',
                STATE_CLASS[state],
                state === 'idle' ? 'bg-transparent' : 'bg-current',
              )}
              style={{ left: at.x, top: at.y, width, height }}
            />
          );
        }
        return (
          <span
            key={node.id}
            title={node.label}
            className={cn(
              'bg-surface-primary absolute flex items-center gap-1.5 rounded-full border px-2 text-xs',
              STATE_CLASS[state],
              (node.id === entry || node.id === result) && 'font-medium',
            )}
            style={{ left: at.x, top: at.y, width, height }}
          >
            {node.state === 'done' && <Check className="h-3 w-3 shrink-0" aria-hidden="true" />}
            {node.state === 'failed' && <X className="h-3 w-3 shrink-0" aria-hidden="true" />}
            {node.state !== 'done' && node.state !== 'failed' && node.icon}
            <span className="min-w-0 flex-1 truncate">{node.label}</span>
            {node.id === result && (
              <span
                className="bg-series-6 h-1.5 w-1.5 shrink-0 rounded-full"
                data-flow-result
                aria-hidden="true"
              />
            )}
          </span>
        );
      })}
    </div>
  );
}
