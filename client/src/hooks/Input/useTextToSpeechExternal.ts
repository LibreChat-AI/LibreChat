import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { useMutation } from '@tanstack/react-query';
import { useToastContext } from '@librechat/client';
import { dataService, MutationKeys, getClientLimit } from 'librechat-data-provider';
import {
  getTTSCacheKey,
  setCachedTTSAudio,
  getCachedTTSAudio,
  getTTSCacheGeneration,
} from '~/utils';
import { MediaSourceAppender } from '~/hooks/Audio/MediaSourceAppender';
import { useLocalize, useAuthContext } from '~/hooks';
import { useVoicesQuery } from '~/data-provider';
import store from '~/store';

type TUseTTSExternal = {
  setIsSpeaking: React.Dispatch<React.SetStateAction<boolean>>;
  audioRef: React.MutableRefObject<HTMLAudioElement | null>;
  messageId?: string;
  isLast: boolean;
  index?: number;
};

function useTextToSpeechExternal({
  setIsSpeaking,
  audioRef,
  messageId,
  isLast,
  index = 0,
}: TUseTTSExternal) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const voice = useRecoilValue(store.voice);
  const cacheTTS = useRecoilValue(store.cacheTTS);
  const playbackRate = useRecoilValue(store.playbackRate);
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;
  const [isLoading, setIsLoading] = useState(false);
  const controllerRef = useRef<AbortController>();
  const sourceRef = useRef<MediaSourceAppender>();
  const promiseAudioRef = useRef<HTMLAudioElement | null>(null);
  const globalIsFetching = useRecoilValue(store.globalAudioFetchingFamily(index));
  const globalIsPlaying = useRecoilValue(store.globalAudioPlayingFamily(index));

  const releaseAudio = useCallback(() => {
    sourceRef.current?.dispose();
    sourceRef.current = undefined;
    const audio = promiseAudioRef.current;
    if (audio) {
      promiseAudioRef.current = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      URL.revokeObjectURL(audio.src);
      audio.removeAttribute('src');
      audio.load();
    }
  }, []);

  const cancelSpeech = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    releaseAudio();
    const messageAudio = document.getElementById(`audio-${messageId}`) as HTMLAudioElement | null;
    messageAudio?.pause();
    setIsLoading(false);
    setIsSpeaking(false);
  }, [messageId, releaseAudio, setIsSpeaking]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = undefined;
      releaseAudio();
    },
    [releaseAudio],
  );

  useEffect(() => {
    if (promiseAudioRef.current && playbackRate != null && playbackRate > 0) {
      promiseAudioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  const { mutate } = useMutation({
    mutationKey: [MutationKeys.textToSpeech],
    mutationFn: async ({
      text,
      download,
      controller,
    }: {
      text: string;
      download: boolean;
      controller: AbortController;
    }) => {
      const { signal } = controller;
      const isCurrent = () => controllerRef.current === controller && !signal.aborted;
      const generation = getTTSCacheGeneration();
      const failPlayback = () => {
        if (!isCurrent()) {
          return;
        }
        cancelSpeech();
        showToast({ message: localize('com_nav_audio_play_error', { 0: '' }), status: 'error' });
      };
      const play = (url: string) => {
        const audio = new Audio(url);
        promiseAudioRef.current = audio;
        const rate = playbackRateRef.current;
        if (rate != null && rate > 0) {
          audio.playbackRate = rate;
        }
        audio.onended = () => {
          if (isCurrent()) {
            releaseAudio();
            setIsSpeaking(false);
          }
        };
        audio.onerror = failPlayback;
        void audio
          .play()
          .then(() => {
            if (isCurrent()) {
              setIsLoading(false);
            }
          })
          .catch(failPlayback);
      };
      const deliverBlob = (blob: Blob) => {
        const url = URL.createObjectURL(blob);
        if (!download) {
          play(url);
          return;
        }
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'audio.mp3';
        anchor.click();
        URL.revokeObjectURL(url);
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const cacheKey = cacheTTS ? await getTTSCacheKey(text, voice ?? '', user?.id) : null;
        if (!isCurrent()) {
          return;
        }
        const cached = cacheKey ? getCachedTTSAudio(cacheKey) : undefined;
        if (cached) {
          deliverBlob(cached);
          return;
        }
        if (text.length >= 4096) {
          showToast({ message: localize('com_nav_long_audio_warning'), status: 'warning' });
        }
        const formData = new FormData();
        formData.append('input', text);
        formData.append('voice', voice ?? '');
        timer = setTimeout(() => controller.abort(), getClientLimit('ttsMs'));
        const response = await dataService.streamTextToSpeech(formData, signal);
        clearTimeout(timer);
        if (!isCurrent()) {
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error('Audio request failed');
        }
        const streaming =
          !download &&
          typeof MediaSource !== 'undefined' &&
          MediaSource.isTypeSupported('audio/mpeg');
        const source = streaming ? new MediaSourceAppender('audio/mpeg') : undefined;
        sourceRef.current = source;
        const chunks: ArrayBuffer[] = [];
        let receivedAudio = false;
        const reader = response.body.getReader();
        try {
          if (source) {
            play(source.mediaSourceUrl);
          }
          while (isCurrent()) {
            const { value, done } = await reader.read();
            if (!isCurrent() || done) {
              break;
            }
            if (!value.byteLength) {
              continue;
            }
            receivedAudio = true;
            const chunk = new Uint8Array(value).buffer;
            source?.addData(chunk);
            if (cacheTTS || !source) {
              chunks.push(chunk);
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (!isCurrent()) {
          return;
        }
        if (!receivedAudio) {
          releaseAudio();
          setIsSpeaking(false);
          return;
        }
        source?.close();
        if (chunks.length) {
          const blob = new Blob(chunks, { type: 'audio/mpeg' });
          if (cacheKey) {
            setCachedTTSAudio(cacheKey, blob, generation);
          }
          if (!source) {
            deliverBlob(blob);
          }
        } else if (!source) {
          setIsSpeaking(false);
        }
      } catch {
        if (controllerRef.current === controller) {
          controller.abort();
          releaseAudio();
          setIsSpeaking(false);
          showToast({
            message: localize('com_nav_audio_process_error', { 0: '' }),
            status: 'error',
          });
        }
      } finally {
        clearTimeout(timer);
        if (controllerRef.current === controller) {
          setIsLoading(false);
          if (download || signal.aborted) {
            releaseAudio();
            setIsSpeaking(false);
          }
        }
      }
    },
  });

  const generateSpeechExternal = (text: string, download: boolean) => {
    cancelSpeech();
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsLoading(true);
    setIsSpeaking(!download);
    mutate({ text, download, controller });
  };

  const isFetching = useMemo(
    () => isLast && globalIsFetching && !globalIsPlaying,
    [globalIsFetching, globalIsPlaying, isLast],
  );
  const { data: voicesData = [] } = useVoicesQuery();
  return {
    generateSpeechExternal,
    cancelSpeech,
    isLoading: isFetching || isLoading,
    audioRef,
    voices: voicesData,
  };
}

export default useTextToSpeechExternal;
