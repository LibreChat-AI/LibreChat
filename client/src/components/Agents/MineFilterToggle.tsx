import { UserRound } from 'lucide-react';
import { Button, TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';

interface MineFilterToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

const MineFilterToggle: React.FC<MineFilterToggleProps> = ({ checked, onCheckedChange }) => {
  const localize = useLocalize();

  return (
    <TooltipAnchor
      description={localize('com_agents_filter_mine')}
      render={
        <Button
          variant="outline-toggle"
          aria-label={localize('com_agents_my_agents')}
          size="compact"
          aria-pressed={checked}
          onClick={() => onCheckedChange(!checked)}
        >
          <UserRound className="size-3.5" aria-hidden="true" />
          {localize('com_agents_my_agents')}
        </Button>
      }
    />
  );
};

export default MineFilterToggle;
