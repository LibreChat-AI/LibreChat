import { useEffect, useRef } from 'react';
import { getSpeechText } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';

export interface BrowserAudioProps {
  /** The route lifetime that owns playback, including the new-chat route. */
  routeKey?: string;
  shouldPlay: boolean;
  activeRunId: string | null;
  latestMessage: TMessage | null;
  /** Returns true only when an utterance was queued; may change when voices load. */
  speak: (text: string) => boolean;
  cancel: () => void;
  onStarted: (runId: string) => void;
}

/** Browser speech playback, with route, voice configuration and run state supplied by the host. */
export default function BrowserAudio({
  routeKey,
  shouldPlay,
  activeRunId,
  latestMessage,
  speak,
  cancel,
  onStarted,
}: BrowserAudioProps): null {
  const cancelRef = useRef(cancel);
  useEffect(() => {
    cancelRef.current = cancel;
  }, [cancel]);

  /** Cleanup belongs only to the route lifetime, not voice availability or callback identity.
   * React runs cleanups before effect bodies, so same-commit new-chat finalization cancels the
   * previous utterance before starting the newly finalized reply. */
  useEffect(() => {
    // Preserve this route's cancellation even if a later voice refresh reports no support.
    const cancelRoute = cancelRef.current;
    return () => cancelRoute();
  }, [routeKey]);

  useEffect(() => {
    if (!shouldPlay || activeRunId == null || latestMessage == null) {
      return;
    }
    const text = getSpeechText(latestMessage);
    if (!text) {
      return;
    }
    // A voice list that has not loaded yet must leave the run eligible for a later retry.
    if (speak(text)) {
      onStarted(activeRunId);
    }
  }, [shouldPlay, activeRunId, latestMessage, onStarted, speak]);

  return null;
}
