import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquareText } from 'lucide-react';
import { cn, Shimmer, useLocalize } from '@librechat/client';
import type {
  SubagentDigest,
  SubagentDigestNode,
  SubagentDigestStatus,
} from 'librechat-data-provider';
import type { TranslationKeys } from '@librechat/client';
import type { NamedExoticComponent } from 'react';
import { parseToolName, getToolDisplayLabel } from '../../core/parts/toolLabels';
import { getRunStepDurationLabels } from '../messages/duration';
import ToolIcon, { getToolIconType } from './ToolIcon';

export type DigestTreeNode = { node: SubagentDigestNode; children: DigestTreeNode[] };

type Localize = ReturnType<typeof useLocalize>;

const STATUS_LABEL: Record<SubagentDigestStatus, TranslationKeys> = {
  running: 'com_ui_background_tasks_running',
  ok: 'com_ui_background_tasks_completed',
  error: 'com_ui_failed',
  cancelled: 'com_ui_cancelled',
};

/** `3.2` belongs to `3`, `3.1-20` to `3`, and `1-14` to the run itself. */
function parentPath(path: string): string {
  const dash = path.indexOf('-');
  const base = dash === -1 ? path : path.slice(0, dash);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(0, dot);
}

/** Rebuilds the tree the digest flattened into path-addressed nodes. */
export function buildDigestTree(nodes: readonly SubagentDigestNode[]): DigestTreeNode[] {
  const roots: DigestTreeNode[] = [];
  const byPath = new Map<string, DigestTreeNode>();
  for (const node of nodes) {
    const entry: DigestTreeNode = { node, children: [] };
    byPath.set(node.path, entry);
    const parent = byPath.get(parentPath(node.path));
    (parent == null ? roots : parent.children).push(entry);
  }
  return roots;
}

const NESTED_SUMMARY = /^(\d+) turns?, (\d+) tools?$/;
const COUNTED_ENTRY = /^(.+) ×(\d+)$/;
const MORE_SUFFIX = / \+(\d+) more$/;

export type DigestTally = { entries: Array<{ name: string; count: number }>; more: number };

/** Reads the server's model-facing tally ("bash_tool ×3, text +2 more") into counts. */
export function parseDigestSummary(summary: string): DigestTally {
  const more = MORE_SUFFIX.exec(summary);
  const head = more == null ? summary : summary.slice(0, more.index);
  const entries = head
    .split(', ')
    .filter((entry) => entry !== '')
    .map((entry) => {
      const counted = COUNTED_ENTRY.exec(entry);
      return counted == null
        ? { name: entry, count: 1 }
        : { name: counted[1], count: Number(counted[2]) };
    });
  return { entries, more: more == null ? 0 : Number(more[1]) };
}

function tallyLabel(name: string, localize: Localize, serverNames?: readonly string[]): string {
  return name === 'text'
    ? localize('com_ui_subagent_progress_reply')
    : getToolDisplayLabel(name, localize, serverNames);
}

/**
 * The server folds children into a model-facing English tally ("bash_tool ×3,
 * text +2 more", "1 turn, 2 tools"). Tool names stay as display labels and every
 * other fragment is localized here, so the card never shows the raw prose.
 */
export function localizeDigestSummary(
  summary: string,
  localize: Localize,
  serverNames?: readonly string[],
): string {
  const nested = NESTED_SUMMARY.exec(summary);
  if (nested != null) {
    return localize('com_ui_subagent_progress_nested', { 0: nested[1], 1: nested[2] });
  }
  const { entries, more } = parseDigestSummary(summary);
  const parts = entries.map(({ name, count }) => {
    const label = tallyLabel(name, localize, serverNames);
    return count > 1 ? `${label} ×${count}` : label;
  });
  if (more > 0) {
    parts.push(localize('com_ui_subagent_progress_more', { 0: more }));
  }
  return parts.join(', ');
}

/** One line of the timeline: a folded range of steps, a folded step, or a single call. */
type Row = { entry: DigestTreeNode; nested?: Row[] };

/**
 * The open step's calls read as steps of their own, so the newest work is never hidden
 * behind a fold; a call that started its own subagent carries that run beneath it.
 */
function toRows(entries: readonly DigestTreeNode[]): Row[] {
  const rows: Row[] = [];
  for (const entry of entries) {
    if (entry.node.kind === 'turn' && entry.children.length > 0) {
      rows.push(...toRows(entry.children));
    } else if (entry.children.length > 0) {
      rows.push({ entry, nested: toRows(entry.children) });
    } else {
      rows.push({ entry });
    }
  }
  return rows;
}

const MAX_STACKED_ICONS = 2;

/** The MCP servers' names and icons, so a server's tool draws with that server's icon. */
type Servers = { names?: readonly string[]; icons?: Map<string, string> };

function ToolGlyph({ name, servers }: { name: string; servers: Servers }): React.JSX.Element {
  if (name === 'text') {
    return <MessageSquareText className="size-3.5" />;
  }
  const server = parseToolName(name, servers.names).mcpServer;
  return (
    <ToolIcon
      type={getToolIconType(name)}
      iconUrl={server ? servers.icons?.get(server) : undefined}
      className="size-3.5"
    />
  );
}

function ToolStack({
  names,
  servers,
}: {
  names: readonly string[];
  servers: Servers;
}): React.JSX.Element {
  return (
    <span className="flex shrink-0 items-center" aria-hidden="true">
      {names.slice(0, MAX_STACKED_ICONS).map((name, index) => (
        <span
          key={name}
          className={cn(
            'bg-surface-tertiary border-surface-secondary text-text-secondary flex size-5 items-center justify-center rounded-md border',
            index > 0 && '-ms-1.5',
          )}
        >
          <ToolGlyph name={name} servers={servers} />
        </span>
      ))}
    </span>
  );
}

function Chips({ tally, servers }: { tally: DigestTally; servers: Servers }): React.JSX.Element {
  const localize = useLocalize();
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5 py-1">
      {tally.entries.map(({ name, count }) => (
        <span
          key={name}
          className="bg-surface-tertiary text-text-secondary inline-flex h-5 shrink-0 items-center gap-1 rounded-md ps-1 pe-1.5"
        >
          <span className="flex size-3.5 items-center justify-center" aria-hidden="true">
            <ToolGlyph name={name} servers={servers} />
          </span>
          <span className="truncate">{tallyLabel(name, localize, servers.names)}</span>
          {count > 1 && (
            <span className="text-text-primary font-semibold tabular-nums">{count}</span>
          )}
        </span>
      ))}
      {tally.more > 0 && (
        <span className="text-text-tertiary shrink-0">
          {localize('com_ui_subagent_progress_more', { 0: tally.more })}
        </span>
      )}
    </span>
  );
}

/** The marker on the rail: hollow for settled steps, filled where something happened. */
function Marker({
  status,
  range,
  last,
}: {
  status?: SubagentDigestStatus;
  range: boolean;
  last: boolean;
}): React.JSX.Element {
  const localize = useLocalize();
  let tone = 'border-text-tertiary bg-surface-secondary';
  if (status === 'running') {
    tone = 'border-status-info bg-status-info ring-status-info-subtle ring-2';
  } else if (status === 'error') {
    tone = 'border-status-error bg-status-error';
  } else if (status === 'cancelled') {
    tone = 'border-status-warning bg-status-warning';
  } else if (last && status === 'ok') {
    tone = 'border-status-success bg-status-success';
  }
  return (
    <span
      className={cn('relative block w-1.5 rounded-full border', range ? 'h-3.5' : 'h-1.5', tone)}
      role={status == null ? undefined : 'img'}
      aria-label={status == null ? undefined : localize(STATUS_LABEL[status])}
      aria-hidden={status == null ? true : undefined}
    />
  );
}

/** The last segment of a path's range ("12.1-5" → "1–5"), for a folded line's heading. */
function rangeText(path: string): string {
  const tail = path.slice(path.lastIndexOf('.') + 1);
  return tail.replace('-', '–');
}

function TimelineRow({
  row,
  max,
  first,
  last,
  settled,
  servers,
}: {
  row: Row;
  max: number;
  first: boolean;
  last: boolean;
  settled: boolean;
  servers: Servers;
}): React.JSX.Element {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const serverNames = servers.names;
  const { node } = row.entry;
  const tally = node.summary == null ? undefined : parseDigestSummary(node.summary);
  const nestedSummary = node.summary != null && NESTED_SUMMARY.test(node.summary);
  const isRange = node.kind === 'range';
  const running = node.status === 'running';

  let heading: string | undefined;
  let label: string;
  let names: string[] = [];
  let more = 0;
  if (isRange) {
    heading = localize(
      node.path.includes('.')
        ? 'com_ui_subagent_progress_calls_range'
        : 'com_ui_subagent_progress_steps_range',
      { 0: rangeText(node.path) },
    );
    label = heading;
  } else if (node.kind === 'turn') {
    names = tally?.entries.map((entry) => entry.name) ?? [];
    const total = (tally?.entries ?? []).reduce(
      (sum, entry) => sum + entry.count,
      tally?.more ?? 0,
    );
    if (node.label != null) {
      label = node.label;
      more = Math.max(0, total - 1);
    } else {
      label =
        node.summary == null ? '' : localizeDigestSummary(node.summary, localize, serverNames);
    }
  } else if (node.kind === 'text') {
    names = ['text'];
    label = localize(
      running ? 'com_ui_subagent_progress_writing_reply' : 'com_ui_subagent_progress_wrote_reply',
    );
  } else {
    names = [node.name ?? ''];
    label = node.label ?? getToolDisplayLabel(node.name ?? '', localize, serverNames);
  }

  const duration = node.ms == null ? undefined : getRunStepDurationLabels(node.ms, i18n.language);
  const width = node.ms == null || max <= 0 ? 0 : Math.max(2.5, (node.ms / max) * 100);
  const failed = node.kind !== 'range' && node.status === 'error';

  return (
    <li className="min-w-0">
      <div className="flex min-h-8 min-w-0 items-center gap-2.5 text-xs">
        <span
          className={cn(
            'relative flex w-3 shrink-0 items-center justify-center self-stretch',
            'before:bg-border-medium before:absolute before:inset-y-0 before:start-1/2 before:w-px before:-translate-x-1/2',
            first && 'before:top-1/2',
            last && row.nested == null && 'before:bottom-1/2',
          )}
        >
          <Marker status={node.status} range={isRange} last={last && settled} />
        </span>
        {isRange ? (
          <span className="text-text-tertiary shrink-0 tabular-nums">{heading}</span>
        ) : (
          <ToolStack names={names} servers={servers} />
        )}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {isRange && tally != null ? (
            <Chips tally={tally} servers={servers} />
          ) : (
            <span
              className="text-text-primary min-w-0 truncate"
              title={node.evicted === true ? localize('com_ui_subagent_progress_evicted') : label}
            >
              {running ? <Shimmer className="truncate">{label}</Shimmer> : label}
            </span>
          )}
          {more > 0 && (
            <span className="text-text-tertiary shrink-0">
              {localize('com_ui_subagent_progress_more', { 0: more })}
            </span>
          )}
          {nestedSummary && node.summary != null && (
            <span className="text-text-tertiary shrink-0">
              {localizeDigestSummary(node.summary, localize, serverNames)}
            </span>
          )}
          {node.kind === 'text' && node.chars != null && (
            <span className="text-text-tertiary shrink-0">
              {localize('com_ui_subagent_progress_chars', {
                0: node.chars.toLocaleString(i18n.language),
              })}
            </span>
          )}
          {failed && (
            <span className="text-status-error shrink-0">{localize('com_ui_failed')}</span>
          )}
        </span>
        <span
          className="bg-surface-tertiary hidden h-1 w-24 shrink-0 overflow-hidden rounded-full sm:block"
          aria-hidden="true"
        >
          <span
            className={cn(
              'block h-full rounded-full',
              running && 'bg-status-info',
              !running && node.status === 'error' && 'bg-status-error',
              !running && node.status !== 'error' && 'bg-text-tertiary',
            )}
            style={{ width: `${width}%` }}
          />
        </span>
        <span
          className={cn(
            'w-12 shrink-0 text-end tabular-nums',
            running ? 'text-status-info' : 'text-text-tertiary',
          )}
        >
          {duration == null ? null : localize(duration.key, duration.values)}
        </span>
      </div>
      {row.nested != null && row.nested.length > 0 && (
        <div className="border-border-medium ms-1.5 border-s ps-3">
          <Timeline rows={row.nested} settled={settled} servers={servers} />
        </div>
      )}
    </li>
  );
}

function Timeline({
  rows,
  settled,
  servers,
  thinking = false,
  label,
}: {
  rows: readonly Row[];
  settled: boolean;
  servers: Servers;
  thinking?: boolean;
  label?: string;
}): React.JSX.Element {
  const localize = useLocalize();
  const max = rows.reduce((longest, row) => Math.max(longest, row.entry.node.ms ?? 0), 0);
  return (
    <ol aria-label={label} className="min-w-0">
      {rows.map((row, index) => (
        <TimelineRow
          key={row.entry.node.path}
          row={row}
          max={max}
          first={index === 0}
          last={index === rows.length - 1 && !thinking}
          settled={settled}
          servers={servers}
        />
      ))}
      {thinking && (
        <li className="flex min-h-8 items-center gap-2.5 text-xs">
          <span
            className={cn(
              'relative flex w-3 shrink-0 items-center justify-center self-stretch',
              'before:bg-border-medium before:absolute before:inset-y-0 before:start-1/2 before:bottom-1/2 before:w-px before:-translate-x-1/2',
              rows.length === 0 && 'before:hidden',
            )}
          >
            <Marker status="running" range={false} last />
          </span>
          <Shimmer className="truncate">{localize('com_ui_subagent_progress_thinking')}</Shimmer>
        </li>
      )}
    </ol>
  );
}

export interface SubagentProgressProps {
  digest: SubagentDigest;
  /** Configured MCP server names, so `tool_mcp_server` names label correctly. */
  serverNames?: readonly string[];
  /** Each configured MCP server's icon, by server name. */
  serverIcons?: Map<string, string>;
  /** The task has ended, so its last settled step is marked as the finish. */
  settled?: boolean;
}

/**
 * A background subagent's progress as a timeline: older steps fold into ranges with
 * tool tallies, each recent step reads as the child's own one-line intent, and the open
 * step's calls are listed individually with their share of the time. The full, live
 * transcript stays in the subagent activity panel this card links to.
 */
const SubagentProgress: NamedExoticComponent<SubagentProgressProps> = memo(
  function SubagentProgress({
    digest,
    serverNames,
    serverIcons,
    settled = false,
  }: SubagentProgressProps) {
    const localize = useLocalize();
    const servers = useMemo(
      () => ({ names: serverNames, icons: serverIcons }),
      [serverIcons, serverNames],
    );
    const rows = useMemo(() => toRows(buildDigestTree(digest.nodes)), [digest.nodes]);
    const thinking = digest.phase === 'thinking' && !settled;
    return (
      <div className="border-border-inset mt-3 border-t pt-2.5" data-testid="subagent-progress">
        <p className="text-text-tertiary mb-1 text-xs">
          <span className="text-text-secondary font-semibold">
            {localize('com_ui_subagent_progress_tool_calls', { count: digest.tools })}
          </span>{' '}
          {localize('com_ui_subagent_progress_steps', { count: digest.turns })}
          {digest.errors > 0 && (
            <>
              {' · '}
              <span className="text-status-error">
                {localize('com_ui_subagent_progress_failed', { count: digest.errors })}
              </span>
            </>
          )}
        </p>
        {(rows.length > 0 || thinking) && (
          <Timeline
            rows={rows}
            settled={settled}
            servers={servers}
            thinking={thinking}
            label={localize('com_ui_subagent_progress')}
          />
        )}
        {digest.truncated === true && (
          <p className="text-text-tertiary mt-1 text-xs">
            {localize('com_ui_subagent_progress_truncated')}
          </p>
        )}
      </div>
    );
  },
);

export default SubagentProgress;
