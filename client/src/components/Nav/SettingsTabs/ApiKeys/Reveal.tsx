import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button, Label, SecretInput } from '@librechat/client';
import type { TAgentApiKeyCreateResponse } from 'librechat-data-provider';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useLocalize, useCopyToClipboard } from '~/hooks';

type RevealProps = {
  createdKey: TAgentApiKeyCreateResponse;
  onDone: () => void;
};

export default function Reveal({ createdKey, onDone }: RevealProps) {
  const localize = useLocalize();
  const [isCopied, setIsCopied] = useState(false);
  const copyToClipboard = useCopyToClipboard({ text: createdKey.key });

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex gap-2.5 rounded-lg border border-status-warning-border bg-status-warning-subtle p-3">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-text-warning" aria-hidden="true" />
        <p className="text-sm text-text-warning">{localize('com_ui_api_key_warning')}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="reveal-api-key">{localize('com_ui_your_api_key')}</Label>
        <SecretInput
          id="reveal-api-key"
          readOnly
          value={createdKey.key}
          className="font-mono"
          aria-label={localize('com_ui_your_api_key')}
          copyButton={
            <CopyButton iconOnly isCopied={isCopied} onClick={() => copyToClipboard(setIsCopied)} />
          }
        />
      </div>
      <div className="flex justify-end">
        <Button onClick={onDone}>{localize('com_ui_done')}</Button>
      </div>
    </div>
  );
}
