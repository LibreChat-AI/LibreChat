import { useId, useRef, useMemo, useState, useCallback } from 'react';
import * as Ariakit from '@ariakit/react';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Play, Trash, Folder, Pencil, Ellipsis } from 'lucide-react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
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
import type { TSchedule, ScheduleRunStatus, ScheduleDisabledReason } from 'librechat-data-provider';
import type { ImmediateScheduleMCPFailure } from './errors';
import type { TranslationKeys } from '~/hooks';
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
import ScheduleMCPRecovery from './ScheduleMCPRecovery';
import { useAgentsMapContext } from '~/Providers';
import { getMessageTimestamp } from '~/utils';
import ScheduleDialog from './ScheduleDialog';
import { describeCadence } from './cadence';

interface ScheduleCardProps {
  schedule: TSchedule;
  /** Resolved by the panel, which holds ONE project-name lookup for the whole list —
   *  deriving it per card is O(schedules x projects) on every project-list refresh. */
  projectName?: string | null;
}

type StatusTone = 'neutral' | 'success' | 'warning' | 'error';

const STATUS_CHIPS: Record<ScheduleRunStatus, { label: TranslationKeys; tone: StatusTone }> = {
  success: { label: 'com_ui_schedule_last_run', tone: 'success' },
  error: { label: 'com_ui_schedule_last_run_failed', tone: 'error' },
  interrupted: { label: 'com_ui_schedule_last_run_failed', tone: 'error' },
  requires_action: { label: 'com_ui_schedule_needs_approval', tone: 'warning' },
  started: { label: 'com_ui_schedule_run_started', tone: 'neutral' },
  skipped_overlap: { label: 'com_ui_schedule_run_skipped', tone: 'neutral' },
  skipped_balance: { label: 'com_ui_schedule_run_skipped', tone: 'neutral' },
};

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

  const nextRunText = useMemo(() => {
    if (!schedule.enabled || schedule.nextRunAt == null) {
      return null;
    }
    const timestamp = getMessageTimestamp(schedule.nextRunAt, i18n.language, hour12);
    if (!timestamp) {
      return null;
    }
    return localize('com_ui_schedule_next_run', { time: timestamp.relative });
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
          <Play className="icon-sm mr-2 text-text-primary" aria-hidden="true" />
        ),
      },
      {
        label: localize('com_ui_edit'),
        onClick: () => setEditOpen(true),
        icon: <Pencil className="icon-sm mr-2 text-text-primary" aria-hidden="true" />,
        ariaHasPopup: 'dialog' as const,
        hideOnClick: false,
        ref: editButtonRef,
        render: (props) => <button {...props} />,
      },
      {
        label: localize('com_ui_delete'),
        onClick: () => setDeleteOpen(true),
        icon: <Trash className="icon-sm mr-2 text-text-primary" aria-hidden="true" />,
        ariaHasPopup: 'dialog' as const,
        hideOnClick: false,
        ref: deleteButtonRef,
        render: (props) => <button {...props} />,
      },
    ],
    [localize, handleRunNow, runSchedule.isLoading],
  );

  const statusChip = schedule.lastRun ? STATUS_CHIPS[schedule.lastRun.status] : null;
  const lastRunConvoId = schedule.lastRun?.conversationId;

  return (
    <div
      data-testid="schedule-card"
      className="rounded-lg border border-border-light bg-transparent px-3 py-2.5 transition-colors duration-theme-fast hover:bg-surface-secondary"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
          {schedule.name}
        </span>
        {canWrite && (
          <>
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
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-tertiary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
                >
                  <Ellipsis className="size-4" aria-hidden={true} />
                </Ariakit.MenuButton>
              }
              items={dropdownItems}
            />
          </>
        )}
      </div>
      <p className="mt-0.5 truncate text-xs text-text-secondary" title={agentName}>
        {agentName}
      </p>
      {projectName != null && projectName !== '' && (
        <p
          className="mt-0.5 flex items-center gap-1 truncate text-xs text-text-secondary"
          title={projectName}
        >
          <Folder className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{projectName}</span>
        </p>
      )}
      <p className="mt-1 text-sm text-text-primary">{cadenceText}</p>
      {nextRunText != null && <p className="mt-0.5 text-xs text-text-secondary">{nextRunText}</p>}
      {(statusChip != null || schedule.disabledReason != null) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {statusChip != null &&
            (lastRunConvoId != null && lastRunConvoId !== '' ? (
              <button
                type="button"
                className="rounded-full hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
                onClick={() => navigate(`/c/${lastRunConvoId}`)}
              >
                <Chip tone={statusChip.tone}>{localize(statusChip.label)}</Chip>
              </button>
            ) : (
              <Chip tone={statusChip.tone}>{localize(statusChip.label)}</Chip>
            ))}
          {schedule.disabledReason != null && (
            <Chip tone="error">
              {localize(disabledMCPLabel ?? DISABLED_REASON_LABELS[schedule.disabledReason])}
            </Chip>
          )}
        </div>
      )}
      <div className="mt-1">
        <ScheduleMCPRecovery
          outcomes={mcpOutcomes}
          fallbackAgentId={schedule.agent_id}
          agentNames={agentNames}
          onOpenAgent={(ownerId) => navigate(`/c/new?agent_id=${encodeURIComponent(ownerId)}`)}
        />
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
