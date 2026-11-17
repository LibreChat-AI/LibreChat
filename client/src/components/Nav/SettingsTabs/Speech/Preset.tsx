import { useId } from 'react';
import { useRecoilCallback, useRecoilValue } from 'recoil';
import { Button, useToastContext } from '@librechat/client';
import { useLocalize } from '~/hooks';
import store from '~/store';

export default function Preset() {
  const id = useId();
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const speechToText = useRecoilValue(store.speechToText);
  const applyPreset = useRecoilCallback(
    ({ set }) =>
      () => {
        set(store.autoTranscribeAudio, true);
        set(store.autoSendText, 3);
        set(store.decibelValue, -45);
        showToast({ message: localize('com_nav_speech_input_preset_applied') });
      },
    [localize, showToast],
  );

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div id={`${id}-label`} className="text-text-primary text-sm">
          {localize('com_nav_speech_input_preset')}
        </div>
        <p id={`${id}-description`} className="text-text-secondary mt-1 text-xs">
          {localize('com_nav_info_speech_input_preset')}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        className="shrink-0"
        aria-describedby={`${id}-label ${id}-description`}
        onClick={applyPreset}
        disabled={!speechToText}
      >
        {localize('com_nav_apply_speech_input_preset')}
      </Button>
    </div>
  );
}
