import { useSetRecoilState } from 'recoil';
import { Switch, InfoHoverCard, ESide } from '@librechat/client';
import { useLocalize, useClientResize } from '~/hooks';
import store from '~/store';

const getInfoKey = (isSupported: boolean, isEnforced: boolean, isConfigUnavailable: boolean) => {
  if (!isSupported) {
    return 'com_nav_info_client_image_resize_unsupported' as const;
  }
  if (isConfigUnavailable) {
    return 'com_nav_info_client_image_resize_unavailable' as const;
  }
  if (isEnforced) {
    return 'com_nav_info_client_image_resize_enforced' as const;
  }
  return 'com_nav_info_client_image_resize' as const;
};

export default function ImageResize() {
  const localize = useLocalize();
  const setUserPreference = useSetRecoilState(store.clientImageResize);
  const { isEnabled, isEnforced, isSupported, isConfigPending, isConfigUnavailable } =
    useClientResize();

  const labelId = 'clientImageResize-label';
  const infoKey = getInfoKey(isSupported, isEnforced, isConfigUnavailable);

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center space-x-2">
        <div id={labelId}>{localize('com_nav_client_image_resize')}</div>
        <InfoHoverCard side={ESide.Bottom} text={localize(infoKey)} />
      </div>
      <Switch
        id="clientImageResize"
        checked={isEnabled}
        onCheckedChange={setUserPreference}
        disabled={isEnforced || !isSupported || isConfigUnavailable || isConfigPending}
        aria-busy={isConfigPending}
        className="ml-4"
        data-testid="clientImageResize"
        aria-labelledby={labelId}
      />
    </div>
  );
}
