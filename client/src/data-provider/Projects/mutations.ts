import { useRecoilCallback } from 'recoil';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  TChatProject,
  TConversation,
  TCreateChatProjectRequest,
  TDeleteChatProjectResponse,
  TUpdateChatProjectRequest,
  TAssignConversationToProjectRequest,
  TAssignConversationToProjectResponse,
} from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import { enqueue, invalidateConversationLists } from '~/utils';
import { getSessionPrincipal } from '~/utils/session';
import store from '~/store';

export const useCreateProjectMutation = (): UseMutationResult<
  TChatProject,
  unknown,
  TCreateChatProjectRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation((payload: TCreateChatProjectRequest) => dataService.createProject(payload), {
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.projects]);
    },
  });
};

export const useUpdateProjectMutation = (): UseMutationResult<
  TChatProject,
  unknown,
  TUpdateChatProjectRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation((payload: TUpdateChatProjectRequest) => dataService.updateProject(payload), {
    onSuccess: (project) => {
      queryClient.setQueryData([QueryKeys.project, project._id], project);
      queryClient.invalidateQueries([QueryKeys.projects]);
    },
  });
};

export const useDeleteProjectMutation = (): UseMutationResult<
  TDeleteChatProjectResponse,
  unknown,
  string,
  unknown
> => {
  const queryClient = useQueryClient();
  const clearActiveConversationProject = useRecoilCallback(
    ({ snapshot, set }) =>
      async (projectId: string) => {
        const conversation = await snapshot.getPromise(store.conversationByIndex(0));
        if (conversation?.conversationId && conversation.chatProjectId === projectId) {
          set(store.updateConversationSelector(conversation.conversationId), {
            ...conversation,
            chatProjectId: null,
          });
        }
      },
    [],
  );
  return useMutation((projectId: string) => dataService.deleteProject(projectId), {
    onSuccess: (_result, projectId) => {
      clearActiveConversationProject(projectId);
      // Invalidate so an *active* project-detail observer refetches and settles into a
      // not-found state — consumers (e.g. ChatRoute) can then react to the deletion.
      // (Removing it instead leaves observers stuck loading under `refetchOnMount: false`.)
      queryClient.invalidateQueries([QueryKeys.project, projectId]);
      // Drop any *inactive* cached detail so a later visit to the deleted project
      // refetches (→ not-found) rather than rendering stale cache within `cacheTime`.
      queryClient.removeQueries([QueryKeys.project, projectId], { type: 'inactive' });
      queryClient.invalidateQueries([QueryKeys.projects]);
      /** Archived rows carry the same project field and menu state. */
      invalidateConversationLists(queryClient);
      /** Deleting a project unsets chatProjectId on its chats, pinned ones included. */
      queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
    },
  });
};

/** One queue per conversation: assignments to different chats stay independent. */
const ASSIGN_CONVERSATION_QUEUE = 'assign-conversation:';

/** Where each conversation is headed while a write for it is still queued or in
 *  flight, recorded here so every assignment path shares one answer: a drag
 *  helper that tracked only its own writes would keep reporting its
 *  destination after a menu action had moved the chat somewhere else. Each
 *  entry is identified by the write that made it, since comparing destinations
 *  alone cannot tell two moves to the same project apart. */
type PendingAssignment = { token: number; projectId: string | null; owner?: string };

const pendingAssignments = new Map<string, PendingAssignment>();
let assignmentToken = 0;

/** The destination of the newest write still outstanding, if there is one. */
export const getPendingAssignment = (conversationId: string): PendingAssignment | undefined => {
  const pending = pendingAssignments.get(conversationId);
  /* An entry left by another account describes a conversation this session
   * cannot see, so it must not answer for one of its own. */
  return pending && !isForeignSession(pending.owner) ? pending : undefined;
};

const isForeignSession = (owner?: string): boolean =>
  owner == null || getSessionPrincipal() !== owner;

export const useAssignConversationToProjectMutation = (): UseMutationResult<
  TAssignConversationToProjectResponse,
  unknown,
  TAssignConversationToProjectRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  /* Only the project field is published. `updateConversationSelector` spreads
   * whatever it is given over the active conversation, so passing the whole
   * response would also reinstate every other field as the server held it when
   * the assignment ran, undoing a rename that landed in between. */
  const updateActiveConversation = useRecoilCallback(
    ({ set }) =>
      (conversationId: string, chatProjectId: string | null) => {
        set(store.updateConversationSelector(conversationId), { chatProjectId });
      },
    [],
  );

  return useMutation(
    /* Serialized per conversation, and here rather than at any one caller: the
     * drag targets, the row menu and the project dialog each hold their own
     * mutation instance, and the write is an unconditional update, so two of
     * them racing let whichever request reached the database last decide the
     * project regardless of which the user asked for first. */
    (payload: TAssignConversationToProjectRequest) => {
      const { conversationId, projectId } = payload;
      const owner = getSessionPrincipal();
      const token = ++assignmentToken;
      pendingAssignments.set(conversationId, { token, projectId: projectId ?? null, owner });
      return enqueue(`${ASSIGN_CONVERSATION_QUEUE}${owner ?? ''}:${conversationId}`, async () => {
        /* Inside the `try`, so that abandoning the write still releases its
         * pending entry: left behind, it would answer for this conversation
         * again the next time the account signed in, and report a destination
         * that was never sent. */
        try {
          /* A queued write travels with whatever credentials are current when it
           * finally runs. Conversation ids are per-user, so sending one account's
           * under another's would act on whatever that id names over there. */
          if (isForeignSession(owner)) {
            throw new Error('assignment abandoned: the signed-in user changed');
          }
          const result = await dataService.assignConversationToProject(payload);
          if (isForeignSession(owner)) {
            /* The session turned over while the request was out. Rejecting
             * rather than returning, so none of the success path runs: the
             * caches are not scoped by user and conversation ids repeat across
             * accounts, so this answer would otherwise describe one account's
             * conversation to the next, and report success for it. */
            throw new Error('assignment abandoned: the signed-in user changed');
          }
          /* The authoritative cache is written here, before the pending entry is
           * released, so a drag starting in between still sees the new project
           * from one of the two. Doing it in `onSuccess` left a gap while that
           * callback awaited the cancellation, and would not run at all once
           * the component that owns the mutation had unmounted. */
          await queryClient.cancelQueries([QueryKeys.conversation, conversationId]);
          /* Cancelling waits on whatever fetch was already running, so the
           * session can turn over between the check above and the write below.
           * Asked again on this side of the await, where the answer is the one
           * the write is about to act on. */
          if (isForeignSession(owner)) {
            throw new Error('assignment abandoned: the signed-in user changed');
          }
          /* Merged rather than replaced, for the same reason: an assignment that
           * reached the database before a concurrent rename can still answer
           * after it, and its copy of the conversation predates that rename. */
          queryClient.setQueryData<TConversation>(
            [QueryKeys.conversation, conversationId],
            (previous) =>
              previous
                ? { ...previous, chatProjectId: result.conversation.chatProjectId ?? null }
                : result.conversation,
          );
          return result;
        } finally {
          /* Only the newest write clears the entry; by now the conversation
           * cache carries the truth, so no list refresh has to be waited on. */
          if (pendingAssignments.get(conversationId)?.token === token) {
            pendingAssignments.delete(conversationId);
          }
        }
      });
    },
    {
      onSuccess: (result) => {
        /* The conversation cache is written in the request itself, above. */
        if (result.conversation.conversationId) {
          updateActiveConversation(
            result.conversation.conversationId,
            result.conversation.chatProjectId ?? null,
          );
        }
        [result.previousProjectId, result.projectId].forEach((projectId) => {
          if (projectId) {
            queryClient.invalidateQueries([QueryKeys.project, projectId]);
          }
        });
        queryClient.invalidateQueries([QueryKeys.projects]);
        /** Archived rows carry the same project field and menu state. */
        invalidateConversationLists(queryClient);
        /** The pinned row carries `chatProjectId` for its options menu. */
        queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
        queryClient.invalidateQueries([QueryKeys.projectConversations]);
      },
    },
  );
};
