import { useMemo } from 'react';
import { useAtom } from 'jotai';
import { useRecoilState, useRecoilValue, useResetRecoilState } from 'recoil';
import type { ReactNode } from 'react';
import type { ChatSettings } from '~/hooks/Chat/contract';
import { ChatTransportContext, defaultChatTransport } from '~/Providers/ChatTransportContext';
import { ChatSettingsContext } from '~/Providers/ChatSettingsContext';
import { duringRunActionAtom } from '~/store/duringRun';
import store from '~/store';

/** Supplies the chat's app-global preferences from the app's own settings store, and the
 *  transport its turns run over. */
export default function ChatSettingsProvider({ children }: { children: ReactNode }) {
  const [duringRunDefaultAction, setDuringRunDefaultAction] = useAtom(duringRunActionAtom);
  const resetVisibleArtifacts = useResetRecoilState(store.visibleArtifacts);
  const saveDrafts = useRecoilValue<boolean>(store.saveDrafts);
  const [isTemporary, setIsTemporary] = useRecoilState<boolean>(store.isTemporary);

  const settings = useMemo<ChatSettings>(
    () => ({
      duringRunDefaultAction,
      setDuringRunDefaultAction,
      resetVisibleArtifacts,
      saveDrafts,
      isTemporary,
      setIsTemporary,
    }),
    [
      duringRunDefaultAction,
      setDuringRunDefaultAction,
      resetVisibleArtifacts,
      saveDrafts,
      isTemporary,
      setIsTemporary,
    ],
  );

  return (
    <ChatTransportContext.Provider value={defaultChatTransport}>
      <ChatSettingsContext.Provider value={settings}>{children}</ChatSettingsContext.Provider>
    </ChatTransportContext.Provider>
  );
}
