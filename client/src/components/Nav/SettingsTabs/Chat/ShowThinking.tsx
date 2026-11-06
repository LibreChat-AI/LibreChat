import { useAtom } from 'jotai';
import { Switch, InfoHoverCard, ESide } from '@librechat/client';
import { showThinkingAtom } from '~/store/showThinking';
import { useLocalize } from '~/hooks';

export default function SaveDraft({
  onCheckedChange,
}: {
  onCheckedChange?: (value: boolean) => void;
}) {
  const [showThinking, setShowThinking] = useAtom(showThinkingAtom);
  const localize = useLocalize();

  const handleCheckedChange = (value: boolean) => {
    setShowThinking(value);
    if (onCheckedChange) {
      onCheckedChange(value);
    }
  };

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center space-x-2">
        <div>{localize('com_nav_show_thinking')}</div>
        <InfoHoverCard side={ESide.Bottom} text={localize('com_nav_info_show_thinking')} />
      </div>
      <Switch
        id="showThinking"
        checked={showThinking}
        onCheckedChange={handleCheckedChange}
        className="ms-4"
        data-testid="showThinking"
        aria-label={localize('com_nav_show_thinking')}
      />
    </div>
  );
}
