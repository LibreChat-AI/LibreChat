import { useMemo } from 'react';
import { useAtom } from 'jotai';
import { supportsConversationTitleOwnership } from 'librechat-data-provider';
import { useRecoilState, useRecoilValue, useResetRecoilState } from 'recoil';
import type { ReactNode } from 'react';
import type { ChatSettings, ChatConfig, ChatAuth } from '~/hooks/Chat/contract';
import { ChatTransportContext, defaultChatTransport } from '~/Providers/ChatTransportContext';
import { ChatSettingsContext } from '~/Providers/ChatSettingsContext';
import { duringRunActionAtom } from '~/store/duringRun';
import { useGetStartupConfig } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import store from '~/store';

/** Supplies the chat's app-global preferences from the app's own settings store, the deployment
 *  config and signed-in account from the app's queries, and the transport its turns run over. */
export default function ChatSettingsProvider({ children }: { children: ReactNode }) {
  const [duringRunDefaultAction, setDuringRunDefaultAction] = useAtom(duringRunActionAtom);
  const resetVisibleArtifacts = useResetRecoilState(store.visibleArtifacts);
  const saveDrafts = useRecoilValue<boolean>(store.saveDrafts);
  const [isTemporary, setIsTemporary] = useRecoilState<boolean>(store.isTemporary);
  const { data: startupConfig } = useGetStartupConfig();
  const { user } = useAuthContext();

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
    };
  }, [startupConfig]);
  const auth = useMemo<ChatAuth>(() => ({ user }), [user]);

  const settings = useMemo<ChatSettings>(
    () => ({
      duringRunDefaultAction,
      setDuringRunDefaultAction,
      resetVisibleArtifacts,
      saveDrafts,
      isTemporary,
      setIsTemporary,
      config,
      auth,
    }),
    [
      duringRunDefaultAction,
      setDuringRunDefaultAction,
      resetVisibleArtifacts,
      saveDrafts,
      isTemporary,
      setIsTemporary,
      config,
      auth,
    ],
  );

  return (
    <ChatTransportContext.Provider value={defaultChatTransport}>
      <ChatSettingsContext.Provider value={settings}>{children}</ChatSettingsContext.Provider>
    </ChatTransportContext.Provider>
  );
}
