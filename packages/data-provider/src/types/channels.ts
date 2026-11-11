export interface AgentChannel {
  channelId: string;
  tenantId?: string;
  agentId: string;
  createdBy: string;
  type: 'slack';
  status: 'pending_install' | 'active' | 'disabled' | 'deleting';
  credentialMode: 'shared' | 'per_user';
  /** Changes whenever existing identity/execution consent must be re-established. */
  revision?: string;
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
  features: { bot_user: { display_name: string } };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    socket_mode_enabled: boolean;
    event_subscriptions: { bot_events: string[] };
    org_deploy_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}
