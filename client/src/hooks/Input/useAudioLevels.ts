import { useRef, useState, useEffect } from 'react';

/** Samples kept; enough to fill the widest composer at the waveform's pitch. */
const BAR_COUNT = 240;
/** Sampling cadence. Fast enough to feel live, slow enough not to thrash. */
const SAMPLE_MS = 55;
/** Loudness that draws an empty bar, and loudness that draws a full one. Room
 *  noise sits near the floor and ordinary speech lands mid-range, which a
 *  linear scale could not do: speech is a few percent of full scale. */
const FLOOR_DB = -55;
const CEILING_DB = -12;

const SILENT: number[] = new Array(BAR_COUNT).fill(0);

/**
 * Loudness of one time-domain frame on a 0-1 scale. RMS around the 128
 * midpoint, then decibels, because hearing is logarithmic and a linear mapping
 * left speech drawn as a row of dots.
 */
export function frameLevel(buffer: Uint8Array): number {
  if (buffer.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const deviation = (buffer[i] - 128) / 128;
    sum += deviation * deviation;
  }
  const rms = Math.sqrt(sum / buffer.length);
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)));
}

/**
 * Rolling loudness history of the microphone, for drawing a live waveform.
 *
 * Deliberately opens its own stream rather than reaching into the speech hooks:
 * the browser and external transcription paths are completely different (the
 * Web Speech API never exposes audio at all), and a visualiser has no business
 * interfering with either. The stream is torn down the moment `active` goes
 * false, so the recording indicator does not linger.
 */
export default function useAudioLevels(active: boolean): number[] {
  const [levels, setLevels] = useState<number[]>(SILENT);
  const levelsRef = useRef<number[]>(SILENT);

  useEffect(() => {
    if (!active) {
      levelsRef.current = SILENT;
      setLevels(SILENT);
      return;
    }

    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        /* Permission denied or no device: the bar still works, just flat. */
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      context = new AudioContext();
      /* Created after the permission prompt resolved, which is outside the click
         that started recording, so the browser may hand it over suspended; a
         suspended graph reads as silence forever. */
      if (context.state === 'suspended') {
        void context.resume();
      }
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.fftSize);

      timer = setInterval(() => {
        analyser.getByteTimeDomainData(buffer);
        levelsRef.current = [...levelsRef.current.slice(1), frameLevel(buffer)];
        setLevels(levelsRef.current);
      }, SAMPLE_MS);
    };

    void start();

    return () => {
      cancelled = true;
      if (timer != null) {
        clearInterval(timer);
      }
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
    };
  }, [active]);

  return levels;
}

export { BAR_COUNT };
