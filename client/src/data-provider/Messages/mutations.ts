import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys, MutationKeys, Constants } from 'librechat-data-provider';
import type { UseMutationResult, UseMutationOptions } from '@tanstack/react-query';
import type * as t from 'librechat-data-provider';

type EditArtifactContext = {
  previousMessages: Record<string, t.TMessage[] | undefined>;
  updatedConversationId: string | null;
};

export const useEditArtifact = (
  _options?: t.EditArtifactOptions,
): UseMutationResult<
  t.TEditArtifactResponse,
  Error,
  t.TEditArtifactRequest,
  EditArtifactContext
> => {
  const queryClient = useQueryClient();
  const { onSuccess, onError, onMutate: userOnMutate, ...options } = _options ?? {};

  const mutationOptions: UseMutationOptions<
    t.TEditArtifactResponse,
    Error,
    t.TEditArtifactRequest,
    EditArtifactContext
  > = {
    mutationKey: [MutationKeys.editArtifact],
    mutationFn: (variables: t.TEditArtifactRequest) => dataService.editArtifact(variables),
    /**
     * onMutate: No optimistic updates for artifact editing
     * The code editor shows changes instantly via local Sandpack state
     * Optimistic updates cause "original content not found" errors because:
     * 1. First edit optimistically updates cache
     * 2. Artifact.content reflects the updated cache
     * 3. Next edit sends updated content as "original" → doesn't match DB → error
     */
    onMutate: async (vars) => {
      // Call user's onMutate if provided
      if (userOnMutate) {
        await userOnMutate(vars);
      }
      return { previousMessages: {}, updatedConversationId: null };
    },
    onError: (error, vars, context) => {
      onError?.(error, vars, context);
    },
    /**
     * On success: Update with server response to ensure consistency
     */
    onSuccess: (data, vars, context) => {
      let targetNotFound = true;
      const setMessageData = (conversationId?: string | null) => {
        if (!conversationId) {
          return;
        }
        queryClient.setQueryData<t.TMessage[]>([QueryKeys.messages, conversationId], (prev) => {
          if (!prev) {
            return prev;
          }

          const newArray = [...prev];
          let targetIndex: number | undefined;

          for (let i = newArray.length - 1; i >= 0; i--) {
            if (newArray[i].messageId === vars.messageId) {
              targetIndex = i;
              targetNotFound = false;
              break;
            }
          }

          if (targetIndex == null) {
            return prev;
          }

          newArray[targetIndex] = {
            ...newArray[targetIndex],
            content: data.content,
            text: data.text,
          };

          return newArray;
        });
      };
      setMessageData(data.conversationId);
      if (targetNotFound) {
        console.warn(
          'Edited Artifact Message not found in cache, trying `new` as `conversationId`',
        );
        setMessageData(Constants.NEW_CONVO as string);
      }

      onSuccess?.(data, vars, context);
    },
    ...options,
  };

  return useMutation(mutationOptions);
};

type BranchMessageContext = {
  previousMessages: t.TMessage[] | undefined;
  conversationId: string | null;
};

export const useBranchMessageMutation = (
  conversationId: string | null,
  _options?: t.BranchMessageOptions,
): UseMutationResult<
  t.TBranchMessageResponse,
  Error,
  t.TBranchMessageRequest,
  BranchMessageContext
> => {
  const queryClient = useQueryClient();
  const { onSuccess, onError, onMutate: userOnMutate, ...options } = _options ?? {};

  const mutationOptions: UseMutationOptions<
    t.TBranchMessageResponse,
    Error,
    t.TBranchMessageRequest,
    BranchMessageContext
  > = {
    mutationFn: (variables: t.TBranchMessageRequest) => dataService.branchMessage(variables),
    onMutate: async (vars) => {
      // Call user's onMutate if provided
      if (userOnMutate) {
        await userOnMutate(vars);
      }

      // Cancel any outgoing queries for messages
      if (conversationId) {
        await queryClient.cancelQueries([QueryKeys.messages, conversationId]);
      }

      // Get the previous messages for rollback
      const previousMessages = conversationId
        ? queryClient.getQueryData<t.TMessage[]>([QueryKeys.messages, conversationId])
        : undefined;

      return { previousMessages, conversationId };
    },
    onError: (error, vars, context) => {
      // Rollback to previous messages on error
      if (context?.conversationId && context?.previousMessages) {
        queryClient.setQueryData(
          [QueryKeys.messages, context.conversationId],
          context.previousMessages,
        );
      }
      onError?.(error, vars, context);
    },
    onSuccess: (data, vars, context) => {
      // Add the new message to the cache
      const targetConversationId = data.conversationId || context?.conversationId;
      if (targetConversationId) {
        queryClient.setQueryData<t.TMessage[]>(
          [QueryKeys.messages, targetConversationId],
          (prev) => {
            if (!prev) {
              return [data];
            }
            return [...prev, data];
          },
        );
      }

      onSuccess?.(data, vars, context);
    },
    ...options,
  };

  return useMutation(mutationOptions);
};
