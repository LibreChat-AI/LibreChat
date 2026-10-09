import { useMemo } from 'react';
import { useRecoilState } from 'recoil';
import { usePromptGroupsInfiniteQuery } from '~/data-provider';
import store from '~/store';

export default function usePromptGroupsNav(hasAccess = true) {
  const [pageSize] = useRecoilState(store.promptsPageSize);
  const [category] = useRecoilState(store.promptsCategory);
  const [name, setName] = useRecoilState(store.promptsName);

  const groupsQuery = usePromptGroupsInfiniteQuery(
    {
      name,
      pageSize,
      category,
    },
    {
      enabled: hasAccess,
    },
  );

  const promptGroups = useMemo(() => {
    if (!hasAccess || !groupsQuery.data?.pages) {
      return [];
    }
    return groupsQuery.data.pages.flatMap((page) => page.promptGroups ?? []);
  }, [hasAccess, groupsQuery.data?.pages]);

  /** `useNavScrolling` stops fetching once this is null */
  const nextCursor = useMemo(() => {
    const pages = groupsQuery.data?.pages;
    if (!hasAccess || !pages?.length) {
      return null;
    }
    const lastPage = pages[pages.length - 1];
    return lastPage.has_more === true ? (lastPage.after ?? null) : null;
  }, [hasAccess, groupsQuery.data?.pages]);

  return {
    promptGroups,
    groupsQuery,
    nextCursor,
    fetchNextPage: groupsQuery.fetchNextPage,
    isFetchingNextPage: hasAccess ? groupsQuery.isFetchingNextPage : false,
    isFetching: hasAccess ? groupsQuery.isFetching : false,
    name,
    setName,
  };
}
