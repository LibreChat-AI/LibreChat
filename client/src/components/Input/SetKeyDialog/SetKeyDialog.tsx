import React, { useEffect, useRef, useState } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import {
  useRevokeUserKeyMutation,
  useRevokeAllUserKeysMutation,
} from 'librechat-data-provider/react-query';
import {
  AuthKeys,
  isValidProviderBaseURL,
  EModelEndpoint,
  alternateName,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import {
  Label,
  Button,
  Spinner,
  OGDialog,
  Dropdown,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogFooter,
  OGDialogContent,
  useToastContext,
  OGDialogTrigger,
} from '@librechat/client';
import type { MediaUserKey } from 'librechat-data-provider';
import type { TDialogProps } from '~/common';
import { useUserKey, useLocalize, useClockFormat } from '~/hooks';
import { NotificationSeverity } from '~/common';
import { formatKeyExpiryLabel } from './utils';
import CustomConfig from './CustomEndpoint';
import BedrockConfig from './BedrockConfig';
import GoogleConfig from './GoogleConfig';
import OpenAIConfig from './OpenAIConfig';
import OtherConfig from './OtherConfig';
import HelpText from './HelpText';

const endpointComponents = {
  [EModelEndpoint.google]: GoogleConfig,
  [EModelEndpoint.openAI]: OpenAIConfig,
  [EModelEndpoint.custom]: CustomConfig,
  [EModelEndpoint.azureOpenAI]: OpenAIConfig,
  [EModelEndpoint.assistants]: OpenAIConfig,
  [EModelEndpoint.azureAssistants]: OpenAIConfig,
  [EModelEndpoint.bedrock]: BedrockConfig,
  default: OtherConfig,
};

const formSet: Set<string> = new Set([
  EModelEndpoint.openAI,
  EModelEndpoint.custom,
  EModelEndpoint.azureOpenAI,
  EModelEndpoint.assistants,
  EModelEndpoint.azureAssistants,
  EModelEndpoint.bedrock,
]);

const EXPIRY = {
  THIRTY_MINUTES: { label: 'com_endpoint_config_expiry_30_minutes', value: 30 * 60 * 1000 },
  TWO_HOURS: { label: 'com_endpoint_config_expiry_2_hours', value: 2 * 60 * 60 * 1000 },
  TWELVE_HOURS: { label: 'com_endpoint_config_expiry_12_hours', value: 12 * 60 * 60 * 1000 },
  ONE_DAY: { label: 'com_endpoint_config_expiry_1_day', value: 24 * 60 * 60 * 1000 },
  ONE_WEEK: { label: 'com_endpoint_config_expiry_7_days', value: 7 * 24 * 60 * 60 * 1000 },
  ONE_MONTH: { label: 'com_endpoint_config_expiry_30_days', value: 30 * 24 * 60 * 60 * 1000 },
  NEVER: { label: 'com_ui_api_key_expire_never', value: 0 },
} as const;

const RevokeKeysButton = ({
  endpoint,
  label,
  disabled,
  setDialogOpen,
  onPendingChange,
}: {
  endpoint: string;
  label: string;
  disabled: boolean;
  setDialogOpen: (open: boolean) => void;
  onPendingChange: (pending: boolean) => void;
}) => {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const { showToast } = useToastContext();
  const revokeKeyMutation = useRevokeUserKeyMutation(endpoint);
  const revokeKeysMutation = useRevokeAllUserKeysMutation();

  const handleSuccess = () => {
    showToast({
      message: localize('com_ui_revoke_key_success'),
      status: NotificationSeverity.SUCCESS,
    });

    if (!setDialogOpen) {
      return;
    }

    setDialogOpen(false);
  };

  const handleError = () => {
    showToast({
      message: localize('com_ui_revoke_key_error'),
      status: NotificationSeverity.ERROR,
    });
  };

  const onClick = () => {
    revokeKeyMutation.mutate(
      {},
      {
        onSuccess: handleSuccess,
        onError: handleError,
      },
    );
  };

  const isLoading = revokeKeyMutation.isLoading || revokeKeysMutation.isLoading;
  useEffect(() => {
    onPendingChange(isLoading);
  }, [isLoading, onPendingChange]);

  return (
    <div className="flex items-center justify-between">
      <OGDialog
        open={open}
        onOpenChange={(next) => {
          if (!isLoading) setOpen(next);
        }}
      >
        <OGDialogTrigger asChild>
          <Button
            variant="destructive"
            className="flex items-center justify-center rounded-lg transition-colors duration-200"
            onClick={() => setOpen(true)}
            disabled={disabled || isLoading}
          >
            {localize('com_ui_revoke')}
          </Button>
        </OGDialogTrigger>
        <OGDialogContent className="max-w-[450px]">
          <OGDialogHeader>
            <OGDialogTitle>{localize('com_ui_revoke_key_endpoint', { 0: label })}</OGDialogTitle>
          </OGDialogHeader>
          <div className="py-4">
            <Label className="text-left text-sm font-medium">
              {localize('com_ui_revoke_key_confirm')}
            </Label>
          </div>
          <OGDialogFooter>
            <Button variant="outline" disabled={isLoading} onClick={() => setOpen(false)}>
              {localize('com_ui_cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={onClick}
              disabled={isLoading}
              className="bg-surface-destructive text-text-on-status hover:bg-surface-destructive-hover transition-all duration-200"
            >
              {isLoading ? <Spinner /> : localize('com_ui_revoke')}
            </Button>
          </OGDialogFooter>
        </OGDialogContent>
      </OGDialog>
    </div>
  );
};

const SetKeyDialog = ({
  open,
  onOpenChange,
  endpoint,
  endpointType,
  userProvideURL,
  userProvideAccessKeyId,
  userProvideSecretAccessKey,
  userProvideSessionToken,
  userProvideBearerToken,
  keyConfiguration,
  label,
  onCloseAutoFocus,
}: Pick<TDialogProps, 'open' | 'onOpenChange'> & {
  endpoint: EModelEndpoint | string;
  endpointType?: EModelEndpoint;
  userProvideURL?: boolean | null;
  userProvideAccessKeyId?: boolean;
  userProvideSecretAccessKey?: boolean;
  userProvideSessionToken?: boolean;
  userProvideBearerToken?: boolean;
  keyConfiguration?: MediaUserKey & { label: string };
  label?: string;
  onCloseAutoFocus?: (event: Event) => void;
}) => {
  const methods = useForm({
    defaultValues: {
      apiKey: '',
      baseURL: '',
      azureOpenAIApiKey: '',
      azureOpenAIApiInstanceName: '',
      azureOpenAIApiDeploymentName: '',
      azureOpenAIApiVersion: '',
      bedrockAccessKeyId: '',
      bedrockSecretAccessKey: '',
      bedrockSessionToken: '',
      bedrockBearerToken: '',
      // TODO: allow endpoint definitions from user
      // name: '',
      // TODO: add custom endpoint models defined by user
      // models: '',
    },
  });

  const [userKey, setUserKey] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const submitting = useRef(false);
  const [expiresAfter, setExpiresAfter] = useState<number>(EXPIRY.TWELVE_HOURS.value);
  const { getExpiry, saveUserKey, keyName, isSaving, isFetching, isError, refetch } = useUserKey(
    endpoint,
    { keyName: keyConfiguration?.keyName, enabled: open },
  );
  const { showToast } = useToastContext();
  const localize = useLocalize();

  const expirationOptions = Object.values(EXPIRY).map((option) => ({
    ...option,
    label: localize(option.label),
  }));
  const configuredEndpoint = endpointType ?? endpoint;
  const displayName = label ?? keyConfiguration?.label ?? alternateName[endpoint] ?? endpoint;
  const pending = isSaving || revoking || methods.formState.isSubmitting;
  useEffect(() => {
    if (open) return;
    methods.reset();
    setUserKey('');
    setSaveError(false);
  }, [open, methods]);

  const handleExpirationChange = (label: string) => {
    const option = expirationOptions.find((item) => item.label === label);
    if (option) setExpiresAfter(option.value);
  };

  const submitRequest = async () => {
    if (pending) return;
    setSaveError(false);
    const selectedOption = expirationOptions.find((option) => option.value === expiresAfter);
    let expiresAt: number | null;

    if (selectedOption?.value === 0) {
      expiresAt = null;
    } else {
      expiresAt = Date.now() + (selectedOption ? selectedOption.value : 0);
    }

    const saveKey = async (key: string) => {
      try {
        await saveUserKey(key, expiresAt);
        showToast({
          message: localize('com_ui_save_key_success'),
          status: NotificationSeverity.SUCCESS,
        });
        onOpenChange(false);
        return true;
      } catch {
        setSaveError(true);
        showToast({
          message: localize('com_ui_save_key_error'),
          status: NotificationSeverity.ERROR,
        });
        return false;
      }
    };

    if (keyConfiguration) {
      await methods.handleSubmit(async ({ apiKey, baseURL }) => {
        const value = apiKey.trim();
        if (!value) {
          methods.setError(
            'apiKey',
            { message: localize('com_ui_key_required') },
            { shouldFocus: true },
          );
          return;
        }
        const url = baseURL.trim();
        if (keyConfiguration.userProvideURL) {
          if (!isValidProviderBaseURL(url)) {
            methods.setError(
              'baseURL',
              { message: localize('com_endpoint_config_url_invalid') },
              { shouldFocus: true },
            );
            return;
          }
        }
        const credentials = {
          [keyConfiguration.encoding === 'google' ? AuthKeys.GOOGLE_API_KEY : 'apiKey']: value,
          ...(keyConfiguration.userProvideURL ? { baseURL: url } : {}),
        };
        if (await saveKey(JSON.stringify(credentials))) methods.reset();
      })();
      return;
    }

    if (formSet.has(endpoint) || formSet.has(endpointType ?? '')) {
      // TODO: handle other user provided options besides baseURL and apiKey
      await methods.handleSubmit(async (data) => {
        const isAzure = configuredEndpoint === EModelEndpoint.azureOpenAI;
        const isBedrock = configuredEndpoint === EModelEndpoint.bedrock;
        const isOpenAIBase =
          isAzure ||
          configuredEndpoint === EModelEndpoint.openAI ||
          isAssistantsEndpoint(configuredEndpoint);
        if (isAzure) {
          data.apiKey = 'n/a';
        }

        const emptyValues = Object.keys(data).filter((key) => {
          if (!isAzure && key.startsWith('azure')) {
            return false;
          }
          if (!isBedrock && key.startsWith('bedrock')) {
            return false;
          }
          if (isOpenAIBase && key === 'baseURL') {
            return false;
          }
          if (key === 'baseURL' && !(userProvideURL ?? false)) {
            return false;
          }
          return data[key] === '';
        });

        if (isBedrock) {
          const bearerToken = userProvideBearerToken ? data.bedrockBearerToken?.trim() : '';
          const accessKeyId = userProvideAccessKeyId ? data.bedrockAccessKeyId?.trim() : '';
          const secretAccessKey = userProvideSecretAccessKey
            ? data.bedrockSecretAccessKey?.trim()
            : '';
          const sessionToken = userProvideSessionToken ? data.bedrockSessionToken?.trim() : '';
          const accessKeyIdLabel = localize('com_endpoint_config_bedrock_access_key_id');
          const secretAccessKeyLabel = localize('com_endpoint_config_bedrock_secret_access_key');
          const sessionTokenLabel = localize('com_endpoint_config_bedrock_session_token');
          const bearerTokenLabel = localize('com_endpoint_config_bedrock_bearer_token');
          const canSubmitBearerToken = !!bearerToken;
          const hasUserProvidedAccessKeyAuth =
            !!userProvideAccessKeyId || !!userProvideSecretAccessKey || !!userProvideSessionToken;
          const missingFields = [
            !canSubmitBearerToken && !hasUserProvidedAccessKeyAuth && userProvideBearerToken
              ? bearerTokenLabel
              : '',
            !canSubmitBearerToken && userProvideAccessKeyId && !accessKeyId ? accessKeyIdLabel : '',
            !canSubmitBearerToken && userProvideSecretAccessKey && !secretAccessKey
              ? secretAccessKeyLabel
              : '',
            !canSubmitBearerToken && userProvideSessionToken && !sessionToken
              ? sessionTokenLabel
              : '',
          ].filter(Boolean);

          if (!canSubmitBearerToken && missingFields.length > 0) {
            showToast({
              message: `${localize('com_endpoint_config_required_fields')} ${missingFields.join(', ')}`,
              status: NotificationSeverity.ERROR,
            });
            onOpenChange(true);
            return;
          }

          if (!canSubmitBearerToken && !hasUserProvidedAccessKeyAuth) {
            showToast({
              message: localize('com_endpoint_config_bedrock_credentials_required'),
              status: NotificationSeverity.ERROR,
            });
            onOpenChange(true);
            return;
          }
        } else if (emptyValues.length > 0) {
          showToast({
            message: `${localize('com_endpoint_config_required_fields')} ${emptyValues.join(', ')}`,
            status: NotificationSeverity.ERROR,
          });
          onOpenChange(true);
          return;
        }

        const {
          apiKey,
          baseURL,
          bedrockAccessKeyId,
          bedrockSecretAccessKey,
          bedrockSessionToken,
          bedrockBearerToken,
          ...azureOptions
        } = data;
        const userProvidedData = { apiKey, baseURL };
        if (isAzure) {
          userProvidedData.apiKey = JSON.stringify({
            azureOpenAIApiKey: azureOptions.azureOpenAIApiKey,
            azureOpenAIApiInstanceName: azureOptions.azureOpenAIApiInstanceName,
            azureOpenAIApiDeploymentName: azureOptions.azureOpenAIApiDeploymentName,
            azureOpenAIApiVersion: azureOptions.azureOpenAIApiVersion,
          });
        } else if (isBedrock) {
          const bearerToken = userProvideBearerToken ? bedrockBearerToken.trim() : '';
          const accessKeyId = userProvideAccessKeyId ? bedrockAccessKeyId.trim() : '';
          const secretAccessKey = userProvideSecretAccessKey ? bedrockSecretAccessKey.trim() : '';
          const sessionToken = userProvideSessionToken ? bedrockSessionToken.trim() : '';

          if (bearerToken) {
            userProvidedData.apiKey = JSON.stringify({
              bearerToken,
            });
          } else {
            userProvidedData.apiKey = JSON.stringify({
              ...(accessKeyId && { accessKeyId }),
              ...(secretAccessKey && { secretAccessKey }),
              ...(sessionToken && { sessionToken }),
            });
          }
        }

        if (await saveKey(JSON.stringify(userProvidedData))) methods.reset();
      })();
      return;
    }

    if (!userKey.trim()) {
      showToast({
        message: localize('com_ui_key_required'),
        status: NotificationSeverity.ERROR,
      });
      return;
    }

    if (configuredEndpoint === EModelEndpoint.google && userProvideURL) {
      let baseURL = '';
      try {
        const credentials: { baseURL?: string } = JSON.parse(userKey);
        baseURL = credentials.baseURL ?? '';
      } catch {
        baseURL = '';
      }
      if (!isValidProviderBaseURL(baseURL)) {
        showToast({
          message: localize('com_endpoint_config_url_invalid'),
          status: NotificationSeverity.ERROR,
        });
        return;
      }
    }

    if (await saveKey(userKey)) setUserKey('');
  };
  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    try {
      await submitRequest();
    } finally {
      submitting.current = false;
    }
  };

  const EndpointComponent = endpointComponents[configuredEndpoint] ?? endpointComponents['default'];
  const expiryTime = getExpiry();
  const hour12 = useClockFormat();
  let currentExpiryLabel: string | null = null;
  if (expiryTime === 'never') {
    currentExpiryLabel = localize('com_endpoint_config_key_never_expires');
  } else if (expiryTime !== undefined) {
    currentExpiryLabel = formatKeyExpiryLabel(localize, expiryTime, hour12);
  }

  return (
    <OGDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <OGDialogContent className="w-11/12 max-w-2xl" onCloseAutoFocus={onCloseAutoFocus}>
        <OGDialogHeader>
          <OGDialogTitle>
            {`${localize('com_endpoint_config_key_for')} ${displayName}`}
          </OGDialogTitle>
        </OGDialogHeader>
        <div className="grid w-full items-center gap-2 py-2">
          {keyConfiguration && (
            <p className="text-text-secondary text-sm">{localize('com_media_provider_key_help')}</p>
          )}
          {isFetching && (
            <p role="status" className="text-text-secondary text-sm">
              {localize('com_ui_loading')}
            </p>
          )}
          {isError && (
            <div role="alert" className="text-text-destructive text-sm">
              {localize('com_endpoint_config_status_error')}
              <Button variant="link" onClick={() => void refetch()}>
                {localize('com_ui_retry')}
              </Button>
            </div>
          )}
          {saveError && (
            <p role="alert" className="text-text-destructive text-sm">
              {localize('com_ui_save_key_error')}
            </p>
          )}
          {currentExpiryLabel && (
            <small className="text-text-destructive">{currentExpiryLabel}</small>
          )}
          <Dropdown
            label={`${localize('com_endpoint_config_new_key_expiration')}: `}
            value={expirationOptions.find((option) => option.value === expiresAfter)?.label ?? ''}
            onChange={handleExpirationChange}
            options={expirationOptions.map((option) => option.label)}
            sizeClasses="w-[185px]"
            portal={false}
          />
          <fieldset
            disabled={pending}
            onSubmitCapture={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <FormProvider {...methods}>
              {keyConfiguration ? (
                <CustomConfig
                  endpoint={displayName}
                  userProvideURL={keyConfiguration.userProvideURL}
                />
              ) : (
                <EndpointComponent
                  userKey={userKey}
                  endpoint={endpoint}
                  setUserKey={setUserKey}
                  userProvideURL={userProvideURL}
                  userProvideAccessKeyId={userProvideAccessKeyId}
                  userProvideSecretAccessKey={userProvideSecretAccessKey}
                  userProvideSessionToken={userProvideSessionToken}
                  userProvideBearerToken={userProvideBearerToken}
                />
              )}
            </FormProvider>
          </fieldset>
          {!keyConfiguration && <HelpText endpoint={endpoint} />}
        </div>
        <OGDialogFooter>
          <RevokeKeysButton
            endpoint={keyName}
            label={displayName}
            disabled={pending || isFetching || !(expiryTime ?? '')}
            setDialogOpen={onOpenChange}
            onPendingChange={setRevoking}
          />
          <Button variant="submit" onClick={submit} disabled={pending}>
            {pending && <Spinner className="mr-2" />}
            {localize('com_ui_submit')}
          </Button>
        </OGDialogFooter>
      </OGDialogContent>
    </OGDialog>
  );
};

export default SetKeyDialog;
