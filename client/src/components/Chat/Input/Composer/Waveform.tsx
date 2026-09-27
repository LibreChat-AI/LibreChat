import { memo } from 'react';
import useElementSize from '~/hooks/Generic/useElementSize';
import useAudioLevels from '~/hooks/Input/useAudioLevels';
import { cn } from '~/utils';

/** Bars never collapse to nothing, so silence still reads as a live line. */
const MIN_BAR = 0.12;
/** One bar and the gap after it, in px; matches `w-0.75` and `gap-0.5`. */
const BAR_PITCH = 5;

interface WaveformProps {
  /** Whether the microphone is running; the levels are sampled from here. */
  active: boolean;
  className?: string;
}

/**
 * Live microphone trace. Draws as many bars as its width holds at a fixed
 * pitch, newest on the right, so it fills its box exactly on any composer
 * width instead of spreading a fixed count and running past the edge.
 *
 * Samples the microphone itself rather than being handed the levels: at ~18
 * samples a second, holding them any higher up re-rendered the whole composer,
 * and every tool and skill row with it, to move these bars.
 */
function Waveform({ active, className }: WaveformProps) {
  const levels = useAudioLevels(active);
  const { ref, width } = useElementSize<HTMLDivElement>();
  const count = Math.min(levels.length, Math.floor((width + 2) / BAR_PITCH));
  const shown = count > 0 ? levels.slice(-count) : [];

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn('flex items-center justify-end gap-0.5 overflow-hidden', className)}
    >
      {shown.map((level, index) => (
        <span
          key={index}
          style={{ height: `${Math.max(MIN_BAR, level) * 100}%` }}
          className="bg-text-primary w-0.75 shrink-0 rounded-full transition-all duration-100 ease-out motion-reduce:transition-none"
        />
      ))}
    </div>
  );
}

export default memo(Waveform);
