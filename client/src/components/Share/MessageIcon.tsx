import { useMemo } from 'react';
import { UserIcon } from '@librechat/client';
import type { TMessage, Assistant, Agent } from 'librechat-data-provider';
import type { TMessageProps } from '~/common';
import MessageEndpointIcon from '../Endpoints/MessageEndpointIcon';
import ConvoIconURL from '~/components/Endpoints/ConvoIconURL';
import { getIconEndpoint, logger } from '~/utils';
import { isImageURL } from '~/utils/icons';

export default function MessageIcon(
  props: Pick<TMessageProps, 'message' | 'conversation'> & {
    assistant?: false | Assistant;
    agent?: false | Agent;
  },
) {
  const { message, conversation, assistant, agent } = props;

  const messageSettings = useMemo(
    () => ({
      ...(conversation ?? {}),
      ...({
        ...message,
        iconURL: message?.iconURL ?? '',
      } as TMessage),
    }),
    [conversation, message],
  );

  const iconURL = messageSettings.iconURL ?? '';
  let endpoint = messageSettings.endpoint;
  endpoint = getIconEndpoint({ endpointsConfig: undefined, iconURL, endpoint });
  const assistantName = (assistant ? assistant.name : '') ?? '';
  const assistantAvatar = (assistant ? assistant.metadata?.avatar : '') ?? '';
  const agentName = (agent ? agent.name : '') ?? '';
  const agentAvatar = (agent ? agent?.avatar?.filepath : '') ?? '';
  const avatarURL = useMemo(() => {
    let result = '';
    if (assistant) {
      result = assistantAvatar;
    } else if (agent) {
      result = agentAvatar;
    }
    return result;
  }, [assistant, agent, assistantAvatar, agentAvatar]);
  logger.log('MessageIcon', {
    endpoint,
    iconURL,
    assistantName,
    assistantAvatar,
    agentName,
    agentAvatar,
  });
  if (message?.isCreatedByUser !== true && isImageURL(iconURL)) {
    return (
      <ConvoIconURL
        iconURL={iconURL}
        modelLabel={messageSettings.chatGptLabel ?? messageSettings.modelLabel ?? ''}
        context="message"
        assistantAvatar={assistantAvatar}
        assistantName={assistantName}
        agentAvatar={agentAvatar}
        agentName={agentName}
      />
    );
  }

  if (message?.isCreatedByUser === true) {
    return (
      <div
        style={{
          width: '20px',
          height: '20px',
        }}
        className="bg-avatar-fill text-avatar-text ring-avatar-edge/10 relative flex h-9 w-9 items-center justify-center rounded-sm p-1 ring-1"
      >
        <UserIcon />
      </div>
    );
  }

  return (
    <MessageEndpointIcon
      {...messageSettings}
      endpoint={endpoint}
      iconURL={avatarURL}
      model={message?.model ?? conversation?.model}
      assistantName={assistantName}
      agentName={agentName}
      size={28.8}
    />
  );
}
