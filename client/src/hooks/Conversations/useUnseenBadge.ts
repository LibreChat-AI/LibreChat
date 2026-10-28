import { useEffect } from 'react';
import { readThemeColor } from '@librechat/client';
import { useReplyAlertPreferences } from './replyNotificationSettings';
import { getDocumentTitleRevision } from '~/utils';

const FAVICON_SELECTOR = 'link[rel="icon"]';
const FALLBACK_ICON_SIZE = 32;

/**
 * Reads the badge colour from the live theme so the favicon dot tracks the same semantic role
 * as the sidebar indicator. Returns null when the role cannot be read, which leaves the plain
 * favicon in place rather than painting a colour the active theme never chose.
 */
const badgeColor = (): string | null => readThemeColor('--status-info');

const drawBadgedFavicon = (
  source: string,
  color: string,
  onReady: (dataUrl: string) => void,
): (() => void) => {
  const image = new Image();
  let cancelled = false;

  image.onload = () => {
    if (cancelled) {
      return;
    }
    /* The icon's own resolution: upscaling the 16x16 link to 32 would soften it for exactly
       the browsers that pick it. Sizeless sources (an SVG icon) fall back to 32. */
    const size = image.naturalWidth || FALLBACK_ICON_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    context.drawImage(image, 0, 0, size, size);
    const radius = size * 0.28;
    const center = size - radius - 1;
    context.beginPath();
    context.arc(center, center, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    try {
      onReady(canvas.toDataURL('image/png'));
    } catch {
      /* A cross-origin icon taints the canvas; the unbadged favicon is the only way out. */
    }
  };

  image.src = source;
  return () => {
    cancelled = true;
  };
};

/**
 * Reflects the unseen count in the tab title and favicon.
 *
 * The title has another canonical writer: `setDocumentTitle` updates it whenever
 * the active conversation or page changes. Its revision signal lets this hook
 * distinguish a canonical write that happens to leave the same title string,
 * while the `MutationObserver` still preserves compatibility with direct DOM
 * writers. Recomputing from the current value, rather than from a remembered
 * base, lets the two compose instead of clobbering each other.
 *
 * Every declared icon is badged, not just the 32x32 one: Firefox and 1x-DPI Chrome pick
 * the 16x16 link, and a single-link badge would leave them without one.
 */
export default function useUnseenBadge(count: number) {
  const { badgeEnabled } = useReplyAlertPreferences();
  const activeCount = badgeEnabled ? count : 0;

  useEffect(() => {
    const titleElement = document.querySelector('title');
    if (!titleElement) {
      return;
    }

    let writtenBadge = '';
    let writtenTitle = '';
    let seenTitleRevision = getDocumentTitleRevision();
    const apply = () => {
      const titleRevision = getDocumentTitleRevision();
      if (titleRevision !== seenTitleRevision) {
        writtenBadge = '';
        seenTitleRevision = titleRevision;
      }

      const badge = activeCount > 0 ? `(${activeCount}) ` : '';
      const isOurs = writtenBadge !== '' && document.title === writtenTitle;
      const base = isOurs ? document.title.slice(writtenBadge.length) : document.title;
      const next = `${badge}${base}`;
      if (document.title !== next) {
        document.title = next;
      }
      writtenBadge = badge;
      writtenTitle = next;
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(titleElement, { childList: true, characterData: true, subtree: true });

    return () => {
      observer.disconnect();
      if (
        seenTitleRevision === getDocumentTitleRevision() &&
        writtenBadge !== '' &&
        document.title === writtenTitle
      ) {
        document.title = document.title.slice(writtenBadge.length);
      }
    };
  }, [activeCount]);

  useEffect(() => {
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>(FAVICON_SELECTOR));
    if (links.length === 0) {
      return;
    }

    /* Recorded once per link on first run; the dataset entry survives effect re-runs and
       can never capture an already-badged data URL. */
    for (const link of links) {
      link.dataset.originalHref ??= link.href;
    }
    const originals = links.map((link) => link.dataset.originalHref ?? link.href);
    let cancellations: Array<() => void> = [];

    const restore = () => {
      for (const [index, link] of links.entries()) {
        link.href = originals[index];
      }
    };

    const paint = () => {
      for (const cancel of cancellations) {
        cancel();
      }
      const color = badgeColor();
      if (activeCount === 0 || color == null) {
        cancellations = [];
        restore();
        return;
      }
      cancellations = links.map((link, index) =>
        drawBadgedFavicon(originals[index], color, (dataUrl) => {
          link.href = dataUrl;
        }),
      );
    };

    paint();

    /* The badge colour is a theme role, and switching theme changes it without changing the
       count. Watching the root's theme attributes repaints on every theme, custom ones
       included, without coupling this to the theme provider's shape. */
    const themeObserver = new MutationObserver(paint);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });

    return () => {
      themeObserver.disconnect();
      for (const cancel of cancellations) {
        cancel();
      }
      /* Signing out unmounts the host, and a badged data URL left behind would show the
         previous account's unread count on the login page. */
      restore();
    };
  }, [activeCount]);
}
