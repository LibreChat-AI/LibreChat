import { memo } from 'react';
import { useRecoilValue } from 'recoil';
import BrowserAudio from './BrowserAudio';
import StreamAudio from './StreamAudio';
import { TTSEndpoints } from '~/common';
import store from '~/store';

/**
 * Mount point for "Autoplay Latest Message". Playback has to honor the selected TTS engine
 * the same way the message speaker button does, otherwise the Browser engine silently falls
 * through to the external endpoint and never reaches the Web Speech API.
 */
function AutoPlayAudio({ index = 0 }) {
  const engineTTS = useRecoilValue<string>(store.engineTTS);
  const speechSettingsInitialized = useRecoilValue(store.speechSettingsInitialized);

  if (!speechSettingsInitialized) {
    return null;
  }

  const AutoPlayComponents = {
    [TTSEndpoints.browser]: BrowserAudio,
    [TTSEndpoints.external]: StreamAudio,
  };

  const SelectedAutoPlay = AutoPlayComponents[engineTTS];
  if (!SelectedAutoPlay) {
    return null;
  }

  return <SelectedAutoPlay index={index} />;
}

export default memo(AutoPlayAudio);
