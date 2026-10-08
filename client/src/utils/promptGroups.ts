import { InfiniteCollections, QueryKeys } from 'librechat-data-provider';
import type {
  PromptGroupListResponse,
  PromptGroupListData,
  TPromptGroup,
} from 'librechat-data-provider';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import {
  addData,
  deleteData,
  updateData,
  updateFields,
  addToCacheList,
  updateCacheList,
  updateFieldsInPlace,
  removeFromCacheList,
  getRecordByProperty,
} from './collection';

export const addPromptGroup = (
  data: InfiniteData<PromptGroupListResponse>,
  newPromptGroup: TPromptGroup,
): PromptGroupListData => {
  return addData<PromptGroupListResponse, TPromptGroup>(
    data,
    InfiniteCollections.PROMPT_GROUPS,
    newPromptGroup,
    (page) => page.promptGroups.findIndex((group) => group._id === newPromptGroup._id),
  );
};

export const updatePromptGroup = (
  data: InfiniteData<PromptGroupListResponse>,
  updatedPromptGroup: TPromptGroup,
): PromptGroupListData => {
  return updateData<PromptGroupListResponse, TPromptGroup>(
    data,
    InfiniteCollections.PROMPT_GROUPS,
    updatedPromptGroup,
    (page) => page.promptGroups.findIndex((group) => group._id === updatedPromptGroup._id),
  );
};

export const deletePromptGroup = (
  data: InfiniteData<PromptGroupListResponse>,
  groupId: string,
): PromptGroupListData => {
  return deleteData<PromptGroupListResponse, PromptGroupListData>(
    data,
    InfiniteCollections.PROMPT_GROUPS,
    (page) => page.promptGroups.findIndex((group) => group._id === groupId),
  );
};

export const updateGroupFields = (
  data: InfiniteData<PromptGroupListResponse>,
  updatedGroup: Partial<TPromptGroup>,
  callback?: (group: TPromptGroup) => void,
): InfiniteData<PromptGroupListResponse> => {
  return updateFields<PromptGroupListResponse, TPromptGroup>(
    data,
    updatedGroup,
    InfiniteCollections.PROMPT_GROUPS,
    '_id',
    callback,
  );
};

export const updateGroupFieldsInPlace = (
  data: InfiniteData<PromptGroupListResponse>,
  updatedGroup: Partial<TPromptGroup>,
): InfiniteData<PromptGroupListResponse> => {
  return updateFieldsInPlace<PromptGroupListResponse, TPromptGroup>(
    data,
    updatedGroup,
    InfiniteCollections.PROMPT_GROUPS,
    '_id',
  );
};

export const getSnippet = (promptText: string, length = 56) => {
  return promptText.length > length ? `${promptText.slice(0, length - 3)}...` : promptText;
};

export const findPromptGroup = (
  data: InfiniteData<PromptGroupListResponse>,
  findProperty: (group: TPromptGroup) => boolean,
): TPromptGroup | undefined => {
  return getRecordByProperty<PromptGroupListResponse, TPromptGroup>(
    data,
    InfiniteCollections.PROMPT_GROUPS,
    findProperty,
  );
};

const restartUnresolvedAllPromptGroups = (
  queryClient: QueryClient,
  queryKey: string[],
): boolean => {
  const state = queryClient.getQueryState(queryKey);
  /**
   * An idle, never-fetched list must not be seeded partial; its first fetch
   * includes the mutation. A first fetch already in flight may have read the
   * database before the mutation and settle stale (invalidating alone does not
   * cancel a data-less fetch in React Query v4), and an errored fetch never
   * retries on its own because retry and refetch triggers are off.
   */
  if (!state || state.data === undefined) {
    if (state && (state.fetchStatus === 'fetching' || state.status === 'error')) {
      void queryClient.cancelQueries(queryKey).then(() => queryClient.invalidateQueries(queryKey));
    }
    return true;
  }
  return false;
};

export const addGroupToAll = (queryClient: QueryClient, newGroup: TPromptGroup) => {
  const queryKey = [QueryKeys.allPromptGroups];
  if (restartUnresolvedAllPromptGroups(queryClient, queryKey)) {
    return;
  }
  addToCacheList<TPromptGroup>(queryClient, queryKey, newGroup);
};

export const updateGroupInAll = (
  queryClient: QueryClient,
  updatedGroup: Partial<TPromptGroup> & { _id: string },
) => {
  const queryKey = [QueryKeys.allPromptGroups];
  if (restartUnresolvedAllPromptGroups(queryClient, queryKey)) {
    return;
  }
  updateCacheList<TPromptGroup>({
    queryClient,
    queryKey,
    searchProperty: '_id',
    updateData: updatedGroup,
    searchValue: updatedGroup._id,
  });
};

export const removeGroupFromAll = (queryClient: QueryClient, groupId: string) => {
  const queryKey = [QueryKeys.allPromptGroups];
  if (restartUnresolvedAllPromptGroups(queryClient, queryKey)) {
    return;
  }
  removeFromCacheList<TPromptGroup>(queryClient, queryKey, '_id', groupId);
};
