import { useEffect, useRef } from 'react';
import { useRecoilState, useSetRecoilState } from 'recoil';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import { STTEndpoints, TTSEndpoints } from '~/common';
import { logger } from '~/utils';
import store from '~/store';

const VALID_TTS_ENGINES: string[] = [TTSEndpoints.browser, TTSEndpoints.external];

/**
 * Initializes speech-related Recoil values from the server-side custom
 * configuration on first load (only when the user is authenticated)
 */
export default function useSpeechSettingsInit(isAuthenticated: boolean) {
  const { data, isError, isFetched } = useGetCustomConfigSpeechQuery({ enabled: isAuthenticated });
  const [engineSTT, setEngineSTT] = useRecoilState<string>(store.engineSTT);
  const [engineTTS, setEngineTTS] = useRecoilState<string>(store.engineTTS);
  const setSpeechSettingsInitialized = useSetRecoilState(store.speechSettingsInitialized);

  const setters = useRef({
    conversationMode: useSetRecoilState(store.conversationMode),
    advancedMode: useSetRecoilState(store.advancedMode),
    speechToText: useSetRecoilState(store.speechToText),
    textToSpeech: useSetRecoilState(store.textToSpeech),
    cacheTTS: useSetRecoilState(store.cacheTTS),
    engineSTT: setEngineSTT,
    languageSTT: useSetRecoilState(store.languageSTT),
    autoTranscribeAudio: useSetRecoilState(store.autoTranscribeAudio),
    decibelValue: useSetRecoilState(store.decibelValue),
    autoSendText: useSetRecoilState(store.autoSendText),
    engineTTS: setEngineTTS,
    voice: useSetRecoilState(store.voice),
    cloudBrowserVoices: useSetRecoilState(store.cloudBrowserVoices),
    languageTTS: useSetRecoilState(store.languageTTS),
    automaticPlayback: useSetRecoilState(store.automaticPlayback),
    playbackRate: useSetRecoilState(store.playbackRate),
  }).current;

  useEffect(() => {
    if (!isAuthenticated) {
      setSpeechSettingsInitialized(false);
      return;
    }

    if (!isFetched) return;

    if (
      isError &&
      (localStorage.getItem('engineSTT') === null || localStorage.getItem('engineTTS') === null)
    ) {
      setSpeechSettingsInitialized(false);
      return;
    }

    const hasSavedEngineSTT = localStorage.getItem('engineSTT') !== null;
    const hasSavedEngineTTS = localStorage.getItem('engineTTS') !== null;

    if (data && data.message !== 'not_found') {
      logger.log('Initializing speech settings from config:', data);

      Object.entries(data).forEach(([key, value]) => {
        if (key === 'sttExternal' || key === 'ttsExternal') return;

        if (localStorage.getItem(key) !== null) return;

        const setter = setters[key as keyof typeof setters];
        if (setter) {
          logger.log(`Setting default speech setting: ${key} = ${value}`);
          setter(value as any);
        }
      });
    }

    const configuredEngineSTT = hasSavedEngineSTT ? engineSTT : data?.engineSTT;
    const configuredEngineTTS = hasSavedEngineTTS ? engineTTS : data?.engineTTS;
    const sttExternalUnavailable = data?.sttExternal != null && !data.sttExternal;
    const ttsExternalUnavailable = data?.ttsExternal != null && !data.ttsExternal;

    if (sttExternalUnavailable && configuredEngineSTT === STTEndpoints.external) {
      setEngineSTT(STTEndpoints.browser);
    }
    if (ttsExternalUnavailable && configuredEngineTTS === TTSEndpoints.external) {
      setEngineTTS(TTSEndpoints.browser);
    }

    setSpeechSettingsInitialized(true);
  }, [
    data,
    engineSTT,
    engineTTS,
    isAuthenticated,
    isError,
    isFetched,
    setEngineSTT,
    setEngineTTS,
    setSpeechSettingsInitialized,
    setters,
  ]);

  useEffect(() => {
    if (VALID_TTS_ENGINES.includes(engineTTS)) return;
    logger.log(`Resetting invalid TTS engine "${engineTTS}" to ${TTSEndpoints.browser}`);
    setEngineTTS(TTSEndpoints.browser);
  }, [engineTTS, setEngineTTS]);
}
