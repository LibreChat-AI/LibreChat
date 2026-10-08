import { useMemo } from 'react';
import { useRecoilCallback, useRecoilValue, useResetRecoilState, useSetRecoilState } from 'recoil';
import type { ReactNode } from 'react';
import type { ChatSurface } from '~/components/Chat/Subagents/surface';
import { ChatSurfaceProvider } from '~/components/Chat/Subagents/surface';
import useComposerBindings from '~/hooks/Input/useComposerBindings';
import store from '~/store';

/**
 * The application's adapter for {@link ChatSurface}. Every preference and
 * shell command the chat surface consumes is resolved here, in host territory,
 * so the feature below never reaches into the app store for them.
 */
export default function AppChatSurface({ children }: { children: ReactNode }) {
  const enterToSend = useRecoilValue(store.enterToSend);
  const maximizeChatSpace = useRecoilValue(store.maximizeChatSpace);
  const showScrollButton = useRecoilValue(store.showScrollButton);
  const composerBindings = useComposerBindings();
  const setArtifactsVisible = useSetRecoilState(store.artifactsVisibility);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const handOffComposerText = useRecoilCallback(
    ({ set }) =>
      (conversationId: string, text: string) =>
        set(store.pendingComposerTextByConvoId(conversationId), text),
    [],
  );

  const value = useMemo<ChatSurface>(
    () => ({
      enterToSend,
      maximizeChatSpace,
      showScrollButton,
      composerBindings,
      /** The artifacts panel and the subagent panel share one slot. */
      claimForeground: () => {
        resetCurrentArtifactId();
        setArtifactsVisible(false);
      },
      handOffComposerText,
    }),
    [
      composerBindings,
      enterToSend,
      handOffComposerText,
      maximizeChatSpace,
      resetCurrentArtifactId,
      setArtifactsVisible,
      showScrollButton,
    ],
  );

  return <ChatSurfaceProvider value={value}>{children}</ChatSurfaceProvider>;
}
