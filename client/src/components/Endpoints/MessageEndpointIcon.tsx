import { memo } from 'react';
import { Feather } from 'lucide-react';
import { EModelEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import { AssistantIcon, TooltipAnchor, ProviderAvatar } from '@librechat/client';
import type { IconProps } from '~/common';
import { useProviderIcon } from '~/hooks/Endpoint';
import { cn } from '~/utils';

const MessageEndpointIcon: React.FC<IconProps> = (props) => {
  const {
    error,
    iconURL = '',
    endpoint,
    size = 30,
    model = '',
    assistantName,
    agentName,
    endpointsConfig,
  } = props;
  const { provider, imageURL } = useProviderIcon({ endpoint, iconURL, endpointsConfig });

  const assistantsIcon = {
    icon: iconURL ? (
      <div className="relative flex h-6 w-6 items-center justify-center">
        <TooltipAnchor
          description={assistantName ?? ''}
          style={{
            width: size,
            height: size,
          }}
          className={cn('overflow-hidden rounded-full', props.className ?? '')}
        >
          <img
            className="shadow-stroke h-full w-full object-cover"
            src={iconURL}
            alt={assistantName}
            style={{ height: '80', width: '80' }}
          />
        </TooltipAnchor>
      </div>
    ) : (
      <div className="h-6 w-6">
        <div className="shadow-stroke flex h-6 w-6 items-center justify-center overflow-hidden rounded-full">
          <AssistantIcon className="h-2/3 w-2/3 text-text-tertiary" />
        </div>
      </div>
    ),
    name: endpoint,
  };

  const agentsIcon = {
    icon: iconURL ? (
      <div className="relative flex h-6 w-6 items-center justify-center">
        <TooltipAnchor
          description={agentName ?? ''}
          style={{
            width: size,
            height: size,
          }}
          className={cn('overflow-hidden rounded-full', props.className ?? '')}
        >
          <img
            className="shadow-stroke h-full w-full object-cover"
            src={iconURL}
            alt={agentName}
            style={{ height: '80', width: '80' }}
          />
        </TooltipAnchor>
      </div>
    ) : (
      <div className="h-6 w-6">
        <div className="shadow-stroke flex h-6 w-6 items-center justify-center overflow-hidden rounded-full">
          <Feather className="h-2/3 w-2/3 text-text-tertiary" aria-hidden="true" />
        </div>
      </div>
    ),
    name: endpoint,
  };

  const errorBadge = error === true && (
    <span className="absolute right-0 top-[20px] -mr-2 flex h-3 w-3 items-center justify-center rounded-full border border-surface-primary bg-status-error-strong text-[10px] text-text-on-status">
      !
    </span>
  );

  if (isAssistantsEndpoint(endpoint)) {
    return assistantsIcon.icon;
  }

  if (endpoint === EModelEndpoint.agents) {
    return agentsIcon.icon;
  }

  if (imageURL != null) {
    return (
      <div
        title={endpoint ?? ''}
        style={{
          width: size,
          height: size,
        }}
        className={cn(
          'relative flex h-9 w-9 items-center justify-center rounded-sm p-1 text-text-primary',
          props.className ?? '',
        )}
      >
        <div className="h-6 w-6">
          <div className="overflow-hidden rounded-full">
            <img className="h-full w-full object-contain" src={imageURL} alt={`${endpoint} Icon`} />
          </div>
        </div>
        {errorBadge}
      </div>
    );
  }

  return (
    <ProviderAvatar provider={provider} model={model} size={size} className={props.className}>
      {errorBadge}
    </ProviderAvatar>
  );
};

export default memo(MessageEndpointIcon);
