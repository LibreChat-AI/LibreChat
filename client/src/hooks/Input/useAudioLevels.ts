import { useRef, useState, useEffect } from 'react';

/** Bars kept on screen; the newest sample is appended and the oldest drops.
 *  Sized for a waveform spanning the composer rather than a small pill. */
const BAR_COUNT = 96;
/** Sampling cadence. Fast enough to feel live, slow enough not to thrash. */
const SAMPLE_MS = 55;

const SILENT: number[] = new Array(BAR_COUNT).fill(0);

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
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);

      timer = setInterval(() => {
        analyser.getByteTimeDomainData(buffer);
        /* RMS around the 128 midpoint, scaled so ordinary speech lands near the
           top of the range without clipping every bar to full height. */
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          const deviation = (buffer[i] - 128) / 128;
          sum += deviation * deviation;
        }
        const rms = Math.sqrt(sum / buffer.length);
        const level = Math.min(1, rms * 3.2);
        levelsRef.current = [...levelsRef.current.slice(1), level];
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
