import type { ChannelStorageConfig, ChannelGatewayWirePolicy } from '../config';

export const SLACK_CHANNEL_BOT_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'reactions:read',
  'reactions:write',
  'files:write',
  'im:write',
  'im:history',
] as const;
export const SLACK_CHANNEL_BOT_EVENTS = [
  'app_mention',
  'message.im',
  'agent_session_stopped',
  'reaction_added',
  'reaction_removed',
] as const;

export interface AgentChannel {
  channelId: string;
  tenantId?: string;
  agentId: string;
  createdBy: string;
  type: 'slack';
  status: 'pending_install' | 'active' | 'disabled' | 'deleting';
  credentialMode: 'shared' | 'per_user';
  /** Changes whenever existing identity/execution consent must be re-established. */
  revision: string;
  slack?: { teamId: string; appId: string; botUserId: string };
}

export interface ActivateAgentChannel {
  slack: {
    appId: string;
    botToken: string;
    signingSecret?: string;
  };
}

export interface SlackChannelManifest {
  display_information: { name: string };
  features: {
    bot_user: { display_name: string };
    agent_view: { agent_description: string };
    app_home: { messages_tab_enabled: true; messages_tab_read_only_enabled: false };
  };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    socket_mode_enabled: boolean;
    event_subscriptions: { bot_events: string[]; request_url?: string };
    interactivity: { is_enabled: boolean; request_url?: string };
    org_deploy_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

/** Private service projection; transport policy is authoritative, not independently inferred by replicas. */
export interface ChannelServiceBundle {
  channel: AgentChannel & {
    revision: string;
    slack: { teamId: string; appId: string; botUserId: string };
  };
  credentials: { botToken: string; signingSecret?: string };
  agent: { id: string; name?: string };
  gateway: ChannelGatewayWirePolicy;
  delivery: Pick<ChannelStorageConfig, 'maxDeliveryParts'>;
}
