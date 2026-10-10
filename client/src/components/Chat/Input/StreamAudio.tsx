import { useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, getSpeechText } from 'librechat-data-provider';
import { useRecoilState, useRecoilValue, useSetRecoilState } from 'recoil';
import type { TMessage } from 'librechat-data-provider';
import {
  useCustomAudioRef,
  useAutoplayTrigger,
  MediaSourceAppender,
  usePauseGlobalAudio,
} from '~/hooks/Audio';
import { useAuthContext } from '~/hooks';
import { globalAudioId } from '~/common';
import { logger } from '~/utils';
import store from '~/store';

function timeoutPromise(ms: number, message?: string) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(message ?? 'Promise timed out')), ms),
  );
}

const promiseTimeoutMessage = 'Reader promise timed out';
const maxPromiseTime = 15000;

export default function StreamAudio({ index = 0 }) {
  const { token } = useAuthContext();

  const cacheTTS = useRecoilValue(store.cacheTTS);
  const playbackRate = useRecoilValue(store.playbackRate);

  const voice = useRecoilValue(store.voice);
  const automaticPlayback = useRecoilValue(store.automaticPlayback);
  const setIsPlaying = useSetRecoilState(store.globalAudioPlayingFamily(index));
  const setAudioRunId = useSetRecoilState(store.audioRunFamily(index));
  const [isFetching, setIsFetching] = useRecoilState(store.globalAudioFetchingFamily(index));
  const [globalAudioURL, setGlobalAudioURL] = useRecoilState(store.globalAudioURLFamily(index));

  const { shouldPlay, activeRunId, latestMessage } = useAutoplayTrigger(index);
  const { audioRef } = useCustomAudioRef({ setIsPlaying });
  const { pauseGlobalAudio } = usePauseGlobalAudio();

  const { conversationId: paramId } = useParams();
  const queryParam = paramId === 'new' ? paramId : (latestMessage?.conversationId ?? paramId ?? '');

  const queryClient = useQueryClient();
  const getMessages = useCallback(
    () => queryClient.getQueryData<TMessage[]>([QueryKeys.messages, queryParam]),
    [queryParam, queryClient],
  );

  useEffect(() => {
    if (!(token != null && automaticPlayback && shouldPlay && !isFetching)) {
      return;
    }

    async function fetchAudio() {
      setIsFetching(true);
      let mediaSource: MediaSourceAppender | undefined;

      try {
        if (audioRef.current) {
          audioRef.current.pause();
          URL.revokeObjectURL(audioRef.current.src);
          setGlobalAudioURL(null);
        }

        /** Keyed by the spoken text, as manual playback is, so audio cached from an
         *  unfiltered message (reasoning included) is never replayed. */
        let cacheKey = latestMessage ? getSpeechText(latestMessage) : '';
        const cache = await caches.open('tts-responses');
        const cachedResponse = await cache.match(cacheKey);

        setAudioRunId(activeRunId);
        if (cachedResponse) {
          logger.log('Audio found in cache');
          const audioBlob = await cachedResponse.blob();
          const blobUrl = URL.createObjectURL(audioBlob);
          setGlobalAudioURL(blobUrl);
          setIsFetching(false);
          return;
        }

        logger.log('Fetching audio...', navigator.userAgent);
        const response = await fetch('/api/files/speech/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ messageId: latestMessage?.messageId, runId: activeRunId, voice }),
        });

        if (!response.ok) {
          throw new Error('Failed to fetch audio');
        }
        if (!response.body) {
          throw new Error('Null Response body');
        }

        const reader = response.body.getReader();

        const type = 'audio/mpeg';
        const browserSupportsType =
          typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type);
        if (browserSupportsType) {
          mediaSource = new MediaSourceAppender(type);
          setGlobalAudioURL(mediaSource.mediaSourceUrl);
        }

        /** Browsers without MSE support for the type (Safari, for one) can only be handed the
         *  audio once it is fully read, so that path always buffers — caching opts MSE in too. */
        const shouldBufferChunks = cacheTTS || !browserSupportsType;

        let done = false;
        const chunks: ArrayBuffer[] = [];

        while (!done) {
          const readPromise = reader.read();
          const { value, done: readerDone } = (await Promise.race([
            readPromise,
            timeoutPromise(maxPromiseTime, promiseTimeoutMessage),
          ])) as ReadableStreamReadResult<ArrayBuffer>;

          if (shouldBufferChunks && value) {
            chunks.push(value);
          }
          if (value && mediaSource) {
            mediaSource.addData(value);
          }
          done = readerDone;
        }

        mediaSource?.close();

        if (chunks.length) {
          const audioBlob = new Blob(chunks, { type });
          if (!browserSupportsType) {
            setGlobalAudioURL(URL.createObjectURL(audioBlob));
          }
          if (cacheTTS) {
            const latestMessages = getMessages() ?? [];
            const targetMessage = latestMessages.find(
              (msg) => msg.messageId === latestMessage?.messageId,
            );
            cacheKey = targetMessage ? getSpeechText(targetMessage) : '';
            if (!cacheKey) {
              logger.warn('Cache key not found, skipping audio cache');
            } else {
              logger.log('Adding audio to cache');
              await cache.put(cacheKey, new Response(audioBlob));
            }
          }
        }

        logger.log('Audio stream reading ended');
      } catch (error) {
        if (error?.['message'] === promiseTimeoutMessage) {
          logger.log(promiseTimeoutMessage);
          /** Let whatever was already appended finish playing instead of stalling forever */
          mediaSource?.close();
          return;
        }
        logger.error('Error fetching audio:', error);
        setGlobalAudioURL(null);
      } finally {
        setIsFetching(false);
      }
    }

    fetchAudio();
  }, [
    automaticPlayback,
    setGlobalAudioURL,
    setAudioRunId,
    setIsFetching,
    latestMessage,
    activeRunId,
    getMessages,
    shouldPlay,
    isFetching,
    cacheTTS,
    audioRef,
    voice,
    token,
  ]);

  useEffect(() => {
    if (
      playbackRate != null &&
      globalAudioURL != null &&
      playbackRate > 0 &&
      audioRef.current &&
      audioRef.current.playbackRate !== playbackRate
    ) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [audioRef, globalAudioURL, playbackRate]);

  useEffect(() => {
    pauseGlobalAudio();
    // We only want the effect to run when the paramId changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramId]);

  logger.log('StreamAudio.tsx - globalAudioURL:', globalAudioURL);
  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <audio
      ref={audioRef}
      controls
      controlsList="nodownload nofullscreen noremoteplayback"
      style={{
        position: 'absolute',
        overflow: 'hidden',
        display: 'none',
        height: '0px',
        width: '0px',
      }}
      src={globalAudioURL ?? undefined}
      id={globalAudioId}
      autoPlay
    />
  );
}
