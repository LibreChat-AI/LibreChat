import { useMemo } from 'react';
import { useAtom } from 'jotai';
import { supportsConversationTitleOwnership } from 'librechat-data-provider';
import { useRecoilState, useRecoilValue, useRecoilCallback, useResetRecoilState } from 'recoil';
import type { ReactNode } from 'react';
import type { ChatAuth, ChatConfig, ChatSettings, PaneConversation } from '~/hooks/Chat/contract';
import { ChatTransportContext, defaultChatTransport } from '~/Providers/ChatTransportContext';
import { ChatSettingsContext } from '~/Providers/ChatSettingsContext';
import { duringRunActionAtom } from '~/store/duringRun';
import { useGetStartupConfig } from '~/data-provider';
import store, { useGetEphemeralAgent } from '~/store';
import { useAuthContext } from '~/hooks/AuthContext';

/** Reads the conversation each mounted pane shows from the app's pane store, at call time. */
export function usePaneConversations(): ChatSettings['getPaneConversations'] {
  return useRecoilCallback(
    ({ snapshot }) =>
      (): PaneConversation[] =>
        snapshot
          .getLoadable(store.conversationKeysAtom)
          .getValue()
          .map((index) => ({
            index,
            conversationId:
              snapshot.getLoadable(store.conversationByIndex(index)).getValue()?.conversationId ??
              null,
          })),
    [],
  );
}

/** Supplies the chat's app-global preferences from the app's own settings store, the deployment
 *  config and signed-in account from the app's queries, and the transport its turns run over. */
export default function ChatSettingsProvider({ children }: { children: ReactNode }) {
  const [duringRunDefaultAction, setDuringRunDefaultAction] = useAtom(duringRunActionAtom);
  const resetVisibleArtifacts = useResetRecoilState(store.visibleArtifacts);
  const saveDrafts = useRecoilValue<boolean>(store.saveDrafts);
  const [isTemporary, setIsTemporary] = useRecoilState<boolean>(store.isTemporary);
  const getEphemeralAgent = useGetEphemeralAgent();
  const addedConversation = useRecoilValue(store.conversationByKeySelector(1));
  const { data: startupConfig, isFetched: startupConfigLoaded } = useGetStartupConfig();
  const { user, token, isAuthenticated } = useAuthContext();

  const config = useMemo<ChatConfig>(() => {
    const ui = startupConfig?.interface;
    return {
      retentionMode: ui?.retentionMode,
      feedbackEnabled: startupConfig != null && ui?.feedback !== false,
      canRenameRunningChat: supportsConversationTitleOwnership(startupConfig),
      modelSpecs: startupConfig?.modelSpecs?.list,
      queuedSendLockTimeoutMs: ui?.queuedSendLockTimeoutMs,
      queuedTurnReconciliationTimeoutMs: ui?.queuedTurnReconciliationTimeoutMs,
      steerArmConfirmationTimeoutMs: ui?.steerArmConfirmationTimeoutMs,
      loaded: startupConfigLoaded,
      balanceEnabled: startupConfig?.balance?.enabled ?? false,
    };
  }, [startupConfig, startupConfigLoaded]);
  const auth = useMemo<ChatAuth>(
    () => ({ user, token, isAuthenticated }),
    [user, token, isAuthenticated],
  );
  const getPaneConversations = usePaneConversations();

  const settings = useMemo<ChatSettings>(
    () => ({
      duringRunDefaultAction,
      setDuringRunDefaultAction,
      resetVisibleArtifacts,
      saveDrafts,
      isTemporary,
      setIsTemporary,
      getEphemeralAgent,
      addedConversation,
      config,
      auth,
      getPaneConversations,
    }),
    [
      duringRunDefaultAction,
      setDuringRunDefaultAction,
      resetVisibleArtifacts,
      saveDrafts,
      isTemporary,
      setIsTemporary,
      getEphemeralAgent,
      addedConversation,
      config,
      auth,
      getPaneConversations,
    ],
  );

  return (
    <ChatTransportContext.Provider value={defaultChatTransport}>
      <ChatSettingsContext.Provider value={settings}>{children}</ChatSettingsContext.Provider>
    </ChatTransportContext.Provider>
  );
}
