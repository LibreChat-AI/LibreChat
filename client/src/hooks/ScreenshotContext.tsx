import { createContext, useRef, useContext, RefObject, ReactNode } from 'react';
import { toCanvas } from 'html-to-image';
import { ThemeContext, isDark } from '@librechat/client';
import { completeProgressiveRowMounts } from '~/hooks/Messages/useProgressiveRowMount';

type ScreenshotContextType = {
  ref?: RefObject<HTMLDivElement>;
};

/** Canvas area ceiling (~16.7 MP, 4096²) — WebKit rejects larger canvases and PNG encode cost grows linearly past it */
const MAX_CAPTURE_AREA = 16_777_216;
/** Chromium/Firefox cap a canvas edge at 32767px; beyond it drawing silently produces a blank canvas */
const MAX_CANVAS_EDGE = 32_767;
/** Below half-resolution the capture is illegible, so abort rather than degrade further */
const MIN_PIXEL_RATIO = 0.5;
/** html-to-image clones every node and copies ~340 computed styles each; cap the synchronous clone work */
const MAX_CAPTURE_ELEMENTS = 50_000;

export class ScreenshotLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenshotLimitError';
  }
}

const ScreenshotContext = createContext<ScreenshotContextType>({});

export const useScreenshot = () => {
  const { ref } = useContext(ScreenshotContext);
  const { theme } = useContext(ThemeContext);

  const takeScreenShot = async (node?: HTMLElement): Promise<Blob> => {
    if (!node) {
      throw new Error('You should provide correct html node.');
    }

    const width = node.scrollWidth;
    const height = node.scrollHeight;
    if (!width || !height) {
      throw new Error('Cannot capture an empty node.');
    }

    const elementCount = node.querySelectorAll('*').length;
    if (elementCount > MAX_CAPTURE_ELEMENTS) {
      throw new ScreenshotLimitError(
        `Screenshot capture aborted: ${elementCount} elements exceed the ${MAX_CAPTURE_ELEMENTS} limit`,
      );
    }

    const pixelRatio = Math.min(
      window.devicePixelRatio || 1,
      Math.sqrt(MAX_CAPTURE_AREA / (width * height)),
      MAX_CANVAS_EDGE / Math.max(width, height),
    );
    if (pixelRatio < MIN_PIXEL_RATIO) {
      throw new ScreenshotLimitError(
        `Screenshot capture aborted: ${width}x${height} CSS px cannot fit within ${MAX_CAPTURE_AREA} device px`,
      );
    }

    /** Read the canvas the app is actually painting rather than a fixed pair, so
     *  an export matches the selected appearance and the state colours keep the
     *  contrast they were calibrated against. The token is a channel triplet,
     *  not a colour, so it has to be wrapped before html-to-image sees it. */
    const canvasTriplet = getComputedStyle(document.documentElement)
      .getPropertyValue('--surface-primary')
      .trim();
    const fallbackBackground = isDark(theme) ? '#171717' : 'white';
    const backgroundColor = canvasTriplet ? `rgb(${canvasTriplet})` : fallbackBackground;
    const canvas = await toCanvas(node, {
      backgroundColor,
      pixelRatio,
      imagePlaceholder:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    });

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      throw new Error('Failed to encode screenshot canvas.');
    }
    return blob;
  };

  const captureScreenshot = async (): Promise<Blob> => {
    if (ref instanceof Function) {
      throw new Error('Ref callback is not supported.');
    }
    /** A capture taken while a long thread is still progressively mounting
     *  would clone a truncated DOM; force the remaining rows in first. */
    await completeProgressiveRowMounts();
    if (ref?.current) {
      return takeScreenShot(ref.current);
    }
    throw new Error('Ref is not attached to any element.');
  };

  return { screenshotTargetRef: ref, captureScreenshot };
};

export const ScreenshotProvider = ({ children }: { children: ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null);

  return <ScreenshotContext.Provider value={{ ref }}>{children}</ScreenshotContext.Provider>;
};
