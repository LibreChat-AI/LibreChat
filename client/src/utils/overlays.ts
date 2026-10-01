import type { OverlayRegistration, RegisterOverlay } from '@librechat/client';
import type { NavigationType } from 'react-router-dom';

/** Native close/navigation types are missing from the client's TypeScript DOM library. */
type CloseWatcher = EventTarget & { destroy(): void };
type NavigateEvent = Event & {
  navigationType: string;
  destination: { index: number; sameDocument: boolean };
};
type OverlayWindow = Window & {
  CloseWatcher?: new () => CloseWatcher;
  navigation?: {
    currentEntry: { index: number } | null;
    addEventListener(type: 'navigate', listener: (event: NavigateEvent) => void): void;
    removeEventListener(type: 'navigate', listener: (event: NavigateEvent) => void): void;
  };
};
const URL_MIRRORED = 'librechat:url-mirrored';

/** Mirror without navigating or initializing the streaming conversation. */
export function replaceBrowserUrl(url: string) {
  window.history.replaceState(window.history.state, '', url);
  window.dispatchEvent(new Event(URL_MIRRORED));
}

/** Never manufacture history entries for overlays: pushing would erase Forward.
 *  Unsupported or non-cancelable navigation remains the browser's responsibility. */
export function createOverlayDismissal(browser: OverlayWindow): {
  register: RegisterOverlay;
  listen: () => () => void;
  navigated: (action: NavigationType) => void;
} {
  const layers = new Map<string, OverlayRegistration>();
  const snapshot = () => ({
    key: (browser.history.state as { key?: string } | null)?.key,
    url: browser.location.href,
  });
  let current = snapshot();
  let mirroredPath: string | null = null;
  let watcher: CloseWatcher | undefined;
  let listening = false;
  let scheduled = false;

  const topLayer = () => {
    let top: OverlayRegistration | undefined;
    for (const layer of layers.values()) {
      if (top == null || layer.depth >= top.depth) top = layer;
    }
    return top;
  };

  const reconcile = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!listening || layers.size === 0) {
        watcher?.destroy();
        watcher = undefined;
        return;
      }
      if (watcher != null || browser.CloseWatcher == null) return;
      /** One native watcher owns the stack, avoiding grouped per-dialog closes. */
      watcher = new browser.CloseWatcher();
      watcher.addEventListener('close', () => {
        watcher = undefined;
        topLayer()?.onClose();
        /** A native close consumes the watcher even if controlled UI refuses it. */
        reconcile();
      });
    });
  };

  const onNavigate = (event: NavigateEvent) => {
    const entry = browser.navigation?.currentEntry;
    if (
      event.defaultPrevented ||
      !event.cancelable ||
      event.navigationType !== 'traverse' ||
      !event.destination.sameDocument ||
      entry == null ||
      event.destination.index >= entry.index
    ) {
      return;
    }
    const top = topLayer();
    if (top == null) return;
    event.preventDefault();
    top.onClose();
  };

  const mirrored = () => {
    if (new URL(current.url).pathname !== browser.location.pathname) {
      mirroredPath = browser.location.pathname;
    }
    current = snapshot();
  };

  return {
    register: (layer) => {
      layers.set(layer.id, layer);
      reconcile();
      return () => {
        if (layers.get(layer.id) !== layer) return;
        layers.delete(layer.id);
        reconcile();
      };
    },
    listen: () => {
      listening = true;
      current = snapshot();
      browser.navigation?.addEventListener('navigate', onNavigate);
      browser.addEventListener(URL_MIRRORED, mirrored);
      reconcile();
      return () => {
        listening = false;
        watcher?.destroy();
        watcher = undefined;
        browser.navigation?.removeEventListener('navigate', onNavigate);
        browser.removeEventListener(URL_MIRRORED, mirrored);
      };
    },
    navigated: (action) => {
      const previous = current;
      const synchronizing = action === 'REPLACE' && mirroredPath === browser.location.pathname;
      mirroredPath = null;
      current = snapshot();
      if (synchronizing || (previous.key === current.key && previous.url === current.url)) return;
      for (const layer of layers.values()) layer.onClose();
    },
  };
}
