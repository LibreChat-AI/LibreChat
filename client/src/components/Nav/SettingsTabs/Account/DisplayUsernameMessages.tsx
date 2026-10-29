import React from 'react';
import { useRecoilState } from 'recoil';
import { Switch, Label, InfoHoverCard, ESide } from '@librechat/client';
import { useLocalize } from '~/hooks';
import store from '~/store';

export default function DisplayUsernameMessages() {
  const localize = useLocalize();
  const [UsernameDisplay, setUsernameDisplay] = useRecoilState(store.UsernameDisplay);

  const handleCheckedChange = (checked: boolean) => {
    setUsernameDisplay(checked);
  };

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center space-x-2">
        <Label id="user-name-display-label">{localize('com_nav_user_name_display')}</Label>
        <InfoHoverCard side={ESide.Bottom} text={localize('com_nav_info_user_name_display')} />
      </div>
      <Switch
        id="UsernameDisplay"
        checked={UsernameDisplay}
        onCheckedChange={handleCheckedChange}
        className="ms-4"
        data-testid="UsernameDisplay"
        aria-labelledby="user-name-display-label"
      />
    </div>
  );
}
