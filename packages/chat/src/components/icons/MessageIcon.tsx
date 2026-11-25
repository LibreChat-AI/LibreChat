import { useMemo, memo } from 'react';
import { getEndpointField } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { NamedExoticComponent, ReactNode } from 'react';
import type { MessageIconProps } from '../../react/messages/host';
import { useMessagesHost, setDefaultMessageIcon } from '../../react/messages/host';
import { getIconEndpoint, isImageURL } from '../../core/icons';
import ConvoIconURL from './ConvoIconURL';
import Icon from './Icon';

const noEndpointsConfig = (): TEndpointsConfig | undefined => undefined;

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

function MessageIconBody({ iconData, assistant, agent }: MessageIconProps): ReactNode {
  const { useEndpointsConfig = noEndpointsConfig } = useMessagesHost();
  const endpointsConfig = useEndpointsConfig() ?? undefined;

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
}

/**
 * A message author's icon: an image the message names, the agent's or assistant's avatar, the
 * endpoint's configured image, the provider's icon, or for a prompt the signed-in user's avatar.
 */
const MessageIcon: NamedExoticComponent<MessageIconProps> = memo(MessageIconBody, arePropsEqual);
MessageIcon.displayName = 'MessageIcon';

export default MessageIcon;

/** How a row draws an author's icon when the host names no renderer: `MessageIcon`. */
export function renderMessageIcon(props: MessageIconProps): ReactNode {
  return <MessageIcon {...props} />;
}

setDefaultMessageIcon(renderMessageIcon);
