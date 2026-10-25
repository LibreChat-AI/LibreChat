import { useCallback, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useToastContext } from '@librechat/client';
import { setDefaultMessagePartsHost, pendingSteersByConvoId } from '@librechat/chat/react';
import {
  liveAppliedSteerFamily,
  liveAppliedSteerIdsAtom,
  escalatingSteerFamily,
} from '@librechat/chat/react';
import {
  useRecoilCallback,
  useRecoilState,
  useRecoilValue,
  useResetRecoilState,
  useSetRecoilState,
} from 'recoil';
import type { Agent } from 'librechat-data-provider';
import type {
  MessagePartArtifactPanel,
  MessagePartsUserTextPreferences,
  MessagePartMessage,
  MessagePartsHost,
} from '~/hooks/Chat/contract';
import type { MessagesEditing } from './MessagesViewContext';
import type { Artifact } from '~/common';
import {
  useMessageContext,
  useFileMapContext,
  useAgentsMapContext,
  useMessagesOperations,
  useMessagesConversation,
  useOptionalMessagesOperations,
} from '~/Providers';
import { getAppPartRenderers } from '~/components/Chat/Messages/Content/Parts/slots';
import useSmoothStreaming from '~/hooks/Messages/useSmoothStreaming';
import { ptcTraceByToolCallId, ptcTraceKey } from '~/hooks/SSE/ptc';
import { sandboxStartingByToolCallId } from '~/hooks/SSE/sandbox';
import { chatDirectionAtom } from '~/store/chatDirection';
import { showThinkingAtom } from '~/store/showThinking';
import { fontSizeAtom } from '~/store/fontSize';
import store from '~/store';

function useAppMessage(): MessagePartMessage {
  const { messageId, isSubmitting, isLatestMessage, nextType, conversationId, partIndex } =
    useMessageContext();
  return { messageId, isSubmitting, isLatestMessage, nextType, conversationId, partIndex };
}

function useAppMessagesEditing(): MessagesEditing {
  const { conversation } = useMessagesConversation();
  const { ask, getMessages, setMessages } = useMessagesOperations();
  return useMemo(
    () => ({ conversation, ask, getMessages, setMessages }),
    [conversation, ask, getMessages, setMessages],
  );
}

function useAppAgent(agentId: string): Agent | undefined {
  const agentsMap = useAgentsMapContext();
  return useMemo(() => agentsMap?.[agentId], [agentsMap, agentId]);
}

function useAppUserTextPreferences(): MessagePartsUserTextPreferences {
  const usernameDisplay = useRecoilValue<boolean>(store.UsernameDisplay);
  const enableUserMsgMarkdown = useRecoilValue<boolean>(store.enableUserMsgMarkdown);
  const collapseLongUserMessages = useRecoilValue<boolean>(store.collapseLongUserMessages);
  return useMemo(
    () => ({ usernameDisplay, enableUserMsgMarkdown, collapseLongUserMessages }),
    [usernameDisplay, enableUserMsgMarkdown, collapseLongUserMessages],
  );
}

function useAppArtifactPanel(artifactId: string): MessagePartArtifactPanel {
  const setVisible = useSetRecoilState(store.artifactsVisibility);
  const setArtifacts = useSetRecoilState(store.artifactsState);
  const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const currentArtifactId = useRecoilValue(store.currentArtifactId);
  const registered = useRecoilValue(store.artifactByIdSelector(artifactId));
  const register = useCallback(
    (artifact: Artifact) => setArtifacts((prev) => ({ ...(prev ?? {}), [artifact.id]: artifact })),
    [setArtifacts],
  );
  const open = useCallback(
    (id: string) => {
      setCurrentArtifactId(id);
      setVisible(true);
    },
    [setCurrentArtifactId, setVisible],
  );
  const close = useCallback(() => {
    resetCurrentArtifactId();
    setVisible(false);
  }, [resetCurrentArtifactId, setVisible]);
  /* A snapshot read, so the card does not subscribe to other files' or messages' flags. */
  const consumeJustResolved = useRecoilCallback(
    ({ snapshot, reset }) =>
      (messageId: string, fileId: string) => {
        const signal = store.previewJustResolved([messageId, fileId]);
        const flagged = snapshot.getLoadable(signal).valueMaybe() ?? false;
        if (flagged) {
          reset(signal);
        }
        return flagged;
      },
    [],
  );
  return { currentArtifactId, registered, register, open, close, consumeJustResolved };
}

function useAppLiveAppliedSteer(steerId: string): [boolean, (steerId: string) => void] {
  const isLiveApplied = useAtomValue(liveAppliedSteerFamily(steerId));
  const setLiveAppliedIds = useSetAtom(liveAppliedSteerIdsAtom);
  const consume = useCallback(
    (id: string) =>
      setLiveAppliedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : prev)),
    [setLiveAppliedIds],
  );
  return [isLiveApplied, consume];
}

/**
 * The host the app's own views supply: the Recoil and Jotai stores and the app providers. It is
 * registered as the default, so parts rendered outside a provider read the app's stores.
 */
export const appMessagePartsHost: MessagePartsHost = {
  useMessage: useAppMessage,
  renderMarkdown: (props) => getAppPartRenderers().renderMarkdown(props),
  useSmoothStreaming,
  useAgent: useAppAgent,
  renderAgentIcon: (agent) => getAppPartRenderers().renderAgentIcon(agent),
  useFontSize: () => useAtomValue(fontSizeAtom),
  useShowThinking: () => useAtomValue(showThinkingAtom),
  useAutoExpandTools: () => useRecoilValue<boolean>(store.autoExpandTools),
  useLaTeXParsing: () => useRecoilValue<boolean>(store.LaTeXParsing),
  useChatDirection: () => useAtomValue(chatDirectionAtom),
  useUserTextPreferences: useAppUserTextPreferences,
  /* The atom rather than the auth context: AuthContextProvider mirrors the user into it, and the
   * public share route mounts outside that provider. */
  useUser: () => useRecoilValue(store.user),
  useFileMap: () => useFileMapContext(),
  useToast: () => useToastContext().showToast,
  useSandboxStarting: (toolCallId) => useAtomValue(sandboxStartingByToolCallId(toolCallId)),
  usePtcTrace: (messageId, toolCallId) =>
    useAtomValue(
      ptcTraceByToolCallId(toolCallId && messageId ? ptcTraceKey(messageId, toolCallId) : ''),
    ),
  useToolArtifactClaim: (artifactId) => useRecoilState(store.toolArtifactClaim(artifactId)),
  useArtifactPanel: useAppArtifactPanel,
  usePendingSteers: (conversationId) => useAtomValue(pendingSteersByConvoId(conversationId)),
  useSteerEscalating: (conversationId) => useAtomValue(escalatingSteerFamily(conversationId)),
  usePaneConversationId: (index) => useRecoilValue(store.conversationIdByIndex(index)),
  useLiveAppliedSteer: useAppLiveAppliedSteer,
  useMessagesEditing: useAppMessagesEditing,
  useMessagesAsk: () => useOptionalMessagesOperations().ask,
};

setDefaultMessagePartsHost(appMessagePartsHost);

export { MessagePartsHostProvider, useMessagePartsHost } from '@librechat/chat/react';
