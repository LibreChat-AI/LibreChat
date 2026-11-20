import { useId } from 'react';
import { Button, useToastContext } from '@librechat/client';
import { useLocalize } from '~/hooks';

export default function Preset({ enabled, onApply }: { enabled: boolean; onApply: () => void }) {
  const id = useId();
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const applyPreset = () => {
    onApply();
    showToast({ message: localize('com_nav_speech_input_preset_applied') });
  };

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
        disabled={!enabled}
      >
        {localize('com_nav_apply_speech_input_preset')}
      </Button>
    </div>
  );
}
