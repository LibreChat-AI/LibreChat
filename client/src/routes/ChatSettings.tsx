import { useMemo } from 'react';
import { useRecoilState, useRecoilValue, useResetRecoilState } from 'recoil';
import type { ReactNode } from 'react';
import type { ChatSettings } from '~/hooks/Chat/contract';
import { ChatTransportContext, defaultChatTransport } from '~/Providers/ChatTransportContext';
import { ChatSettingsContext } from '~/Providers/ChatSettingsContext';
import store from '~/store';

/** Supplies the chat's app-global preferences from the app's own settings store, and the
 *  transport its turns run over. */
export default function ChatSettingsProvider({ children }: { children: ReactNode }) {
  const [duringRunDefaultAction, setDuringRunDefaultAction] = useRecoilState(
    store.duringRunDefaultAction,
  );
  const steerInterruptsByDefault = useRecoilValue(store.steerInterruptsByDefault);
  const resetVisibleArtifacts = useResetRecoilState(store.visibleArtifacts);

  const settings = useMemo<ChatSettings>(
    () => ({
      duringRunDefaultAction,
      setDuringRunDefaultAction,
      steerInterruptsByDefault,
      resetVisibleArtifacts,
    }),
    [
      duringRunDefaultAction,
      setDuringRunDefaultAction,
      steerInterruptsByDefault,
      resetVisibleArtifacts,
    ],
  );

  return (
    <ChatTransportContext.Provider value={defaultChatTransport}>
      <ChatSettingsContext.Provider value={settings}>{children}</ChatSettingsContext.Provider>
    </ChatTransportContext.Provider>
  );
}
