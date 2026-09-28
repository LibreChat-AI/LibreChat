import { useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { Button, TooltipAnchor } from '@librechat/client';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { PanelContent, PanelFooter } from '~/components/ui';
import { useChatProjectNames } from './useScheduleProjects';
import ScheduleCardSkeleton from './ScheduleCardSkeleton';
import ScheduleEmptyState from './ScheduleEmptyState';
import { useSchedulesQuery } from '~/data-provider';
import { useLocalize, useHasAccess } from '~/hooks';
import ScheduleDialog from './ScheduleDialog';
import ScheduleCard from './ScheduleCard';
import useRunSync from './useRunSync';

export default function SchedulePanel() {
  const localize = useLocalize();
  const { data, dataUpdatedAt, isLoading, isError, refetch } = useSchedulesQuery();
  /** The cards refresh themselves from this query; the sidebar cannot, so the
   *  chat a run just produced is read out of the same poll. */
  useRunSync(data?.schedules, dataUpdatedAt);
  const [createOpen, setCreateOpen] = useState(false);

  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.SCHEDULES,
    permission: Permissions.CREATE,
  });

  const schedules = data?.schedules ?? [];
  /** ONE lookup for the whole list. Resolving a name inside each card would re-walk
   *  every loaded project per card, per render. Skipped entirely until some schedule
   *  actually has a scope, so an unscoped panel issues no project request at all. */
  const projectNames = useChatProjectNames(
    schedules.some((schedule) => schedule.chatProjectId != null),
  );
  const maxPerUser = data?.limits.maxPerUser;
  const atLimit = maxPerUser !== undefined && schedules.length >= maxPerUser;
  let panelContent: ReactNode;

  if (isError) {
    panelContent = <ScheduleEmptyState isError onRetry={() => refetch()} />;
  } else if (schedules.length === 0) {
    panelContent = <ScheduleEmptyState canCreate={hasCreateAccess && !atLimit} />;
  } else {
    panelContent = (
      <div className="space-y-2" role="list" aria-label={localize('com_ui_schedules')}>
        {schedules.map((schedule) => (
          <div key={schedule.id} role="listitem">
            <ScheduleCard
              schedule={schedule}
              // The raw id is a poor label but an honest one: it only shows for a
              // project outside the loaded pages, and beats claiming no scope.
              projectName={
                schedule.chatProjectId != null
                  ? (projectNames.get(schedule.chatProjectId) ?? schedule.chatProjectId)
                  : null
              }
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label={localize('com_ui_schedules')}
      className="flex h-full w-full flex-col overflow-hidden pt-2"
    >
      <div className="shrink-0 px-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-text-primary">
            {localize('com_ui_schedules')}
          </span>
          {hasCreateAccess && (
            <TooltipAnchor
              description={localize('com_ui_schedule_new')}
              side="bottom"
              render={
                <Button
                  variant="outline"
                  size="icon"
                  className="size-9 shrink-0 bg-transparent"
                  aria-label={localize('com_ui_schedule_new')}
                  disabled={atLimit || isError || isLoading}
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="size-4" aria-hidden="true" />
                </Button>
              }
            />
          )}
        </div>
      </div>

      <PanelContent isLoading={isLoading} skeleton={<ScheduleCardSkeleton />} className="px-3 pb-3">
        {/* A failed query must not masquerade as an empty list or enable creation
            against limits that could not be loaded. */}
        {panelContent}
      </PanelContent>

      {!isLoading && !isError && maxPerUser !== undefined && (
        <PanelFooter className="justify-start">
          <p className="text-xs text-text-secondary">
            {localize('com_ui_schedules_used', { used: schedules.length, max: maxPerUser })}
          </p>
        </PanelFooter>
      )}

      {createOpen && <ScheduleDialog open={createOpen} onOpenChange={setCreateOpen} />}
    </div>
  );
}
