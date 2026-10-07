import { useMemo, memo } from 'react';
import { getEndpointField } from 'librechat-data-provider';
import type { Assistant, Agent } from 'librechat-data-provider';
import type { TMessageIcon } from '~/common';
import ConvoIconURL from '~/components/Endpoints/ConvoIconURL';
import { useShareContext } from '~/Providers/ShareContext';
import { useGetEndpointsQuery } from '~/data-provider';
import Icon from '~/components/Endpoints/Icon';
import { isImageURL } from '~/utils/icons';
import { getIconEndpoint } from '~/utils';

type MessageIconProps = {
  iconData?: TMessageIcon;
  assistant?: Assistant;
  agent?: Agent;
};

/**
 * Compares only the fields MessageIcon actually renders.
 * `agent.id` / `assistant.id` are intentionally omitted because
 * this component renders display properties only, not identity-derived content.
 */
export function arePropsEqual(prev: MessageIconProps, next: MessageIconProps): boolean {
  const checks: [unknown, unknown][] = [
    [prev.iconData?.endpoint, next.iconData?.endpoint],
    [prev.iconData?.model, next.iconData?.model],
    [prev.iconData?.iconURL, next.iconData?.iconURL],
    [prev.iconData?.modelLabel, next.iconData?.modelLabel],
    [prev.iconData?.isCreatedByUser, next.iconData?.isCreatedByUser],
    [prev.agent?.name, next.agent?.name],
    [prev.agent?.avatar?.filepath, next.agent?.avatar?.filepath],
    [prev.assistant?.name, next.assistant?.name],
    [prev.assistant?.metadata?.avatar, next.assistant?.metadata?.avatar],
  ];

  for (const [prevVal, nextVal] of checks) {
    if (prevVal !== nextVal) {
      return false;
    }
  }
  return true;
}

const MessageIcon = memo(({ iconData, assistant, agent }: MessageIconProps) => {
  const { isSharedConvo } = useShareContext();
  const { data: endpointsConfig } = useGetEndpointsQuery({ enabled: isSharedConvo !== true });

  const agentName = agent?.name ?? '';
  const agentAvatar = agent?.avatar?.filepath ?? '';
  const assistantName = assistant?.name ?? '';
  const assistantAvatar = assistant?.metadata?.avatar ?? '';
  let avatarURL = '';
  if (assistant) {
    avatarURL = assistantAvatar;
  } else if (agent) {
    avatarURL = agentAvatar;
  }

  const iconURL = iconData?.iconURL;
  const endpoint = useMemo(
    () => getIconEndpoint({ endpointsConfig, iconURL, endpoint: iconData?.endpoint }),
    [endpointsConfig, iconURL, iconData?.endpoint],
  );

  const endpointIconURL = useMemo(
    () => getEndpointField(endpointsConfig, endpoint, 'iconURL'),
    [endpointsConfig, endpoint],
  );

  if (iconData?.isCreatedByUser !== true && isImageURL(iconURL)) {
    return (
      <ConvoIconURL
        iconURL={iconURL}
        modelLabel={iconData?.modelLabel}
        context="message"
        assistantAvatar={assistantAvatar}
        agentAvatar={agentAvatar}
        assistantName={assistantName}
        agentName={agentName}
      />
    );
  }

  return (
    <Icon
      isCreatedByUser={iconData?.isCreatedByUser ?? false}
      endpoint={endpoint}
      iconURL={avatarURL || endpointIconURL}
      endpointsConfig={endpointsConfig}
      model={iconData?.model}
      assistantName={assistantName}
      agentName={agentName}
      size={28.8}
    />
  );
}, arePropsEqual);

MessageIcon.displayName = 'MessageIcon';

export default MessageIcon;
