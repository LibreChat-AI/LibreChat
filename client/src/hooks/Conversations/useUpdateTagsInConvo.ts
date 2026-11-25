import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import type { ConversationListResponse } from 'librechat-data-provider';
import type { InfiniteData } from '@tanstack/react-query';
import type t from 'librechat-data-provider';

const useUpdateTagsInConvo = () => {
  const queryClient = useQueryClient();

  // Update the queryClient cache with the new tag when a new tag is added/removed to a conversation
  const updateTagsInConversation = (conversationId: string, tags: string[]) => {
    // Update the tags for the current conversation
    const currentConvo = queryClient.getQueryData<t.TConversation>([
      QueryKeys.conversation,
      conversationId,
    ]);
    if (!currentConvo) {
      return;
    }

    const updatedConvo = {
      ...currentConvo,
      tags,
    } as t.TConversation;
    queryClient.setQueryData([QueryKeys.conversation, conversationId], updatedConvo);

    for (const listKey of [QueryKeys.allConversations, QueryKeys.archivedConversations]) {
      const queries = queryClient.getQueryCache().findAll([listKey], { exact: false });
      for (const query of queries) {
        queryClient.setQueryData<InfiniteData<ConversationListResponse>>(
          query.queryKey,
          (convoData) => {
            if (!convoData) {
              return convoData;
            }
            return {
              ...convoData,
              pages: convoData.pages.map((page) => ({
                ...page,
                conversations: page.conversations.map((conversation) =>
                  conversation.conversationId === conversationId
                    ? { ...conversation, tags: updatedConvo.tags }
                    : conversation,
                ),
              })),
            };
          },
        );
      }
      /* A tag filter can change membership, so a patched row is not enough to make
       * every parameterized list variant correct. */
      queryClient.invalidateQueries({ queryKey: [listKey] });
    }
  };

  // update the tag to newTag in all conversations when a tag is updated to a newTag
  // The difference with updateTagsInConversation is that it adds or removes tags for a specific conversation,
  // whereas this function is for changing the title of a specific tag.
  const replaceTagsInAllConversations = (tag: string, newTag: string) => {
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
                  conversationTags.includes(tag)
                ) {
                  conversationIdsWithTag.add(conversation.conversationId);
                  return {
                    ...conversation,
                    tags: conversationTags.map((conversationTag) =>
                      conversationTag === tag ? newTag : conversationTag,
                    ),
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
      const conversation = queryClient.getQueryData<t.TConversation>([
        QueryKeys.conversation,
        conversationId,
      ]);
      if (conversation?.tags) {
        queryClient.setQueryData<t.TConversation>([QueryKeys.conversation, conversationId], {
          ...conversation,
          tags: conversation.tags.map((conversationTag) =>
            conversationTag === tag ? newTag : conversationTag,
          ),
        });
      }
    }
  };

  return { updateTagsInConversation, replaceTagsInAllConversations };
};

export default useUpdateTagsInConvo;
