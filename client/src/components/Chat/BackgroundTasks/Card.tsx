import { memo, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, ChevronDown, Square } from 'lucide-react';
import { IconButton, Spinner, TooltipAnchor } from '@librechat/client';
import type { TaskRow, TaskRowDelivery, TaskRowStatus } from './rows';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { getRunStepDurationLabels, getToolDisplayLabel, cn } from '~/utils';
import { Collapse } from '~/components/ui';
import { useLocalize } from '~/hooks';

const STATUS_KEYS: Record<TaskRowStatus, TranslationKeys> = {
  running: 'com_ui_background_tasks_running',
  stopping: 'com_ui_background_tasks_stopping',
  completed: 'com_ui_background_tasks_completed',
  error: 'com_ui_failed',
  cancelled: 'com_ui_cancelled',
};

const STATUS_CLASSES: Partial<Record<TaskRowStatus, string>> = {
  error: 'text-status-error',
  cancelled: 'text-status-warning',
};

const DELIVERY_KEYS: Record<TaskRowDelivery, TranslationKeys> = {
  pending: 'com_ui_background_tasks_result_pending',
  failed: 'com_ui_background_tasks_result_undelivered',
};

const DELIVERY_CLASSES: Partial<Record<TaskRowDelivery, string>> = {
  failed: 'text-status-warning',
};

function TaskCard({
  row,
  now,
  canStop,
  isStopping,
  onStop,
  portalElement,
  onJump,
}: {
  row: TaskRow;
  now: number;
  canStop: boolean;
  isStopping: boolean;
  onStop: (row: TaskRow) => void;
  portalElement: HTMLElement | null;
  onJump: (row: TaskRow) => boolean;
}) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const detailId = useId();
  const [open, setOpen] = useState(false);
  const [jumpUnavailable, setJumpUnavailable] = useState(false);
  const active = row.status === 'running' || row.status === 'stopping';
  const kindLabel =
    row.kind === 'subagent'
      ? localize('com_ui_background_tasks_subagent')
      : getToolDisplayLabel(row.name, localize);
  const title = row.title ?? (row.kind === 'subagent' ? row.name : kindLabel);
  const end = active ? now : row.settledAt;
  const duration =
    row.startedAt != null && end != null
      ? getRunStepDurationLabels(Math.max(0, end - row.startedAt), i18n.language)
      : undefined;
  const stopLabel = localize('com_ui_background_tasks_stop');
  const expandable = row.detail != null;

  return (
    <li className="bg-surface-tertiary rounded-lg px-3 py-2" data-testid="background-task-row">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {expandable ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={() => setOpen((value) => !value)}
              className="text-text-primary focus-visible:ring-text-primary flex max-w-full items-start gap-1 rounded text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
            >
              <span className={cn('line-clamp-2 break-words', active && 'shimmer')}>{title}</span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'text-text-secondary mt-1 size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
                  open && 'rotate-180',
                )}
              />
            </button>
          ) : (
            <p
              className={cn(
                'text-text-primary line-clamp-2 text-sm break-words',
                active && 'shimmer',
              )}
            >
              {title}
            </p>
          )}
          <p className="text-text-secondary mt-0.5 flex items-center gap-2 text-xs">
            {title !== kindLabel && <span className="font-medium">{kindLabel}</span>}
            {active ? null : (
              <span className={STATUS_CLASSES[row.status]}>
                {localize(STATUS_KEYS[row.status])}
              </span>
            )}
            {row.status === 'stopping' && <span>{localize(STATUS_KEYS.stopping)}</span>}
            {row.delivery != null && (
              <span
                className={DELIVERY_CLASSES[row.delivery]}
                data-testid="background-task-delivery"
              >
                {localize(DELIVERY_KEYS[row.delivery])}
              </span>
            )}
            {duration != null && (
              <span
                className="tabular-nums"
                aria-label={localize(duration.announcedKey, duration.announcedValues)}
              >
                {localize(duration.key, duration.values)}
              </span>
            )}
          </p>
        </div>
        {row.status === 'running' && canStop && (
          <TooltipAnchor
            description={stopLabel}
            portalElement={portalElement}
            render={
              <IconButton
                type="button"
                variant="primary"
                size="xs"
                shape="inset"
                label={`${stopLabel}: ${title}`}
                disabled={isStopping}
                onClick={() => onStop(row)}
              >
                <Square className="size-3 fill-current" aria-hidden="true" />
              </IconButton>
            }
          />
        )}
        <TooltipAnchor
          description={localize('com_ui_background_tasks_go_to_tool')}
          portalElement={portalElement}
          render={
            <IconButton
              variant="ghost"
              size="xs"
              shape="inset"
              label={localize('com_ui_background_tasks_go_to_tool')}
              onClick={() => setJumpUnavailable(!onJump(row))}
            >
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </IconButton>
          }
        />
        {row.status === 'stopping' && <Spinner className="size-4 shrink-0" />}
      </div>
      {expandable && (
        <Collapse open={open}>
          <pre
            id={detailId}
            className="bg-surface-primary text-text-primary mt-2 max-h-48 overflow-auto rounded-md p-2 font-mono text-xs break-words whitespace-pre-wrap"
          >
            {row.detail}
          </pre>
        </Collapse>
      )}
      {jumpUnavailable && (
        <p role="status" className="text-text-secondary mt-1 text-xs">
          {localize('com_ui_background_tasks_tool_unavailable')}
        </p>
      )}
    </li>
  );
}

export default memo(TaskCard);
