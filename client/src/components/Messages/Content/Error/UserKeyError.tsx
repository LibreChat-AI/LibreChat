import { useState } from 'react';
import { ErrorTypes, getEndpointField } from 'librechat-data-provider';
import type { ErrorRendererProps } from './parts';
import type { TranslationKeys } from '~/hooks';
import {
  ErrorBody,
  readString,
  ErrorAction,
  ErrorActions,
  formatTimestamp,
  useErrorEndpoint,
  ProviderErrorCodes,
} from './parts';
import { SetKeyDialog } from '~/components/Input/SetKeyDialog';
import { useLocalize } from '~/hooks';

type UserKeyErrorCode =
  | ErrorTypes.NO_USER_KEY
  | ErrorTypes.EXPIRED_USER_KEY
  | ErrorTypes.INVALID_USER_KEY
  | ErrorTypes.NO_BASE_URL
  | ErrorTypes.INVALID_BASE_URL
  | (typeof ProviderErrorCodes)[keyof typeof ProviderErrorCodes];

/** What the dialog is opened to do; every other code updates a key that is already saved. */
const actionLabels: Partial<Record<UserKeyErrorCode, TranslationKeys>> = {
  [ErrorTypes.NO_USER_KEY]: 'com_error_user_key_add',
  [ErrorTypes.NO_BASE_URL]: 'com_error_user_url_add',
  [ErrorTypes.INVALID_BASE_URL]: 'com_error_user_url_update',
};

export default function UserKeyError({ json, message }: ErrorRendererProps) {
  const localize = useLocalize();
  const [dialogOpen, setDialogOpen] = useState(false);
  const code = (readString(json, 'code') ?? readString(json, 'type')) as
    | UserKeyErrorCode
    | undefined;
  /** An expired key's payload names the endpoint whose key expired, which outranks the row's. */
  const payloadEndpoint =
    code === ErrorTypes.EXPIRED_USER_KEY ? readString(json, 'endpoint') : undefined;
  const { endpoint, endpointType, provider, userProvidesCredentials, endpointsConfig } =
    useErrorEndpoint(message, payloadEndpoint);
  const expiredAt = readString(json, 'expiredAt');

  /**
   * Every one of these codes reads three ways: who owns the key is unknown (a shared link, or any
   * view without the endpoint configuration), the reader owns it and can fix it, or the deployment
   * owns it and only an administrator can.
   */
  const byOwnership = (
    generic: TranslationKeys,
    userProvided: TranslationKeys,
    admin: TranslationKeys,
  ): string => {
    if (provider == null || userProvidesCredentials == null) {
      return localize(generic);
    }
    return localize(userProvidesCredentials ? userProvided : admin, { 0: provider });
  };

  /**
   * These codes can only come from the reader's own saved record (an unparseable key, a missing or
   * rejected user-provided URL), so there is no administrator variant: named copy when that record
   * is still the reader's to edit, the generic sentence otherwise.
   */
  const ownRecord = (generic: TranslationKeys, owned: TranslationKeys): string =>
    userProvidesCredentials === true && provider != null
      ? localize(owned, { 0: provider })
      : localize(generic);

  let errorMessage: string;
  switch (code) {
    case ErrorTypes.NO_USER_KEY:
      errorMessage = byOwnership(
        'com_error_no_user_key_generic',
        'com_error_no_user_key',
        'com_error_no_user_key_admin',
      );
      break;
    case ErrorTypes.EXPIRED_USER_KEY:
      if (expiredAt == null) {
        errorMessage = localize('com_error_invalid_user_key');
      } else if (provider == null) {
        errorMessage = localize('com_error_expired_user_key_generic', {
          0: formatTimestamp(expiredAt),
        });
      } else {
        errorMessage = localize('com_error_expired_user_key', {
          0: provider,
          1: formatTimestamp(expiredAt),
        });
      }
      break;
    case ErrorTypes.INVALID_USER_KEY:
      errorMessage = ownRecord('com_error_invalid_user_key', 'com_error_invalid_user_key_provider');
      break;
    case ErrorTypes.NO_BASE_URL:
      errorMessage = ownRecord('com_error_no_base_url', 'com_error_no_base_url_provider');
      break;
    case ErrorTypes.INVALID_BASE_URL:
      errorMessage = ownRecord('com_error_invalid_base_url', 'com_error_invalid_base_url_provider');
      break;
    case ProviderErrorCodes.INVALID_API_KEY:
      errorMessage = byOwnership(
        'com_error_invalid_api_key_generic',
        'com_error_invalid_api_key',
        'com_error_invalid_api_key_admin',
      );
      break;
    case ProviderErrorCodes.INSUFFICIENT_QUOTA:
      errorMessage = byOwnership(
        'com_error_insufficient_quota_generic',
        'com_error_insufficient_quota',
        'com_error_insufficient_quota_admin',
      );
      break;
    default:
      errorMessage = localize('com_error_invalid_user_key');
  }

  const canEditKey = userProvidesCredentials === true && endpoint != null;
  const updateLabel =
    (code != null ? actionLabels[code] : undefined) ?? 'com_error_user_key_update';

  return (
    <ErrorBody>
      {errorMessage}
      {canEditKey && (
        <ErrorActions>
          <ErrorAction onClick={() => setDialogOpen(true)}>{localize(updateLabel)}</ErrorAction>
        </ErrorActions>
      )}
      {canEditKey && dialogOpen && endpoint != null && (
        <SetKeyDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          endpoint={endpoint}
          endpointType={endpointType}
          userProvideURL={getEndpointField(endpointsConfig, endpoint, 'userProvideURL')}
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
          userProvideRegion={getEndpointField(endpointsConfig, endpoint, 'userProvideRegion')}
        />
      )}
    </ErrorBody>
  );
}
