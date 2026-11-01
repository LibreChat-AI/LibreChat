import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import type {
  DraftServices,
  FocusServices,
  TitleServices,
  EventServices,
  TemplateServices,
  NavigationServices,
  EventServicesParams,
  EventTransportServices,
  ConversationCacheServices,
  FileServices,
} from '@librechat/chat/react';
import type { TStartupConfig } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import {
  logger,
  setDraft,
  scrollToEnd,
  requestChatFocus,
  withoutListFlags,
  setDocumentTitle,
  applyServerReplyStamp,
  getConversationDraftId,
  upsertConvoInAllQueries,
  updateConvoInAllQueries,
  addFileToCache,
  adoptComposerConversation,
  markLocallyCommittedReply,
  removeConvoFromAllQueries,
} from '~/utils';
import {
  startupConfigKey,
  queueTitleGeneration,
  markTitleGenerationProcessed,
  useReconcileConversationCodeEnvironmentMutation,
} from '~/data-provider';
import { transferFileSearchPreference, withFileSearchPreference } from '~/hooks/Files/search';
import useFocusRegeneratedResponse from '~/hooks/Chat/useFocusRegeneratedResponse';
import { getFailedCodeDecisionRequest } from '~/hooks/Agents/codeDecision';
import { useChatTransport } from '~/Providers/ChatTransportContext';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import { updateAttachmentCaches } from './useAttachmentHandler';
import { useApplyAgentTemplate } from '~/hooks/Agents';
import { useLiveAnnouncer } from '~/Providers';
import { getConvoTitle } from './turns';

/** The sidebar, pinned, search and project lists, written through the helpers that walk every
 *  cached page. Arguments are forwarded as given, so each helper keeps its own defaults. */
export const createConversationCache = (queryClient: QueryClient): ConversationCacheServices => ({
  upsert: (conversation) => upsertConvoInAllQueries(queryClient, conversation),
  update: (...args) => updateConvoInAllQueries(queryClient, ...args),
  remove: (conversationId) => removeConvoFromAllQueries(queryClient, conversationId),
  listEntry: withoutListFlags,
  getTitle: (request) => getConvoTitle({ queryClient, ...request }),
  commitReply: (conversationId, stamp) => {
    markLocallyCommittedReply(queryClient, conversationId, stamp.lastResponseAt);
    applyServerReplyStamp(queryClient, conversationId, stamp);
  },
});

export const appTitleServices: TitleServices = {
  queue: (conversationId) => queueTitleGeneration(conversationId),
  markProcessed: (conversationId) => markTitleGenerationProcessed(conversationId),
  setDocumentTitle: (title) => setDocumentTitle(title),
};

export const appDraftServices: DraftServices = {
  save: (draft) => setDraft(draft),
  getId: (runIndex, conversationId) => getConversationDraftId(runIndex, conversationId),
  adopt: (conversation, conversationId, runIndex, options) => {
    if (options?.carryPreferences === true) {
      adoptComposerConversation(
        conversation,
        conversationId,
        runIndex,
        transferFileSearchPreference,
      );
      return;
    }
    adoptComposerConversation(conversation, conversationId, runIndex);
  },
};

/** The app's services behind the stream event handlers. Each group keeps its identity until
 *  what it reads changes, so the handlers built on it do too. */
export default function useEventServices({ setConversation }: EventServicesParams): EventServices {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { conversationId } = useParams();
  const { announcePolite } = useLiveAnnouncer();
  const applyAgentTemplate = useApplyAgentTemplate();
  const showRegenerated = useFocusRegeneratedResponse();
  const { mutate: reconcileCodeDecision } =
    useReconcileConversationCodeEnvironmentMutation(setConversation);
  const { token } = useChatSettings().auth;
  const chatTransport = useChatTransport();

  const conversations = useMemo(() => createConversationCache(queryClient), [queryClient]);
  const navigation = useMemo<NavigationServices>(
    () => ({ pathname, conversationId, navigate }),
    [pathname, conversationId, navigate],
  );
  const focus = useMemo<FocusServices>(
    () => ({
      announce: announcePolite,
      showRegenerated,
      focusComposer: () => requestChatFocus(),
      scrollToEnd: () => scrollToEnd(),
    }),
    [announcePolite, showRegenerated],
  );
  const templates = useMemo<TemplateServices>(
    () => ({
      apply: ({ targetId, sourceId, ephemeralAgent, specName }) =>
        applyAgentTemplate({
          targetId,
          sourceId,
          ephemeralAgent: withFileSearchPreference(targetId, ephemeralAgent),
          specName,
          startupConfig: queryClient.getQueryData<TStartupConfig>(startupConfigKey(true)),
        }),
      reconcileFailedCode: (submission, failedConversationId) => {
        const request = getFailedCodeDecisionRequest(submission, failedConversationId);
        if (request != null) reconcileCodeDecision(request);
      },
    }),
    [applyAgentTemplate, reconcileCodeDecision, queryClient],
  );
  const files = useMemo<FileServices>(
    () => ({
      onAttachment: (attachment) => updateAttachmentCaches(queryClient, attachment),
      onImageFile: (file) => addFileToCache(queryClient, file),
    }),
    [queryClient],
  );
  const transport = useMemo<EventTransportServices>(
    () => ({ abortRun: (request) => chatTransport.abortRun(request, { token }) }),
    [chatTransport, token],
  );

  return useMemo(
    () => ({
      conversations,
      titles: appTitleServices,
      drafts: appDraftServices,
      navigation,
      focus,
      templates,
      files,
      transport,
      logger,
    }),
    [conversations, navigation, focus, templates, files, transport],
  );
}
