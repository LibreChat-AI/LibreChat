import React from 'react';
import { act, render } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import type { ChatSurface } from '~/components/Chat/Subagents/surface';
import { useChatSurface } from '~/components/Chat/Subagents/surface';
import AppChatSurface from '../Surface';
import store from '~/store';

/** The feature reads its host through {@link ChatSurface}; this is the other
 *  half — that the application's adapter answers with the reader's real
 *  preferences and drives the real shell when the feature asks. */
describe('AppChatSurface', () => {
  const renderSurface = () => {
    const seen = { current: null as ChatSurface | null };
    const app = {
      artifactsVisible: true as boolean,
      currentArtifactId: null as string | null,
      handedOff: undefined as string | undefined,
    };

    const Consumer = () => {
      seen.current = useChatSurface();
      return null;
    };
    const AppObserver = () => {
      app.artifactsVisible = useRecoilValue(store.artifactsVisibility);
      app.currentArtifactId = useRecoilValue(store.currentArtifactId);
      app.handedOff = useRecoilValue(store.pendingComposerTextByConvoId('continued-chat'));
      return null;
    };
    const Preferences = () => {
      const setEnterToSend = useSetRecoilState(store.enterToSend);
      const setMaximize = useSetRecoilState(store.maximizeChatSpace);
      const setScrollButton = useSetRecoilState(store.showScrollButton);
      const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);
      React.useEffect(() => {
        setEnterToSend(false);
        setMaximize(true);
        setScrollButton(false);
        setCurrentArtifactId('artifact-1');
      }, [setCurrentArtifactId, setEnterToSend, setMaximize, setScrollButton]);
      return null;
    };

    render(
      <RecoilRoot>
        <AppObserver />
        <Preferences />
        <AppChatSurface>
          <Consumer />
        </AppChatSurface>
      </RecoilRoot>,
    );
    return { seen, app };
  };

  it('answers with the reader’s own preferences', () => {
    const { seen } = renderSurface();
    expect(seen.current).toMatchObject({
      enterToSend: false,
      maximizeChatSpace: true,
      showScrollButton: false,
      composerBindings: { shortcutsEnabled: expect.any(Boolean) },
    });
  });

  it('clears the slot the panel is about to take', () => {
    const { seen, app } = renderSurface();
    expect(app.currentArtifactId).toBe('artifact-1');

    act(() => seen.current?.claimForeground());

    expect(app.artifactsVisible).toBe(false);
    expect(app.currentArtifactId).toBeNull();
  });

  it('hands unsent words to the conversation the host is opening', () => {
    const { seen, app } = renderSurface();

    act(() => seen.current?.handOffComposerText('continued-chat', 'Take this further.'));

    expect(app.handedOff).toBe('Take this further.');
  });
});
