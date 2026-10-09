import React from 'react';
import { object, string } from 'zod';
import { Label } from '@librechat/client';
import { AuthKeys } from 'librechat-data-provider';
import type { TConfigProps } from '~/common';
import FileUpload from '~/components/Chat/Input/Files/FileUpload';
import { useLocalize, useMultipleKeys } from '~/hooks';
import InputWithLabel from './InputWithLabel';

const CredentialsSchema = object({
  client_email: string().email().min(3),
  project_id: string().min(3),
  private_key: string().min(601),
});

const validateCredentials = (credentials: Record<string, unknown>) => {
  const result = CredentialsSchema.safeParse(credentials);
  return result.success;
};

const GoogleConfig = ({ userKey, setUserKey }: Pick<TConfigProps, 'userKey' | 'setUserKey'>) => {
  const localize = useLocalize();
  const { getMultiKey, setMultiKey } = useMultipleKeys(setUserKey);

  return (
    <>
      <div className="flex flex-row">
        <Label htmlFor={AuthKeys.GOOGLE_SERVICE_KEY} className="text-left text-sm font-medium">
          {localize('com_endpoint_config_google_service_key')}
        </Label>
        <Label className="mx-1 text-right text-sm text-text-secondary">
          {localize('com_endpoint_config_google_cloud_platform')}
        </Label>
        <br />
      </div>
      <FileUpload
        id={AuthKeys.GOOGLE_SERVICE_KEY}
        className="w-full"
        containerClassName="bg-surface-secondary h-10 max-h-10 w-full resize-none py-2"
        text={localize('com_endpoint_config_key_import_json_key')}
        successText={localize('com_endpoint_config_key_import_json_key_success')}
        invalidText={localize('com_endpoint_config_key_import_json_key_invalid')}
        validator={validateCredentials}
        onFileSelected={(data) => {
          setMultiKey(AuthKeys.GOOGLE_SERVICE_KEY, JSON.stringify(data), userKey);
        }}
      />
      <InputWithLabel
        id={AuthKeys.GOOGLE_API_KEY}
        value={getMultiKey(AuthKeys.GOOGLE_API_KEY, userKey) ?? ''}
        onChange={(e: { target: { value: string } }) =>
          setMultiKey(AuthKeys.GOOGLE_API_KEY, e.target.value ?? '', userKey)
        }
        label={localize('com_endpoint_config_google_api_key')}
        subLabel={localize('com_endpoint_config_google_gemini_api')}
        secret
      />
    </>
  );
};

export default GoogleConfig;
