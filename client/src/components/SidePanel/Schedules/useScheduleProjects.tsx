import { useMemo } from 'react';
import { Folder } from 'lucide-react';
import type { TChatProject } from 'librechat-data-provider';
import type { OptionWithIcon } from '~/common';
import { useProjectsInfiniteQuery } from '~/data-provider';

/** Shared with `ProjectButton`, so every project surface reads one cached page set
 *  instead of each card and dialog opening its own list. */
const PROJECT_LIST_PARAMS = {
  sortBy: 'name',
  sortDirection: 'asc',
  limit: 100,
} as const;

function useLoadedProjects(enabled: boolean) {
  const { data, fetchNextPage, isFetchingNextPage, isLoading } = useProjectsInfiniteQuery(
    PROJECT_LIST_PARAMS,
    { enabled },
  );
  const projects = useMemo<TChatProject[]>(
    () => data?.pages.flatMap((page) => page.projects) ?? [],
    [data?.pages],
  );
  const hasNextPage = data?.pages[data.pages.length - 1]?.nextCursor != null;
  return { projects, hasNextPage, fetchNextPage, isFetchingNextPage, isLoading };
}

/**
 * Name lookup ONLY, deliberately built without the picker's option list.
 *
 * Call this ONCE for a whole list of schedules, not per row: React Query shares the
 * request, but every hook instance still walks all loaded projects, and the picker
 * shape additionally allocates an icon element per project. Per-card that is
 * O(schedules x projects) of work — and a fresh React element per project per card —
 * on every render and every project-list refresh.
 */
export function useChatProjectNames(enabled = true): Map<string, string> {
  const { projects } = useLoadedProjects(enabled);
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects) {
      names.set(project._id, project.name);
    }
    return names;
  }, [projects]);
}

export interface ChatProjectPicker {
  items: OptionWithIcon[];
  /** Names of the projects paged in so far; a stored id outside them needs its own read. */
  namesById: Map<string, string>;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  isFetchingNextPage: boolean;
  isLoading: boolean;
}

/** Picker-shaped projects for the schedule dialog's single combobox. */
export function useChatProjectPicker(enabled = true): ChatProjectPicker {
  const { projects, hasNextPage, fetchNextPage, isFetchingNextPage, isLoading } =
    useLoadedProjects(enabled);

  /** One pass builds both the option list and the name lookup the display value reads. */
  const { items, namesById } = useMemo(() => {
    const options: OptionWithIcon[] = [];
    const names = new Map<string, string>();
    for (const project of projects) {
      names.set(project._id, project.name);
      options.push({
        label: project.name,
        value: project._id,
        icon: <Folder className="h-4 w-4 text-text-secondary" aria-hidden="true" />,
      });
    }
    return { items: options, namesById: names };
  }, [projects]);

  return { items, namesById, hasNextPage, fetchNextPage, isFetchingNextPage, isLoading };
}
