import { z } from 'zod';
import { nanoid } from 'nanoid';
import { timingSafeEqual } from 'node:crypto';
import { runAsSystem, tenantStorage } from '@librechat/data-schemas';
import {
  channelConfigSchema,
  channelGatewayWirePolicySchema,
  CHANNEL_GATEWAY_POLICY_VERSION,
} from 'librechat-data-provider';
import type { AgentChannelMethods, AgentChannelRecord } from '@librechat/data-schemas';
import type { ChannelConfig, ChannelServiceBundle } from 'librechat-data-provider';
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

export function publicChannel(
  channel: AgentChannelRecord,
): Pick<
  AgentChannelRecord,
  | 'channelId'
  | 'tenantId'
  | 'agentId'
  | 'createdBy'
  | 'type'
  | 'status'
  | 'credentialMode'
  | 'revision'
  | 'slack'
> {
  return {
    channelId: channel.channelId,
    tenantId: channel.tenantId,
    agentId: channel.agentId,
    createdBy: channel.createdBy,
    type: channel.type,
    status: channel.status,
    credentialMode: channel.credentialMode,
    revision: channel.revision,
    slack: channel.slack,
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
  getThread: RequestHandler;
  putThread: RequestHandler;
  service: ChannelServiceGuard;
} {
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
        deps.logError(getSafeErrorMetadata(error));
        res.status(503).json({ error: 'channel_operation_failed' });
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
    res.json(channels.map(publicChannel));
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
    if (!channel) {
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
      res.status(202).json(publicChannel(deleting));
      return;
    }
    res.status(204).end();
  });

  const manifest = protect(async (req, res, config) => {
    const channel = await ownedChannel(req);
    if (!channel) {
      res.status(404).json({ error: 'channel_not_found' });
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
          deps.db.getAgentChannel(req.params.channelId),
        );
        const requestedTenant = req.params.tenantId ?? req.get('x-tenant-id') ?? '_';
        if (
          !channel ||
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
          await handler(req, res, channel, channelConfigSchema.parse(loaded));
        });
      } catch (error) {
        deps.logError(getSafeErrorMetadata(error));
        res.status(503).json({ error: 'channel_operation_failed' });
      }
    };

  const service: ChannelServiceGuard = (handler) =>
    serviceWithConfig((req, res, channel, config) => handler(req, res, channel, config));

  const bundle = serviceWithConfig(async (_req, res, channel, config) => {
    const agent = await deps.getAgent(channel.agentId);
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
    const [botToken, signingSecret] = await Promise.all([
      decryptCredential(channel.encryptedBotToken),
      channel.encryptedSigningSecret
        ? decryptCredential(channel.encryptedSigningSecret)
        : Promise.resolve(''),
    ]);
    res.set('Cache-Control', 'no-store');
    if (!validSigningSecret(config, signingSecret)) {
      res.status(409).json({ error: 'channel_signing_secret_required' });
      return;
    }
    res.json({
      channel: {
        ...publicChannel(channel),
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

  return { list, create, update, remove, manifest, bundle, getThread, putThread, service };
}
