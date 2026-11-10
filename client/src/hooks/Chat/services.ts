import { useRef, useEffect } from 'react';
import { useStore } from 'jotai';
import { useNavigate } from 'react-router-dom';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import { launchedConversationFamily } from '@librechat/chat/react';
import type { ChatTurnsParams, TurnServices } from '@librechat/chat/react';
import type { TEndpointsConfig } from 'librechat-data-provider';
import {
  logger,
  requestChatFocus,
  markPasteSubmitted,
  bindComposerLaunch,
  getRouteChatProjectId,
} from '~/utils';
import useGetConversation from '~/hooks/Conversations/useGetConversation';
import useDiscardPastedFiles from '~/hooks/Files/useDiscardPastedFiles';
import useCodeApprovalMode from '~/hooks/Agents/useCodeApprovalMode';
import useSetFilesToDelete from '~/hooks/Files/useSetFilesToDelete';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import useCodeWorkspace from '~/hooks/Agents/useCodeWorkspace';
import { cancelUploads } from '~/hooks/Files/useFileHandling';
import useUserKey from '~/hooks/Input/useUserKey';
import { isTargetReady } from './ask/guards';

/** The app's side of a pane's turns: its catalogs, router, composer files, code workspace and
 *  logger, for the package's `useTurns`. */
export default function useTurnServices({
  index,
  conversation,
}: Pick<ChatTurnsParams, 'index' | 'conversation'>): TurnServices {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const discardFiles = useDiscardPastedFiles(index, conversation?.conversationId);
  const setFilesToDelete = useSetFilesToDelete();
  const agentsMap = useAgentsMapContext();
  const { isTemporary, config, auth, getEphemeralAgent, addedConversation } = useChatSettings();
  const { getExpiry } = useUserKey(conversation?.endpoint ?? '');
  const getConversation = useGetConversation(index);
  const codeWorkspaceState = useCodeWorkspace(conversation, addedConversation);
  const codeApprovalState = useCodeApprovalMode(
    conversation,
    addedConversation,
    codeWorkspaceState.mode,
  );

  /** A send reads the newest render's values, even through a `readCodeInputs` it captured from an
   *  earlier render. */
  const codeReaders = useRef({
    workspace: codeWorkspaceState.readInputs,
    approval: codeApprovalState.readInputs,
  });
  codeReaders.current = {
    workspace: codeWorkspaceState.readInputs,
    approval: codeApprovalState.readInputs,
  };

  const readiness = useRef({ config, addedConversation });
  readiness.current = { config, addedConversation };

  const store = useStore();
  /** The composer draft follows the conversation a submission launches; the package writes the
   *  launch just before it publishes the submission, and the subscription binds it inside that
   *  write. */
  useEffect(() => {
    const launched = launchedConversationFamily(index);
    return store.sub(launched, () => bindComposerLaunch(store.get(launched), index));
  }, [store, index]);

  return {
    logger,
    isTemporary,
    user: auth.user,
    modelSpecs: config.modelSpecs,
    getEndpointsConfig: () => queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]),
    agentsMap,
    getEphemeralAgent,
    getUserKey: getExpiry,
    getRouteProjectId: getRouteChatProjectId,
    canSubmit: (submitted) => {
      const { config, addedConversation } = readiness.current;
      return (
        config.loaded !== false &&
        isTargetReady(queryClient, submitted) &&
        (addedConversation == null || isTargetReady(queryClient, addedConversation))
      );
    },
    readCodeInputs: () => ({
      workspace: codeReaders.current.workspace(),
      approval: codeReaders.current.approval(),
      latest: getConversation(),
    }),
    openNewChat: (path) => {
      requestChatFocus();
      navigate(path);
    },
    cancelUploads,
    discardFiles,
    releaseFiles: (fileIds) => markPasteSubmitted(...fileIds),
    clearFilesToDelete: () => setFilesToDelete({}),
  };
}
