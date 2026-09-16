import { memo } from 'react';
import useAudioLevels from '~/hooks/Input/useAudioLevels';
import { cn } from '~/utils';

/** Bars never collapse to nothing, so silence still reads as a live line. */
const MIN_BAR = 0.1;

interface WaveformProps {
  /** Whether the microphone is running; the levels are sampled from here. */
  active: boolean;
  className?: string;
}

/**
 * Live microphone trace. Spreads a fixed bar count across whatever width it is
 * given, so it fills its container rather than overflowing and being clipped.
 *
 * Samples the microphone itself rather than being handed the levels: at ~18
 * samples a second, holding them any higher up re-rendered the whole composer,
 * and every tool and skill row with it, to move these bars.
 */
function Waveform({ active, className }: WaveformProps) {
  const levels = useAudioLevels(active);
  return (
    <div
      aria-hidden="true"
      className={cn('flex w-full items-center justify-between overflow-hidden', className)}
    >
      {levels.map((level, index) => (
        <span
          key={index}
          style={{ height: `${Math.max(MIN_BAR, level) * 100}%` }}
          className="w-[3px] shrink-0 rounded-full bg-text-primary opacity-70 transition-[height] duration-100 ease-out motion-reduce:transition-none"
        />
      ))}
    </div>
  );
}

export default memo(Waveform);
