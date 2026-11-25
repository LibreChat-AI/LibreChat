import type {
  EModelEndpoint,
  TConversation,
  TEndpointsConfig,
  TMessage,
} from 'librechat-data-provider';

/** What an author or endpoint icon is drawn from. */
export type IconProps = Pick<TMessage, 'isCreatedByUser' | 'model'> &
  Pick<TConversation, 'chatGptLabel' | 'modelLabel'> & {
    size?: number;
    button?: boolean;
    iconURL?: string;
    message?: boolean;
    className?: string;
    iconClassName?: string;
    endpoint?: EModelEndpoint | string | null;
    endpointType?: EModelEndpoint | null;
    endpointsConfig?: TEndpointsConfig | null;
    assistantName?: string;
    agentName?: string;
    error?: boolean;
  };
