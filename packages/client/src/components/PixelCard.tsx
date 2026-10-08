import { useEffect, useRef, useCallback } from 'react';
import { JSX } from 'react/jsx-runtime';
import { cn } from '~/utils';

/** Last fillStyle written during the current frame. Reset at the start of each frame so a
 *  pixel only touches canvas state when its color differs from the previous draw. */
let lastFillStyle = '';

class Pixel {
  width: number;
  height: number;
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  color: string;
  speed: number;
  size: number;
  sizeStep: number;
  minSize: number;
  maxSizeInteger: number;
  maxSize: number;
  delay: number;
  counter: number;
  counterStep: number;
  isIdle: boolean;
  isReverse: boolean;
  isShimmer: boolean;
  activationThreshold: number;

  constructor(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    color: string,
    speed: number,
    delay: number,
    activationThreshold: number,
  ) {
    this.width = canvas.width;
    this.height = canvas.height;
    this.ctx = context;
    this.x = x;
    this.y = y;
    this.color = color;
    this.speed = this.random(0.1, 0.9) * speed;
    this.size = 0;
    this.sizeStep = Math.random() * 0.4;
    this.minSize = 0.5;
    this.maxSizeInteger = 2;
    this.maxSize = this.random(this.minSize, this.maxSizeInteger);
    this.delay = delay;
    this.counter = 0;
    this.counterStep = Math.random() * 4 + (this.width + this.height) * 0.01;
    this.isIdle = false;
    this.isReverse = false;
    this.isShimmer = false;
    this.activationThreshold = activationThreshold;
  }

  private random(min: number, max: number) {
    return Math.random() * (max - min) + min;
  }

  private draw() {
    const offset = this.maxSizeInteger * 0.5 - this.size * 0.5;
    if (lastFillStyle !== this.color) {
      this.ctx.fillStyle = this.color;
      lastFillStyle = this.color;
    }
    this.ctx.fillRect(this.x + offset, this.y + offset, this.size, this.size);
  }

  appear() {
    this.isIdle = false;
    if (this.counter <= this.delay) {
      this.counter += this.counterStep;
      return;
    }
    if (this.size >= this.maxSize) {
      this.isShimmer = true;
    }
    if (this.isShimmer) {
      this.shimmer();
    } else {
      this.size += this.sizeStep;
    }
    this.draw();
  }

  appearWithProgress(progress: number) {
    const diff = progress - this.activationThreshold;
    if (diff <= 0) {
      this.isIdle = true;
      return;
    }
    if (this.counter <= this.delay) {
      this.counter += this.counterStep;
      this.isIdle = false;
      return;
    }
    if (this.size >= this.maxSize) {
      this.isShimmer = true;
    }
    if (this.isShimmer) {
      this.shimmer();
    } else {
      this.size += this.sizeStep;
    }
    this.isIdle = false;
    this.draw();
  }

  disappear() {
    this.isShimmer = false;
    this.counter = 0;
    if (this.size <= 0) {
      this.isIdle = true;
      return;
    }
    this.size -= 0.1;
    this.draw();
  }

  private shimmer() {
    if (this.size >= this.maxSize) {
      this.isReverse = true;
    } else if (this.size <= this.minSize) {
      this.isReverse = false;
    }
    this.size += this.isReverse ? -this.speed : this.speed;
  }
}

const getEffectiveSpeed = (value: number, reducedMotion: boolean) => {
  const parsed = parseInt(String(value), 10);
  const throttle = 0.001;
  if (parsed <= 0 || reducedMotion) {
    return 0;
  }
  if (parsed >= 100) {
    return 100 * throttle;
  }
  return parsed * throttle;
};

const clamp = (n: number, min = 0, max = 1) => Math.min(Math.max(n, min), max);

/** The default palette names theme channel variables, read off the card when the pixels are
 *  laid out, so the canvas draws the active theme instead of a fixed light palette. */
const VARIANTS = {
  default: {
    gap: 5,
    speed: 35,
    colors: '--surface-primary-alt,--surface-tertiary,--border-medium',
    noFocus: false,
  },
  /** Decorative presets no theme role reproduces; kept as given, like a `colors` prop. */
  blue: { gap: 10, speed: 25, colors: '#e0f2fe,#7dd3fc,#0ea5e9', noFocus: false },
  yellow: { gap: 3, speed: 20, colors: '#fef08a,#fde047,#eab308', noFocus: false },
  pink: { gap: 6, speed: 80, colors: '#fecdd3,#fda4af,#e11d48', noFocus: true },
} as const;

/** Resolves `--token` entries to the element's channel triplet; any other entry is a CSS color
 *  the caller supplied and passes through. A token the page does not define falls back to the
 *  canvas ink rather than drawing nothing. */
const resolvePalette = (palette: string, element: Element): string[] => {
  const style = getComputedStyle(element);
  return palette.split(',').map((entry) => {
    const color = entry.trim();
    if (!color.startsWith('--')) {
      return color;
    }
    const channels = style.getPropertyValue(color).trim();
    return channels ? `rgb(${channels})` : 'currentColor';
  });
};

interface PixelCardProps {
  variant?: keyof typeof VARIANTS;
  gap?: number;
  speed?: number;
  colors?: string;
  noFocus?: boolean;
  className?: string;
  progress?: number;
  randomness?: number;
  width?: string;
  height?: string;
}

export default function PixelCard({
  variant = 'default',
  gap,
  speed,
  colors,
  noFocus,
  className = '',
  progress,
  randomness = 0.3,
  width,
  height,
}: PixelCardProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pixelsRef = useRef<Pixel[]>([]);
  const animationRef = useRef<number | undefined>(undefined);
  const timePrevRef = useRef(performance.now());
  const progressRef = useRef<number | undefined>(progress);
  const reducedMotion = useRef(
    window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  ).current;

  const cfg = VARIANTS[variant];
  const g = gap ?? cfg.gap;
  const s = speed ?? cfg.speed;
  const palette = colors ?? cfg.colors;
  const disableFocus = noFocus ?? cfg.noFocus;

  const updateCanvasOpacity = useCallback(() => {
    if (!canvasRef.current) {
      return;
    }
    if (progressRef.current === undefined) {
      canvasRef.current.style.opacity = '1';
      return;
    }
    const fadeStart = 0.9;
    const alpha =
      progressRef.current >= fadeStart ? 1 - (progressRef.current - fadeStart) / 0.1 : 1;
    canvasRef.current.style.opacity = String(clamp(alpha));
  }, []);

  const animate = useCallback(
    (method: keyof Pixel) => {
      animationRef.current = requestAnimationFrame(() => animate(method));

      const now = performance.now();
      const elapsed = now - timePrevRef.current;
      if (elapsed < 1000 / 60) {
        return;
      }
      timePrevRef.current = now - (elapsed % (1000 / 60));

      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx || !canvasRef.current) {
        return;
      }

      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

      lastFillStyle = '';
      let idle = true;
      const pixels = pixelsRef.current;
      if (method === 'appearWithProgress') {
        const currentProgress = progressRef.current;
        for (const p of pixels) {
          if (currentProgress !== undefined) {
            p.appearWithProgress(currentProgress);
          } else {
            p.isIdle = true;
          }
          if (!p.isIdle) {
            idle = false;
          }
        }
      } else {
        for (const p of pixels) {
          // @ts-ignore dynamic dispatch
          p[method]();
          if (!p.isIdle) {
            idle = false;
          }
        }
      }

      updateCanvasOpacity();
      if (idle) {
        cancelAnimationFrame(animationRef.current!);
      }
    },
    [updateCanvasOpacity],
  );

  const startAnim = useCallback(
    (m: keyof Pixel) => {
      cancelAnimationFrame(animationRef.current!);
      animationRef.current = requestAnimationFrame(() => animate(m));
    },
    [animate],
  );

  const initPixels = useCallback(() => {
    if (!containerRef.current || !canvasRef.current) {
      return;
    }

    const { width: cw, height: ch } = containerRef.current.getBoundingClientRect();
    const ctx = canvasRef.current.getContext('2d');
    canvasRef.current.width = Math.floor(cw);
    canvasRef.current.height = Math.floor(ch);

    const cols = resolvePalette(palette, containerRef.current);
    const px: Pixel[] = [];

    const cx = cw / 2;
    const cy = ch / 2;
    const maxDist = Math.hypot(cx, cy);
    const effectiveSpeed = getEffectiveSpeed(s, reducedMotion);

    for (let x = 0; x < cw; x += g) {
      for (let y = 0; y < ch; y += g) {
        const color = cols[Math.floor(Math.random() * cols.length)];
        const distNorm = Math.hypot(x - cx, y - cy) / maxDist;
        const threshold = clamp(distNorm * (1 - randomness) + Math.random() * randomness);
        const delay = reducedMotion ? 0 : distNorm * maxDist;
        if (!ctx) {
          continue;
        }
        px.push(new Pixel(canvasRef.current, ctx, x, y, color, effectiveSpeed, delay, threshold));
      }
    }
    pixelsRef.current = px;

    if (progressRef.current !== undefined) {
      startAnim('appearWithProgress');
    }
  }, [g, palette, s, randomness, reducedMotion, startAnim]);

  useEffect(() => {
    progressRef.current = progress;
    if (progress !== undefined) {
      startAnim('appearWithProgress');
    }
  }, [progress, startAnim]);

  useEffect(() => {
    if (progress === undefined) {
      cancelAnimationFrame(animationRef.current!);
    }
  }, [progress]);

  useEffect(() => {
    initPixels();
    const obs = new ResizeObserver(initPixels);
    if (containerRef.current) {
      obs.observe(containerRef.current);
    }
    /** A mode switch or an applied theme rewrites the root's class or inline variables, which
     *  the resolved palette has already been read from. The root's inline style also carries
     *  unrelated variables (scrollbar gutter, font size), so the pixels are laid out again only
     *  when the palette itself resolves differently. */
    let resolved = containerRef.current
      ? resolvePalette(palette, containerRef.current).join(',')
      : '';
    const themeObs = new MutationObserver(() => {
      if (!containerRef.current) {
        return;
      }
      const next = resolvePalette(palette, containerRef.current).join(',');
      if (next === resolved) {
        return;
      }
      resolved = next;
      initPixels();
    });
    themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    return () => {
      obs.disconnect();
      themeObs.disconnect();
      cancelAnimationFrame(animationRef.current!);
    };
  }, [initPixels, palette]);

  const hoverIn = () => progressRef.current === undefined && startAnim('appear');
  const hoverOut = () => progressRef.current === undefined && startAnim('disappear');
  const focusIn: React.FocusEventHandler<HTMLDivElement> = (e) => {
    if (
      !disableFocus &&
      !e.currentTarget.contains(e.relatedTarget) &&
      progressRef.current === undefined
    ) {
      startAnim('appear');
    }
  };
  const focusOut: React.FocusEventHandler<HTMLDivElement> = (e) => {
    if (
      !disableFocus &&
      !e.currentTarget.contains(e.relatedTarget) &&
      progressRef.current === undefined
    ) {
      startAnim('disappear');
    }
  };

  return (
    <div
      ref={containerRef}
      style={{
        width: width || '100%',
        height: height || '100%',
      }}
    >
      <div
        className={cn(
          'border-border-light relative isolate grid place-items-center overflow-hidden rounded-lg border shadow-md transition-colors duration-200 ease-in-out select-none',
          className,
        )}
        style={{
          width: '100%',
          height: '100%',
          transitionTimingFunction: 'cubic-bezier(0.5, 1, 0.89, 1)',
        }}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
        onFocus={disableFocus ? undefined : focusIn}
        onBlur={disableFocus ? undefined : focusOut}
        tabIndex={disableFocus ? -1 : 0}
      >
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 block"
          width={width && width !== 'auto' ? parseInt(String(width)) : undefined}
          height={height && height !== 'auto' ? parseInt(String(height)) : undefined}
        />
      </div>
    </div>
  );
}
