import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { CopyButton } from '@librechat/chat/components';
import { Button, Input, Label, SecretInput } from '@librechat/client';
import type { TAgentApiKeyCreateResponse } from 'librechat-data-provider';
import { useLocalize, useCopyToClipboard } from '~/hooks';
import { useGetStartupConfig } from '~/data-provider';
import { getRemoteApiBaseUrl } from './utils';

type RevealProps = {
  createdKey: TAgentApiKeyCreateResponse;
  onDone: () => void;
};

export default function Reveal({ createdKey, onDone }: RevealProps) {
  const localize = useLocalize();
  const [isCopied, setIsCopied] = useState(false);
  const [isUrlCopied, setIsUrlCopied] = useState(false);
  const { data: startupConfig } = useGetStartupConfig();
  const baseUrl = getRemoteApiBaseUrl();
  const copyToClipboard = useCopyToClipboard({ text: createdKey.key });
  const copyBaseUrl = useCopyToClipboard({ text: baseUrl });

  return (
    <div className="min-w-0 space-y-4">
      <div className="border-status-warning-border bg-status-warning-subtle flex gap-2.5 rounded-lg border p-3">
        <TriangleAlert className="text-text-warning mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="text-text-warning text-sm">{localize('com_ui_api_key_warning')}</p>
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
      <div className="space-y-2">
        <Label htmlFor="reveal-api-base-url">{localize('com_ui_api_base_url')}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="reveal-api-base-url"
            readOnly
            value={baseUrl}
            aria-describedby="reveal-api-key-usage"
          />
          <CopyButton
            iconOnly
            label={localize('com_ui_copy_api_base_url')}
            isCopied={isUrlCopied}
            onClick={() => copyBaseUrl(setIsUrlCopied)}
          />
        </div>
        <p id="reveal-api-key-usage" className="text-text-secondary text-sm">
          {localize(
            startupConfig?.remoteApiModelsEnabled === false
              ? 'com_ui_api_key_usage_agents'
              : 'com_ui_api_key_usage_models',
          )}
        </p>
      </div>
      <div className="flex justify-end">
        <Button onClick={onDone}>{localize('com_ui_done')}</Button>
      </div>
    </div>
  );
}
