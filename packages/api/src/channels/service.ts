import { z } from 'zod';
import { nanoid } from 'nanoid';
import { timingSafeEqual } from 'node:crypto';
import { runAsSystem, tenantStorage } from '@librechat/data-schemas';
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

interface ChannelConfig {
  enabled: boolean;
  gatewayUrl?: string;
  transport?: 'socket_mode' | 'webhook';
}

export interface ChannelDependencies {
  db: AgentChannelMethods;
  serviceToken: () => string | undefined;
  config: () => Promise<ChannelConfig | undefined>;
  getAgent: (agentId: string) => Promise<{ id: string; name?: string | null } | null>;
  deleteApiKey: (id: string, userId: string) => Promise<boolean>;
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
    revision: channel.revision ?? channel.channelId,
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
    (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      try {
        if (!(await deps.config())?.enabled) {
          res.status(404).json({ error: 'channels_disabled' });
          return;
        }
        await handler(req, res);
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

  const update = protect(async (req, res) => {
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
      if (disabled?.apiKeyId) {
        await deps.deleteApiKey(disabled.apiKeyId, channel.createdBy);
      }
      res.json(publicChannel(disabled));
      return;
    }
    const mode = modeInput.safeParse(req.body);
    if (mode.success) {
      if (
        channel.status !== 'disabled' ||
        mode.data.revision !== (channel.revision ?? channel.channelId)
      ) {
        res.status(409).json({ error: 'channel_changed' });
        return;
      }
      if (channel.apiKeyId) await deps.deleteApiKey(channel.apiKeyId, channel.createdBy);
      const updated = await deps.db.updateAgentChannel(
        channel.channelId,
        channel.createdBy,
        {
          credentialMode: mode.data.credentialMode,
          revision: nanoid(),
          encryptedApiKey: '',
          apiKeyId: '',
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
    if (!parsed.success || channel.status === 'active') {
      res.status(400).json({ error: 'invalid_channel_activation' });
      return;
    }
    const identity = await deps.verifySlackToken(parsed.data.slack.botToken);
    if (!identity) {
      res.status(400).json({ error: 'invalid_slack_token' });
      return;
    }
    // Retire legacy unrestricted owner keys before granting a new channel revision.
    if (channel.apiKeyId) await deps.deleteApiKey(channel.apiKeyId, channel.createdBy);
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
        encryptedApiKey: '',
        encryptedSigningSecret,
        apiKeyId: '',
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
    const deleting = await deps.db.updateAgentChannel(channel.channelId, channel.createdBy, {
      status: 'deleting',
      revision: nanoid(),
    });
    if (deleting?.apiKeyId) {
      await deps.deleteApiKey(deleting.apiKeyId, channel.createdBy);
    }
    if (!(await deps.db.deleteAgentChannel(channel.channelId, channel.createdBy))) {
      res.status(202).json(publicChannel(deleting ?? { ...channel, status: 'deleting' }));
      return;
    }
    res.status(204).end();
  });

  const manifest = protect(async (req, res) => {
    const channel = await ownedChannel(req);
    if (!channel) {
      res.status(404).json({ error: 'channel_not_found' });
      return;
    }
    const agent = await deps.getAgent(channel.agentId);
    const config = await deps.config();
    res.json(
      buildSlackChannelManifest({
        name: agent?.name ?? 'Agent',
        tenantId: channel.tenantId ?? '_',
        channelId: channel.channelId,
        transport: config?.transport,
        gatewayUrl: config?.gatewayUrl,
      }),
    );
  });

  const service = (
    handler: (req: Request, res: Response, channel: AgentChannelRecord) => Promise<void>,
  ) =>
    protect(async (req, res) => {
      if (!acceptsChannelServiceToken(req.get('authorization'), deps.serviceToken())) {
        res.status(401).json({ error: 'invalid_service_auth' });
        return;
      }
      if (!identifier.safeParse(req.params.channelId).success) {
        res.status(404).json({ error: 'channel_not_found' });
        return;
      }
      const channel = await runAsSystem(async () => deps.db.getAgentChannel(req.params.channelId));
      const requestedTenant = req.params.tenantId ?? req.get('x-tenant-id') ?? '_';
      if (
        !channel ||
        channel.status !== 'active' ||
        requestedTenant !== (channel.tenantId ?? '_')
      ) {
        res.status(404).json({ error: 'channel_not_found' });
        return;
      }
      await tenantStorage.run({ tenantId: channel.tenantId }, async () => {
        await handler(req, res, channel);
      });
    });

  const bundle = service(async (_req, res, channel) => {
    const agent = await deps.getAgent(channel.agentId);
    if (!agent || !channel.encryptedBotToken) {
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
    res.json({
      channel: publicChannel(channel),
      credentials: { botToken, signingSecret },
      agent: { id: agent.id, name: agent.name ?? 'Agent' },
    });
  });

  const getThread = service(async (_req, res) => {
    res.status(410).json({ error: 'use_actor_scoped_runs' });
  });

  const putThread = getThread;

  return { list, create, update, remove, manifest, bundle, getThread, putThread, service };
}
