import { z } from 'zod';
import type {
  ChannelStorageConfig,
  ChannelGatewayWirePolicy,
  SharedSlackGatewayPolicy,
} from '../config';

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
export const SLACK_CHANNEL_LIFECYCLE_EVENTS = ['app_uninstalled', 'tokens_revoked'] as const;

/** Organization-owned app metadata. Submitted secrets are write-only. */
export interface SlackAppRegistration {
  appId: string;
  clientId: string;
  name?: string;
  revision: string;
}

export const slackAppNameSchema = z.string().trim().max(100);
export const configureSlackAppSchema = z
  .object({
    appId: z
      .string()
      .regex(/^A[A-Z0-9]+$/)
      .max(256),
    clientId: z
      .string()
      .regex(/^\d+\.\d+$/)
      .max(512),
    name: slackAppNameSchema.optional(),
    clientSecret: z.string().trim().min(1).max(512).optional(),
    signingSecret: z.string().trim().min(1).max(512).optional(),
    expectedRevision: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w-]+$/)
      .optional(),
  })
  .strict()
  .refine((input) =>
    Boolean(input.expectedRevision || (input.clientSecret && input.signingSecret)),
  );

export type ConfigureSlackApp = z.infer<typeof configureSlackAppSchema>;

export interface SlackAppPage {
  configured: boolean;
  canManage: boolean;
  apps: SlackAppRegistration[];
  next?: string;
  setup?: { redirectUri: string; eventsBaseUrl: string; interactionsBaseUrl: string };
}

/** A tenant's Slack installation. Provider credentials are never part of browser metadata. */
export interface SlackBotManager {
  id: string;
  name?: string;
  email?: string;
  avatar?: string;
}

export interface SlackBotManagers {
  revision: string;
  managers: SlackBotManager[];
  maxManagers: number;
}

export interface SlackWorkspace {
  tenantId?: string;
  workspaceId: string;
  appId: string;
  /** Current organization nickname, only in browser metadata; not a Slack profile name. */
  appName?: string;
  teamId: string;
  teamName: string;
  /** Only present in authenticated browser metadata. */
  canManageBot?: boolean;
  botUserId: string;
  status: 'active' | 'disconnected';
  revision: string;
  scopes: string[];
}

export interface SlackWorkspaceStatus {
  configured: boolean;
  canManage: boolean;
  workspaces: SlackWorkspace[];
  next?: string;
}

export interface SlackWorkspaceDetail {
  configured: boolean;
  canManage: boolean;
  workspace: SlackWorkspace;
}

export interface SlackWorkspaceRouteTarget {
  externalChannelId?: string;
  revision: string;
}
export interface SlackWorkspaceRoutePage {
  routes: SlackWorkspaceRouteTarget[];
  next?: string;
}
export interface SlackWorkspaceRouteStatus {
  /** Only present when the requesting user has VIEW access to the assigned agent. */
  assignedAgentName?: string;
  canReplace: boolean;
  occupied: boolean;
  assignedToThisChannel: boolean;
  revision?: string;
}
export interface SetSlackWorkspaceRoute {
  channelRevision: string;
  externalChannelId?: string;
  expectedRevision?: string;
}

export interface SlackWorkspaceConnect {
  url: string;
  flowId: string;
  expiresInSeconds: number;
}

/** Deployment-service protocol; never returned by browser configuration endpoints. */
export interface SharedSlackGatewayBootstrap {
  gateway: ChannelGatewayWirePolicy;
  workers: SharedSlackGatewayPolicy;
}

export interface SharedSlackAppSecurity {
  tenantId: string;
  appId: string;
  signingSecret: string;
}

export type SharedSlackRoute =
  | { kind: 'bound'; tenantId: string; workspaceId: string; channelId: string }
  | { kind: 'unmapped' | 'retired_thread'; workspace: SlackWorkspace; botToken: string };

const routingId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w-]+$/);
const messageKey = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^:\s/\\]+:\d{1,10}\.\d{1,6}$/);
export const sharedSlackRouteLookupSchema = z
  .object({
    appId: routingId,
    teamId: routingId,
    target: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('thread'),
          actorId: routingId,
          externalChannelId: routingId,
          externalThreadKey: messageKey,
        })
        .strict(),
      z.object({ kind: z.literal('run'), runId: routingId }).strict(),
      z.object({ kind: z.literal('link'), linkId: routingId }).strict(),
      z.object({ kind: z.literal('message'), externalMessageKey: messageKey }).strict(),
    ]),
  })
  .strict()
  .refine(
    ({ target }) =>
      target.kind !== 'thread' ||
      target.externalThreadKey.startsWith(`${target.externalChannelId}:`),
  );
export type SharedSlackRouteLookup = z.infer<typeof sharedSlackRouteLookupSchema>;

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
  /** Shared app installation; credentials remain owned by the workspace. */
  workspaceId?: string;
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
