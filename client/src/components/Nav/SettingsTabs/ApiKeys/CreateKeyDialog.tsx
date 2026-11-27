import { useState } from 'react';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import type { TAgentApiKeyCreateResponse } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import Create from './Create';
import Reveal from './Reveal';

type CreateKeyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export default function CreateKeyDialog({ open, onOpenChange }: CreateKeyDialogProps) {
  const localize = useLocalize();
  const [createdKey, setCreatedKey] = useState<TAgentApiKeyCreateResponse | null>(null);
  const [prevOpen, setPrevOpen] = useState(open);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setCreatedKey(null);
    }
  }

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent
        showCloseButton={false}
        className="w-11/12 max-w-lg"
        aria-describedby={undefined}
      >
        <OGDialogHeader>
          <OGDialogTitle>
            {createdKey != null
              ? localize('com_ui_api_key_created')
              : localize('com_ui_create_api_key')}
          </OGDialogTitle>
        </OGDialogHeader>
        {createdKey != null ? (
          <Reveal createdKey={createdKey} onDone={() => onOpenChange(false)} />
        ) : (
          <Create onCreated={setCreatedKey} onCancel={() => onOpenChange(false)} />
        )}
      </OGDialogContent>
    </OGDialog>
  );
}
