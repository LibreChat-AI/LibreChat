/// <reference lib="es2022" />
import { once } from 'node:events';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import mongoose from 'mongoose';
import { expect } from '@playwright/test';
import {
  createModels,
  createMethods,
  createDiscordInstallationStorage,
  createDiscordRouteStorage,
  encryptV3,
  tenantStorage,
} from '@librechat/data-schemas';
import type { APIRequestContext, Page } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import type { DiscordPrivateReply } from 'librechat-data-provider';
import type { ChannelRunRecord } from '@librechat/data-schemas';
import { DiscordGatewayApp } from '../../../packages/channel-gateway/src/discord/app';
import { DiscordRuntimeClient } from '../../../packages/channel-gateway/src/discord/discovery';
import { loadBootstrap } from '../../../packages/channel-gateway/src/config';
import { getPrimaryE2EUser } from '../../setup/users.mock';
import { loginAdmin } from './content-filters.helpers';
import { getMongoUri } from './db';

let ordinal = 0;
const snowflake = () =>
  String((BigInt(Date.now() - 1420070400000) << BigInt(22)) + BigInt(++ordinal));
const result = <T>(input: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!input.ok) throw new Error(input.error.code);
  return input.value;
};

export interface NativeEvent {
  id: string;
  token: string;
  body: string;
}
interface DiscordWrite {
  method: string;
  channelId: string;
  id: string;
  content: string;
  allowed_mentions: { parse: string[]; replied_user: boolean };
  nonce?: string;
  enforce_nonce?: boolean;
  components?: {
    components: { custom_id?: string; url?: string; label: string; style?: number }[];
  }[];
}

/** Real HTTP/runtime and persistence. Only Discord's external HTTP service is a fixture. */
export async function createDiscordAcceptance(request: APIRequestContext, baseURL: string) {
  if (process.env.E2E_DISCORD_CHANNELS !== 'true')
    throw new Error('Discord backend acceptance requires E2E_DISCORD_CHANNELS=true');
  const uri = getMongoUri();
  if (!/\/(LibreChat-e2e|lc_verify_[A-Za-z0-9_]+)(?:\?|$)/.test(uri))
    throw new Error('Discord acceptance requires a disposable E2E database');
  const token = await loginAdmin(request);
  const db = new mongoose.Mongoose();
  await db.connect(uri, { autoIndex: false });
  const models = createModels(db);
  const methods = createMethods(db);
  const headers = { Authorization: `Bearer ${token}`, Origin: new URL(baseURL).origin };
  const currentUser = await models.User.findOne({ email: getPrimaryE2EUser().email }).lean();
  if (!currentUser) {
    await db.disconnect();
    throw new Error('E2E owner was not authenticated');
  }
  const userId = String(currentUser._id);
  const tenantId = currentUser.tenantId || undefined;
  const scoped = <T>(operation: () => Promise<T>) => tenantStorage.run({ tenantId }, operation);
  const applicationId = snowflake();
  const guildId = snowflake();
  const botUserId = snowflake();
  const externalChannelId = snowflake();
  const actors = [snowflake(), snowflake()] as const;
  const channelId = `discord-e2e-${randomUUID()}`;
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('hex');
  const botToken = `discord-fixture-${randomUUID()}`;
  const controller = new AbortController();
  const privateReplies = new Map<string, DiscordPrivateReply>();
  const writes: DiscordWrite[] = [];
  const logs: string[] = [];
  const messages = new Map<string, DiscordWrite>();
  let agentId = '';
  let running: Promise<void> | undefined;
  let appServer: ReturnType<typeof createServer> | undefined;
  let discordServer: ReturnType<typeof createServer> | undefined;
  const runIds = new Set<string>();
  const conversationIds = new Set<string>();

  async function close() {
    controller.abort();
    await running?.catch(() => undefined);
    for (const server of [appServer, discordServer]) {
      server?.closeAllConnections();
      if (server?.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    }
    try {
      await scoped(async () => {
        const retained = await models.ChannelRun.find({ channelId }).lean();
        for (const run of retained) {
          runIds.add(run.runId);
          if (run.execution?.conversationId) conversationIds.add(run.execution.conversationId);
        }
      });
      if (agentId)
        await request.delete(`/api/agents/${encodeURIComponent(agentId)}`, {
          headers,
          failOnStatusCode: false,
        });
      await scoped(async () => {
        // Every filter is this fixture's app, channel, Agent or generated conversation IDs.
        for (const name of [
          'DiscordInbox',
          'DiscordReceipt',
          'DiscordMessageReceipt',
          'DiscordGuild',
          'DiscordThreadRoute',
          'DiscordThreadPin',
          'DiscordDmSelection',
        ])
          if (db.models[name]) await db.models[name].deleteMany({ applicationId });
        for (const name of [
          'ChannelRun',
          'ChannelLane',
          'ChannelReply',
          'ChannelFeedback',
          'ChannelFeedbackEvent',
          'ChannelScope',
        ])
          if (db.models[name]) await db.models[name].deleteMany({ channelId });
        await models.ChannelIdentity.deleteMany({ 'identity.channelId': channelId });
        await models.AgentChannel.deleteMany({ channelId });
        await models.DiscordRoute.deleteMany({ channelId });
        await models.DiscordApplication.deleteMany({ applicationId });
        await models.AgentApiKey.deleteMany({
          'binding.id': { $in: [...runIds].map((id) => `${channelId}/${id}`) },
        });
        await models.StoredResponse.deleteMany({ agentId });
        for (const name of ['Message', 'Conversation'])
          if (db.models[name])
            await db.models[name].deleteMany({ conversationId: { $in: [...conversationIds] } });
      });
    } finally {
      await db.disconnect();
    }
  }
  try {
    const created = await request.post('/api/agents', {
      headers,
      data: {
        name: `Discord runtime ${randomUUID()}`,
        provider: 'Mock Provider A',
        model: 'mock-model-a',
        model_parameters: {},
        tools: [],
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    agentId = (await created.json()).id;
    // External installation facts are preconditions. Actual storage fences still authorize the owner and binding.
    await scoped(async () => {
      const installations = createDiscordInstallationStorage(db);
      const application = result(
        await installations.configureApplication({
          actorId: userId,
          applicationId,
          botUserId,
          publicKey,
          encryptedBotToken: `v3:${encryptV3(botToken)}`,
          encryptedClientSecret: `v3:${encryptV3('fixture-oauth-secret')}`,
        }),
      );
      const guild = result(
        await installations.connectGuild({
          actorId: userId,
          applicationId,
          applicationRevision: application.revision,
          guildId,
          guildName: 'Acceptance Guild',
        }),
      );
      await methods.createAgentChannel({
        type: 'discord',
        channelId,
        agentId,
        tenantId,
        createdBy: userId,
        credentialMode: 'per_user',
        status: 'pending_install',
        revision: 'initial',
        installationId: guild.installationId,
        installationRevision: guild.revision,
        applicationRevision: application.revision,
        discord: { applicationId, guildId, botUserId, externalChannelId },
      });
      result(
        await createDiscordRouteStorage(db).assign({
          actorId: userId,
          installationId: guild.installationId,
          installationRevision: guild.revision,
          applicationRevision: application.revision,
          channelId,
          channelRevision: 'initial',
          externalChannelId,
        }),
      );
    });
    discordServer = createServer(async (req, res) => {
      const path = new URL(req.url || '/', 'http://fixture').pathname;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/json');
      if (path.startsWith(`/api/v10/webhooks/${applicationId}/`)) {
        const interactionToken = decodeURIComponent(path.split('/')[5]);
        const body: DiscordWrite = JSON.parse(bytes.toString());
        const actions = body.components?.flatMap((row) =>
          row.components.map((button) => {
            if (button.url) return { label: button.label, url: button.url };
            if (!button.custom_id) throw new Error('Missing Discord control reference');
            return {
              label: button.label,
              reference: button.custom_id,
              style: button.style === 1 ? ('primary' as const) : ('secondary' as const),
            };
          }),
        );
        privateReplies.set(interactionToken, {
          content: body.content,
          ...(actions?.length ? { actions } : {}),
        });
        res.end(JSON.stringify({ id: snowflake(), channel_id: externalChannelId }));
        return;
      }
      if (req.headers.authorization !== `Bot ${botToken}`) {
        res.writeHead(401).end('{}');
        return;
      }
      if (
        path === `/api/v10/guilds/${guildId}/members/${actors[0]}` ||
        path === `/api/v10/guilds/${guildId}/members/${actors[1]}`
      ) {
        res.end(JSON.stringify({ user: { id: path.split('/').at(-1) } }));
        return;
      }
      if (path.startsWith(`/api/v10/channels/${externalChannelId}/permissions/member/`)) {
        res.end(JSON.stringify({ permissions: path.endsWith(`/${botUserId}`) ? '68608' : '1024' }));
        return;
      }
      if (path === `/api/v10/channels/${externalChannelId}` && req.method === 'GET') {
        res.end(JSON.stringify({ id: externalChannelId, guild_id: guildId, type: 0 }));
        return;
      }
      if (path.startsWith(`/api/v10/channels/${externalChannelId}/messages`)) {
        if (req.method === 'DELETE') {
          messages.delete(path.split('/').at(-1)!);
          res.writeHead(204).end();
          return;
        }
        if (!['POST', 'PATCH'].includes(req.method || '')) {
          res.writeHead(405).end('{}');
          return;
        }
        const body = JSON.parse(bytes.toString());
        const id = req.method === 'PATCH' ? path.split('/').at(-1)! : snowflake();
        const write = { ...body, id, method: req.method, channelId: externalChannelId };
        messages.set(id, write);
        writes.push(write);
        res.end(JSON.stringify({ id, channel_id: externalChannelId }));
        return;
      }
      res.writeHead(404).end('{}');
    });
    discordServer.listen(0, '127.0.0.1');
    await once(discordServer, 'listening');
    const externalBase = `http://127.0.0.1:${(discordServer.address() as AddressInfo).port}`;
    const serviceToken = process.env.E2E_DISCORD_SERVICE_TOKEN;
    if (!serviceToken) throw new Error('Missing isolated Discord service token');
    const bootstrap = loadBootstrap({
      CHANNEL_PROVIDER: 'discord',
      LIBRECHAT_INTERNAL_URL: baseURL,
      CHANNEL_SERVICE_TOKEN: serviceToken,
    });
    if (bootstrap.mode !== 'discord') throw new Error('Invalid Discord bootstrap');
    const runtime = new DiscordRuntimeClient(bootstrap.config);
    const settings = await runtime.bootstrap();
    expect(settings.discord.enabled).toBe(true);
    expect(settings.discord.gateway.enabled).toBe(false);
    const transport: typeof fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = new URL(String(input));
        if (url.origin === 'https://discord.com')
          return fetch(externalBase + url.pathname + url.search, init);
        if (url.origin !== new URL(baseURL).origin)
          throw new Error('Unexpected Discord fixture egress');
        return fetch(input, init);
      },
      fetch,
    );
    const app = new DiscordGatewayApp(
      bootstrap.config,
      settings.discord,
      {
        info: (code) => logs.push(code),
        warn: (code) => logs.push(code),
        error: (code) => logs.push(code),
      },
      transport,
    );
    appServer = createServer((req, res) => {
      void app.http(req, res);
    });
    appServer.listen(0, '127.0.0.1');
    await once(appServer, 'listening');
    app.ready = true;
    running = app.run(controller.signal);
    const ingress = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}/discord/${applicationId}/interactions`;
    await expect.poll(() => logs.includes('discord_gateway_ready'), { timeout: 20000 }).toBe(true);

    function event(
      actor: string,
      action: 'ask' | 'link' | 'status' | 'cancel',
      prompt = '',
      component?: string | { reference: string; messageId: string },
    ): NativeEvent {
      const id = snowflake();
      const token = `interaction-${id}`;
      return {
        id,
        token,
        body: JSON.stringify({
          type: component ? 3 : 2,
          id,
          application_id: applicationId,
          token,
          version: 1,
          context: 0,
          authorizing_integration_owners: { '0': guildId },
          guild_id: guildId,
          channel_id: externalChannelId,
          member: { user: { id: actor } },
          ...(component
            ? {
                message: {
                  id: typeof component === 'string' ? snowflake() : component.messageId,
                  channel_id: externalChannelId,
                },
              }
            : {}),
          data: component
            ? {
                component_type: 2,
                custom_id: typeof component === 'string' ? component : component.reference,
              }
            : {
                id: snowflake(),
                name: 'librechat',
                type: 1,
                options: [
                  {
                    name: action,
                    type: 1,
                    ...(action === 'ask'
                      ? { options: [{ name: 'prompt', type: 3, value: prompt }] }
                      : {}),
                  },
                ],
              },
        }),
      };
    }
    async function send(input: NativeEvent, valid = true) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = valid
        ? sign(
            null,
            Buffer.concat([Buffer.from(timestamp), Buffer.from(input.body)]),
            keys.privateKey,
          ).toString('hex')
        : '0'.repeat(128);
      return fetch(ingress, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-timestamp': timestamp,
          'x-signature-ed25519': signature,
        },
        body: input.body,
      });
    }
    async function reply(input: NativeEvent): Promise<DiscordPrivateReply> {
      await expect.poll(() => privateReplies.has(input.token), { timeout: 20000 }).toBe(true);
      return privateReplies.get(input.token)!;
    }
    async function command(
      actor: string,
      action: 'ask' | 'link' | 'status' | 'cancel',
      prompt = '',
      component?: string | { reference: string; messageId: string },
    ) {
      const input = event(actor, action, prompt, component);
      const ack = await send(input);
      expect(ack.status).toBe(200);
      expect(await ack.json()).toEqual({ type: 5, data: { flags: 64 } });
      return { input, reply: await reply(input) };
    }
    async function retainedRuns(): Promise<ChannelRunRecord[]> {
      const retained = await scoped(() =>
        models.ChannelRun.find({ channelId }).sort({ receivedAt: 1, runId: 1 }).lean(),
      );
      for (const run of retained) {
        runIds.add(run.runId);
        if (run.execution?.conversationId) conversationIds.add(run.execution.conversationId);
      }
      return retained;
    }
    async function link(actor: string) {
      const offered = await command(actor, 'link');
      const url = offered.reply.actions?.find((action) => 'url' in action);
      if (!url || !('url' in url)) throw new Error('Missing browser consent URL');
      const ticket = new URL(url.url).hash.slice(1);
      const preview = await request.post('/api/channels/links/preview', {
        headers,
        data: { ticket },
      });
      expect(preview.status()).toBe(200);
      const view = await preview.json();
      expect(view.ok).toBe(true);
      const accepted = await request.post('/api/channels/links/accept', {
        headers,
        data: { ticket, revision: view.value.revision },
      });
      expect(accepted.status()).toBe(200);
      const card = await command(actor, 'link');
      const confirmation = card.reply.actions?.find((action) => 'reference' in action);
      if (!confirmation || !('reference' in confirmation))
        throw new Error('Missing native confirmation');
      const confirmed = await command(actor, 'link', '', confirmation.reference);
      expect(confirmed.reply.content).toContain('Your account is linked');
    }
    return {
      applicationId,
      guildId,
      botUserId,
      externalChannelId,
      channelId,
      agentId,
      userId,
      actors,
      event,
      send,
      reply,
      command,
      link,
      runs: retainedRuns,
      writes,
      messages,
      privateReplies,
      headers,
      close,
      async linkState(actor: string) {
        return scoped(() =>
          models.ChannelIdentity.findOne({
            'identity.channelId': channelId,
            'identity.externalUserId': actor,
          }).lean(),
        );
      },
      async response(responseId: string) {
        return scoped(() => models.StoredResponse.findOne({ responseId }).lean());
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function acceptDiscordInBrowser(page: Page, reply: DiscordPrivateReply) {
  const action = reply.actions?.find((entry) => 'url' in entry);
  if (!action || !('url' in action)) throw new Error('Missing consent URL');
  await page.goto(action.url);
  await page.getByRole('button', { name: 'Link account', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Return to the original Discord channel');
}
