import React from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import { useFormContext, Controller } from 'react-hook-form';
import { useLocalize } from '~/hooks';
import InputWithLabel from './InputWithLabel';

const BedrockConfig = ({
  userProvideAccessKeyId,
  userProvideSecretAccessKey,
  userProvideSessionToken,
  userProvideBearerToken,
}: {
  endpoint: EModelEndpoint | string;
  userProvideURL?: boolean | null;
  userProvideAccessKeyId?: boolean;
  userProvideSecretAccessKey?: boolean;
  userProvideSessionToken?: boolean;
  userProvideBearerToken?: boolean;
}) => {
  const { control } = useFormContext();
  const localize = useLocalize();

  const renderFields = () => {
    const fields: React.ReactNode[] = [];

    if (userProvideAccessKeyId) {
      fields.push(
        <Controller
          key="bedrockAccessKeyId"
          name="bedrockAccessKeyId"
          control={control}
          render={({ field }) => (
            <InputWithLabel
              id="bedrockAccessKeyId"
              {...field}
              label={localize('com_endpoint_config_bedrock_access_key_id')}
              labelClassName="mb-1"
              inputClassName="mb-2"
            />
          )}
        />,
      );
    }

    if (userProvideSecretAccessKey) {
      if (fields.length > 0) fields.push(<div key="spacer1" className="mt-3" />);
      fields.push(
        <Controller
          key="bedrockSecretAccessKey"
          name="bedrockSecretAccessKey"
          control={control}
          render={({ field }) => (
            <InputWithLabel
              id="bedrockSecretAccessKey"
              {...field}
              label={localize('com_endpoint_config_bedrock_secret_access_key')}
              labelClassName="mb-1"
              inputClassName="mb-2"
            />
          )}
        />,
      );
    }

    if (userProvideSessionToken) {
      if (fields.length > 0) fields.push(<div key="spacer2" className="mt-3" />);
      fields.push(
        <Controller
          key="bedrockSessionToken"
          name="bedrockSessionToken"
          control={control}
          render={({ field }) => (
            <InputWithLabel
              id="bedrockSessionToken"
              {...field}
              label={localize('com_endpoint_config_bedrock_session_token')}
              labelClassName="mb-1"
              inputClassName="mb-2"
            />
          )}
        />,
      );
    }

    if (userProvideBearerToken) {
      if (fields.length > 0) fields.push(<div key="spacer3" className="mt-3" />);
      fields.push(
        <Controller
          key="bedrockBearerToken"
          name="bedrockBearerToken"
          control={control}
          render={({ field }) => (
            <InputWithLabel
              id="bedrockBearerToken"
              {...field}
              label={localize('com_endpoint_config_bedrock_bearer_token')}
              labelClassName="mb-1"
              inputClassName="mb-2"
            />
          )}
        />,
      );
    }

    return <>{fields}</>;
  };

  return <form className="flex-wrap">{renderFields()}</form>;
};

export default BedrockConfig;
