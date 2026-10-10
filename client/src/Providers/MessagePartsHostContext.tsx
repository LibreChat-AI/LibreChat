import { createContext, useCallback, useContext, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useToastContext } from '@librechat/client';
import {
  useRecoilCallback,
  useRecoilState,
  useRecoilValue,
  useResetRecoilState,
  useSetRecoilState,
} from 'recoil';
import type { ReactNode } from 'react';
import type {
  MessagePartArtifactPanel,
  MessagePartsUserTextPreferences,
  MessagePartMessage,
  MessagePartsHost,
} from '~/hooks/Chat/contract';
import type { Artifact } from '~/common';
import {
  liveAppliedSteerFamily,
  liveAppliedSteerIdsAtom,
  escalatingSteerFamily,
} from '~/store/steer';
import store, { ptcTraceByToolCallId, ptcTraceKey, sandboxStartingByToolCallId } from '~/store';
import { useMessageContext, useFileMapContext } from '~/Providers';
import { showThinkingAtom } from '~/store/showThinking';
import { fontSizeAtom } from '~/store/fontSize';

function useAppMessage(): MessagePartMessage {
  const { messageId, isSubmitting, isLatestMessage, nextType } = useMessageContext();
  return { messageId, isSubmitting, isLatestMessage, nextType };
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

/** The host the app's own views supply: the Recoil and Jotai stores and the app providers. */
export const appMessagePartsHost: MessagePartsHost = {
  useMessage: useAppMessage,
  useFontSize: () => useAtomValue(fontSizeAtom),
  useShowThinking: () => useAtomValue(showThinkingAtom),
  useUserTextPreferences: useAppUserTextPreferences,
  /* The atom rather than the auth context: AuthContextProvider mirrors the user into it, and the
   * public share route mounts outside that provider. */
  useUser: () => useRecoilValue(store.user),
  useFileMap: () => useFileMapContext(),
  useToast: () => useToastContext().showToast,
  useSandboxStarting: (toolCallId) => useAtomValue(sandboxStartingByToolCallId(toolCallId)),
  usePtcTrace: (messageId, toolCallId) =>
    useRecoilValue(
      ptcTraceByToolCallId(toolCallId && messageId ? ptcTraceKey(messageId, toolCallId) : ''),
    ),
  useToolArtifactClaim: (artifactId) => useRecoilState(store.toolArtifactClaim(artifactId)),
  useArtifactPanel: useAppArtifactPanel,
  usePendingSteers: (conversationId) =>
    useRecoilValue(store.pendingSteersByConvoId(conversationId)),
  useSteerEscalating: (conversationId) => useAtomValue(escalatingSteerFamily(conversationId)),
  usePaneConversationId: (index) => useRecoilValue(store.conversationIdByIndex(index)),
  useLiveAppliedSteer: useAppLiveAppliedSteer,
};

const MessagePartsHostContext = createContext<MessagePartsHost>(appMessagePartsHost);

/** Supplies the host the message parts read from. Without one, parts read the app's stores. */
export function MessagePartsHostProvider({
  host,
  children,
}: {
  host: MessagePartsHost;
  children: ReactNode;
}) {
  return (
    <MessagePartsHostContext.Provider value={host}>{children}</MessagePartsHostContext.Provider>
  );
}

export const useMessagePartsHost = () => useContext(MessagePartsHostContext);
