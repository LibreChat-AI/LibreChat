import {
  DEFAULT_CHANNEL_GATEWAY_POLICY,
  SLACK_CHANNEL_BOT_SCOPES,
  SLACK_CHANNEL_BOT_EVENTS,
} from 'librechat-data-provider';
import type { SlackChannelManifest } from 'librechat-data-provider';
export type { SlackChannelManifest } from 'librechat-data-provider';

/** Declarative installation requirements only; generating a manifest grants no Slack access. */
export function buildSlackChannelManifest(input: {
  name: string;
  tenantId: string;
  channelId: string;
  transport?: 'socket_mode' | 'webhook';
  gatewayUrl?: string;
}): SlackChannelManifest {
  const socket = (input.transport ?? DEFAULT_CHANNEL_GATEWAY_POLICY.transport) === 'socket_mode';
  let gateway: string | undefined;
  if (!socket) {
    const url = new URL(input.gatewayUrl ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Webhook channels require an HTTPS gateway URL without credentials or query');
    }
    gateway = url.toString().replace(/\/+$/, '');
  }
  const binding = `${encodeURIComponent(input.tenantId)}/${encodeURIComponent(input.channelId)}`;
  const title = input.name.trim() || 'LibreChat';
  const name = [...title].slice(0, 35).join('');
  const botName =
    title
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'librechat_agent';
  return {
    display_information: { name },
    features: {
      bot_user: { display_name: botName },
      agent_view: { agent_description: [...title].slice(0, 300).join('') },
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    },
    oauth_config: {
      scopes: {
        bot: [...SLACK_CHANNEL_BOT_SCOPES],
      },
    },
    settings: {
      socket_mode_enabled: socket,
      event_subscriptions: {
        bot_events: [...SLACK_CHANNEL_BOT_EVENTS],
        ...(!socket ? { request_url: `${gateway}/slack/events/${binding}` } : {}),
      },
      interactivity: {
        is_enabled: true,
        ...(!socket ? { request_url: `${gateway}/slack/interactions/${binding}` } : {}),
      },
      org_deploy_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
