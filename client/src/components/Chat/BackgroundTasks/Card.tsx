import { memo, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Square } from 'lucide-react';
import { Spinner, TooltipAnchor } from '@librechat/client';
import type { TaskRow, TaskRowDelivery, TaskRowStatus } from './rows';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { getRunStepDurationLabels, getToolDisplayLabel, cn } from '~/utils';
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
}: {
  row: TaskRow;
  now: number;
  canStop: boolean;
  isStopping: boolean;
  onStop: (row: TaskRow) => void;
  portalElement: HTMLElement | null;
}) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const detailId = useId();
  const [open, setOpen] = useState(false);
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
    <li className="rounded-lg bg-surface-tertiary px-3 py-2" data-testid="background-task-row">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {expandable ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={() => setOpen((value) => !value)}
              className="flex max-w-full items-start gap-1 rounded text-left text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
            >
              <span className="line-clamp-2 break-words">{title}</span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'mt-1 size-3.5 shrink-0 text-text-secondary transition-transform motion-reduce:transition-none',
                  open && 'rotate-180',
                )}
              />
            </button>
          ) : (
            <p className="line-clamp-2 break-words text-sm text-text-primary">{title}</p>
          )}
          <p className="mt-0.5 flex items-center gap-2 text-xs text-text-secondary">
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
              <button
                type="button"
                aria-label={`${stopLabel}: ${title}`}
                disabled={isStopping}
                onClick={() => onStop(row)}
                className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border-medium text-text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary disabled:opacity-50"
              >
                <Square className="size-3" aria-hidden="true" />
              </button>
            }
          />
        )}
        {row.status === 'stopping' && <Spinner className="size-4 shrink-0 text-text-secondary" />}
      </div>
      {expandable && open && (
        <pre
          id={detailId}
          className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-primary p-2 font-mono text-xs text-text-primary"
        >
          {row.detail}
        </pre>
      )}
    </li>
  );
}

export default memo(TaskCard);
