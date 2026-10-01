import { useState, type ReactNode, useId } from 'react';
import { Plus } from 'lucide-react';
import { Button, FilterInput, TooltipAnchor } from '@librechat/client';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { PanelContent, PanelFooter, PanelHeader } from '~/components/ui';
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
  const headingId = useId();
  const { data, dataUpdatedAt, isLoading, isError, refetch } = useSchedulesQuery();
  /** The cards refresh themselves from this query; the sidebar cannot, so the
   *  chat a run just produced is read out of the same poll. */
  useRunSync(data?.schedules, dataUpdatedAt);
  const [createOpen, setCreateOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.SCHEDULES,
    permission: Permissions.CREATE,
  });

  const allSchedules = data?.schedules ?? [];
  /** Filtering is client-side because the panel already holds every schedule the
   *  limit allows; a query per keystroke would buy nothing. */
  const query = searchQuery.trim().toLowerCase();
  const schedules =
    query.length > 0
      ? allSchedules.filter((schedule) => schedule.name.toLowerCase().includes(query))
      : allSchedules;
  /** ONE lookup for the whole list. Resolving a name inside each card would re-walk
   *  every loaded project per card, per render. Skipped entirely until some schedule
   *  actually has a scope, so an unscoped panel issues no project request at all. */
  const projectNames = useChatProjectNames(
    schedules.some((schedule) => schedule.chatProjectId != null),
  );
  const maxPerUser = data?.limits.maxPerUser;
  const atLimit = maxPerUser !== undefined && allSchedules.length >= maxPerUser;
  let filterAnnouncement = '';
  if (query.length > 0 && !isLoading && !isError) {
    filterAnnouncement =
      schedules.length === 1
        ? localize('com_ui_search_result_count', { count: schedules.length })
        : localize('com_ui_search_results_count', { count: schedules.length });
  }
  let panelContent: ReactNode;

  if (isError) {
    panelContent = <ScheduleEmptyState isError onRetry={() => refetch()} />;
  } else if (schedules.length === 0) {
    panelContent = (
      <ScheduleEmptyState canCreate={hasCreateAccess && !atLimit} isFiltered={query.length > 0} />
    );
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
      aria-labelledby={headingId}
      className="flex h-full w-full flex-col overflow-hidden pt-2"
    >
      <PanelHeader
        title={localize('com_ui_schedules')}
        titleId={headingId}
        action={
          hasCreateAccess && (
            <TooltipAnchor
              description={localize('com_ui_schedule_new')}
              side="bottom"
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  aria-label={localize('com_ui_schedule_new')}
                  disabled={atLimit || isError || isLoading}
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="size-4" aria-hidden="true" />
                </Button>
              }
            />
          )
        }
        search={
          <>
            {/* Focus stays in the field while the list changes, so the match count
                is announced rather than left for the user to go and find. */}
            <div aria-live="polite" aria-atomic="true" className="sr-only">
              {filterAnnouncement}
            </div>
            <FilterInput
              inputId="schedules-filter"
              label={localize('com_ui_schedules_filter')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </>
        }
      />

      <PanelContent isLoading={isLoading} skeleton={<ScheduleCardSkeleton />} className="px-3 pb-3">
        {/* A failed query must not masquerade as an empty list or enable creation
            against limits that could not be loaded. */}
        {panelContent}
      </PanelContent>

      {!isLoading && !isError && maxPerUser !== undefined && (
        <PanelFooter className="justify-start">
          <p className="text-text-secondary text-xs">
            {localize('com_ui_schedules_used', { used: allSchedules.length, max: maxPerUser })}
          </p>
        </PanelFooter>
      )}

      {createOpen && <ScheduleDialog open={createOpen} onOpenChange={setCreateOpen} />}
    </div>
  );
}
