import React from 'react';
import { Dropdown } from '@librechat/client';
import { useRecoilState, useRecoilValue } from 'recoil';
import { useLocalize } from '~/hooks';
import store from '~/store';

interface EngineSTTDropdownProps {
  external: boolean;
}

const EngineSTTDropdown: React.FC<EngineSTTDropdownProps> = ({ external }) => {
  const localize = useLocalize();
  const [engineSTT, setEngineSTT] = useRecoilState<string>(store.engineSTT);
  const speechToText = useRecoilValue(store.speechToText);

  const endpointOptions = external
    ? [
        { value: 'browser', label: localize('com_nav_browser') },
        { value: 'external', label: localize('com_nav_external') },
      ]
    : [{ value: 'browser', label: localize('com_nav_browser') }];

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
