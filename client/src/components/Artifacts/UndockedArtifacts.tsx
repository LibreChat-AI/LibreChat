import { useEffect, useLayoutEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { createPortal } from 'react-dom';
import { useAtom, useSetAtom } from 'jotai';
import * as RadixToast from '@radix-ui/react-toast';
import { Toast, ToastViewport } from '@librechat/client';
import {
  mirrorDocumentStyles,
  mirrorDocumentTheme,
  persistBounds,
  relayFrameMessages,
} from './undockedWindow';
import { artifactsPaneFocusRequest, undockedArtifacts } from './state';
import { useLocalize } from '~/hooks';
import store from '~/store';

/** `pagehide` covers the ordinary close; the poll covers the cases browsers
 *  drop it (OS-level window close, session restore), because a pane that never
 *  came home would leave the user with no artifacts at all. */
const CLOSED_POLL_MS = 500;

/**
 * Hosts the artifacts pane in a separate browser window while keeping it in
 * this window's React tree, so the pane keeps receiving artifacts as they
 * stream in and docking back is a re-render rather than a reload.
 *
 * The portal renders on the first commit — the window and its container are
 * prepared by the header before this mounts — so the pane never spends a
 * commit unmounted, which is what keeps its artifact registry alive.
 */
export default function UndockedArtifacts({ children }: { children: React.ReactNode }) {
  const localize = useLocalize();
  const artifacts = useRecoilValue(store.artifactsState);
  const currentArtifactId = useRecoilValue(store.currentArtifactId);
  const [detached, setDetached] = useAtom(undockedArtifacts);
  const setPaneFocusRequest = useSetAtom(artifactsPaneFocusRequest);

  useLayoutEffect(() => {
    if (detached == null) {
      return;
    }
    const { window: detachedWindow, root } = detached;
    /* Never clobber a window the user opened after this one. */
    const redock = () => setDetached((current) => (current === detached ? null : current));
    if (detachedWindow.closed) {
      redock();
      return;
    }

    const teardown = [
      mirrorDocumentStyles(document, detachedWindow.document),
      mirrorDocumentTheme(document, detachedWindow.document),
      relayFrameMessages(window, detachedWindow),
    ];

    const closeWithOpener = () => detachedWindow.close();
    /* A window the user closes through the browser reports zeroes by the time
     * the cleanup runs, so its size and position are read while it still has
     * them — otherwise the remembered bounds only ever track Dock. Closing the
     * window is a dock the user asked for, so the pane that takes over picks
     * focus up exactly as it does for the Dock control. */
    const rememberAndRedock = () => {
      persistBounds(detachedWindow, window);
      setPaneFocusRequest(true);
      redock();
    };
    detachedWindow.addEventListener('pagehide', rememberAndRedock);
    window.addEventListener('pagehide', closeWithOpener);
    const closedPoll = window.setInterval(() => {
      if (detachedWindow.closed) {
        setPaneFocusRequest(true);
        redock();
      }
    }, CLOSED_POLL_MS);

    return () => {
      window.clearInterval(closedPoll);
      window.removeEventListener('pagehide', closeWithOpener);
      detachedWindow.removeEventListener('pagehide', rememberAndRedock);
      for (const dispose of teardown) {
        dispose();
      }
      root.remove();
      persistBounds(detachedWindow, window);
      detachedWindow.close();
      /* Closing the pane while undocked is not a dock: clear the window so the
       * next artifact opens in the side panel. */
      redock();
    };
  }, [detached, setDetached, setPaneFocusRequest]);

  const artifactTitle =
    (currentArtifactId != null ? artifacts?.[currentArtifactId]?.title : null) ??
    localize('com_ui_artifacts');

  useEffect(() => {
    if (detached == null || detached.window.closed) {
      return;
    }
    detached.window.document.title = artifactTitle;
  }, [artifactTitle, detached]);

  if (detached == null) {
    return null;
  }

  /* The app's toast surface lives in the opener's document, which the user is
   * not looking at while the pane is undocked. A Radix provider of its own
   * gives every toast raised inside this window a viewport inside it, and the
   * toast state is shared, so the same notice shows wherever the user is. */
  return createPortal(
    <RadixToast.Provider>
      {children}
      <Toast />
      <ToastViewport />
    </RadixToast.Provider>,
    detached.root,
  );
}
