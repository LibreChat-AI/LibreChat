import React from 'react';
import type { TConfigProps } from '~/common';
import InputWithLabel from './InputWithLabel';
import { useLocalize } from '~/hooks';

const OtherConfig = ({ userKey, setUserKey, endpoint }: TConfigProps) => {
  const localize = useLocalize();
  return (
    <InputWithLabel
      id={endpoint}
      value={userKey ?? ''}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUserKey(e.target.value ?? '')}
      label={localize('com_endpoint_config_key_name')}
      secret
    />
  );
};

export default OtherConfig;
