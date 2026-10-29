/** How long the microphone has to stay below the noise floor before a take ends itself. */
export const SILENCE_THRESHOLD_MS = 3000;

/**
 * Calls `onSilence` once the stream has stayed quiet for `thresholdMs`, for the Auto
 * Transcribe setting. Returns a stop function that cancels the frame loop and closes
 * the audio context; it is safe to call more than once and is called for you before
 * `onSilence` runs. Without the close, every take leaves another audio context open
 * until the browser refuses to grant one.
 */
export function monitorSilence(
  stream: MediaStream,
  {
    minDecibels,
    onSilence,
    thresholdMs = SILENCE_THRESHOLD_MS,
  }: { minDecibels: number; onSilence: () => void; thresholdMs?: number },
): () => void {
  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.minDecibels = minDecibels;
  audioContext.createMediaStreamSource(stream).connect(analyser);

  const domainData = new Uint8Array(analyser.frequencyBinCount);
  let lastSoundTime = Date.now();
  let frameId: number | null = null;
  let stopped = false;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (audioContext.state !== 'closed') {
      void audioContext.close().catch(() => undefined);
    }
  };

  const detectSound = () => {
    frameId = null;
    analyser.getByteFrequencyData(domainData);
    if (domainData.some((value) => value > 0)) {
      lastSoundTime = Date.now();
    }
    if (Date.now() - lastSoundTime > thresholdMs) {
      stop();
      onSilence();
      return;
    }
    frameId = window.requestAnimationFrame(detectSound);
  };

  frameId = window.requestAnimationFrame(detectSound);
  return stop;
}
