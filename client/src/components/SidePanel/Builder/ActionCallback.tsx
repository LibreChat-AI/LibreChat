import { useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { Input, Label } from '@librechat/client';
import { AuthTypeEnum } from 'librechat-data-provider';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useLocalize, useCopyToClipboard } from '~/hooks';

export default function ActionCallback({ action_id }: { action_id?: string }) {
  const localize = useLocalize();
  const { watch } = useFormContext();
  const [isCopied, setIsCopied] = useState(false);

  const callbackURL = `${window.location.protocol}//${window.location.host}/api/actions/${action_id}/oauth/callback`;
  const copyCallbackURL = useCopyToClipboard({ text: callbackURL });

  if (!action_id || watch('type') !== AuthTypeEnum.OAuth) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="oauth-callback-url" className="text-sm font-medium text-text-primary">
        {localize('com_ui_callback_url')}
      </Label>
      <div className="relative">
        <Input
          id="oauth-callback-url"
          type="text"
          readOnly
          dir="ltr"
          value={callbackURL}
          aria-label={localize('com_ui_callback_url')}
          onFocus={(event) => event.currentTarget.select()}
          className="pr-10 text-text-secondary"
        />
        <CopyButton
          iconOnly
          isCopied={isCopied}
          onClick={() => copyCallbackURL(setIsCopied)}
          label={localize('com_ui_copy_link')}
          className="absolute right-1 top-1/2 -translate-y-1/2"
        />
      </div>
    </div>
  );
}
