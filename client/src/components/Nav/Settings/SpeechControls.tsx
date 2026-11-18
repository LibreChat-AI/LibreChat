import { useRecoilCallback, useRecoilValue } from 'recoil';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import { EngineSTTDropdown } from '../SettingsTabs/Speech/STT';
import { EngineTTSDropdown } from '../SettingsTabs/Speech/TTS';
import Preset from '../SettingsTabs/Speech/Preset';
import store from '~/store';

export function EngineSTTSetting() {
  const { data } = useGetCustomConfigSpeechQuery();
  return <EngineSTTDropdown external={Boolean(data?.sttExternal)} />;
}

export function EngineTTSSetting() {
  const { data } = useGetCustomConfigSpeechQuery();
  return <EngineTTSDropdown external={Boolean(data?.ttsExternal)} />;
}

export function SpeechInputPresetSetting() {
  const speechToText = useRecoilValue(store.speechToText);
  const applyPreset = useRecoilCallback(
    ({ set }) =>
      () => {
        set(store.autoTranscribeAudio, true);
        set(store.autoSendText, 3);
        set(store.decibelValue, -45);
      },
    [],
  );

  return <Preset enabled={speechToText} onApply={applyPreset} />;
}
