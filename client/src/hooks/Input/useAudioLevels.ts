import { useRef, useEffect, useCallback } from 'react';

/** Loudness that draws an empty bar, and loudness that draws a full one. Room
 *  noise sits near the floor and ordinary speech lands mid-range, which a
 *  linear scale could not do: speech is a few percent of full scale. */
const FLOOR_DB = -55;
const CEILING_DB = -12;

/**
 * The visualiser's microphone is left unprocessed. Automatic gain starts low
 * and ramps over the first seconds, which drew the opening words as a flat
 * line, and noise suppression holds back speech while it learns the room. The
 * recording sent for transcription opens its own stream with its own settings.
 */
const RAW_AUDIO: MediaTrackConstraints = {
  autoGainControl: false,
  noiseSuppression: false,
  echoCancellation: false,
};

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

interface Tap {
  analyser: AnalyserNode;
  buffer: Uint8Array<ArrayBuffer>;
}

/**
 * The microphone's current loudness, read on demand. Returns a reader rather
 * than a stream of values so the caller samples on its own animation frame and
 * nothing re-renders per sample; the reader answers `null` until the
 * microphone is open.
 *
 * Deliberately opens its own stream rather than reaching into the speech hooks:
 * the browser and external transcription paths are completely different (the
 * Web Speech API never exposes audio at all), and a visualiser has no business
 * interfering with either. The stream is torn down the moment `active` goes
 * false, so the recording indicator does not linger.
 */
export default function useAudioLevels(active: boolean): () => number | null {
  const tapRef = useRef<Tap | null>(null);

  useEffect(() => {
    if (!active) {
      return;
    }

    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let cancelled = false;

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO });
      } catch {
        /* Permission denied or no device: the trace still draws, just flat. */
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
      tapRef.current = { analyser, buffer: new Uint8Array(analyser.fftSize) };
    };

    void start();

    return () => {
      cancelled = true;
      tapRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
    };
  }, [active]);

  return useCallback(() => {
    const tap = tapRef.current;
    if (tap == null) {
      return null;
    }
    tap.analyser.getByteTimeDomainData(tap.buffer);
    return frameLevel(tap.buffer);
  }, []);
}
