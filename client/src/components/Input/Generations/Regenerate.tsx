import { RegenerateIcon } from '@librechat/client';
import type { TGenButtonProps } from '~/common';
import { useLocalize } from '~/hooks';
import Button from './Button';

export default function Regenerate({ onClick }: TGenButtonProps) {
  const localize = useLocalize();

  return (
    <Button onClick={onClick} shortcutId="regenerateResponse">
      <RegenerateIcon className="text-text-secondary h-3 w-3 shrink-0" />
      {localize('com_ui_regenerate')}
    </Button>
  );
}
