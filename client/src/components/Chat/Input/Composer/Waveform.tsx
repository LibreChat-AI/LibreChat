import { memo, useRef, useEffect } from 'react';
import useReducedMotion from '~/hooks/Generic/useReducedMotion';
import useElementSize from '~/hooks/Generic/useElementSize';
import useAudioLevels from '~/hooks/Input/useAudioLevels';
import { cn } from '~/utils';

/** One loudness sample per this many ms; each becomes a bar. */
const SAMPLE_MS = 55;
const BAR_WIDTH = 3;
/** One bar and the gap after it, in px. */
const BAR_PITCH = 5;
/** Silence still reads as a live line rather than as nothing. */
const MIN_BAR_PX = 3;
/** A frame this late (a backgrounded tab) restarts the clock instead of
 *  replaying every missed sample at once. */
const MAX_CATCH_UP_MS = 500;

interface WaveformProps {
  /** Whether the microphone is running; the levels are sampled from here. */
  active: boolean;
  className?: string;
}

/**
 * Live microphone trace. Drawn on a canvas from an animation-frame loop, so
 * the bars glide left continuously between samples instead of stepping once
 * per sample, and nothing re-renders while it runs: the whole trace lives in
 * this effect. Newest on the right, as many bars as the width holds. Reduced
 * motion keeps the step.
 *
 * The bar color is the element's own `text-text-primary`, read from the
 * canvas every frame, so it follows the theme like any other text.
 */
function Waveform({ active, className }: WaveformProps) {
  const read = useAudioLevels(active);
  const reducedMotion = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { ref, width, height } = useElementSize<HTMLDivElement>();

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!active || canvas == null || context == null || width === 0 || height === 0) {
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    /* Live: read per frame so a theme switch mid-dictation recolors the bars. */
    const style = getComputedStyle(canvas);

    const capacity = Math.ceil(width / BAR_PITCH) + 2;
    const levels: number[] = new Array(capacity).fill(0);
    let sampledAt = performance.now();
    let frame = 0;

    const draw = (now: number) => {
      if (now - sampledAt > MAX_CATCH_UP_MS) {
        sampledAt = now;
      }
      while (now - sampledAt >= SAMPLE_MS) {
        sampledAt += SAMPLE_MS;
        levels.push(read() ?? 0);
        levels.shift();
      }
      /* How far the newest bar has slid in since it was sampled. */
      const progress = reducedMotion ? 1 : (now - sampledAt) / SAMPLE_MS;

      context.clearRect(0, 0, width, height);
      context.fillStyle = style.color;
      context.beginPath();
      for (let age = 0; age < capacity; age++) {
        const x = width - BAR_WIDTH - (age - 1 + progress) * BAR_PITCH;
        if (x > width) {
          continue;
        }
        if (x < -BAR_WIDTH) {
          break;
        }
        const barHeight = Math.max(MIN_BAR_PX, levels[capacity - 1 - age] * height);
        context.roundRect(x, (height - barHeight) / 2, BAR_WIDTH, barHeight, BAR_WIDTH / 2);
      }
      context.fill();
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      context.clearRect(0, 0, width, height);
    };
  }, [active, width, height, read, reducedMotion]);

  return (
    <div ref={ref} aria-hidden="true" className={cn('overflow-hidden', className)}>
      <canvas ref={canvasRef} className="text-text-primary block h-full w-full" />
    </div>
  );
}

export default memo(Waveform);
