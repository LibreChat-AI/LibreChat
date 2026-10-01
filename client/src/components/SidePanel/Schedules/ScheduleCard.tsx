import { useId, useRef, useMemo, useState, useCallback } from 'react';
import * as Ariakit from '@ariakit/react';
import { Link, useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { Play, Trash, Pencil, Ellipsis, TriangleAlert } from 'lucide-react';
import {
  Label,
  Chip,
  Switch,
  Spinner,
  OGDialog,
  DropdownPopup,
  OGDialogTemplate,
  useToastContext,
} from '@librechat/client';
import type { TSchedule, ScheduleDisabledReason } from 'librechat-data-provider';
import type { ImmediateScheduleMCPFailure } from './errors';
import type { TranslationKeys } from '~/hooks';
import type { ScheduleRowTone } from './state';
import {
  scheduleMCPErrorMessage,
  scheduleMCPErrorOutcomes,
  scheduleLastRunKey,
  scheduleMCPCardOutcomes,
  scheduleDisabledMCPLabel,
} from './errors';
import {
  useGetAgentByIdQuery,
  useDeleteScheduleMutation,
  useUpdateScheduleMutation,
  useRunScheduleNowMutation,
} from '~/data-provider';
import { useLocalize, useHasAccess, useClockFormat, useWeekStart } from '~/hooks';
import { cn, getMessageTimestamp, rowActionClasses } from '~/utils';
import ScheduleMCPRecovery from './ScheduleMCPRecovery';
import { useAgentsMapContext } from '~/Providers';
import ScheduleDialog from './ScheduleDialog';
import { describeCadence } from './cadence';
import { scheduleRowState } from './state';

interface ScheduleCardProps {
  schedule: TSchedule;
  /** Resolved by the panel, which holds ONE project-name lookup for the whole list —
   *  deriving it per card is O(schedules x projects) on every project-list refresh. */
  projectName?: string | null;
}

const DISABLED_REASON_LABELS: Record<ScheduleDisabledReason, TranslationKeys> = {
  mcp_reauth_required: 'com_ui_schedule_disabled_mcp_reauth',
  mcp_configuration_missing: 'com_ui_schedule_disabled_mcp_configuration',
  mcp_permission_denied: 'com_ui_schedule_disabled_mcp_permission',
  too_many_failures: 'com_ui_schedule_disabled_too_many_failures',
  agent_deleted: 'com_ui_schedule_disabled_agent_deleted',
  invalid_schedule: 'com_ui_schedule_disabled_invalid',
  permission_revoked: 'com_ui_schedule_disabled_permission_revoked',
  insufficient_balance: 'com_ui_schedule_disabled_insufficient_balance',
  project_deleted: 'com_ui_schedule_disabled_project_deleted',
  project_required: 'com_ui_schedule_disabled_project_required',
};

const TRAILING_TONE: Record<ScheduleRowTone, string> = {
  running: 'text-text-secondary',
  paused: 'text-text-secondary',
  warning: 'text-status-warning',
  error: 'text-status-error',
};

/**
 * The row's state, in the margin. A dot for the two states the clock owns, filled
 * while the schedule is running to its cadence and hollow while it is paused, and a
 * triangle for the two that want their owner: the shape changes with the meaning, so
 * the marker does not rest on colour alone.
 */
function StateMarker({ tone }: { tone: ScheduleRowTone }) {
  if (tone === 'error' || tone === 'warning') {
    return (
      <TriangleAlert
        aria-hidden="true"
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          tone === 'error' ? 'text-status-error' : 'text-status-warning',
        )}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'mt-1.5 size-2 shrink-0 rounded-full',
        tone === 'running' ? 'bg-status-success' : 'border-border-heavy border',
      )}
    />
  );
}

/**
 * What the state means, at the end of the title line: when the next run lands, or
 * the one word that explains why none is coming. When a previous run has a
 * conversation, keep its navigation available alongside the current state.
 */
function TrailingState({
  label,
  tone,
  nextRun,
  conversationId,
  onOpenRun,
  openRunLabel,
}: {
  label: string | null;
  tone: ScheduleRowTone;
  nextRun: { relative: string; full: string } | null;
  conversationId?: string;
  onOpenRun: () => void;
  openRunLabel: string;
}) {
  if (label == null && nextRun == null) {
    return null;
  }

  const content =
    label != null ? (
      label
    ) : (
      <>
        {/* The bare time is what the eye needs; the sentence is what a screen
            reader needs, since "Mon 9:00 AM" alone does not say which run. */}
        <span aria-hidden="true">{nextRun?.relative}</span>
        <span className="sr-only">{nextRun?.full}</span>
      </>
    );
  const className = cn('shrink-0 text-xs', TRAILING_TONE[tone]);

  if (conversationId == null || conversationId === '') {
    return <span className={className}>{content}</span>;
  }

  return (
    <button
      type="button"
      title={openRunLabel}
      aria-label={label == null ? openRunLabel : `${label}: ${openRunLabel}`}
      onClick={onOpenRun}
      className={cn(
        className,
        'focus-visible:ring-text-primary rounded-sm hover:underline focus-visible:ring-2 focus-visible:outline-hidden',
      )}
    >
      {content}
    </button>
  );
}

export default function ScheduleCard({ schedule, projectName }: ScheduleCardProps) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const lastRunKey = scheduleLastRunKey(schedule);
  const [immediateMCPFailure, setImmediateMCPFailure] =
    useState<ImmediateScheduleMCPFailure | null>(null);
  const mcpOutcomes = scheduleMCPCardOutcomes(schedule, immediateMCPFailure);
  const disabledMCPLabel = scheduleDisabledMCPLabel(schedule.disabledReason, mcpOutcomes);
  const { i18n } = useTranslation();
  const { showToast } = useToastContext();
  const agentsMap = useAgentsMapContext();
  const agentNames = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(agentsMap ?? {}).map(([id, agent]) => [id, agent?.name || id]),
      ),
    [agentsMap],
  );
  // Enable/disable, run-now, edit and delete all hit CREATE-gated routes, so a
  // USE-only viewer sees a read-only card instead of controls that 403.
  const canWrite = useHasAccess({
    permissionType: PermissionTypes.SCHEDULES,
    permission: Permissions.CREATE,
  });

  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  const mappedAgent = agentsMap?.[schedule.agent_id];
  const { data: fetchedAgent } = useGetAgentByIdQuery(schedule.agent_id, {
    enabled: agentsMap !== undefined && mappedAgent == null,
  });
  const agentName = mappedAgent?.name || fetchedAgent?.name || schedule.agent_id;

  const updateSchedule = useUpdateScheduleMutation({
    /** Re-enabling re-validates the schedule's EFFECTIVE state — its stored agent, its
     *  cadence against the current floor, and its project against the current policy —
     *  so this switch is a real place to meet a 400. A generic failure toast would
     *  leave the owner flipping a switch that keeps flipping back; point them at the
     *  dialog, which is where the fixable settings are. */
    onError: (error, variables) => {
      const outcomes = scheduleMCPErrorOutcomes(error);
      setImmediateMCPFailure(outcomes.length > 0 ? { outcomes, lastRunKey } : null);
      const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
      const blockedEnable = status === 400 && variables.payload.enabled === true;
      showToast({
        message:
          scheduleMCPErrorMessage(error, localize) ??
          localize(blockedEnable ? 'com_ui_schedule_enable_blocked' : 'com_ui_error'),
        status: 'error',
      });
    },
  });
  const deleteSchedule = useDeleteScheduleMutation();
  const runSchedule = useRunScheduleNowMutation();

  const handleToggle = useCallback(
    (checked: boolean) => {
      setImmediateMCPFailure(null);
      updateSchedule.mutate({ id: schedule.id, payload: { enabled: checked } });
    },
    [schedule.id, updateSchedule],
  );

  const handleRunNow = useCallback(() => {
    setImmediateMCPFailure(null);
    runSchedule.mutate(schedule.id, {
      onSuccess: () => {
        showToast({ message: localize('com_ui_schedule_run_now_started'), status: 'success' });
        setMenuOpen(false);
      },
      onError: (error) => {
        const outcomes = scheduleMCPErrorOutcomes(error);
        setImmediateMCPFailure(outcomes.length > 0 ? { outcomes, lastRunKey } : null);
        showToast({
          message: scheduleMCPErrorMessage(error, localize) ?? localize('com_ui_error'),
          status: 'error',
        });
      },
    });
  }, [schedule.id, runSchedule, showToast, localize, lastRunKey]);

  const confirmDelete = useCallback(() => {
    deleteSchedule.mutate(schedule.id, {
      onSuccess: () => {
        showToast({ message: localize('com_ui_deleted'), status: 'success' });
        setDeleteOpen(false);
      },
      onError: () => {
        showToast({ message: localize('com_ui_error'), status: 'error' });
      },
    });
  }, [schedule.id, deleteSchedule, showToast, localize]);

  const hour12 = useClockFormat();
  const weekStartsOn = useWeekStart();
  const cadenceText = describeCadence(
    schedule.cadence,
    localize,
    i18n.language,
    hour12,
    weekStartsOn,
  );

  const nextRun = useMemo(() => {
    if (!schedule.enabled || schedule.nextRunAt == null) {
      return null;
    }
    const timestamp = getMessageTimestamp(schedule.nextRunAt, i18n.language, hour12);
    if (!timestamp) {
      return null;
    }
    return {
      relative: timestamp.relative,
      full: localize('com_ui_schedule_next_run', { time: timestamp.relative }),
    };
  }, [schedule.enabled, schedule.nextRunAt, i18n.language, hour12, localize]);

  const dropdownItems = useMemo(
    () => [
      {
        label: localize('com_ui_schedule_run_now'),
        onClick: handleRunNow,
        hideOnClick: false,
        disabled: runSchedule.isLoading,
        icon: runSchedule.isLoading ? (
          <Spinner className="size-4" />
        ) : (
          <Play className="icon-sm text-text-primary mr-2" aria-hidden="true" />
        ),
      },
      {
        label: localize('com_ui_edit'),
        onClick: () => setEditOpen(true),
        icon: <Pencil className="icon-sm text-text-primary mr-2" aria-hidden="true" />,
        ariaHasPopup: 'dialog' as const,
        hideOnClick: false,
        ref: editButtonRef,
        render: (props) => <button {...props} />,
      },
      {
        label: localize('com_ui_delete'),
        onClick: () => setDeleteOpen(true),
        icon: <Trash className="icon-sm text-text-primary mr-2" aria-hidden="true" />,
        ariaHasPopup: 'dialog' as const,
        hideOnClick: false,
        ref: deleteButtonRef,
        render: (props) => <button {...props} />,
      },
    ],
    [localize, handleRunNow, runSchedule.isLoading],
  );

  const lastRunConvoId = schedule.lastRun?.conversationId;

  /** One state per row, derived once so the marker and the word cannot disagree. */
  const rowState = useMemo(() => scheduleRowState(schedule, localize), [schedule, localize]);

  /** The agent, the cadence and the project are the row's detail, on one line in the
   *  order you would say them. The full text stays in `title`, since the line is the
   *  first thing a narrow panel truncates. */
  const detailText = [agentName, cadenceText, projectName].filter(Boolean).join(' · ');

  return (
    <div
      data-testid="schedule-card"
      className="group hover:bg-surface-active-alt rounded-lg bg-transparent px-3 py-2.5"
    >
      <div className="flex items-start gap-2.5">
        {/* The state, in the margin: a filled dot for a schedule that is running to
            its cadence, a hollow one for a paused one, and a triangle for the two
            states that want the owner rather than the clock. */}
        <StateMarker tone={rowState.tone} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-text-primary min-w-0 flex-1 truncate text-sm font-medium">
              {schedule.name}
            </span>
            <TrailingState
              label={rowState.label}
              tone={rowState.tone}
              nextRun={nextRun}
              conversationId={rowState.tone === 'running' ? undefined : lastRunConvoId}
              onOpenRun={() => navigate(`/c/${lastRunConvoId}`)}
              openRunLabel={localize('com_ui_schedule_last_run')}
            />
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <p className="text-text-secondary min-w-0 flex-1 truncate text-xs" title={detailText}>
              {detailText}
            </p>
            {rowState.tone === 'running' && lastRunConvoId && (
              <Link
                to={`/c/${lastRunConvoId}`}
                aria-label={`${localize('com_ui_schedule_last_run')}: ${schedule.name}`}
                className="text-text-secondary focus-visible:ring-text-primary shrink-0 rounded-sm text-xs hover:underline focus-visible:ring-2 focus-visible:outline-hidden"
              >
                {localize('com_ui_schedule_last_run')}
              </Link>
            )}
            {canWrite && (
              /* Not the collapsible slot other rows use: this panel's rows end at
                 the sidebar's resize handle, and a slot collapsed to zero width
                 puts the switch's clickable point outside the panel entirely,
                 under that handle, where no hover can ever reveal it. The menu
                 trigger still fades in on row hover by itself. */
              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  checked={schedule.enabled}
                  onCheckedChange={handleToggle}
                  disabled={updateSchedule.isLoading}
                  aria-label={`${localize('com_ui_schedule_enabled')}: ${schedule.name}`}
                  className="shrink-0"
                />
                <DropdownPopup
                  portal={true}
                  menuId={menuId}
                  focusLoop={true}
                  className="z-[125]"
                  unmountOnHide={true}
                  isOpen={menuOpen}
                  setIsOpen={setMenuOpen}
                  trigger={
                    <Ariakit.MenuButton
                      id={`schedule-menu-${schedule.id}`}
                      aria-label={`${localize('com_ui_schedule_options')}: ${schedule.name}`}
                      className={rowActionClasses({ open: menuOpen })}
                    >
                      <Ellipsis className="size-4" aria-hidden={true} />
                    </Ariakit.MenuButton>
                  }
                  items={dropdownItems}
                />
              </div>
            )}
          </div>
          {/* Only what the two lines above cannot say: why the clock stopped, and how
              to get an MCP server back. A healthy schedule shows neither. */}
          {schedule.disabledReason != null && (
            <div className="mt-1.5">
              <Chip tone="error">
                {localize(disabledMCPLabel ?? DISABLED_REASON_LABELS[schedule.disabledReason])}
              </Chip>
            </div>
          )}
          <ScheduleMCPRecovery
            outcomes={mcpOutcomes}
            fallbackAgentId={schedule.agent_id}
            agentNames={agentNames}
            onOpenAgent={(ownerId) => navigate(`/c/new?agent_id=${encodeURIComponent(ownerId)}`)}
          />
        </div>
      </div>
      {editOpen && (
        <ScheduleDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          schedule={schedule}
          triggerRef={editButtonRef as React.MutableRefObject<HTMLButtonElement | null>}
        />
      )}
      <OGDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        triggerRef={deleteButtonRef as React.MutableRefObject<HTMLButtonElement | null>}
      >
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_ui_schedule_delete')}
          className="w-11/12 max-w-lg"
          main={
            <Label className="text-left text-sm font-medium">
              <Trans
                i18nKey="com_ui_delete_confirm_strong"
                values={{ title: schedule.name }}
                components={{ strong: <strong /> }}
              />
            </Label>
          }
          selection={{
            selectHandler: confirmDelete,
            selectClasses:
              'bg-surface-destructive text-text-on-status hover:bg-surface-destructive-hover',
            selectText: localize('com_ui_delete'),
          }}
        />
      </OGDialog>
    </div>
  );
}
