import { z } from 'zod';
import { nanoid } from 'nanoid';
import { timingSafeEqual } from 'node:crypto';
import { runAsSystem, tenantStorage, TransactionUnavailableError } from '@librechat/data-schemas';
import {
  channelConfigSchema,
  channelSnowflakeSchema,
  channelGatewayWirePolicySchema,
  CHANNEL_GATEWAY_POLICY_VERSION,
} from 'librechat-data-provider';
import type {
  AgentChannel,
  ChannelConfig,
  ListedAgentChannel,
  ChannelServiceBundle,
} from 'librechat-data-provider';
import type { AgentChannelMethods, AgentChannelRecord } from '@librechat/data-schemas';
import type { Request, Response, RequestHandler } from 'express';
import type { ChannelServiceGuard } from './types';
import { encryptCredential, decryptCredential } from '~/crypto/credentials';
import { buildSlackChannelManifest } from './manifest';
import { getSafeErrorMetadata } from '~/utils/errors';

export interface SlackIdentity {
  teamId: string;
  botUserId: string;
}

function authenticatedUserId(req: Request): string | undefined {
  if (req.user && 'id' in req.user && typeof req.user.id === 'string') {
    return req.user.id;
  }
  return undefined;
}

function validSigningSecret(config: ChannelConfig, secret?: string): boolean {
  return config.transport !== 'webhook' || Boolean(secret?.trim());
}

export interface ChannelDependencies {
  db: AgentChannelMethods;
  serviceToken: () => string | undefined;
  config: (
    req: Request,
    channel?: AgentChannelRecord,
  ) => Promise<Partial<ChannelConfig> | undefined>;
  getAgent: (agentId: string) => Promise<{ id: string; name?: string | null } | null>;
  verifySlackToken: (token: string) => Promise<SlackIdentity | null>;
  logError: (metadata: ReturnType<typeof getSafeErrorMetadata>) => void;
}

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
const createInput = z
  .object({
    type: z.literal('slack'),
    credentialMode: z.enum(['shared', 'per_user']),
  })
  .strict();
const activateInput = z
  .object({
    slack: z
      .object({
        botToken: z.string().startsWith('xoxb-').max(512),
        signingSecret: z.string().max(512).optional(),
        appId: z.string().regex(/^A[A-Z0-9]+$/),
      })
      .strict(),
  })
  .strict();
const statusInput = z.object({ status: z.literal('disabled') }).strict();
const modeInput = z
  .object({ credentialMode: z.enum(['shared', 'per_user']), revision: identifier })
  .strict();

export function publicChannel(channel: AgentChannelRecord): AgentChannel {
  const common = {
    channelId: channel.channelId,
    tenantId: channel.tenantId,
    agentId: channel.agentId,
    createdBy: channel.createdBy,
    status: channel.status,
    revision: channel.revision,
  };
  if (channel.type === 'discord')
    return {
      ...common,
      type: 'discord',
      credentialMode: 'per_user',
      installationId: channel.installationId,
      installationRevision: channel.installationRevision,
      discord: channel.discord,
    };
  if (channel.type !== 'slack') throw new TypeError('Unsupported channel provider');
  return {
    ...common,
    type: 'slack',
    credentialMode: channel.credentialMode,
    workspaceId: channel.workspaceId,
    slack: channel.slack,
  };
}

/**
 * What an owner sees of any stored row. A row no provider serves, such as one restored from another
 * build or written before rows carried a provider, is listed as unavailable: it keeps its identity
 * and a disabled (or deleting) status and nothing else, so its owner can still delete it and one
 * such row cannot fail the whole list. A Discord row restored without the installation and guild
 * binding its response promises is listed the same way, judged by the rule the stored model enforces.
 */
export function listedChannel(channel: AgentChannelRecord): ListedAgentChannel {
  // Stored data can carry a tag the type no longer lists, so it is read as plain data here.
  const provider: string | undefined = channel.type;
  const { discord } = channel;
  const served =
    provider === 'slack' ||
    (provider === 'discord' &&
      Boolean(channel.installationId && channel.installationRevision) &&
      [
        discord?.applicationId,
        discord?.guildId,
        discord?.botUserId,
        discord?.externalChannelId,
      ].every((id) => channelSnowflakeSchema.safeParse(id).success));
  if (served) return publicChannel(channel);
  return {
    channelId: channel.channelId,
    tenantId: channel.tenantId,
    agentId: channel.agentId,
    createdBy: channel.createdBy,
    type: 'unavailable',
    status: channel.status === 'deleting' ? 'deleting' : 'disabled',
    revision: channel.revision,
  };
}

export function acceptsChannelServiceToken(
  authorization: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || expected.length < 32 || !authorization?.startsWith('Bearer ')) {
    return false;
  }
  const actual = Buffer.from(authorization.slice(7));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Slack responses are decoded at the external boundary and never relayed to clients. */
export async function verifySlackChannelToken(token: string): Promise<SlackIdentity | null> {
  const response = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error('Slack identity service unavailable');
  }
  const result = z
    .object({
      ok: z.boolean(),
      team_id: z.string().optional(),
      user_id: z.string().optional(),
      bot_id: z.string().optional(),
    })
    .safeParse(await response.json());
  if (
    !result.success ||
    !result.data.ok ||
    !result.data.team_id ||
    !result.data.user_id ||
    !result.data.bot_id
  ) {
    return null;
  }
  return { teamId: result.data.team_id, botUserId: result.data.user_id };
}

export function createChannelHandlers(deps: ChannelDependencies): {
  list: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
  manifest: RequestHandler;
  bundle: RequestHandler;
  discordBundle: RequestHandler;
  getThread: RequestHandler;
  putThread: RequestHandler;
  service: ChannelServiceGuard;
} {
  function operationFailed(error: unknown, res: Response): void {
    if (error instanceof TransactionUnavailableError) {
      res.status(503).json({ error: error.code });
      return;
    }
    deps.logError(getSafeErrorMetadata(error));
    res.status(503).json({ error: 'channel_operation_failed' });
  }

  const protect =
    (
      handler: (req: Request, res: Response, config: ChannelConfig) => Promise<void>,
    ): RequestHandler =>
    async (req, res) => {
      try {
        const loaded = await deps.config(req);
        if (!loaded?.enabled) {
          res.status(404).json({ error: 'channels_disabled' });
          return;
        }
        await handler(req, res, channelConfigSchema.parse(loaded));
      } catch (error) {
        operationFailed(error, res);
      }
    };

  async function ownedChannel(req: Request): Promise<AgentChannelRecord | null> {
    if (!identifier.safeParse(req.params.channelId).success) {
      return null;
    }
    const channel = await deps.db.getAgentChannel(req.params.channelId);
    if (
      !channel ||
      channel.agentId !== req.params.agentId ||
      channel.createdBy !== authenticatedUserId(req)
    ) {
      return null;
    }
    return channel;
  }

  const list = protect(async (req, res) => {
    const channels = await deps.db.listAgentChannels(req.params.agentId);
    res.json(channels.map(listedChannel));
  });

  const create = protect(async (req, res) => {
    const userId = authenticatedUserId(req);
    const parsed = createInput.safeParse(req.body);
    if (!parsed.success || !userId) {
      res.status(400).json({ error: 'invalid_channel' });
      return;
    }
    const channel = await deps.db.createAgentChannel({
      channelId: nanoid(),
      agentId: req.params.agentId,
      createdBy: userId,
      type: 'slack',
      status: 'pending_install',
      credentialMode: parsed.data.credentialMode,
      revision: nanoid(),
    });
    res.status(201).json(publicChannel(channel));
  });

  const update = protect(async (req, res, config) => {
    const channel = await ownedChannel(req);
    if (!channel || channel.type !== 'slack') {
      res.status(404).json({ error: 'channel_not_found' });
      return;
    }
    if (channel.status === 'deleting') {
      res.status(409).json({ error: 'channel_deletion_pending' });
      return;
    }
    if (statusInput.safeParse(req.body).success) {
      const disabled = await deps.db.updateAgentChannel(
        channel.channelId,
        channel.createdBy,
        {
          status: 'disabled',
          revision: nanoid(),
        },
        channel.status,
        channel.revision,
      );
      if (!disabled) {
        res.status(409).json({ error: 'channel_changed' });
        return;
      }
      res.json(publicChannel(disabled));
      return;
    }
    if (channel.workspaceId) {
      res.status(409).json({ error: 'workspace_managed_connection' });
      return;
    }
    const mode = modeInput.safeParse(req.body);
    if (mode.success) {
      if (channel.status !== 'disabled' || mode.data.revision !== channel.revision) {
        res.status(409).json({ error: 'channel_changed' });
        return;
      }
      const updated = await deps.db.updateAgentChannel(
        channel.channelId,
        channel.createdBy,
        {
          credentialMode: mode.data.credentialMode,
          revision: nanoid(),
        },
        'disabled',
        channel.revision,
      );
      if (!updated) {
        res.status(409).json({ error: 'channel_changed' });
        return;
      }
      res.json(publicChannel(updated));
      return;
    }
    const parsed = activateInput.safeParse(req.body);
    if (
      !parsed.success ||
      channel.status === 'active' ||
      !validSigningSecret(config, parsed.data.slack.signingSecret)
    ) {
      res.status(400).json({ error: 'invalid_channel_activation' });
      return;
    }
    const identity = await deps.verifySlackToken(parsed.data.slack.botToken);
    if (!identity) {
      res.status(400).json({ error: 'invalid_slack_token' });
      return;
    }
    const [encryptedBotToken, encryptedSigningSecret] = await Promise.all([
      encryptCredential(parsed.data.slack.botToken),
      parsed.data.slack.signingSecret
        ? encryptCredential(parsed.data.slack.signingSecret)
        : Promise.resolve(''),
    ]);
    const updated = await deps.db.updateAgentChannel(
      channel.channelId,
      channel.createdBy,
      {
        status: 'active',
        revision: nanoid(),
        slack: { ...identity, appId: parsed.data.slack.appId },
        encryptedBotToken,

        encryptedSigningSecret,
      },
      channel.status,
      channel.revision,
    );
    if (!updated) {
      res.status(404).json({ error: 'channel_not_found' });
      return;
    }
    res.json(publicChannel(updated));
  });

  const remove = protect(async (req, res) => {
    const channel = await ownedChannel(req);
    if (!channel) {
      res.status(404).json({ error: 'channel_not_found' });
      return;
    }
    const deleting = await deps.db.beginAgentChannelDeletion(channel.channelId, channel.createdBy);
    if (!deleting) return void res.status(204).end();
    const result = await deps.db.deleteAgentChannel(channel.channelId, channel.createdBy);
    if (result.status === 'pending_drain') {
      res.status(202).json(listedChannel(deleting));
      return;
    }
    res.status(204).end();
  });

  const manifest = protect(async (req, res, config) => {
    const channel = await ownedChannel(req);
    if (!channel || channel.type !== 'slack') {
      res.status(404).json({ error: 'channel_not_found' });
      return;
    }
    if (channel.workspaceId) {
      res.status(409).json({ error: 'workspace_managed_connection' });
      return;
    }
    const agent = await deps.getAgent(channel.agentId);
    res.json(
      buildSlackChannelManifest({
        name: agent?.name ?? 'Agent',
        tenantId: channel.tenantId || '_',
        channelId: channel.channelId,
        transport: config?.transport,
        gatewayUrl: config?.gatewayUrl,
      }),
    );
  });

  const serviceWithConfig =
    (
      handler: (
        req: Request,
        res: Response,
        channel: AgentChannelRecord,
        config: ChannelConfig,
      ) => Promise<void>,
    ): RequestHandler =>
    async (req, res) => {
      try {
        if (!acceptsChannelServiceToken(req.get('authorization'), deps.serviceToken())) {
          res.status(401).json({ error: 'invalid_service_auth' });
          return;
        }
        if (!identifier.safeParse(req.params.channelId).success) {
          res.status(404).json({ error: 'channel_not_found' });
          return;
        }
        const channel = await runAsSystem(async () =>
          deps.db.getActiveAgentChannel(req.params.channelId),
        );
        const requestedTenant = req.params.tenantId ?? req.get('x-tenant-id') ?? '_';
        if (
          !channel ||
          (channel.type !== 'slack' && channel.type !== 'discord') ||
          channel.status !== 'active' ||
          requestedTenant !== (channel.tenantId || '_')
        ) {
          res.status(404).json({ error: 'channel_not_found' });
          return;
        }
        await tenantStorage.run({ tenantId: channel.tenantId || undefined }, async () => {
          const loaded = await deps.config(req, channel);
          if (!loaded?.enabled) {
            res.status(404).json({ error: 'channels_disabled' });
            return;
          }
          const config = channelConfigSchema.parse(loaded);
          if (channel.type === 'discord') {
            if (!config.discord?.enabled || !channel.applicationRevision) {
              res.status(404).json({ error: 'channel_not_found' });
              return;
            }
          }
          if (
            channel.workspaceId &&
            (!config.slackApp?.enabled || config.transport !== 'webhook')
          ) {
            res.status(404).json({ error: 'channel_not_found' });
            return;
          }
          await handler(req, res, channel, config);
        });
      } catch (error) {
        operationFailed(error, res);
      }
    };

  const service: ChannelServiceGuard = (handler) =>
    serviceWithConfig((req, res, channel, config) => handler(req, res, channel, config));

  const bundle = (provider: 'slack' | 'discord') =>
    serviceWithConfig(async (req, res, channel, config) => {
      const metadata = publicChannel(channel);
      if (metadata.type !== provider) {
        res.status(404).json({ error: 'channel_not_found' });
        return;
      }
      const agent = await deps.getAgent(channel.agentId);
      if (metadata.type === 'discord') {
        const expected = req.get('x-discord-application-revision');
        if (expected !== undefined && expected !== channel.applicationRevision) {
          res.status(409).json({ error: 'channel_application_changed' });
          return;
        }
        if (
          !agent ||
          !channel.encryptedBotToken ||
          !channel.applicationRevision ||
          !config.discord?.enabled
        ) {
          res.status(404).json({ error: 'channel_not_found' });
          return;
        }
        res.set('Cache-Control', 'no-store');
        res.json({
          channel: metadata,
          applicationRevision: channel.applicationRevision,
          credentials: { botToken: await decryptCredential(channel.encryptedBotToken) },
          agent: { id: agent.id, name: agent.name ?? 'Agent' },
          discord: config.discord,
          delivery: { maxDeliveryParts: config.maxDeliveryParts },
          gateway: channelGatewayWirePolicySchema.parse({
            version: CHANNEL_GATEWAY_POLICY_VERSION,
            ...config,
            transport: 'webhook',
            nativeSessions: false,
            lifecycleReactions: false,
          }),
        } satisfies ChannelServiceBundle);
        return;
      }
      const slack = channel.slack;
      if (
        !agent ||
        !channel.encryptedBotToken ||
        !slack?.teamId ||
        !slack.appId ||
        !slack.botUserId
      ) {
        res.status(404).json({ error: 'channel_not_found' });
        return;
      }
      const signing = channel.encryptedSigningSecret
        ? decryptCredential(channel.encryptedSigningSecret)
        : Promise.resolve('');
      const [botToken, signingSecret] = await Promise.all([
        decryptCredential(channel.encryptedBotToken),
        signing,
      ]);
      res.set('Cache-Control', 'no-store');
      if (!validSigningSecret(config, signingSecret)) {
        res.status(409).json({ error: 'channel_signing_secret_required' });
        return;
      }
      res.json({
        channel: {
          ...metadata,
          revision: channel.revision,
          slack,
        },
        credentials: { botToken, signingSecret },
        agent: { id: agent.id, name: agent.name ?? 'Agent' },
        delivery: { maxDeliveryParts: config.maxDeliveryParts },
        gateway: channelGatewayWirePolicySchema.parse({
          version: CHANNEL_GATEWAY_POLICY_VERSION,
          ...config,
        }),
      } satisfies ChannelServiceBundle);
    });

  const getThread = service(async (_req, res) => {
    res.status(410).json({ error: 'use_actor_scoped_runs' });
  });

  const putThread = getThread;

  return {
    list,
    create,
    update,
    remove,
    manifest,
    bundle: bundle('slack'),
    discordBundle: bundle('discord'),
    getThread,
    putThread,
    service,
  };
}
