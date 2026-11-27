import { StopGeneratingIcon } from '@librechat/client';
import type { TGenButtonProps } from '~/common';
import { useLocalize } from '~/hooks';
import Button from './Button';

export default function Stop({ onClick }: TGenButtonProps) {
  const localize = useLocalize();

  return (
    <Button type="stop" onClick={onClick} shortcutId="stopGenerating">
      <StopGeneratingIcon className="text-text-secondary" />
      {localize('com_ui_stop')}
    </Button>
  );
}
