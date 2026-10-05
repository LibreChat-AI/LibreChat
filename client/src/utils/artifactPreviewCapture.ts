import {
  ARTIFACT_PREVIEW_MAX_URL_LENGTH,
  isAllowedArtifactPreviewUrl,
} from 'librechat-data-provider';
import type { ArtifactPreview } from 'librechat-data-provider';

const PREVIEW_REQUEST = 'librechat:artifact-preview:request';
const PREVIEW_RESPONSE = 'librechat:artifact-preview:response';
const PREVIEW_WIDTHS = [480, 400, 320, 240] as const;
const TRANSPARENT_COLORS = new Set(['transparent', 'rgba(0, 0, 0, 0)', 'rgba(0,0,0,0)']);
export const ARTIFACT_PREVIEW_MAX_SNAPSHOT_LENGTH = ARTIFACT_PREVIEW_MAX_URL_LENGTH * 4;
const ARTIFACT_PREVIEW_FREEZE_CSS = `
  *, *::before, *::after {
    animation-delay: -100000s !important;
    animation-duration: 0s !important;
    animation-fill-mode: both !important;
    animation-iteration-count: 1 !important;
    animation-play-state: paused !important;
    caret-color: transparent !important;
    transition: none !important;
  }
`;

interface ArtifactPreviewSnapshot {
  serialized: string;
  backgroundColor: string;
}

interface ArtifactPreviewDrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function sanitizeArtifactPreviewCss(value: string): string {
  return value
    .replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, 'none')
    .replace(/@import\s+[^;]+;/gi, '');
}

export function getArtifactPreviewDrawRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): ArtifactPreviewDrawRect {
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: 0,
    y: 0,
    width,
    height,
  };
}

function encodePreviewCanvas(source: HTMLCanvasElement, backgroundColor: string): string | null {
  for (const width of PREVIEW_WIDTHS) {
    const height = Math.round((width * 2) / 3);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }

    context.fillStyle = TRANSPARENT_COLORS.has(backgroundColor) ? '#ffffff' : backgroundColor;
    context.fillRect(0, 0, width, height);
    const drawRect = getArtifactPreviewDrawRect(source.width, source.height, width, height);
    context.drawImage(source, drawRect.x, drawRect.y, drawRect.width, drawRect.height);

    for (const [mimeType, quality] of [
      ['image/webp', 0.7],
      ['image/jpeg', 0.68],
    ] as const) {
      const imageUrl = canvas.toDataURL(mimeType, quality);
      if (
        imageUrl.length <= ARTIFACT_PREVIEW_MAX_URL_LENGTH &&
        isAllowedArtifactPreviewUrl(imageUrl)
      ) {
        return imageUrl;
      }
    }
  }
  return null;
}

function loadPreviewImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (result: HTMLImageElement | null) => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener('abort', handleAbort);
      resolve(result);
    };
    const handleAbort = () => finish(null);
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    signal?.addEventListener('abort', handleAbort, { once: true });
    image.src = url;
  });
}

export function toArtifactPreviewSvgDataUrl(
  snapshot: ArtifactPreviewSnapshot,
  width: number,
  height: number,
): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="100%" height="100%" x="0" y="0">${snapshot.serialized}</foreignObject></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function isBoundedArtifactPreviewSnapshot(
  snapshot: Partial<ArtifactPreviewSnapshot> | undefined,
): snapshot is ArtifactPreviewSnapshot {
  return (
    typeof snapshot?.serialized === 'string' &&
    snapshot.serialized.length > 0 &&
    snapshot.serialized.length <= ARTIFACT_PREVIEW_MAX_SNAPSHOT_LENGTH &&
    typeof snapshot.backgroundColor === 'string'
  );
}

async function rasterizeArtifactPreviewSnapshot(
  snapshot: ArtifactPreviewSnapshot,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (
    signal?.aborted ||
    !width ||
    !height ||
    snapshot.serialized.length > ARTIFACT_PREVIEW_MAX_SNAPSHOT_LENGTH
  ) {
    return null;
  }
  const image = await loadPreviewImage(
    toArtifactPreviewSvgDataUrl(snapshot, width, height),
    signal,
  );
  if (!image || signal?.aborted) {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  context.drawImage(image, 0, 0, width, height);
  return encodePreviewCanvas(canvas, snapshot.backgroundColor);
}

/** Runs inside the sandboxed artifact frame and returns a sanitized DOM snapshot to its parent. */
function installArtifactPreviewBridge(
  sanitizeCss: (value: string) => string,
  freezeCss: string,
  maxSnapshotLength: number,
  maxCanvasUrlLength: number,
) {
  const requestType = 'librechat:artifact-preview:request';
  const responseType = 'librechat:artifact-preview:response';
  const bridgeWindow = window as Window & { __libreChatArtifactPreviewBridge?: boolean };
  if (bridgeWindow.__libreChatArtifactPreviewBridge) {
    return;
  }
  bridgeWindow.__libreChatArtifactPreviewBridge = true;
  const pendingRequests = new Set<string>();

  const waitForSettledDom = () =>
    new Promise<void>((resolve) => {
      let idleTimer = 0;
      let maximumTimer = 0;
      const observer = new MutationObserver(() => {
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(done, 350);
      });
      const done = () => {
        window.clearTimeout(idleTimer);
        window.clearTimeout(maximumTimer);
        observer.disconnect();
        resolve();
      };
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      idleTimer = window.setTimeout(done, 350);
      maximumTimer = window.setTimeout(done, 2_500);
    });

  const capture = async (): Promise<ArtifactPreviewSnapshot> => {
    await waitForSettledDom();
    const width = Math.max(document.documentElement.clientWidth, window.innerWidth, 1);
    const height = Math.max(document.documentElement.clientHeight, window.innerHeight, 1);
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    clone.style.width = `${width}px`;
    clone.style.height = `${height}px`;
    clone.style.overflow = 'hidden';
    clone
      .querySelectorAll('script, iframe, video, audio, link, object, embed, source')
      .forEach((node) => node.remove());
    clone.querySelectorAll('img').forEach((image) => {
      if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(image.getAttribute('src') ?? '')) {
        image.remove();
      }
    });
    clone.querySelectorAll<HTMLElement>('[srcset], [poster]').forEach((element) => {
      element.removeAttribute('srcset');
      element.removeAttribute('poster');
    });
    clone.querySelectorAll<HTMLElement>('[href], [xlink\\:href]').forEach((element) => {
      for (const attribute of ['href', 'xlink:href']) {
        const value = element.getAttribute(attribute);
        if (value && !value.startsWith('#')) {
          element.removeAttribute(attribute);
        }
      }
    });
    clone.querySelectorAll('style').forEach((style) => {
      style.textContent = sanitizeCss(style.textContent ?? '');
    });
    clone.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
      const style = element.getAttribute('style');
      if (style) {
        element.setAttribute('style', sanitizeCss(style));
      }
    });
    const freezeStyle = document.createElement('style');
    freezeStyle.textContent = freezeCss;
    const cloneHead = clone.querySelector('head');
    if (cloneHead) {
      cloneHead.appendChild(freezeStyle);
    } else {
      clone.prepend(freezeStyle);
    }
    const sourceCanvases = document.documentElement.querySelectorAll('canvas');
    clone.querySelectorAll('canvas').forEach((canvas, index) => {
      try {
        const imageUrl = sourceCanvases[index]?.toDataURL('image/png') ?? '';
        if (!imageUrl || imageUrl.length > maxCanvasUrlLength) {
          canvas.remove();
          return;
        }
        const image = document.createElement('img');
        image.src = imageUrl;
        image.alt = '';
        image.width = canvas.width;
        image.height = canvas.height;
        canvas.replaceWith(image);
      } catch {
        canvas.remove();
      }
    });

    const serialized = new XMLSerializer().serializeToString(clone);
    if (serialized.length > maxSnapshotLength) {
      throw new Error('snapshot_too_large');
    }
    const computedBackground = getComputedStyle(document.body).backgroundColor;
    const backgroundColor =
      !computedBackground ||
      computedBackground === 'transparent' ||
      computedBackground === 'rgba(0, 0, 0, 0)'
        ? '#ffffff'
        : computedBackground;
    return { serialized, backgroundColor };
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.type !== requestType) {
      return;
    }
    const requestId = event.data.requestId;
    if (typeof requestId !== 'string' || pendingRequests.has(requestId)) {
      return;
    }
    pendingRequests.add(requestId);
    void capture()
      .then((snapshot) => {
        window.parent.postMessage({ type: responseType, requestId, snapshot }, '*');
      })
      .catch((error: Error) => {
        window.parent.postMessage(
          {
            type: responseType,
            requestId,
            failure: `${error.name || 'capture_failed'}: ${error.message || 'Unknown error'}`,
          },
          '*',
        );
      })
      .finally(() => {
        pendingRequests.delete(requestId);
      });
  });
}

export const ARTIFACT_PREVIEW_BRIDGE_SCRIPT = `;(${installArtifactPreviewBridge.toString()})(${sanitizeArtifactPreviewCss.toString()},${JSON.stringify(ARTIFACT_PREVIEW_FREEZE_CSS)},${ARTIFACT_PREVIEW_MAX_SNAPSHOT_LENGTH},${ARTIFACT_PREVIEW_MAX_URL_LENGTH});`;

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function requestArtifactPreviewFromFrame(
  frame: HTMLIFrameElement,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const frameWindow = frame.contentWindow;
  if (!frameWindow || signal?.aborted) {
    return Promise.resolve(null);
  }
  const requestId = createRequestId();

  return new Promise((resolve) => {
    let retryTimer = 0;
    let timeoutTimer = 0;
    const cleanup = () => {
      window.clearInterval(retryTimer);
      window.clearTimeout(timeoutTimer);
      window.removeEventListener('message', handleMessage);
      signal?.removeEventListener('abort', handleAbort);
    };
    const finish = (imageUrl: string | null) => {
      cleanup();
      resolve(imageUrl);
    };
    const handleAbort = () => finish(null);
    const handleMessage = (event: MessageEvent) => {
      if (
        event.source !== frameWindow ||
        event.data?.type !== PREVIEW_RESPONSE ||
        event.data?.requestId !== requestId
      ) {
        return;
      }
      if (typeof event.data.failure === 'string') {
        console.warn(`[ArtifactPreview] Capture failed: ${event.data.failure}`);
        finish(null);
        return;
      }
      const imageUrl = event.data.imageUrl;
      if (typeof imageUrl === 'string') {
        finish(isAllowedArtifactPreviewUrl(imageUrl) ? imageUrl : null);
        return;
      }
      const snapshot = event.data.snapshot as Partial<ArtifactPreviewSnapshot> | undefined;
      if (!isBoundedArtifactPreviewSnapshot(snapshot)) {
        console.warn('[ArtifactPreview] Capture bridge returned an invalid snapshot');
        finish(null);
        return;
      }
      cleanup();
      void rasterizeArtifactPreviewSnapshot(
        {
          serialized: snapshot.serialized,
          backgroundColor: snapshot.backgroundColor,
        },
        Math.max(frame.clientWidth, 1),
        Math.max(frame.clientHeight, 1),
        signal,
      )
        .then(resolve)
        .catch((error: Error) => {
          console.warn(`[ArtifactPreview] Rasterization failed: ${error.name}`);
          resolve(null);
        });
    };
    const request = () => frameWindow.postMessage({ type: PREVIEW_REQUEST, requestId }, '*');

    window.addEventListener('message', handleMessage);
    signal?.addEventListener('abort', handleAbort, { once: true });
    retryTimer = window.setInterval(request, 300);
    timeoutTimer = window.setTimeout(() => {
      console.warn('[ArtifactPreview] Capture bridge timed out');
      finish(null);
    }, timeoutMs);
    request();
  });
}

export async function captureArtifactPreview(
  element: HTMLElement,
  mode: 'element' | 'frame',
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) {
    return null;
  }
  if (mode === 'frame') {
    const deadline = Date.now() + timeoutMs;
    while (!signal?.aborted && Date.now() < deadline) {
      const frame = element.querySelector('iframe');
      if (frame) {
        return requestArtifactPreviewFromFrame(frame, Math.max(deadline - Date.now(), 1), signal);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return null;
  }

  try {
    const { toCanvas } = await import('html-to-image');
    const canvas = await toCanvas(element, {
      pixelRatio: 1,
      skipFonts: true,
      imagePlaceholder:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      filter: (node) => {
        if (node.tagName !== 'IMG') {
          return true;
        }
        return isAllowedArtifactPreviewUrl(node.getAttribute('src') ?? '');
      },
    });
    if (signal?.aborted || !canvas.width || !canvas.height) {
      return null;
    }
    const backgroundColor = getComputedStyle(element).backgroundColor || '#ffffff';
    return encodePreviewCanvas(canvas, backgroundColor);
  } catch {
    return null;
  }
}

export function toArtifactPreview(imageUrl: string, alt?: string): ArtifactPreview | undefined {
  if (!isAllowedArtifactPreviewUrl(imageUrl)) {
    return undefined;
  }
  return { type: 'image', imageUrl, ...(alt ? { alt } : {}) };
}
