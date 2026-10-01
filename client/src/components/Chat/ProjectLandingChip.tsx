import { useCallback, useMemo } from 'react';
import { Folder, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { ControlCombobox, TooltipAnchor } from '@librechat/client';
import type { TChatProject } from 'librechat-data-provider';
import type { OptionWithIcon } from '~/common';
import { useProjectsInfiniteQuery } from '~/data-provider';
import { useChatContext } from '~/Providers';
import { useLocalize } from '~/hooks';

/**
 * Project scope control rendered inside the composer on a project-scoped
 * new-chat landing. The trigger switches projects; the trailing × drops the
 * scope. Both update the draft and `?projectId` in place so the typed message
 * and model are kept.
 */
export default function ProjectLandingChip({ project }: { project: TChatProject }) {
  const localize = useLocalize();
  const { conversation, setConversation } = useChatContext();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data } = useProjectsInfiniteQuery(
    { sortBy: 'lastConversationAt', sortDirection: 'desc', limit: 100 },
    { staleTime: 30000 },
  );
  const projects = useMemo(() => data?.pages.flatMap((page) => page.projects) ?? [], [data?.pages]);
  const items = useMemo<OptionWithIcon[]>(
    () =>
      projects.map((item) => ({
        label: item.name,
        value: item._id,
        icon: <Folder className="text-text-secondary h-4 w-4" aria-hidden="true" />,
      })),
    [projects],
  );

  const applyProject = useCallback(
    (projectId: string | null) => {
      if (conversation) {
        setConversation({ ...conversation, chatProjectId: projectId });
      }
      const nextParams = new URLSearchParams(searchParams);
      if (projectId) {
        nextParams.set('projectId', projectId);
      } else {
        nextParams.delete('projectId');
      }
      /** flushSync commits the URL with the draft update in one pass; a deferred
       *  (startTransition) URL lets ChatRoute see draft≠URL and re-init the scope */
      setSearchParams(nextParams, { replace: true, flushSync: true });
    },
    [conversation, setConversation, searchParams, setSearchParams],
  );

  return (
    <div className="flex items-center gap-0.5 px-2.5 pt-2">
      <ControlCombobox
        selectId="project-landing-select"
        selectedValue={project._id}
        displayValue={project.name}
        items={items}
        setValue={(value) => {
          if (value) {
            applyProject(value);
          }
        }}
        SelectIcon={<Folder className="text-text-secondary h-3.5 w-3.5" aria-hidden="true" />}
        ariaLabel={localize('com_ui_change_project')}
        searchPlaceholder={localize('com_ui_search_projects')}
        isCollapsed={false}
        showCarat={true}
        placement="top-start"
        gutter={12}
        matchTriggerWidth={false}
        containerClassName="w-auto min-w-0 px-0"
        className="text-text-secondary hover:bg-surface-hover hover:text-text-primary h-8 w-auto max-w-[14rem] min-w-[7.5rem] gap-1.5 rounded-full border-0 bg-transparent px-2.5 text-sm font-medium"
        popoverClassName="animate-popover-bottom min-w-64 rounded-2xl shadow-xl"
      />
      <TooltipAnchor
        description={localize('com_ui_remove_from_project')}
        render={
          <button
            type="button"
            aria-label={localize('com_ui_remove_from_project')}
            onClick={() => applyProject(null)}
            className="text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-inset"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        }
      />
    </div>
  );
}
