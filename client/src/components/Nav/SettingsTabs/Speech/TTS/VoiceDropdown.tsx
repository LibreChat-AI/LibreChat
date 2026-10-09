import { useRecoilValue } from 'recoil';
import { BrowserVoiceDropdown, ExternalVoiceDropdown } from '~/components/Audio/Voices';
import { TTSEndpoints } from '~/common';
import store from '~/store';

const voiceDropdownComponentsMap = {
  [TTSEndpoints.browser]: BrowserVoiceDropdown,
  [TTSEndpoints.external]: ExternalVoiceDropdown,
};

export default function VoiceDropdown() {
  const engineTTS = useRecoilValue<string>(store.engineTTS);
  const textToSpeech = useRecoilValue(store.textToSpeech);
  const VoiceDropdownComponent = voiceDropdownComponentsMap[engineTTS];

  if (!VoiceDropdownComponent) {
    return null;
  }

  return <VoiceDropdownComponent disabled={!textToSpeech} />;
}
