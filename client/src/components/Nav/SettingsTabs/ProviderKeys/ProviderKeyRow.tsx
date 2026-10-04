import { useMemo, useState } from 'react';
import { Button } from '@librechat/client';
import { alternateName, getEndpointField } from 'librechat-data-provider';
import type { TEndpointsConfig, MediaUserKey } from 'librechat-data-provider';
import { ResolvedProviderIcon } from '~/components/Endpoints/ResolvedProviderIcon';
import { formatKeyExpiryLabel } from '~/components/Input/SetKeyDialog/utils';
import { useUserKey, useLocalize, useClockFormat } from '~/hooks';
import { SetKeyDialog } from '~/components/Input/SetKeyDialog';
import { useProviderIcon } from '~/hooks/Endpoint';

interface ProviderKeyRowProps {
  endpoint: string;
  endpointsConfig: TEndpointsConfig;
  keyConfiguration?: MediaUserKey & { label: string };
  label?: string;
  conflict?: boolean;
}

export default function ProviderKeyRow({
  endpoint,
  endpointsConfig,
  keyConfiguration,
  label: configuredLabel,
  conflict = false,
}: ProviderKeyRowProps) {
  const localize = useLocalize();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { getExpiry, checkExpiry, isLoading, isError, refetch } = useUserKey(endpoint, {
    keyName: keyConfiguration?.keyName,
    enabled: !conflict,
  });

  const endpointType = getEndpointField(endpointsConfig, endpoint, 'type');
  const { provider, imageURL } = useProviderIcon({ endpoint, endpointsConfig });

  const label = configuredLabel ?? alternateName[endpoint] ?? endpoint;
  const expiry = getExpiry();
  const hasKey = !!expiry && checkExpiry();
  const hour12 = useClockFormat();
  const expiryLabel = useMemo(() => {
    if (conflict) return localize('com_ui_provider_api_keys_conflict');
    if (isLoading) return localize('com_ui_loading');
    if (isError) return localize('com_ui_api_keys_load_error');
    if (!expiry) {
      return localize('com_ui_provider_api_keys_not_set');
    }
    if (expiry === 'never') {
      return localize('com_endpoint_config_key_never_expires');
    }
    return formatKeyExpiryLabel(localize, expiry, hour12);
  }, [expiry, localize, hour12, conflict, isLoading, isError]);
  let buttonLabel = localize('com_endpoint_config_key');
  if (isError) buttonLabel = localize('com_ui_retry');
  else if (hasKey) buttonLabel = localize('com_ui_update');

  return (
    <>
      <div className="flex items-center justify-between gap-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex shrink-0 items-center justify-center" aria-hidden="true">
            <ResolvedProviderIcon
              provider={provider}
              imageURL={imageURL}
              size={20}
              className="icon-md shrink-0"
            />
          </div>
          <div className="min-w-0">
            <div className="text-text-primary truncate font-medium">{label}</div>
            <div className="text-text-secondary text-xs" role={isError ? 'alert' : undefined}>
              {expiryLabel}
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          disabled={conflict || isLoading}
          onClick={() => (isError ? void refetch() : setDialogOpen(true))}
          aria-label={localize('com_ui_provider_key_action', { action: buttonLabel, name: label })}
        >
          {buttonLabel}
        </Button>
      </div>
      {dialogOpen && !conflict && (
        <SetKeyDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          endpoint={endpoint}
          keyConfiguration={keyConfiguration?.encoding === 'google' ? undefined : keyConfiguration}
          endpointType={endpointType}
          userProvideURL={
            keyConfiguration?.userProvideURL ??
            getEndpointField(endpointsConfig, endpoint, 'userProvideURL')
          }
          userProvideAccessKeyId={getEndpointField(
            endpointsConfig,
            endpoint,
            'userProvideAccessKeyId',
          )}
          userProvideSecretAccessKey={getEndpointField(
            endpointsConfig,
            endpoint,
            'userProvideSecretAccessKey',
          )}
          userProvideSessionToken={getEndpointField(
            endpointsConfig,
            endpoint,
            'userProvideSessionToken',
          )}
          userProvideBearerToken={getEndpointField(
            endpointsConfig,
            endpoint,
            'userProvideBearerToken',
          )}
        />
      )}
    </>
  );
}
