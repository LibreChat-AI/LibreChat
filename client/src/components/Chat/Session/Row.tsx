import { memo, useId, useState } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import { ArrowUpRight, ChevronDown, Square } from 'lucide-react';
import { Spinner, IconButton, TooltipAnchor } from '@librechat/client';
import type { Agent, TMessage } from 'librechat-data-provider';
import type { TaskRow } from '../BackgroundTasks/rows';
import {
  STATUS_KEYS,
  DELIVERY_KEYS,
  STATUS_CLASSES,
  DELIVERY_CLASSES,
} from '../BackgroundTasks/labels';
import ToolIcon, { getToolIconType } from '~/components/Chat/Messages/Content/ToolOutput/ToolIcon';
import MessageIcon from '~/components/Share/MessageIcon';
import Elapsed, { Duration } from './Elapsed';
import { Collapse } from '~/components/ui';
import { useLocalize } from '~/hooks';
import SessionNow from './Now';
import { cn } from '~/utils';

const agentMessage = { endpoint: EModelEndpoint.agents, isCreatedByUser: false } as TMessage;

/**
 * One subagent or background tool in the session rail. A running row is marked by its dot and
 * its counting duration alone: the rail stays open beside a streaming thread, and a sweeping
 * title is three compositor layers a row that every frame of the thread then pays for.
 * A subagent's row opens its thread; a
 * tool's row unfolds what it ran and has its own way back to the call in the conversation.
 */
function SessionRow({
  row,
  title,
  source,
  agent,
  selected = false,
  canStop,
  isStopping,
  onStop,
  onOpen,
}: {
  row: TaskRow;
  title: string;
  /** Who or what ran it: the agent's name, or the tool's label. */
  source: string;
  agent?: Pick<Agent, 'name' | 'avatar'>;
  /** The row's thread is the one open beside the conversation. */
  selected?: boolean;
  canStop: boolean;
  isStopping: boolean;
  onStop: (row: TaskRow) => void;
  /** Opens the subagent's thread or goes to the tool's call; false when it cannot be reached. */
  onOpen: (row: TaskRow) => boolean;
}) {
  const localize = useLocalize();
  const detailId = useId();
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const isSubagent = row.kind === 'subagent';
  const active = row.status === 'running' || row.status === 'stopping';
  const expandable = !isSubagent && row.detail != null;
  const stopLabel = localize('com_ui_background_tasks_stop');
  const jumpLabel = localize('com_ui_background_tasks_go_to_tool');
  const visit = () => setUnavailable(!onOpen(row));

  let lead = <p className="text-text-primary line-clamp-2 text-sm break-words">{title}</p>;
  if (isSubagent) {
    lead = (
      <button
        type="button"
        aria-current={selected || undefined}
        aria-label={`${localize('com_ui_background_tasks_open_subagent')}: ${title}`}
        onClick={visit}
        className="text-text-primary focus-visible:after:ring-focus-control block max-w-full text-start text-sm after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2"
      >
        <span className="line-clamp-2 break-words">{title}</span>
      </button>
    );
  } else if (expandable) {
    lead = (
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => {
          setVisited(true);
          setOpen((value) => !value);
        }}
        className="text-text-primary focus-visible:ring-focus-control flex max-w-full items-start gap-1 rounded text-start text-sm focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="line-clamp-2 break-words">{title}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'text-text-secondary mt-1 size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>
    );
  }

  return (
    <li
      data-testid="session-row"
      data-kind={row.kind}
      className={cn(
        'relative flex flex-wrap items-start gap-x-2.5 rounded-lg px-2 py-2',
        isSubagent && 'hover:bg-surface-nav-hover',
        selected && 'bg-surface-nav-selected hover:bg-surface-nav-selected',
      )}
    >
      <span
        className={cn(
          'bg-surface-tertiary relative mt-0.5 flex size-6 shrink-0 items-center justify-center',
          isSubagent ? 'rounded-full' : 'rounded-md',
        )}
      >
        {isSubagent ? (
          <span className="flex size-6 items-center justify-center overflow-hidden rounded-full">
            <MessageIcon message={agentMessage} agent={agent} />
          </span>
        ) : (
          <ToolIcon type={getToolIconType(row.name)} className="size-3.5" />
        )}
        {active && (
          <span
            aria-hidden="true"
            data-testid="session-row-live"
            className="bg-status-info ring-surface-sidebar absolute -end-0.5 -bottom-0.5 size-2 animate-pulse rounded-full ring-2 motion-reduce:animate-none"
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        {lead}
        <p className="text-text-secondary mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
          {title !== source && <span className="font-medium">{source}</span>}
          {!active && (
            <span className={STATUS_CLASSES[row.status]}>{localize(STATUS_KEYS[row.status])}</span>
          )}
          {row.status === 'stopping' && <span>{localize(STATUS_KEYS.stopping)}</span>}
          {active && row.startedAt != null && <Elapsed startedAt={row.startedAt} />}
          {!active && row.startedAt != null && row.settledAt != null && (
            <Duration ms={row.settledAt - row.startedAt} />
          )}
        </p>
        {isSubagent && row.status === 'running' && row.threadId != null && (
          <SessionNow threadId={row.threadId} />
        )}
        {row.delivery != null && (
          <p
            data-testid="background-task-delivery"
            className={cn('text-text-secondary mt-1 text-xs', DELIVERY_CLASSES[row.delivery])}
          >
            {localize(DELIVERY_KEYS[row.delivery])}
          </p>
        )}
        {unavailable && (
          <p role="status" className="text-text-secondary mt-1 text-xs">
            {localize(
              isSubagent
                ? 'com_ui_background_tasks_subagent_unavailable'
                : 'com_ui_background_tasks_tool_unavailable',
            )}
          </p>
        )}
      </div>
      {!isSubagent && (
        <TooltipAnchor
          description={jumpLabel}
          render={
            <IconButton
              variant="ghost"
              size="xs"
              shape="inset"
              label={`${jumpLabel}: ${title}`}
              onClick={visit}
            >
              <ArrowUpRight className="text-text-secondary size-3.5" aria-hidden="true" />
            </IconButton>
          }
        />
      )}
      {row.status === 'running' && canStop && (
        <TooltipAnchor
          description={stopLabel}
          render={
            <IconButton
              variant="ghost"
              size="xs"
              shape="inset"
              label={`${stopLabel}: ${title}`}
              disabled={isStopping}
              onClick={() => onStop(row)}
              className="relative"
            >
              <Square className="text-text-secondary size-3 fill-current" aria-hidden="true" />
            </IconButton>
          }
        />
      )}
      {row.status === 'stopping' && <Spinner className="mt-1 size-4 shrink-0" />}
      {expandable && (
        <div className="ms-[2.125rem] min-w-0 basis-full">
          <Collapse open={open}>
            {visited && (
              <pre
                id={detailId}
                className="bg-surface-primary text-text-primary mt-2 max-h-48 overflow-auto rounded-md p-2 font-mono text-xs break-words whitespace-pre-wrap"
              >
                {row.detail}
              </pre>
            )}
          </Collapse>
        </div>
      )}
    </li>
  );
}

/**
 * A task's row object is rebuilt whenever the list is, which a poll or another task settling
 * causes; a row renders only when what it shows has changed.
 */
const sameRow = (a: TaskRow, b: TaskRow): boolean => {
  if (a === b) return true;
  const { subagent: before, ...was } = a;
  const { subagent: after, ...now } = b;
  const keys = Object.keys(now) as Array<keyof typeof now>;
  return (
    before?.threadId === after?.threadId &&
    before?.taskId === after?.taskId &&
    keys.length === Object.keys(was).length &&
    keys.every((key) => was[key] === now[key])
  );
};

export default memo(SessionRow, (before, after) => {
  const { row: was, ...rest } = before;
  const { row: now, ...next } = after;
  const keys = Object.keys(next) as Array<keyof typeof next>;
  return sameRow(was, now) && keys.every((key) => rest[key] === next[key]);
});
