import { useEffect, useLayoutEffect } from 'react';
import { useAtom } from 'jotai';
import { useRecoilValue } from 'recoil';
import { createPortal } from 'react-dom';
import {
  mirrorDocumentStyles,
  mirrorDocumentTheme,
  persistBounds,
  relayFrameMessages,
} from './undockedWindow';
import { undockedArtifacts } from './state';
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
    detachedWindow.addEventListener('pagehide', redock);
    window.addEventListener('pagehide', closeWithOpener);
    const closedPoll = window.setInterval(() => {
      if (detachedWindow.closed) {
        redock();
      }
    }, CLOSED_POLL_MS);

    return () => {
      window.clearInterval(closedPoll);
      window.removeEventListener('pagehide', closeWithOpener);
      detachedWindow.removeEventListener('pagehide', redock);
      for (const dispose of teardown) {
        dispose();
      }
      root.remove();
      persistBounds(detachedWindow, window.localStorage);
      detachedWindow.close();
      /* Closing the pane while undocked is not a dock: clear the window so the
       * next artifact opens in the side panel. */
      redock();
    };
  }, [detached, setDetached]);

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

  return createPortal(children, detached.root);
}
