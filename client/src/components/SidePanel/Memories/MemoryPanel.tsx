import { useMemo, useState, useEffect, useId } from 'react';
import { Plus } from 'lucide-react';
import { matchSorter } from 'match-sorter';
import { SystemRoles, PermissionTypes, Permissions } from 'librechat-data-provider';
import {
  Button,
  CheckboxGlyph,
  Dropdown,
  FilterInput,
  TooltipAnchor,
  OGDialogTrigger,
  useToastContext,
} from '@librechat/client';
import type { TUserMemory } from 'librechat-data-provider';
import {
  useUpdateMemoryPreferencesMutation,
  useMemoriesQuery,
  useGetUserQuery,
} from '~/data-provider';
import { PanelFooter, PanelContent, PanelHeader } from '~/components/ui';
import { useLocalize, useAuthContext, useHasAccess } from '~/hooks';
import MemoryCardSkeleton from './MemoryCardSkeleton';
import MemoryCreateDialog from './MemoryCreateDialog';
import MemoryUsageBadge from './MemoryUsageBadge';
import AdminSettings from './AdminSettings';
import MemoryList from './MemoryList';
import { cn } from '~/utils';

/** Partition filter sentinels; any other value is an agent id */
const PARTITION_ALL = 'all';
const PARTITION_PERSONAL = 'personal';

export default function MemoryPanel() {
  const localize = useLocalize();
  const headingId = useId();
  const { user } = useAuthContext();
  const { data: userData } = useGetUserQuery();
  const { data: memData, isLoading } = useMemoriesQuery();
  const { showToast } = useToastContext();
  const [searchQuery, setSearchQuery] = useState('');
  const [partitionFilter, setPartitionFilter] = useState(PARTITION_ALL);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [referenceSavedMemories, setReferenceSavedMemories] = useState(true);

  const updateMemoryPreferencesMutation = useUpdateMemoryPreferencesMutation({
    onSuccess: () => {
      showToast({
        message: localize('com_ui_preferences_updated'),
        status: 'success',
      });
    },
    onError: () => {
      showToast({
        message: localize('com_ui_error_updating_preferences'),
        status: 'error',
      });
      setReferenceSavedMemories((prev) => !prev);
    },
  });

  useEffect(() => {
    if (userData?.personalization?.memories !== undefined) {
      setReferenceSavedMemories(userData.personalization.memories);
    }
  }, [userData?.personalization?.memories]);

  const handleMemoryToggle = (checked: boolean) => {
    setReferenceSavedMemories(checked);
    updateMemoryPreferencesMutation.mutate({ memories: checked });
  };

  const hasReadAccess = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.READ,
  });

  const hasUpdateAccess = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.UPDATE,
  });

  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.CREATE,
  });

  const hasOptOutAccess = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.OPT_OUT,
  });

  const memories: TUserMemory[] = useMemo(() => memData?.memories ?? [], [memData]);

  const partitionOptions = useMemo(() => {
    const agentsById = new Map<string, string>();
    for (const memory of memories) {
      if (memory.agentId != null && !agentsById.has(memory.agentId)) {
        agentsById.set(memory.agentId, memory.agentName ?? memory.agentId);
      }
    }
    if (agentsById.size === 0) {
      return null;
    }
    return [
      { value: PARTITION_ALL, label: localize('com_ui_memories_all') },
      { value: PARTITION_PERSONAL, label: localize('com_ui_memories_personal') },
      ...[...agentsById.entries()].map(([value, label]) => ({ value, label })),
    ];
  }, [memories, localize]);

  /** Falls back to "all" when the selected partition no longer exists
   *  (e.g. the last memory of that agent was deleted), so the panel never
   *  gets stuck filtering on a removed partition. */
  const activePartition = useMemo(() => {
    if (partitionFilter === PARTITION_ALL || partitionFilter === PARTITION_PERSONAL) {
      return partitionFilter;
    }
    return partitionOptions?.some((option) => option.value === partitionFilter)
      ? partitionFilter
      : PARTITION_ALL;
  }, [partitionOptions, partitionFilter]);

  const filteredMemories = useMemo(() => {
    const partitionMemories =
      activePartition === PARTITION_ALL
        ? memories
        : memories.filter((memory) =>
            activePartition === PARTITION_PERSONAL
              ? memory.agentId == null
              : memory.agentId === activePartition,
          );
    return matchSorter(partitionMemories, searchQuery, {
      keys: ['key', 'value'],
    });
  }, [memories, searchQuery, activePartition]);

  if (!hasReadAccess) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <div className="text-center">
          <p className="text-text-secondary text-sm">{localize('com_ui_no_read_access')}</p>
        </div>
      </div>
    );
  }

  const tokenLimit = memData?.tokenLimit ?? null;
  const showUsageBadge = tokenLimit != null;

  return (
    <div
      role="region"
      aria-labelledby={headingId}
      className="flex h-full w-full flex-col overflow-hidden pt-2"
    >
      {/* Sticky header: title, create, filter, partition, usage + toggle */}
      <PanelHeader
        title={localize('com_ui_memories')}
        titleId={headingId}
        action={
          hasCreateAccess && (
            <MemoryCreateDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
              <OGDialogTrigger asChild>
                <TooltipAnchor
                  description={localize('com_ui_create_memory')}
                  side="bottom"
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      aria-label={localize('com_ui_create_memory')}
                      onClick={() => setCreateDialogOpen(true)}
                    >
                      <Plus className="size-4" aria-hidden="true" />
                    </Button>
                  }
                />
              </OGDialogTrigger>
            </MemoryCreateDialog>
          )
        }
        search={
          <FilterInput
            inputId="memory-search"
            label={localize('com_ui_memories_filter')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        }
      >
        {/* Partition filter (only when agent-scoped memories exist) */}
        {partitionOptions && (
          <Dropdown
            value={activePartition}
            onChange={setPartitionFilter}
            options={partitionOptions}
            className="w-full"
            triggerClassName="w-full"
            ariaLabel={localize('com_ui_memories_partition_filter')}
            testId="memory-partition-filter"
          />
        )}

        {/* Controls: Usage Badge + Memory Toggle */}
        {(showUsageBadge || hasOptOutAccess) && (
          <div className="flex items-center justify-between">
            {/* Usage Badge */}
            {showUsageBadge && (
              <MemoryUsageBadge
                percentage={memData?.usagePercentage ?? 0}
                tokenLimit={tokenLimit}
                totalTokens={memData?.totalTokens ?? 0}
              />
            )}

            {/* Memory Toggle */}
            {hasOptOutAccess && (
              <Button
                size="sm"
                variant="outline"
                className={cn(
                  showUsageBadge ? 'ml-auto' : 'w-full',
                  referenceSavedMemories && 'bg-surface-hover hover:bg-surface-hover',
                )}
                onClick={() => handleMemoryToggle(!referenceSavedMemories)}
                aria-label={localize('com_ui_use_memory')}
                aria-pressed={referenceSavedMemories}
                disabled={updateMemoryPreferencesMutation.isLoading}
              >
                {/* The button owns the state through `aria-pressed`; this is the
                    mark, not a second control inside it. */}
                <CheckboxGlyph checked={referenceSavedMemories} />
                {localize('com_ui_use_memory')}
              </Button>
            )}
          </div>
        )}
      </PanelHeader>

      {/* Only the list scrolls */}
      <PanelContent isLoading={isLoading} skeleton={<MemoryCardSkeleton />} className="px-3 pb-3">
        <MemoryList
          memories={filteredMemories}
          hasUpdateAccess={hasUpdateAccess}
          isFiltered={searchQuery.length > 0}
        />
      </PanelContent>

      {user?.role === SystemRoles.ADMIN && (
        <PanelFooter>
          <AdminSettings />
        </PanelFooter>
      )}
    </div>
  );
}
