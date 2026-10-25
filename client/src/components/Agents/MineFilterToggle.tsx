import { UserRound, UserRoundCheck } from 'lucide-react';
import { Button, TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';

interface MineFilterToggleProps {
  iconOnly?: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

const MineFilterToggle: React.FC<MineFilterToggleProps> = ({
  checked,
  onCheckedChange,
  iconOnly = false,
}) => {
  const localize = useLocalize();
  const Icon = iconOnly && checked ? UserRoundCheck : UserRound;

  return (
    <TooltipAnchor
      description={localize('com_agents_filter_mine')}
      render={
        <Button
          variant={iconOnly ? 'ghost' : 'outline-toggle'}
          aria-label={localize('com_agents_my_agents')}
          size={iconOnly ? 'icon-sm' : 'compact'}
          aria-pressed={checked}
          onClick={() => onCheckedChange(!checked)}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          {!iconOnly && localize('com_agents_my_agents')}
        </Button>
      }
    />
  );
};

export default MineFilterToggle;
