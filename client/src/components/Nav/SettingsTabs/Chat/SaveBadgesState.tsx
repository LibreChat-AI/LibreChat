import { useRecoilState } from 'recoil';
import { Switch, InfoHoverCard, ESide } from '@librechat/client';
import { useLocalize } from '~/hooks';
import store from '~/store';

export default function SaveBadgesState({
  onCheckedChange,
}: {
  onCheckedChange?: (value: boolean) => void;
}) {
  const [saveBadgesState, setSaveBadgesState] = useRecoilState<boolean>(store.saveBadgesState);
  const localize = useLocalize();

  const handleCheckedChange = (value: boolean) => {
    setSaveBadgesState(value);
    if (onCheckedChange) {
      onCheckedChange(value);
    }
  };

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center space-x-2">
        <div>{localize('com_nav_save_badges_state')}</div>
        <InfoHoverCard side={ESide.Bottom} text={localize('com_nav_info_save_badges_state')} />
      </div>
      <Switch
        id="saveBadgesState"
        checked={saveBadgesState}
        onCheckedChange={handleCheckedChange}
        className="ms-4"
        data-testid="saveBadgesState"
        aria-label={localize('com_nav_save_badges_state')}
      />
    </div>
  );
}
