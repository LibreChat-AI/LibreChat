import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  SubagentDigest,
  SubagentDigestNode,
  SubagentDigestStatus,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { cn, getToolDisplayLabel, getRunStepDurationLabels } from '~/utils';
import { ToolIcon, getToolIconType } from './ToolOutput';
import { useLocalize } from '~/hooks';

export type DigestTreeNode = { node: SubagentDigestNode; children: DigestTreeNode[] };

type Localize = ReturnType<typeof useLocalize>;

const STATUS: Record<SubagentDigestStatus, { label: TranslationKeys; dot: string }> = {
  running: { label: 'com_ui_background_tasks_running', dot: 'bg-status-info' },
  ok: { label: 'com_ui_background_tasks_completed', dot: 'bg-status-success' },
  error: { label: 'com_ui_failed', dot: 'bg-status-error' },
  cancelled: { label: 'com_ui_cancelled', dot: 'bg-status-warning' },
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
  const more = MORE_SUFFIX.exec(summary);
  const entries = (more == null ? summary : summary.slice(0, more.index)).split(', ');
  const parts = entries.map((entry) => {
    const counted = COUNTED_ENTRY.exec(entry);
    const name = counted == null ? entry : counted[1];
    const label =
      name === 'text'
        ? localize('com_ui_subagent_progress_reply')
        : getToolDisplayLabel(name, localize, serverNames);
    return counted == null ? label : `${label} ×${counted[2]}`;
  });
  if (more != null) {
    parts.push(localize('com_ui_subagent_progress_more', { 0: more[1] }));
  }
  return parts.join(', ');
}

const isOnPath = (path: string, active?: string): boolean =>
  active != null && (active === path || active.startsWith(`${path}.`));

function NodeRow({
  node,
  serverNames,
}: {
  node: SubagentDigestNode;
  serverNames?: readonly string[];
}) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const status = node.status == null ? undefined : STATUS[node.status];
  let title: string;
  if (node.kind === 'tool') {
    title = node.label ?? getToolDisplayLabel(node.name ?? '', localize, serverNames);
  } else if (node.kind === 'text') {
    title = localize('com_ui_subagent_progress_reply');
  } else if (node.kind === 'range') {
    title = localize('com_ui_subagent_progress_turns', { 0: node.path });
  } else {
    title = localize('com_ui_subagent_progress_turn', { 0: node.path });
  }
  const duration = node.ms == null ? undefined : getRunStepDurationLabels(node.ms, i18n.language);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
      {node.kind === 'tool' && (
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
          <ToolIcon type={getToolIconType(node.name ?? '')} />
        </span>
      )}
      <span
        className={cn(
          'min-w-0 truncate',
          node.kind === 'tool' || node.kind === 'text'
            ? 'text-text-primary'
            : 'text-text-secondary',
        )}
        title={node.evicted === true ? localize('com_ui_subagent_progress_evicted') : title}
      >
        {title}
      </span>
      {node.summary != null && (
        <span className="text-text-tertiary min-w-0 truncate">
          {localizeDigestSummary(node.summary, localize, serverNames)}
        </span>
      )}
      <span className="ms-auto flex shrink-0 items-center gap-1.5">
        {duration != null && (
          <span className="text-text-tertiary tabular-nums">
            {localize(duration.key, duration.values)}
          </span>
        )}
        {status != null && (
          <span
            className={cn('size-1.5 rounded-full', status.dot)}
            role="img"
            aria-label={localize(status.label)}
          />
        )}
      </span>
    </span>
  );
}

function DigestBranch({
  entry,
  active,
  serverNames,
}: {
  entry: DigestTreeNode;
  active?: string;
  serverNames?: readonly string[];
}) {
  if (entry.children.length === 0) {
    return (
      <li className="flex min-w-0 items-center py-0.5">
        <NodeRow node={entry.node} serverNames={serverNames} />
      </li>
    );
  }
  return (
    <li className="min-w-0">
      <details open={isOnPath(entry.node.path, active)} className="group">
        <summary className="focus-visible:ring-focus-subtle flex min-w-0 cursor-pointer items-center rounded py-0.5 focus-visible:ring-2 focus-visible:outline-none">
          <NodeRow node={entry.node} serverNames={serverNames} />
        </summary>
        <ul className="border-border-light ms-1.5 border-s ps-2">
          {entry.children.map((child) => (
            <DigestBranch
              key={child.node.path}
              entry={child}
              active={active}
              serverNames={serverNames}
            />
          ))}
        </ul>
      </details>
    </li>
  );
}

/**
 * A background subagent's folded progress tree: turns and ranges fold, and the
 * branch holding the child's current step opens by default. The full, live
 * transcript stays in the subagent activity panel this card links to.
 */
const SubagentProgress = memo(function SubagentProgress({
  digest,
  serverNames,
}: {
  digest: SubagentDigest;
  /** Configured MCP server names, so `tool_mcp_server` names label correctly. */
  serverNames?: readonly string[];
}) {
  const localize = useLocalize();
  const tree = useMemo(() => buildDigestTree(digest.nodes), [digest.nodes]);
  const active = digest.active ?? digest.nodes[digest.nodes.length - 1]?.path;
  return (
    <div className="border-border-inset mt-3 border-t pt-2.5" data-testid="subagent-progress">
      <div className="text-text-secondary mb-1.5 flex items-center gap-2 text-xs font-medium">
        <span>{localize('com_ui_subagent_progress')}</span>
        <span className="text-text-tertiary font-normal tabular-nums">
          {localize('com_ui_subagent_progress_counts', {
            0: digest.turns,
            1: digest.tools,
            2: digest.errors,
          })}
        </span>
        {digest.phase === 'thinking' && (
          <span className="text-text-tertiary font-normal">
            {localize('com_ui_subagent_progress_thinking')}
          </span>
        )}
      </div>
      {tree.length > 0 && (
        <ul aria-label={localize('com_ui_subagent_progress')} className="min-w-0">
          {tree.map((entry) => (
            <DigestBranch
              key={entry.node.path}
              entry={entry}
              active={active}
              serverNames={serverNames}
            />
          ))}
        </ul>
      )}
      {digest.truncated === true && (
        <p className="text-text-tertiary mt-1 text-xs">
          {localize('com_ui_subagent_progress_truncated')}
        </p>
      )}
    </div>
  );
});

export default SubagentProgress;
