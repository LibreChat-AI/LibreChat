import React from 'react';
import { Dropdown } from '@librechat/client';
import { useRecoilState, useRecoilValue } from 'recoil';
import { useLocalize } from '~/hooks';
import store from '~/store';

interface EngineSTTDropdownProps {
  external: boolean;
  /** Whether the admin configured live transcription (`speech.stt.openai.realtime`). */
  realtime?: boolean;
}

const EngineSTTDropdown: React.FC<EngineSTTDropdownProps> = ({ external, realtime = false }) => {
  const localize = useLocalize();
  const [engineSTT, setEngineSTT] = useRecoilState<string>(store.engineSTT);
  const speechToText = useRecoilValue(store.speechToText);

  const endpointOptions = [{ value: 'browser', label: localize('com_nav_browser') }];
  if (external) {
    endpointOptions.push({ value: 'external', label: localize('com_nav_external') });
  }
  if (external && realtime) {
    endpointOptions.push({ value: 'realtime', label: localize('com_nav_live') });
  }

  const handleSelect = (value: string) => {
    setEngineSTT(value);
  };

  const labelId = 'engine-stt-dropdown-label';

  return (
    <div className="flex items-center justify-between">
      <div id={labelId}>{localize('com_nav_engine')}</div>
      <Dropdown
        value={engineSTT}
        onChange={handleSelect}
        options={endpointOptions}
        sizeClasses="z-50 w-[min(11.25rem,90vw)]"
        testId="EngineSTTDropdown"
        className="z-50"
        aria-labelledby={labelId}
        disabled={!speechToText}
      />
    </div>
  );
};

export default EngineSTTDropdown;
