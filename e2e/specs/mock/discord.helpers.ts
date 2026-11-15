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
  hashDiscordDmCode,
  encryptV3,
  tenantStorage,
} from '@librechat/data-schemas';
import type { APIRequestContext, Page } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import type {
  ChannelLinkView,
  DiscordDmResult,
  DiscordDmSelectionPage,
  DiscordDmIssuedCode,
  DiscordPrivateReply,
} from 'librechat-data-provider';
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
/** Native BOT_DM interactions: a slash command, or a control button on an earlier DM message. */
export type DmInput =
  | { kind: 'select'; code: string }
  | { kind: 'ask'; prompt: string }
  | { kind: 'status' | 'cancel' }
  | { kind: 'control'; reference: string; messageId: string };
/** The inline interaction response of /select, the only DM command without a deferred reply. */
export interface NativeAnswer {
  type?: number;
  data?: { flags?: number; content?: string; allowed_mentions?: { parse: string[] } };
  error?: string;
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
  // Physical DM channels are distinct from the guild channel and carry no guild.
  const dmChannelId = snowflake();
  const otherDmChannelId = snowflake();
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
  const unexpected: string[] = [];
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
          'DiscordDmCode',
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
        // Vote ledgers carry their channel inside the retained reply mapping.
        await models.ChannelFeedback.deleteMany({ 'mapping.channelId': channelId });
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
          encryptedBotToken: encryptV3(botToken),
          encryptedClientSecret: encryptV3('fixture-oauth-secret'),
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
      // Every write records the channel it was actually sent to, so a stray DM or guild write is visible.
      const target = path.match(/^\/api\/v10\/channels\/(\d+)\/messages(?:\/\d+)?$/)?.[1];
      if (target && [externalChannelId, dmChannelId, otherDmChannelId].includes(target)) {
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
        const write = { ...body, id, method: req.method, channelId: target };
        messages.set(id, write);
        writes.push(write);
        res.end(JSON.stringify({ id, channel_id: target }));
        return;
      }
      unexpected.push(`${req.method} ${path.replace(/\d{17,20}/g, ':id')}`);
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
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = new URL(String(input));
        if (url.origin !== 'https://discord.com' && url.origin !== new URL(baseURL).origin)
          throw new Error('Unexpected Discord fixture egress');
        const response = await fetch(
          url.origin === 'https://discord.com' ? externalBase + url.pathname + url.search : input,
          init,
        );
        const route = url.pathname.startsWith('/api/v10/webhooks/')
          ? '/api/v10/webhooks/:application/:token/messages/@original'
          : url.pathname.replace(/\d{17,20}/g, ':id');
        if (!response.ok) logs.push(`HTTP ${route}: ${response.status}`);
        return response;
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
      try {
        await expect.poll(() => privateReplies.has(input.token), { timeout: 20000 }).toBe(true);
      } catch (cause) {
        const inbox = await scoped(() =>
          models.DiscordInbox.find({ applicationId, eventId: input.id })
            .select('state result leaseEpoch inspectionEpoch -_id')
            .lean(),
        );
        throw new Error(
          `Discord private reply missing: ${JSON.stringify({ events: logs.slice(-12), inbox })}`,
          { cause },
        );
      }
      return privateReplies.get(input.token)!;
    }
    /** A deferred private acknowledgement now, the actual card through the interaction webhook later. */
    async function acknowledged(input: NativeEvent) {
      const ack = await send(input);
      expect(ack.status).toBe(200);
      expect(await ack.json()).toEqual({ type: 5, data: { flags: 64 } });
      return { input, reply: await reply(input) };
    }
    async function command(
      actor: string,
      action: 'ask' | 'link' | 'status' | 'cancel',
      prompt = '',
      component?: string | { reference: string; messageId: string },
    ) {
      return acknowledged(event(actor, action, prompt, component));
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
    /** BOT_DM interactions carry a user and the DM channel; a guild or member would be a spoof. */
    function dmEvent(
      actor: string,
      input: DmInput,
      channel = dmChannelId,
      extra: Record<string, unknown> = {},
    ): NativeEvent {
      const id = snowflake();
      const token = `interaction-${id}`;
      let argument: { name: string; value: string } | undefined;
      if (input.kind === 'select') argument = { name: 'code', value: input.code };
      if (input.kind === 'ask') argument = { name: 'prompt', value: input.prompt };
      return {
        id,
        token,
        body: JSON.stringify({
          type: input.kind === 'control' ? 3 : 2,
          id,
          application_id: applicationId,
          token,
          version: 1,
          context: 1,
          authorizing_integration_owners: { '0': '0' },
          channel_id: channel,
          user: { id: actor },
          ...extra,
          ...(input.kind === 'control'
            ? {
                message: { id: input.messageId, channel_id: channel },
                data: { component_type: 2, custom_id: input.reference },
              }
            : {
                data: {
                  id: snowflake(),
                  name: 'librechat',
                  type: 1,
                  options: [
                    {
                      name: input.kind,
                      type: 1,
                      ...(argument ? { options: [{ ...argument, type: 3 }] } : {}),
                    },
                  ],
                },
              }),
        }),
      };
    }
    async function dmCommand(
      actor: string,
      input: Exclude<DmInput, { kind: 'select' }>,
      channel = dmChannelId,
    ) {
      return acknowledged(dmEvent(actor, input, channel));
    }
    async function dmSelect(actor: string, code: string, channel = dmChannelId) {
      const response = await send(dmEvent(actor, { kind: 'select', code }, channel));
      return { status: response.status, body: (await response.json()) as NativeAnswer };
    }
    /** The browser's own routes (JWT and same-origin). Plain fetch keeps a code out of Playwright traces. */
    async function dmApi<T>(method: 'GET' | 'POST' | 'DELETE', path: string, data?: object) {
      const response = await fetch(new URL(`/api/channels/discord/dm${path}`, baseURL), {
        method,
        headers: { ...headers, ...(data ? { 'content-type': 'application/json' } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      let result: DiscordDmResult<T> | undefined;
      try {
        result = JSON.parse(await response.text());
      } catch {
        result = undefined;
      }
      return { status: response.status, result };
    }
    async function activeLink(actor: string): Promise<ChannelLinkView> {
      const listed = await request.get('/api/channels/links', { headers });
      expect(listed.status()).toBe(200);
      const links: ChannelLinkView[] = await listed.json();
      const link = links.find(
        (entry) =>
          entry.state === 'active' &&
          entry.identity.provider === 'discord' &&
          entry.identity.channelId === channelId &&
          entry.identity.externalUserId === actor,
      );
      if (!link) throw new Error('Missing active Discord link');
      return link;
    }
    async function issueDmCode(actor: string): Promise<DiscordDmIssuedCode> {
      const link = await activeLink(actor);
      const { status, result } = await dmApi<DiscordDmIssuedCode>('POST', '/codes', {
        linkId: link.linkId,
        expectedLinkRevision: link.revision,
      });
      if (status !== 200 || !result?.ok)
        throw new Error(`Discord DM code was not issued: HTTP ${status}`);
      return result.value;
    }
    async function dmSelections() {
      const { status, result } = await dmApi<DiscordDmSelectionPage>('GET', '/selections');
      expect(status).toBe(200);
      if (!result?.ok) throw new Error('Discord DM selections were not listed');
      const selections = result.value.selections.filter(
        (entry) => entry.applicationId === applicationId,
      );
      return { ...result.value, selections };
    }
    function revokeDmSelection(selection: { selectionId: string; revision: string }) {
      return dmApi<null>('DELETE', `/selections/${encodeURIComponent(selection.selectionId)}`, {
        revision: selection.revision,
      });
    }
    async function hasStoredCodeHash(code: string): Promise<boolean> {
      const rows = await scoped(() =>
        models.DiscordDmCode.find({ applicationId }).select('+codeHash').lean(),
      );
      return rows.some((row) => row.codeHash === hashDiscordDmCode(code));
    }
    /** Names every retained surface holding the secret verbatim, so a failure never prints it. */
    async function leaks(secret: string): Promise<string[]> {
      const found: string[] = [];
      if (logs.some((entry) => entry.includes(secret))) found.push('gateway logs');
      if (JSON.stringify([writes, [...privateReplies.values()], unexpected]).includes(secret))
        found.push('discord output');
      const retained = Object.keys(db.models).filter((key) =>
        /^(Discord|Channel)|^StoredResponse$/.test(key),
      );
      for (const name of retained) {
        const rows = await db.models[name].collection.find({}).toArray();
        if (JSON.stringify(rows).includes(secret)) found.push(name);
      }
      return found;
    }
    async function inboxRow(eventId: string) {
      return scoped(() => models.DiscordInbox.findOne({ applicationId, eventId }).lean());
    }
    async function feedback() {
      return scoped(() => models.ChannelFeedback.find({ 'mapping.channelId': channelId }).lean());
    }
    /** Durable and external footprint of this fixture: a refused prompt must not grow any part of it. */
    async function footprint() {
      return scoped(async () => ({
        events: (await models.DiscordInbox.find({ applicationId }).select('eventId').lean())
          .map((row) => row.eventId)
          .sort(),
        votes: await models.ChannelFeedbackEvent.countDocuments({ channelId }),
        runs: await models.ChannelRun.countDocuments({ channelId }),
        responses: await models.StoredResponse.countDocuments({ agentId }),
        keys: await models.AgentApiKey.countDocuments({
          'binding.id': { $regex: `^${channelId}/` },
        }),
        writes: writes.length,
      }));
    }
    return {
      applicationId,
      guildId,
      botUserId,
      externalChannelId,
      dmChannelId,
      otherDmChannelId,
      channelId,
      agentId,
      userId,
      actors,
      event,
      dmEvent,
      send,
      reply,
      command,
      dmCommand,
      dmSelect,
      link,
      issueDmCode,
      dmSelections,
      revokeDmSelection,
      hasStoredCodeHash,
      leaks,
      footprint,
      inboxRow,
      feedback,
      runs: retainedRuns,
      writes,
      unexpected,
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
