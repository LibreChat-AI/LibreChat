import React from 'react';
import { useRecoilState } from 'recoil';
import { Dropdown } from '@librechat/client';
import type { Option } from '~/common';
import { useLocalize, useTTSBrowser, useTTSExternal } from '~/hooks';
import { logger } from '~/utils';
import store from '~/store';

export function BrowserVoiceDropdown({ disabled = false }: { disabled?: boolean }) {
  const localize = useLocalize();
  const { voices = [] } = useTTSBrowser();
  const [voice, setVoice] = useRecoilState(store.voice);

  const handleVoiceChange = (newValue?: string | Option) => {
    logger.log('Browser Voice changed:', newValue);
    const newVoice = typeof newValue === 'string' ? newValue : newValue?.value;
    if (newVoice != null) {
      return setVoice(newVoice.toString());
    }
  };

  const labelId = 'browser-voice-dropdown-label';

  return (
    <div className="flex items-center justify-between">
      <div id={labelId}>{localize('com_nav_voice_select')}</div>
      <Dropdown
        key={`browser-voice-dropdown-${voices.length}`}
        value={voice ?? ''}
        options={voices}
        onChange={handleVoiceChange}
        sizeClasses="z-50 min-w-[min(12.5rem,90vw)] max-w-[min(25rem,90vw)]"
        testId="BrowserVoiceDropdown"
        className="z-50"
        aria-labelledby={labelId}
        disabled={disabled}
      />
    </div>
  );
}

export function ExternalVoiceDropdown({ disabled = false }: { disabled?: boolean }) {
  const localize = useLocalize();
  const { voices = [] } = useTTSExternal();
  const [voice, setVoice] = useRecoilState(store.voice);

  const handleVoiceChange = (newValue?: string | Option) => {
    logger.log('External Voice changed:', newValue);
    const newVoice = typeof newValue === 'string' ? newValue : newValue?.value;
    if (newVoice != null) {
      return setVoice(newVoice.toString());
    }
  };

  const labelId = 'external-voice-dropdown-label';

  return (
    <div className="flex items-center justify-between">
      <div id={labelId}>{localize('com_nav_voice_select')}</div>
      <Dropdown
        key={`external-voice-dropdown-${voices.length}`}
        value={voice ?? ''}
        options={voices}
        onChange={handleVoiceChange}
        sizeClasses="z-50 min-w-[min(12.5rem,90vw)] max-w-[min(25rem,90vw)]"
        testId="ExternalVoiceDropdown"
        className="z-50"
        aria-labelledby={labelId}
        disabled={disabled}
      />
    </div>
  );
}
