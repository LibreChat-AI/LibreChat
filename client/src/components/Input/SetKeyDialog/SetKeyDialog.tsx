import React, { useState } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { EModelEndpoint, alternateName, isAssistantsEndpoint } from 'librechat-data-provider';
import {
  useRevokeUserKeyMutation,
  useRevokeAllUserKeysMutation,
} from 'librechat-data-provider/react-query';
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
import { logger } from '~/utils';

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
  THIRTY_MINUTES: { label: 'in 30 minutes', value: 30 * 60 * 1000 },
  TWO_HOURS: { label: 'in 2 hours', value: 2 * 60 * 60 * 1000 },
  TWELVE_HOURS: { label: 'in 12 hours', value: 12 * 60 * 60 * 1000 },
  ONE_DAY: { label: 'in 1 day', value: 24 * 60 * 60 * 1000 },
  ONE_WEEK: { label: 'in 7 days', value: 7 * 24 * 60 * 60 * 1000 },
  ONE_MONTH: { label: 'in 30 days', value: 30 * 24 * 60 * 60 * 1000 },
  NEVER: { label: 'never', value: 0 },
};

const RevokeKeysButton = ({
  endpoint,
  disabled,
  setDialogOpen,
}: {
  endpoint: string;
  disabled: boolean;
  setDialogOpen: (open: boolean) => void;
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

  return (
    <div className="flex items-center justify-between">
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogTrigger asChild>
          <Button
            variant="destructive"
            className="flex items-center justify-center rounded-lg transition-colors duration-200"
            onClick={() => setOpen(true)}
            disabled={disabled}
          >
            {localize('com_ui_revoke')}
          </Button>
        </OGDialogTrigger>
        <OGDialogContent className="max-w-[450px]">
          <OGDialogHeader>
            <OGDialogTitle>{localize('com_ui_revoke_key_endpoint', { 0: endpoint })}</OGDialogTitle>
          </OGDialogHeader>
          <div className="py-4">
            <Label className="text-left text-sm font-medium">
              {localize('com_ui_revoke_key_confirm')}
            </Label>
          </div>
          <OGDialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {localize('com_ui_cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={onClick}
              disabled={isLoading}
              className="bg-surface-destructive text-text-on-status transition-all duration-200 hover:bg-surface-destructive-hover"
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
}: Pick<TDialogProps, 'open' | 'onOpenChange'> & {
  endpoint: EModelEndpoint | string;
  endpointType?: EModelEndpoint;
  userProvideURL?: boolean | null;
  userProvideAccessKeyId?: boolean;
  userProvideSecretAccessKey?: boolean;
  userProvideSessionToken?: boolean;
  userProvideBearerToken?: boolean;
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
  const [expiresAtLabel, setExpiresAtLabel] = useState(EXPIRY.TWELVE_HOURS.label);
  const { getExpiry, saveUserKey } = useUserKey(endpoint);
  const { showToast } = useToastContext();
  const localize = useLocalize();

  const expirationOptions = Object.values(EXPIRY);
  const configuredEndpoint = endpointType ?? endpoint;

  const handleExpirationChange = (label: string) => {
    setExpiresAtLabel(label);
  };

  const submit = () => {
    const selectedOption = expirationOptions.find((option) => option.label === expiresAtLabel);
    let expiresAt: number | null;

    if (selectedOption?.value === 0) {
      expiresAt = null;
    } else {
      expiresAt = Date.now() + (selectedOption ? selectedOption.value : 0);
    }

    const saveKey = (key: string) => {
      try {
        saveUserKey(key, expiresAt);
        showToast({
          message: localize('com_ui_save_key_success'),
          status: NotificationSeverity.SUCCESS,
        });
        onOpenChange(false);
      } catch (error) {
        logger.error('Error saving user key:', error);
        showToast({
          message: localize('com_ui_save_key_error'),
          status: NotificationSeverity.ERROR,
        });
      }
    };

    if (formSet.has(endpoint) || formSet.has(endpointType ?? '')) {
      // TODO: handle other user provided options besides baseURL and apiKey
      methods.handleSubmit((data) => {
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

        saveKey(JSON.stringify(userProvidedData));
        methods.reset();
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

    saveKey(userKey);
    setUserKey('');
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
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="w-11/12 max-w-2xl">
        <OGDialogHeader>
          <OGDialogTitle>
            {`${localize('com_endpoint_config_key_for')} ${alternateName[endpoint] ?? endpoint}`}
          </OGDialogTitle>
        </OGDialogHeader>
        <div className="grid w-full items-center gap-2 py-2">
          {currentExpiryLabel && (
            <small className="text-text-destructive">{currentExpiryLabel}</small>
          )}
          <Dropdown
            label={`${localize('com_endpoint_config_new_key_expiration')}: `}
            value={expiresAtLabel}
            onChange={handleExpirationChange}
            options={expirationOptions.map((option) => option.label)}
            sizeClasses="w-[185px]"
            portal={false}
          />
          <FormProvider {...methods}>
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
          </FormProvider>
          <HelpText endpoint={endpoint} />
        </div>
        <OGDialogFooter>
          <RevokeKeysButton
            endpoint={endpoint}
            disabled={!(expiryTime ?? '')}
            setDialogOpen={onOpenChange}
          />
          <Button variant="submit" onClick={submit}>
            {localize('com_ui_submit')}
          </Button>
        </OGDialogFooter>
      </OGDialogContent>
    </OGDialog>
  );
};

export default SetKeyDialog;
