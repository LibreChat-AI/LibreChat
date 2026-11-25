import { ChevronLeft } from 'lucide-react';
import { Button } from '@librechat/client';
import { useLocalize } from '~/hooks';

interface BackButtonProps {
  onClick: () => void;
  /** Localization key for the accessible name; defaults to the agent builder's. */
  labelKey?: 'com_ui_back_to_builder';
}

/** The back button every side panel shares, so the way out of a panel never varies. */
export default function BackButton({
  onClick,
  labelKey = 'com_ui_back_to_builder',
}: BackButtonProps) {
  const localize = useLocalize();

  return (
    <Button variant="panel-back" size="icon" onClick={onClick} aria-label={localize(labelKey)}>
      <ChevronLeft className="h-5 w-5 rtl:-scale-x-100" strokeWidth={1.75} aria-hidden="true" />
    </Button>
  );
}
