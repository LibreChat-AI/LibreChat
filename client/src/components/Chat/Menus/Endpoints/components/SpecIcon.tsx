import React, { memo } from 'react';
import { pxToRem, ProviderIcon } from '@librechat/client';
import type { TModelSpec, TEndpointsConfig } from 'librechat-data-provider';
import { EntityEndpointMark, isEntityEndpoint } from '~/components/Endpoints/EntityEndpointMark';
import { URLIcon } from '~/components/Endpoints/URLIcon';
import { useProviderIcon } from '~/hooks/Endpoint';
import { getModelSpecIconURL } from '~/utils';

interface SpecIconProps {
  currentSpec: TModelSpec;
  endpointsConfig: TEndpointsConfig;
  /** Avatar of the agent this spec targets, used when the spec defines no icon of its own. */
  agentAvatarURL?: string;
}

const SpecIcon: React.FC<SpecIconProps> = ({ currentSpec, endpointsConfig, agentAvatarURL }) => {
  const iconURL = getModelSpecIconURL(currentSpec, agentAvatarURL);
  const endpoint = currentSpec.preset?.endpoint;
  const { provider, imageURL } = useProviderIcon({ endpoint, endpointsConfig, iconURL });
  const { provider: fallbackProvider } = useProviderIcon({ endpoint, endpointsConfig });

  if (imageURL) {
    return (
      <URLIcon
        iconURL={imageURL}
        altName={currentSpec.name}
        containerStyle={{ width: pxToRem(20), height: pxToRem(20) }}
        className="icon-md shrink-0 overflow-hidden rounded-full"
        provider={fallbackProvider}
      />
    );
  }

  if (isEntityEndpoint(iconURL || endpoint)) {
    return <EntityEndpointMark endpoint={iconURL || endpoint} />;
  }

  return (
    <ProviderIcon
      provider={provider}
      model={currentSpec.preset?.model}
      size={20}
      className="icon-md shrink-0"
    />
  );
};

export default memo(SpecIcon);
