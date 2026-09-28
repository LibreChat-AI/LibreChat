/**
 * Replaces `Image` and `canvas.getContext('2d')` with fakes driven by a
 * per-source registry, since jsdom decodes no images. `scanMonochrome` still
 * runs against the registered bytes.
 */

export interface FakeIcon {
  width: number;
  height: number;
  /** Flat RGBA quads; omit for a transparent image. */
  pixels?: number[];
  /** Throw from `getImageData` like a tainted canvas. */
  taint?: boolean;
  error?: boolean;
  /** Never fire `onload` or `onerror`. */
  pending?: boolean;
}

const icons = new Map<string, FakeIcon>();
let lastCrossOrigin: string | null = null;
let loadCount = 0;

export function registerFakeIcon(src: string, icon: FakeIcon): void {
  icons.set(src, icon);
}

export function resetFakeIcons(): void {
  icons.clear();
  lastCrossOrigin = null;
  loadCount = 0;
}

export function getLastCrossOrigin(): string | null {
  return lastCrossOrigin;
}

export function getImageLoadCount(): number {
  return loadCount;
}

class MockImage {
  crossOrigin: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  width = 0;
  height = 0;
  private currentSrc = '';

  get src(): string {
    return this.currentSrc;
  }

  set src(value: string) {
    this.currentSrc = value;
    lastCrossOrigin = this.crossOrigin;
    loadCount += 1;
    const icon = icons.get(value);
    if (icon?.pending === true) {
      return;
    }
    Promise.resolve().then(() => {
      if (!icon || icon.error === true) {
        this.onerror?.();
        return;
      }
      this.naturalWidth = icon.width;
      this.naturalHeight = icon.height;
      this.onload?.();
    });
  }
}

class FakeContext {
  private drawn: MockImage | null = null;

  drawImage(image: MockImage): void {
    this.drawn = image;
  }

  getImageData(): ImageData {
    const icon = this.drawn ? icons.get(this.drawn.src) : undefined;
    if (icon?.taint === true) {
      throw new DOMException('tainted canvas', 'SecurityError');
    }
    if (!icon?.pixels || icon.pixels.length === 0) {
      return new ImageData(1, 1);
    }
    const data = Uint8ClampedArray.from(icon.pixels);
    return new ImageData(data, data.length / 4, 1);
  }
}

/** Call from `beforeEach`; jsdom resets globals per test file, so no teardown. */
export function installCanvasMock(): void {
  Object.defineProperty(global, 'Image', {
    value: MockImage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => new FakeContext(),
    configurable: true,
    writable: true,
  });
}
