import { History } from 'lucide-react';
import { Button } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { Panel } from '~/common';

interface VersionButtonProps {
  setActivePanel: (panel: Panel) => void;
}

const VersionButton = ({ setActivePanel }: VersionButtonProps) => {
  const localize = useLocalize();

  return (
    <Button
      variant="subtle"
      shape="theme"
      onClick={() => setActivePanel(Panel.version)}
      aria-label={localize('com_ui_agent_version')}
      className="h-9 w-full px-3"
    >
      <History className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      {localize('com_ui_agent_version')}
    </Button>
  );
};

export default VersionButton;
