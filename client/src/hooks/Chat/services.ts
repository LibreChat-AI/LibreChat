import { useNavigate } from 'react-router-dom';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatTurnsParams, TurnServices } from '@librechat/chat/react';
import type { TEndpointsConfig } from 'librechat-data-provider';
import {
  logger,
  requestChatFocus,
  markPasteSubmitted,
  bindComposerLaunch,
  getRouteChatProjectId,
} from '~/utils';
import {
  withSubmittedCodeDecision,
  resolveSubmittedCodeApprovalMode,
} from '~/hooks/Agents/codeDecision';
import useGetConversation from '~/hooks/Conversations/useGetConversation';
import useCodeApprovalMode from '~/hooks/Agents/useCodeApprovalMode';
import useSetFilesToDelete from '~/hooks/Files/useSetFilesToDelete';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import useCodeWorkspace from '~/hooks/Agents/useCodeWorkspace';
import useGetSender from '~/hooks/Conversations/useGetSender';
import { resolveSubmittedReasoning } from './ask/reasoning';
import useUserKey from '~/hooks/Input/useUserKey';

/** The app's side of a pane's turns: its catalogs, router, composer files, code workspace and
 *  logger, for the package's `useTurns`. */
export default function useTurnServices({
  index,
  conversation,
}: Pick<ChatTurnsParams, 'index' | 'conversation'>): TurnServices {
  const navigate = useNavigate();
  const getSender = useGetSender();
  const queryClient = useQueryClient();
  const setFilesToDelete = useSetFilesToDelete();
  const agentsMap = useAgentsMapContext();
  const { isTemporary, config, auth, getEphemeralAgent, addedConversation } = useChatSettings();
  const { getExpiry } = useUserKey(conversation?.endpoint ?? '');
  const getConversation = useGetConversation(index);
  const codeWorkspaceState = useCodeWorkspace(conversation, addedConversation);
  const { modes: codeApprovalModes, selected: fallbackCodeApprovalMode } = useCodeApprovalMode(
    conversation,
    addedConversation,
    codeWorkspaceState.mode,
  );

  return {
    logger,
    isTemporary,
    user: auth.user,
    modelSpecs: config.modelSpecs,
    getEndpointsConfig: () => queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]),
    getEphemeralAgent,
    getSender,
    getUserKey: getExpiry,
    getRouteProjectId: getRouteChatProjectId,
    resolveCode: (submitted) => {
      const latest = getConversation();
      const latestApprovalMode = latest?.codeApprovalMode;
      const workspaceSubmission = codeWorkspaceState.resolveSubmission(
        latest?.codeWorkspaces ?? submitted?.codeWorkspaces,
        latest?.codeEnvironmentMode ?? submitted?.codeEnvironmentMode,
      );
      if (workspaceSubmission == null) {
        return null;
      }
      const { codeEnvironmentMode, codeWorkspaces } = workspaceSubmission;
      return {
        code: {
          approvalMode: resolveSubmittedCodeApprovalMode({
            requested: latestApprovalMode,
            modes: codeApprovalModes,
            fallback: fallbackCodeApprovalMode,
            codeEnvironmentMode,
          }),
          latestApprovalMode,
          environmentMode: codeEnvironmentMode,
          workspaces: codeWorkspaces,
        },
        apply: (current) => withSubmittedCodeDecision(current, workspaceSubmission),
      };
    },
    resolveReasoning: ({ endpoint, conversation, endpointsConfig, reasoningOverride }) => {
      const resolved = resolveSubmittedReasoning({
        queryClient,
        agentsMap,
        endpoint,
        conversation,
        endpointsConfig,
        reasoningOverride,
        drainedReasoning: true,
        stagedReasoning: reasoningOverride,
      });
      return { reasoningOverride: resolved.reasoningOverride, retryable: resolved.restoreStaged };
    },
    openNewChat: (path) => {
      requestChatFocus();
      navigate(path);
    },
    releaseFiles: (fileIds) => markPasteSubmitted(...fileIds),
    clearFilesToDelete: () => setFilesToDelete({}),
    bindLaunch: bindComposerLaunch,
  };
}
