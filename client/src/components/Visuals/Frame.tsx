import { useRef, useMemo, useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { Button, Spinner } from '@librechat/client';
import { visualFrame, VisualBridgeMethod } from 'librechat-data-provider';
import {
  readLinkRequest,
  readBridgeParams,
  readContentHeight,
  visualThemeMessage,
  injectVisualBootstrap,
} from './bootstrap';
import { getVisualTheme, readVisualTheme, subscribeVisualTheme } from './theme';
import { clampAppViewHeight } from '~/utils/mcpApps';
import { useLocalize } from '~/hooks';
import { hashText } from './hash';
import cn from '~/utils/cn';

/** Past this a page scrolls inside its frame instead of growing the reply. */
export const VISUAL_MAX_HEIGHT = 2000;
const VISUAL_DEFAULT_HEIGHT = 240;
/** A page that never reports a usable size is revealed this long after it was handed over. */
const SIZE_REPORT_GRACE_MS = 3000;
const READY_AFTER_LOAD_MS = 1000;

type FrameStatus = 'loading' | 'ready' | 'failed';

function useVisualTheme() {
  return useSyncExternalStore(subscribeVisualTheme, getVisualTheme);
}

/**
 * One visual's sandboxed frame, sized to the height its page reports up to `maxHeight`, past which
 * the page scrolls inside it. The frame has an opaque origin, so every message is matched on
 * `event.source`.
 */
export default function VisualFrame({
  html,
  title,
  maxHeight = VISUAL_MAX_HEIGHT,
  onContentHeight,
}: {
  html: string;
  title: string;
  maxHeight?: number;
  onContentHeight?: (height: number) => void;
}) {
  const localize = useLocalize();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const theme = useVisualTheme();
  const [status, setStatus] = useState<FrameStatus>('loading');
  const [contentHeight, setContentHeight] = useState(VISUAL_DEFAULT_HEIGHT);
  const onContentHeightRef = useRef(onContentHeight);
  onContentHeightRef.current = onContentHeight;
  const [attempt, setAttempt] = useState(0);
  const renderedRef = useRef(false);

  const pageKey = useMemo(() => hashText(html), [html]);

  /* The shell posts `ready` while it parses, before its load event. A load with no `ready`
   * shortly after means the frame route failed or served something else. */
  const loadTimerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(loadTimerRef.current), []);

  useEffect(() => {
    clearTimeout(loadTimerRef.current);
    renderedRef.current = false;
    setStatus('loading');
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow;
      if (frame == null || event.source !== frame) {
        return;
      }
      if (readBridgeParams(event.data, VisualBridgeMethod.proxyReady) != null) {
        if (renderedRef.current) {
          return;
        }
        renderedRef.current = true;
        /* Read now, not from the last snapshot, so a theme change while the shell loaded is not
         * lost; later changes travel as messages. */
        const page = injectVisualBootstrap(html, readVisualTheme());
        frame.postMessage(
          { jsonrpc: '2.0', method: VisualBridgeMethod.resourceReady, params: { html: page } },
          '*',
        );
        revealTimer = setTimeout(
          () => setStatus((prev) => (prev === 'loading' ? 'ready' : prev)),
          SIZE_REPORT_GRACE_MS,
        );
        return;
      }
      const clamped = clampAppViewHeight(readContentHeight(event.data), { max: VISUAL_MAX_HEIGHT });
      if (clamped != null) {
        setContentHeight(clamped);
        onContentHeightRef.current?.(clamped);
        setStatus((prev) => (prev === 'failed' ? prev : 'ready'));
        return;
      }
      /* The page's own script can post this, so a link opens only on a live user gesture. A
       * click inside the frame activates the window that holds it, which is the undocked panel's
       * popup rather than this one when the panel is undocked. */
      const url = readLinkRequest(event.data);
      const view = iframeRef.current?.ownerDocument.defaultView ?? window;
      if (url != null && view.navigator.userActivation?.isActive === true) {
        view.open(url, '_blank', 'noopener,noreferrer');
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      clearTimeout(revealTimer);
      window.removeEventListener('message', onMessage);
    };
  }, [html, attempt]);

  useEffect(() => {
    if (!renderedRef.current) {
      return;
    }
    iframeRef.current?.contentWindow?.postMessage(visualThemeMessage(theme), '*');
  }, [theme]);

  const onLoad = useCallback(() => {
    clearTimeout(loadTimerRef.current);
    loadTimerRef.current = setTimeout(() => {
      if (!renderedRef.current) {
        setStatus('failed');
      }
    }, READY_AFTER_LOAD_MS);
  }, []);

  const onRetry = useCallback(() => setAttempt((current) => current + 1), []);

  return (
    <div className="relative w-full" style={{ height: Math.min(contentHeight, maxHeight) }}>
      {status === 'loading' && (
        <div
          className="text-text-secondary absolute inset-0 flex items-center gap-2 text-sm"
          role="status"
        >
          <Spinner className="size-4" aria-hidden="true" />
          {localize('com_ui_visual_loading')}
        </div>
      )}
      {status === 'failed' && (
        <div
          className="border-border-light bg-surface-secondary text-text-secondary absolute inset-0 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm"
          role="alert"
        >
          <span>{localize('com_ui_visual_load_error')}</span>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      <iframe
        key={`${attempt}-${pageKey}`}
        ref={iframeRef}
        src={visualFrame()}
        sandbox="allow-scripts"
        title={title}
        onLoad={onLoad}
        className={cn(
          /* A frame whose color-scheme differs from its page's paints an opaque backdrop. */
          'block size-full border-0 bg-transparent',
          theme.appearance === 'dark' ? 'scheme-dark' : 'scheme-light',
          status === 'ready' ? 'visible' : 'invisible',
        )}
      />
    </div>
  );
}
