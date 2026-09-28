import { useSetAtom } from 'jotai';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService, MutationKeys, QueryKeys, defaultOrderQuery } from 'librechat-data-provider';
import {
  Constants,
  defaultAssistantsVersion,
  ConversationListResponse,
} from 'librechat-data-provider';
import type { InfiniteData, QueryClient, UseMutationResult } from '@tanstack/react-query';
import type * as t from 'librechat-data-provider';
import {
  logger,
  /* Conversations */
  addConvoToAllQueries,
  findPinnedConversation,
  findConversationInInfinite,
  updateConvoInAllQueries,
  removeConvoFromAllQueries,
  clearArchivedConversationMessagesCache,
  clearDeletedConversationMessagesCache,
} from '~/utils';
import useUpdateTagsInConvo from '~/hooks/Conversations/useUpdateTagsInConvo';
import { chatFilterTagsAtom } from '~/components/Conversations/chatFilters';
import { updateConversationTag } from '~/utils/conversationTags';
import { useConversationTagsQuery } from './queries';

export const useUpdateConversationMutation = (
  id: string,
): UseMutationResult<
  t.TUpdateConversationResponse,
  unknown,
  t.TUpdateConversationRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation(
    (payload: t.TUpdateConversationRequest) => dataService.updateConversation(payload),
    {
      onSuccess: (updatedConvo, payload) => {
        const targetId = payload.conversationId || id;
        /* A rename carries only a title, so only the title is taken from its
         * response. Writing the whole conversation would also restore its
         * pre-request copy of every other field, undoing a concurrent change
         * whose response happened to land first: an assignment moving the chat
         * to another project would silently revert here. */
        const applyRename = (previous?: t.TConversation): t.TConversation =>
          previous
            ? { ...previous, title: updatedConvo.title, updatedAt: updatedConvo.updatedAt }
            : updatedConvo;
        queryClient.setQueryData<t.TConversation>([QueryKeys.conversation, targetId], applyRename);
        updateConvoInAllQueries(queryClient, targetId, applyRename);
        /* A title-keyset cursor encodes the old ordering; patching loaded rows
         * cannot repair boundaries that have not been fetched yet. */
        queryClient.invalidateQueries({ queryKey: [QueryKeys.allConversations] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.archivedConversations] });
        queryClient.invalidateQueries([QueryKeys.projectConversations]);
      },
    },
  );
};

export const useTagConversationMutation = (
  conversationId: string,
  options?: t.updateTagsInConvoOptions,
): UseMutationResult<t.TTagConversationResponse, unknown, t.TTagConversationRequest, unknown> => {
  const queryClient = useQueryClient();
  const query = useConversationTagsQuery();
  const { updateTagsInConversation } = useUpdateTagsInConvo();
  return useMutation(
    (payload: t.TTagConversationRequest) =>
      dataService.addTagToConversation(conversationId, payload),
    {
      onSuccess: (updatedTags, ...rest) => {
        /** The pinned query is keyed by the active bookmark filter, so changing a
         * chat's tags can move it in or out of that filtered set. */
        queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
        query.refetch();
        updateTagsInConversation(conversationId, updatedTags);
        options?.onSuccess?.(updatedTags, ...rest);
      },
      onError: options?.onError,
      onMutate: options?.onMutate,
    },
  );
};

export const useArchiveConvoMutation = (
  options?: t.ArchiveConversationOptions,
): UseMutationResult<
  t.TArchiveConversationResponse,
  unknown,
  t.TArchiveConversationRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  const convoQueryKey = [QueryKeys.allConversations];
  const archivedConvoQueryKey = [QueryKeys.archivedConversations];
  const { onMutate, onError, onSuccess, ..._options } = options || {};

  return useMutation(
    (payload: t.TArchiveConversationRequest) => dataService.archiveConversation(payload),
    {
      onMutate,
      onSuccess: (_data, vars, context) => {
        const isArchived = vars.isArchived === true;

        removeConvoFromAllQueries(queryClient, vars.conversationId);

        /* Restoring removes the row from every cached archived variant immediately.
         * Archiving itself is reconciled by the all-pages invalidation in onSettled;
         * the mutation cannot know which sort/filter cursor owns the new row. */
        if (!isArchived) {
          for (const query of queryClient
            .getQueryCache()
            .findAll([QueryKeys.archivedConversations], { exact: false })) {
            queryClient.setQueryData<InfiniteData<ConversationListResponse>>(
              query.queryKey,
              (oldData) => {
                if (!oldData) {
                  return oldData;
                }
                return {
                  ...oldData,
                  pages: oldData.pages.map((page) => ({
                    ...page,
                    conversations: page.conversations.filter(
                      (conv) => conv.conversationId !== vars.conversationId,
                    ),
                  })),
                };
              },
            );
          }
        }

        queryClient.setQueryData(
          [QueryKeys.conversation, vars.conversationId],
          isArchived ? null : _data,
        );
        if (isArchived) {
          clearArchivedConversationMessagesCache(queryClient, vars.conversationId);
        }
        if (_data.chatProjectId) {
          queryClient.invalidateQueries([QueryKeys.project, _data.chatProjectId]);
        }

        onSuccess?.(_data, vars, context);
      },
      onError,
      onSettled: () => {
        queryClient.invalidateQueries({
          queryKey: convoQueryKey,
          refetchPage: () => true,
          refetchType: 'active',
        });
        /* Archived ordering and membership depend on the selected sort/filter, which
         * this mutation does not receive. Refetch every loaded page in mounted variants;
         * inactive variants are marked stale and refresh when mounted. */
        queryClient.invalidateQueries({
          queryKey: archivedConvoQueryKey,
          refetchPage: () => true,
          refetchType: 'active',
        });
        /** Archiving drops the chat from the pinned cache, so restoring one that is
         * still pinned has to refetch or the section would stay missing it. */
        queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
        queryClient.invalidateQueries([QueryKeys.projectConversations]);
        queryClient.invalidateQueries([QueryKeys.projects]);
      },
      ..._options,
    },
  );
};

export const useArchiveAllConversationsMutation = (
  options?: t.ArchiveAllConversationsOptions,
): UseMutationResult<t.TArchiveAllConversationsResponse, unknown, void, unknown> => {
  const queryClient = useQueryClient();
  const { onSuccess, onError, ..._options } = options || {};

  const reconcileCaches = () => {
    /* Archiving everything leaves no cached list trustworthy, but only the mounted ones are
       worth the round trips: the rest are dropped, so a remembered sort or bookmark variant
       cannot render chats that are all archived now and refetches from scratch when mounted. */
    for (const listKey of [QueryKeys.allConversations, QueryKeys.archivedConversations]) {
      queryClient.invalidateQueries({
        queryKey: [listKey],
        refetchPage: () => true,
        refetchType: 'active',
      });
      queryClient.removeQueries({ queryKey: [listKey], type: 'inactive' });
    }
    /** The pinned section fetches on its own key with a five-minute stale time, so an
     * archived pin would keep rendering in the sidebar without this. */
    queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
    queryClient.invalidateQueries([QueryKeys.projectConversations]);
    queryClient.invalidateQueries([QueryKeys.projects]);
    queryClient.invalidateQueries([QueryKeys.project]);
    queryClient.removeQueries([QueryKeys.project], { type: 'inactive' });
    queryClient.removeQueries({ queryKey: [QueryKeys.conversation] });
  };

  return useMutation(
    [MutationKeys.archiveAllConversations],
    () => dataService.archiveAllConversations(),
    {
      onSuccess: (data, vars, context) => {
        reconcileCaches();
        onSuccess?.(data, vars, context);
      },
      onError: (error, vars, context) => {
        reconcileCaches();
        onError?.(error, vars, context);
      },
      ..._options,
    },
  );
};

export const usePinConversationMutation = (
  options?: t.PinConversationOptions,
): UseMutationResult<t.TPinConversationResponse, unknown, t.TPinConversationRequest, unknown> => {
  const queryClient = useQueryClient();
  const { onSuccess, onError, ..._options } = options || {};

  return useMutation(
    [MutationKeys.convoPin],
    (payload: t.TPinConversationRequest) => dataService.pinConversation(payload),
    {
      onSuccess: async (data, vars, context) => {
        /** A project drop can start a list refresh before its following unpin.
         * Cancel that older snapshot before publishing the authoritative pin result. */
        await Promise.all([
          queryClient.cancelQueries([QueryKeys.allConversations]),
          queryClient.cancelQueries([QueryKeys.archivedConversations]),
          queryClient.cancelQueries([QueryKeys.pinnedConversations]),
        ]);
        /** `isShared` is derived per list request and is absent from this response, so
         * read it off the cached pin before the update drops that row: the reinsert
         * below has no existing chats row to carry the badge over from. */
        const cachedPin = findPinnedConversation(queryClient, vars.conversationId);
        const next =
          data.isShared === undefined && cachedPin?.isShared !== undefined
            ? { ...data, isShared: cachedPin.isShared }
            : data;
        updateConvoInAllQueries(queryClient, vars.conversationId, () => next);
        /* Pinned state is list-relevant in both active and archived views. The
         * archived variants carry filter/sort parameters, so invalidate by prefix. */
        queryClient.invalidateQueries({ queryKey: [QueryKeys.archivedConversations] });
        /** An older pin may exist only in the dedicated pinned cache. Unpinning
         * it has to put the returned row onto the chats list; later pages
         * cannot recover a conversation whose updatedAt just jumped ahead of
         * the current cursor. addConvoToAllQueries no-ops if it is already
         * present. */
        if (next.pinned !== true) {
          addConvoToAllQueries(queryClient, next);
        }
        /** The pinned section has its own fetch, so a new pin is only visible once
         * that list is refetched; unpins are already dropped from its cache above. */
        queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
        onSuccess?.(data, vars, context);
      },
      onError,
      ..._options,
    },
  );
};

/**
 * The sidebar badge reads `isShared` off the conversation list, which the server derives
 * from a different collection. Share mutations therefore have to flip it locally, or the
 * badge lags until the next conversation-list refetch.
 */
const setConversationSharedFlag = (
  queryClient: QueryClient,
  conversationId: string | null | undefined,
  isShared: boolean,
): void => {
  if (conversationId == null || conversationId === '') {
    return;
  }

  updateConvoInAllQueries(queryClient, conversationId, (convo) => ({ ...convo, isShared }));
};

/**
 * Create and update return a bare `TSharedLinkResponse`, so the per-conversation
 * cache entry has to be lifted into the `TSharedLinkGetResponse` shape the UI reads
 * (`success` gates the dialog's copy and the header badge). `snapshotFiles` is never
 * echoed back and the settings list lives under a sibling key, so both are refetched
 * from the server rather than guessed at.
 */
const syncSharedLinkQueries = (
  queryClient: QueryClient,
  data: t.TSharedLinkResponse,
  requestedSnapshotFiles?: boolean,
): void => {
  queryClient.setQueryData<t.TSharedLinkGetResponse>(
    [QueryKeys.sharedLinks, data.conversationId],
    (previous) => ({
      ...previous,
      ...data,
      // The response never echoes the file choice, and the dialog reads a resolved
      // entry with no choice as the enabled default, so an opt-out would flip back on
      // between here and the refetch.
      ...(requestedSnapshotFiles !== undefined && { snapshotFiles: requestedSnapshotFiles }),
      success: true,
    }),
  );

  setConversationSharedFlag(queryClient, data.conversationId, true);
  queryClient.invalidateQueries({ queryKey: [QueryKeys.archivedConversations] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.sharedLinks], exact: false });
};

export const useCreateSharedLinkMutation = (
  options?: t.MutationOptions<
    t.TCreateShareLinkRequest,
    { conversationId: string; targetMessageId?: string; snapshotFiles?: boolean }
  >,
): UseMutationResult<
  t.TSharedLinkResponse,
  unknown,
  { conversationId: string; targetMessageId?: string; snapshotFiles?: boolean },
  unknown
> => {
  const queryClient = useQueryClient();

  const { onSuccess, ..._options } = options || {};
  return useMutation(
    ({
      conversationId,
      targetMessageId,
      snapshotFiles,
    }: {
      conversationId: string;
      targetMessageId?: string;
      snapshotFiles?: boolean;
    }) => {
      if (!conversationId) {
        throw new Error('Conversation ID is required');
      }

      return dataService.createSharedLink(conversationId, targetMessageId, snapshotFiles);
    },
    {
      onSuccess: (_data: t.TSharedLinkResponse, vars, context) => {
        syncSharedLinkQueries(queryClient, _data, vars.snapshotFiles);

        onSuccess?.(_data, vars, context);
      },
      ..._options,
    },
  );
};

export const useUpdateSharedLinkMutation = (
  options?: t.MutationOptions<
    t.TUpdateShareLinkRequest,
    t.TUpdateShareLinkRequest & { snapshotFiles?: boolean }
  >,
): UseMutationResult<
  t.TSharedLinkResponse,
  unknown,
  t.TUpdateShareLinkRequest & { snapshotFiles?: boolean },
  unknown
> => {
  const queryClient = useQueryClient();

  const { onSuccess, ..._options } = options || {};
  return useMutation(
    ({ shareId, targetMessageId, snapshotFiles }) => {
      if (!shareId) {
        throw new Error('Share ID is required');
      }
      return dataService.updateSharedLink(shareId, targetMessageId, snapshotFiles);
    },
    {
      onSuccess: (_data: t.TSharedLinkResponse, vars, context) => {
        syncSharedLinkQueries(queryClient, _data, vars.snapshotFiles);

        onSuccess?.(_data, vars, context);
      },
      ..._options,
    },
  );
};

export const useDeleteSharedLinkMutation = (
  options?: t.DeleteSharedLinkOptions,
): UseMutationResult<
  t.TDeleteSharedLinkResponse,
  unknown,
  { shareId: string },
  t.DeleteSharedLinkContext
> => {
  const queryClient = useQueryClient();
  const { onSuccess } = options || {};

  return useMutation((vars) => dataService.deleteSharedLink(vars.shareId), {
    onMutate: async (vars) => {
      await queryClient.cancelQueries({
        queryKey: [QueryKeys.sharedLinks],
        exact: false,
      });

      const previousQueries = new Map();
      const unsharedConversationIds = new Set<string | null>();
      const queryKeys = queryClient.getQueryCache().findAll([QueryKeys.sharedLinks]);

      queryKeys.forEach((query) => {
        const previousData = queryClient.getQueryData(query.queryKey);
        previousQueries.set(query.queryKey, previousData);

        const sharedLink = previousData as t.TSharedLinkGetResponse | undefined;
        if (sharedLink?.shareId === vars.shareId) {
          unsharedConversationIds.add(sharedLink.conversationId);
          queryClient.setQueryData<t.TSharedLinkGetResponse>(query.queryKey, {
            ...sharedLink,
            success: false,
            shareId: null,
          });
          return;
        }

        queryClient.setQueryData<t.SharedLinkQueryData>(query.queryKey, (old) => {
          if (!old?.pages) {
            return old;
          }

          const updatedPages = old.pages.map((page) => ({
            ...page,
            links: page.links.filter((link) => {
              if (link.shareId !== vars.shareId) {
                return true;
              }
              unsharedConversationIds.add(link.conversationId);
              return false;
            }),
          }));

          const nonEmptyPages = updatedPages.filter((page) => page.links.length > 0);

          return {
            ...old,
            pages: nonEmptyPages,
          };
        });
      });

      for (const conversationId of unsharedConversationIds) {
        setConversationSharedFlag(queryClient, conversationId, false);
      }

      return { previousQueries, unsharedConversationIds };
    },

    onError: (_err, _vars, context) => {
      if (context?.previousQueries) {
        context.previousQueries.forEach((prevData: unknown, prevQueryKey: unknown) => {
          queryClient.setQueryData(prevQueryKey as string[], prevData);
        });
      }
      // The badge lives on the conversation caches, which the snapshot above does not
      // cover, so a failed delete would leave the conversation looking unshared.
      context?.unsharedConversationIds?.forEach((conversationId) => {
        setConversationSharedFlag(queryClient, conversationId, true);
      });
    },

    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.sharedLinks],
        exact: false,
      });
      /* Shared state is derived on every list response; an archived row needs the
       * same refresh as the active and pinned sections. */
      queryClient.invalidateQueries({ queryKey: [QueryKeys.allConversations] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.archivedConversations] });
      /** The pinned section renders the same badge from its own cache. */
      queryClient.invalidateQueries({ queryKey: [QueryKeys.pinnedConversations] });
    },

    onSuccess: (data, variables) => {
      if (onSuccess) {
        onSuccess(data, variables);
      }

      queryClient.refetchQueries({
        queryKey: [QueryKeys.sharedLinks],
        exact: true,
      });
    },
  });
};

// Add a tag or update tag information (tag, description, position, etc.)
export const useConversationTagMutation = ({
  context,
  tag,
  options,
}: {
  context: string;
  tag?: string;
  options?: t.UpdateConversationTagOptions;
}): UseMutationResult<t.TConversationTagResponse, unknown, t.TConversationTagRequest, unknown> => {
  const queryClient = useQueryClient();
  const { onSuccess, ..._options } = options || {};
  const setChatFilterTags = useSetAtom(chatFilterTagsAtom);
  const onMutationSuccess: typeof onSuccess = (_data, vars) => {
    queryClient.setQueryData<t.TConversationTag[]>([QueryKeys.conversationTags], (queryData) => {
      if (!queryData) {
        return [
          {
            count: 1,
            position: 0,
            tag: Constants.SAVED_TAG,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ] as t.TConversationTag[];
      }
      if (tag === undefined || !tag.length) {
        // Check if the tag already exists
        const existingTagIndex = queryData.findIndex((item) => item.tag === _data.tag);
        if (existingTagIndex !== -1) {
          logger.log(
            'tag_mutation',
            `"Created" tag exists, updating from ${context}`,
            queryData,
            _data,
          );
          // If the tag exists, update it
          const updatedData = [...queryData];
          updatedData[existingTagIndex] = { ...updatedData[existingTagIndex], ..._data };
          return updatedData.sort((a, b) => a.position - b.position);
        } else {
          // If the tag doesn't exist, add it
          logger.log(
            'tag_mutation',
            `"Created" tag is new, adding from ${context}`,
            queryData,
            _data,
          );
          return [...queryData, _data].sort((a, b) => a.position - b.position);
        }
      }
      logger.log('tag_mutation', `Updating tag from ${context}`, queryData, _data);
      return updateConversationTag(queryData, vars, _data, tag);
    });
    if (tag != null && _data.tag) {
      setChatFilterTags((selectedTags) =>
        selectedTags.map((selectedTag) => (selectedTag === tag ? _data.tag : selectedTag)),
      );
    }
    if (vars.addToConversation === true && vars.conversationId != null && _data.tag) {
      const currentConvo = queryClient.getQueryData<t.TConversation>([
        QueryKeys.conversation,
        vars.conversationId,
      ]);
      if (!currentConvo) {
        return;
      }
      logger.log(
        'tag_mutation',
        `\`updateTagsInConversation\` Update from ${context}`,
        currentConvo,
      );
      updateTagsInConversation(vars.conversationId, [...(currentConvo.tags || []), _data.tag]);
    }
    // Change the tag title to the new title
    if (tag != null) {
      replaceTagsInAllConversations(tag, _data.tag);
    }
  };
  const { updateTagsInConversation, replaceTagsInAllConversations } = useUpdateTagsInConvo();
  return useMutation(
    (payload: t.TConversationTagRequest) =>
      tag != null
        ? dataService.updateConversationTag(tag, payload)
        : dataService.createConversationTag(payload),
    {
      onSuccess: (...args) => {
        /** Renaming a selected bookmark rewrites that tag on every matching
         * conversation. The pinned query is keyed by the old filter until it
         * is invalidated. */
        queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
        onMutationSuccess(...args);
        onSuccess?.(...args);
      },
      ..._options,
    },
  );
};

// When a bookmark is deleted, remove that bookmark(tag) from all conversations associated with it
export const useDeleteTagInConversations = () => {
  const queryClient = useQueryClient();
  const deleteTagInAllConversation = (deletedTag: string) => {
    const conversationIdsWithTag = new Set<string>();

    for (const listKey of [QueryKeys.allConversations, QueryKeys.archivedConversations]) {
      const queries = queryClient.getQueryCache().findAll([listKey], { exact: false });
      for (const query of queries) {
        queryClient.setQueryData<InfiniteData<ConversationListResponse>>(query.queryKey, (data) => {
          if (!data) {
            return data;
          }

          return {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              conversations: page.conversations.map((conversation) => {
                const conversationTags = (conversation as t.TConversation).tags;
                if (
                  conversation.conversationId &&
                  Array.isArray(conversationTags) &&
                  conversationTags.includes(deletedTag)
                ) {
                  conversationIdsWithTag.add(conversation.conversationId);
                  return {
                    ...conversation,
                    tags: conversationTags.filter((tag) => tag !== deletedTag),
                  };
                }
                return conversation;
              }),
            })),
          };
        });
      }
      queryClient.invalidateQueries({ queryKey: [listKey] });
    }

    for (const conversationId of conversationIdsWithTag) {
      const conversationData = queryClient.getQueryData<t.TConversation>([
        QueryKeys.conversation,
        conversationId,
      ]);
      if (conversationData?.tags) {
        queryClient.setQueryData<t.TConversation>([QueryKeys.conversation, conversationId], {
          ...conversationData,
          tags: conversationData.tags.filter((tag) => tag !== deletedTag),
        });
      }
    }
  };
  return deleteTagInAllConversation;
};

export const useDeleteConversationTagMutation = (
  options?: t.DeleteConversationTagOptions,
): UseMutationResult<t.TConversationTagResponse, unknown, string, void> => {
  const queryClient = useQueryClient();
  const deleteTagInAllConversations = useDeleteTagInConversations();

  const { onSuccess, ..._options } = options || {};
  const setChatFilterTags = useSetAtom(chatFilterTagsAtom);

  return useMutation((tag: string) => dataService.deleteConversationTag(tag), {
    onSuccess: (_data, tagToDelete, context) => {
      queryClient.setQueryData<t.TConversationTag[]>([QueryKeys.conversationTags], (data) => {
        if (!data) {
          return data;
        }
        return data.filter((t) => t.tag !== tagToDelete);
      });

      deleteTagInAllConversations(tagToDelete);
      setChatFilterTags((selectedTags) =>
        selectedTags.filter((selectedTag) => selectedTag !== tagToDelete),
      );
      /** Deleting a selected bookmark empties that tag-keyed pinned set. */
      queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
      onSuccess?.(_data, tagToDelete, context);
    },
    ..._options,
  });
};

export const useDeleteConversationMutation = (
  options?: t.DeleteConversationOptions,
): UseMutationResult<
  t.TDeleteConversationResponse,
  unknown,
  t.TDeleteConversationRequest,
  unknown
> => {
  const queryClient = useQueryClient();

  return useMutation(
    (payload: t.TDeleteConversationRequest) =>
      dataService.deleteConversation(payload) as Promise<t.TDeleteConversationResponse>,
    {
      onMutate: async () => {
        await queryClient.cancelQueries([QueryKeys.allConversations]);
        await queryClient.cancelQueries([QueryKeys.archivedConversations]);
        /** A pinned GET already in flight would otherwise resolve after the row is
         * stripped below and write the deleted conversation back into that cache. */
        await queryClient.cancelQueries([QueryKeys.pinnedConversations]);
        // could store old state if needed for rollback
      },
      onError: options?.onError,
      onSuccess: (data, vars, context) => {
        const deletedConversation = vars.conversationId
          ? queryClient.getQueryData<t.TConversation>([QueryKeys.conversation, vars.conversationId])
          : undefined;
        let deletedProjectId = deletedConversation?.chatProjectId;
        if (!deletedProjectId && vars.conversationId) {
          /* An archived row can be the only cached copy carrying `chatProjectId`. */
          const cacheKeys = [
            QueryKeys.allConversations,
            QueryKeys.archivedConversations,
            QueryKeys.projectConversations,
          ];
          for (const cacheKey of cacheKeys) {
            const queries = queryClient.getQueryCache().findAll([cacheKey], { exact: false });
            for (const query of queries) {
              const found = findConversationInInfinite(
                queryClient.getQueryData<InfiniteData<ConversationListResponse>>(query.queryKey),
                vars.conversationId,
              );
              if (found?.chatProjectId) {
                deletedProjectId = found.chatProjectId;
                break;
              }
            }
            if (deletedProjectId) {
              break;
            }
          }
        }

        /** A project-backed pin can be absent from the loaded chats and
         * project pages. The pinned cache is the remaining source for
         * `chatProjectId` so the project workspace can drop its stale count. */
        if (!deletedProjectId && vars.conversationId) {
          const pinnedQueries = queryClient
            .getQueryCache()
            .findAll([QueryKeys.pinnedConversations], { exact: false });
          for (const query of pinnedQueries) {
            const data = queryClient.getQueryData<{ conversations?: t.TConversation[] }>(
              query.queryKey,
            );
            const found = data?.conversations?.find(
              (conversation) => conversation.conversationId === vars.conversationId,
            );
            if (found?.chatProjectId) {
              deletedProjectId = found.chatProjectId;
              break;
            }
          }
        }

        if (vars.conversationId) {
          removeConvoFromAllQueries(queryClient, vars.conversationId);
          clearDeletedConversationMessagesCache(queryClient, vars.conversationId);
        }

        // Also remove from all archivedConversations caches
        const archivedQueries = queryClient
          .getQueryCache()
          .findAll([QueryKeys.archivedConversations], { exact: false });

        for (const query of archivedQueries) {
          queryClient.setQueryData<InfiniteData<ConversationListResponse>>(
            query.queryKey,
            (oldData) => {
              if (!oldData) {
                return oldData;
              }
              return {
                ...oldData,
                pages: oldData.pages
                  .map((page) => ({
                    ...page,
                    conversations: page.conversations.filter(
                      (conv) => conv.conversationId !== vars.conversationId,
                    ),
                  }))
                  .filter((page) => page.conversations.length > 0),
              };
            },
          );
        }

        queryClient.removeQueries({
          queryKey: [QueryKeys.conversation, vars.conversationId],
          exact: true,
        });

        /* The row is gone from both lists, and cancelled races mean neither cache can be
           trusted to have settled. */
        queryClient.invalidateQueries({
          queryKey: [QueryKeys.allConversations],
          refetchPage: () => true,
          refetchType: 'active',
        });
        queryClient.invalidateQueries({
          queryKey: [QueryKeys.archivedConversations],
          refetchPage: () => true,
          refetchType: 'active',
        });
        /** Cancelling races is best effort, so reconcile the pinned list afterwards too. */
        queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
        queryClient.invalidateQueries([QueryKeys.projectConversations]);
        queryClient.invalidateQueries([QueryKeys.projects]);
        queryClient.invalidateQueries([QueryKeys.conversationTags]);
        if (deletedProjectId) {
          queryClient.invalidateQueries([QueryKeys.project, deletedProjectId]);
        }

        options?.onSuccess?.(data, vars, context);
      },
    },
  );
};

export const useDuplicateConversationMutation = (
  options?: t.DuplicateConvoOptions,
): UseMutationResult<t.TDuplicateConvoResponse, unknown, t.TDuplicateConvoRequest, unknown> => {
  const queryClient = useQueryClient();
  const { onSuccess, ..._options } = options ?? {};
  return useMutation((payload) => dataService.duplicateConversation(payload), {
    onSuccess: (data, vars, context) => {
      const duplicatedConversation = data.conversation;
      if (!duplicatedConversation?.conversationId) {
        return;
      }
      queryClient.setQueryData(
        [QueryKeys.conversation, duplicatedConversation.conversationId],
        duplicatedConversation,
      );
      addConvoToAllQueries(queryClient, duplicatedConversation);
      queryClient.setQueryData(
        [QueryKeys.messages, duplicatedConversation.conversationId],
        data.messages,
      );
      /* The copy inherits the source's archive state, so a duplicate made from an archived
         row belongs to the archived list, not the active one. */
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.allConversations],
        refetchPage: () => true,
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.archivedConversations],
        refetchPage: () => true,
        refetchType: 'active',
      });
      /** A duplicated, forked or imported chat can arrive already pinned. */
      queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
      queryClient.invalidateQueries([QueryKeys.projectConversations]);
      queryClient.invalidateQueries([QueryKeys.projects]);
      if (duplicatedConversation.chatProjectId) {
        queryClient.invalidateQueries([QueryKeys.project, duplicatedConversation.chatProjectId]);
      }

      if (duplicatedConversation.tags && duplicatedConversation.tags.length > 0) {
        queryClient.setQueryData<t.TConversationTag[]>([QueryKeys.conversationTags], (oldTags) => {
          if (!oldTags) return oldTags;
          return oldTags.map((tag) => {
            if (duplicatedConversation.tags?.includes(tag.tag)) {
              return { ...tag, count: tag.count + 1 };
            }
            return tag;
          });
        });
      }

      onSuccess?.(data, vars, context);
    },
    ..._options,
  });
};

export const useForkConvoMutation = (
  options?: t.ForkConvoOptions,
): UseMutationResult<t.TForkConvoResponse, unknown, t.TForkConvoRequest, unknown> => {
  const queryClient = useQueryClient();
  const { onSuccess, ..._options } = options || {};

  return useMutation((payload: t.TForkConvoRequest) => dataService.forkConversation(payload), {
    onSuccess: (data, vars, context) => {
      if (!vars.conversationId) {
        return;
      }
      const forkedConversation = data.conversation;
      const forkedConversationId = forkedConversation.conversationId;
      if (!forkedConversationId) {
        return;
      }

      queryClient.setQueryData([QueryKeys.conversation, forkedConversationId], forkedConversation);
      addConvoToAllQueries(queryClient, forkedConversation);
      queryClient.setQueryData([QueryKeys.messages, forkedConversationId], data.messages);
      /* A fork inherits the source's archive state, so it can belong to either list. */
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.allConversations],
        refetchPage: () => true,
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.archivedConversations],
        refetchPage: () => true,
        refetchType: 'active',
      });
      /** A duplicated, forked or imported chat can arrive already pinned. */
      queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
      queryClient.invalidateQueries([QueryKeys.projectConversations]);
      queryClient.invalidateQueries([QueryKeys.projects]);
      if (forkedConversation.chatProjectId) {
        queryClient.invalidateQueries([QueryKeys.project, forkedConversation.chatProjectId]);
      }

      if (forkedConversation.tags && forkedConversation.tags.length > 0) {
        queryClient.setQueryData<t.TConversationTag[]>([QueryKeys.conversationTags], (oldTags) => {
          if (!oldTags) return oldTags;
          return oldTags.map((tag) => {
            if (forkedConversation.tags?.includes(tag.tag)) {
              return { ...tag, count: tag.count + 1 };
            }
            return tag;
          });
        });
      }

      onSuccess?.(data, vars, context);
    },
    ..._options,
  });
};

export const useForkSharedConvoMutation = (
  options?: t.ForkSharedConvoOptions,
): UseMutationResult<t.TForkConvoResponse, unknown, t.TForkSharedConvoRequest, unknown> => {
  const queryClient = useQueryClient();
  const { onSuccess, ..._options } = options ?? {};

  return useMutation(
    (payload: t.TForkSharedConvoRequest) =>
      dataService.forkSharedConversation(
        payload.shareId,
        payload.targetMessageIndex,
        payload.shareRevision,
      ),
    {
      onSuccess: (data, vars, context) => {
        const forkedConversation = data.conversation;
        const forkedConversationId = forkedConversation?.conversationId;
        if (!forkedConversationId) {
          return;
        }

        queryClient.setQueryData(
          [QueryKeys.conversation, forkedConversationId],
          forkedConversation,
        );
        addConvoToAllQueries(queryClient, forkedConversation);
        queryClient.setQueryData([QueryKeys.messages, forkedConversationId], data.messages);
        /* A fork inherits the source's archive state, so it can belong to either list. */
        queryClient.invalidateQueries({
          queryKey: [QueryKeys.allConversations],
          refetchPage: () => true,
          refetchType: 'active',
        });
        queryClient.invalidateQueries({
          queryKey: [QueryKeys.archivedConversations],
          refetchPage: () => true,
          refetchType: 'active',
        });

        onSuccess?.(data, vars, context);
      },
      ..._options,
    },
  );
};

export const useUploadConversationsMutation = (
  _options?: t.MutationOptions<t.TImportResponse, FormData>,
) => {
  const queryClient = useQueryClient();
  const { onSuccess, onError, onMutate } = _options || {};

  return useMutation<t.TImportResponse, unknown, FormData>({
    mutationFn: (formData: FormData) => dataService.importConversationsFile(formData),
    onSuccess: (data, variables, context) => {
      /* TODO: optimize to return imported conversations and add manually */
      queryClient.invalidateQueries([QueryKeys.allConversations]);
      /** An import can carry already-archived chats. */
      queryClient.invalidateQueries([QueryKeys.archivedConversations]);
      /** An imported chat can carry `pinned: true`. */
      queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
      if (onSuccess) {
        onSuccess(data, variables, context);
      }
    },
    onError: (err, variables, context) => {
      if (onError) {
        onError(err, variables, context);
      }
    },
    onMutate,
  });
};

export const useUpdatePresetMutation = (
  options?: t.UpdatePresetOptions,
): UseMutationResult<
  t.TPreset, // response data
  unknown,
  t.TPreset,
  unknown
> => {
  return useMutation([MutationKeys.updatePreset], {
    mutationFn: (preset: t.TPreset) => dataService.updatePreset(preset),
    ...(options || {}),
  });
};

export const useDeletePresetMutation = (
  options?: t.DeletePresetOptions,
): UseMutationResult<
  t.PresetDeleteResponse, // response data
  unknown,
  t.TPreset | undefined,
  unknown
> => {
  return useMutation([MutationKeys.deletePreset], {
    mutationFn: (preset: t.TPreset | undefined) => dataService.deletePreset(preset),
    ...(options || {}),
  });
};

/* Avatar upload */
export const useUploadAvatarMutation = (
  options?: t.UploadAvatarOptions,
): UseMutationResult<
  t.AvatarUploadResponse, // response data
  unknown, // error
  FormData, // request
  unknown // context
> => {
  return useMutation([MutationKeys.avatarUpload], {
    mutationFn: (variables: FormData) => dataService.uploadAvatar(variables),
    ...(options || {}),
  });
};

/* Speech to text */
export const useSpeechToTextMutation = (
  options?: t.SpeechToTextOptions,
): UseMutationResult<
  t.SpeechToTextResponse, // response data
  unknown, // error
  FormData, // request
  unknown // context
> => {
  return useMutation([MutationKeys.speechToText], {
    mutationFn: (variables: FormData) => dataService.speechToText(variables),
    ...(options || {}),
  });
};

/* Text to speech */
export const useTextToSpeechMutation = (
  options?: t.TextToSpeechOptions,
): UseMutationResult<
  ArrayBuffer, // response data
  unknown, // error
  FormData, // request
  unknown // context
> => {
  return useMutation([MutationKeys.textToSpeech], {
    mutationFn: (variables: FormData) => dataService.textToSpeech(variables),
    ...(options || {}),
  });
};

/**
 * ASSISTANTS
 */

/**
 * Create a new assistant
 */
export const useCreateAssistantMutation = (
  options?: t.CreateAssistantMutationOptions,
): UseMutationResult<t.Assistant, Error, t.AssistantCreateParams> => {
  const queryClient = useQueryClient();
  return useMutation(
    (newAssistantData: t.AssistantCreateParams) => dataService.createAssistant(newAssistantData),
    {
      onMutate: (variables) => options?.onMutate?.(variables),
      onError: (error, variables, context) => options?.onError?.(error, variables, context),
      onSuccess: (newAssistant, variables, context) => {
        const listRes = queryClient.getQueryData<t.AssistantListResponse>([
          QueryKeys.assistants,
          variables.endpoint,
          defaultOrderQuery,
        ]);

        if (!listRes) {
          return options?.onSuccess?.(newAssistant, variables, context);
        }

        const currentAssistants = [newAssistant, ...JSON.parse(JSON.stringify(listRes.data))];

        queryClient.setQueryData<t.AssistantListResponse>(
          [QueryKeys.assistants, variables.endpoint, defaultOrderQuery],
          {
            ...listRes,
            data: currentAssistants,
          },
        );
        return options?.onSuccess?.(newAssistant, variables, context);
      },
    },
  );
};

/**
 * Hook for updating an assistant
 */
export const useUpdateAssistantMutation = (
  options?: t.UpdateAssistantMutationOptions,
): UseMutationResult<
  t.Assistant,
  Error,
  { assistant_id: string; data: t.AssistantUpdateParams }
> => {
  const queryClient = useQueryClient();
  return useMutation(
    ({ assistant_id, data }: { assistant_id: string; data: t.AssistantUpdateParams }) => {
      const { endpoint } = data;
      const endpointsConfig = queryClient.getQueryData<t.TEndpointsConfig>([QueryKeys.endpoints]);
      const endpointConfig = endpointsConfig?.[endpoint];
      const version = endpointConfig?.version ?? defaultAssistantsVersion[endpoint];
      return dataService.updateAssistant({
        data,
        version,
        assistant_id,
      });
    },
    {
      onMutate: (variables) => options?.onMutate?.(variables),
      onError: (error, variables, context) => options?.onError?.(error, variables, context),
      onSuccess: (updatedAssistant, variables, context) => {
        const listRes = queryClient.getQueryData<t.AssistantListResponse>([
          QueryKeys.assistants,
          variables.data.endpoint,
          defaultOrderQuery,
        ]);

        if (!listRes) {
          return options?.onSuccess?.(updatedAssistant, variables, context);
        }

        queryClient.setQueryData<t.AssistantDocument[]>(
          [QueryKeys.assistantDocs, variables.data.endpoint],
          (prev) => {
            if (!prev) {
              return prev;
            }
            return prev.map((doc) => {
              if (doc.assistant_id === variables.assistant_id) {
                return {
                  ...doc,
                  conversation_starters: updatedAssistant.conversation_starters,
                  append_current_datetime: variables.data.append_current_datetime,
                };
              }
              return doc;
            });
          },
        );

        queryClient.setQueryData<t.AssistantListResponse>(
          [QueryKeys.assistants, variables.data.endpoint, defaultOrderQuery],
          {
            ...listRes,
            data: listRes.data.map((assistant) => {
              if (assistant.id === variables.assistant_id) {
                return updatedAssistant;
              }
              return assistant;
            }),
          },
        );
        return options?.onSuccess?.(updatedAssistant, variables, context);
      },
    },
  );
};

/**
 * Hook for deleting an assistant
 */
export const useDeleteAssistantMutation = (
  options?: t.DeleteAssistantMutationOptions,
): UseMutationResult<void, Error, t.DeleteAssistantBody> => {
  const queryClient = useQueryClient();
  return useMutation(
    ({ assistant_id, model, endpoint }: t.DeleteAssistantBody) => {
      const endpointsConfig = queryClient.getQueryData<t.TEndpointsConfig>([QueryKeys.endpoints]);
      const version = endpointsConfig?.[endpoint]?.version ?? defaultAssistantsVersion[endpoint];
      return dataService.deleteAssistant({ assistant_id, model, version, endpoint });
    },
    {
      onMutate: (variables) => options?.onMutate?.(variables),
      onError: (error, variables, context) => options?.onError?.(error, variables, context),
      onSuccess: (_data, variables, context) => {
        const listRes = queryClient.getQueryData<t.AssistantListResponse>([
          QueryKeys.assistants,
          variables.endpoint,
          defaultOrderQuery,
        ]);

        if (!listRes) {
          return options?.onSuccess?.(_data, variables, context);
        }

        const data = listRes.data.filter((assistant) => assistant.id !== variables.assistant_id);

        queryClient.setQueryData<t.AssistantListResponse>(
          [QueryKeys.assistants, variables.endpoint, defaultOrderQuery],
          {
            ...listRes,
            data,
          },
        );

        return options?.onSuccess?.(_data, variables, data);
      },
    },
  );
};

/**
 * Hook for uploading an assistant avatar
 */
export const useUploadAssistantAvatarMutation = (
  options?: t.UploadAssistantAvatarOptions,
): UseMutationResult<
  t.Assistant, // response data
  unknown, // error
  t.AssistantAvatarVariables, // request
  unknown // context
> => {
  return useMutation([MutationKeys.assistantAvatarUpload], {
    mutationFn: ({ postCreation: _postCreation, ...variables }: t.AssistantAvatarVariables) =>
      dataService.uploadAssistantAvatar(variables),
    ...(options || {}),
  });
};

/**
 * Hook for updating Assistant Actions
 */
export const useUpdateAction = (
  options?: t.UpdateActionOptions,
): UseMutationResult<
  t.UpdateActionResponse, // response data
  unknown, // error
  t.UpdateActionVariables, // request
  unknown // context
> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.updateAction], {
    mutationFn: (variables: t.UpdateActionVariables) => dataService.updateAction(variables),

    onMutate: (variables) => options?.onMutate?.(variables),
    onError: (error, variables, context) => options?.onError?.(error, variables, context),
    onSuccess: (updateActionResponse, variables, context) => {
      const listRes = queryClient.getQueryData<t.AssistantListResponse>([
        QueryKeys.assistants,
        variables.endpoint,
        defaultOrderQuery,
      ]);

      if (!listRes) {
        return options?.onSuccess?.(updateActionResponse, variables, context);
      }

      const updatedAssistant = updateActionResponse[1];

      queryClient.setQueryData<t.AssistantListResponse>(
        [QueryKeys.assistants, variables.endpoint, defaultOrderQuery],
        {
          ...listRes,
          data: listRes.data.map((assistant) => {
            if (assistant.id === variables.assistant_id) {
              return updatedAssistant;
            }
            return assistant;
          }),
        },
      );

      queryClient.setQueryData<t.Action[]>([QueryKeys.actions], (prev) => {
        return prev
          ?.map((action) => {
            if (action.action_id === variables.action_id) {
              return updateActionResponse[2];
            }
            return action;
          })
          .concat(
            variables.action_id != null && variables.action_id ? [] : [updateActionResponse[2]],
          );
      });

      return options?.onSuccess?.(updateActionResponse, variables, context);
    },
  });
};

/**
 * Hook for deleting an Assistant Action
 */
export const useDeleteAction = (
  options?: t.DeleteActionOptions,
): UseMutationResult<
  void, // response data for a delete operation is typically void
  Error, // error type
  t.DeleteActionVariables, // request variables
  unknown // context
> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.deleteAction], {
    mutationFn: (variables: t.DeleteActionVariables) => {
      const { endpoint } = variables;
      const endpointsConfig = queryClient.getQueryData<t.TEndpointsConfig>([QueryKeys.endpoints]);
      const version = endpointsConfig?.[endpoint]?.version ?? defaultAssistantsVersion[endpoint];
      return dataService.deleteAction({
        ...variables,
        version,
      });
    },

    onMutate: (variables) => options?.onMutate?.(variables),
    onError: (error, variables, context) => options?.onError?.(error, variables, context),
    onSuccess: (_data, variables, context) => {
      let domain: string | undefined = '';
      queryClient.setQueryData<t.Action[]>([QueryKeys.actions], (prev) => {
        return prev?.filter((action) => {
          domain = action.metadata.domain;
          return action.action_id !== variables.action_id;
        });
      });

      queryClient.setQueryData<t.AssistantListResponse>(
        [QueryKeys.assistants, variables.endpoint, defaultOrderQuery],
        (prev) => {
          if (!prev) {
            return prev;
          }

          return {
            ...prev,
            data: prev.data.map((assistant) => {
              if (assistant.id === variables.assistant_id) {
                return {
                  ...assistant,
                  tools: (assistant.tools ?? []).filter(
                    (tool) => !(tool.function?.name.includes(domain ?? '') ?? false),
                  ),
                };
              }
              return assistant;
            }),
          };
        },
      );

      return options?.onSuccess?.(_data, variables, context);
    },
  });
};

/**
 * Hook for verifying email address
 */
export const useVerifyEmailMutation = (
  options?: t.VerifyEmailOptions,
): UseMutationResult<t.VerifyEmailResponse, unknown, t.TVerifyEmail, unknown> => {
  return useMutation({
    mutationFn: (variables: t.TVerifyEmail) => dataService.verifyEmail(variables),
    ...(options || {}),
  });
};

/**
 * Hook for resending verficiation email
 */
export const useResendVerificationEmail = (
  options?: t.ResendVerifcationOptions,
): UseMutationResult<t.VerifyEmailResponse, unknown, t.TResendVerificationEmail, unknown> => {
  return useMutation({
    mutationFn: (variables: t.TResendVerificationEmail) =>
      dataService.resendVerificationEmail(variables),
    ...(options || {}),
  });
};

export const useAcceptTermsMutation = (
  options?: t.AcceptTermsMutationOptions,
): UseMutationResult<t.TAcceptTermsResponse, unknown, void, unknown> => {
  const queryClient = useQueryClient();
  return useMutation(() => dataService.acceptTerms(), {
    onSuccess: (data, variables, context) => {
      queryClient.setQueryData<t.TUserTermsResponse>([QueryKeys.userTerms], {
        termsAccepted: true,
        termsAcceptedAt: data.termsAcceptedAt,
      });
      options?.onSuccess?.(data, variables, context);
    },
    onError: options?.onError,
    onMutate: options?.onMutate,
  });
};
