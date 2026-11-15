/// <reference lib="es2022" />
import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import {
  PermissionBits,
  Permissions,
  PermissionTypes,
  Constants,
  channelConfigSchema,
  discordRunControl,
} from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createResponseStorage,
  createChannelIdentityStorage,
  createDiscordInstallationStorage,
  createDiscordRouteStorage,
  createDiscordDmStorage,
  createDiscordGatewayStorage,
  createDiscordMessageStorage,
  createChannelRunStorage,
  createDiscordInboxStorage,
  createDiscordInboxResolutionStorage,
  createDiscordCommandStorage,
  tenantStorage,
  runAsSystem,
  hashDiscordDmCode,
} from '@librechat/data-schemas';
import type { StoredResponseRecord, ResponseOwner } from '@librechat/data-schemas';
import type { DiscordGatewayMessage } from 'librechat-data-provider';
import type { ErrorRequestHandler } from 'express';
import type { Response as AgentResponse } from '~/agents/responses/types';
import {
  createResponseCompletion,
  createResponseExecutionConfirmation,
  createResponseExecutionRelease,
} from '~/agents/responses/completion';
import {
  buildPendingBackgroundResponse,
  createBackgroundResponseService,
} from '~/agents/responses/background';
import { DiscordGatewayControlClient } from '../../../../channel-gateway/src/discord/ownership';
import { createDiscordWorkerProvider } from '../../../../channel-gateway/src/discord/worker';
import { DiscordRuntimeClient } from '../../../../channel-gateway/src/discord/discovery';
import { dispatchDiscordEvent } from '../../../../channel-gateway/src/discord/dispatch';
import { DiscordRateCoordinator } from '../../../../channel-gateway/src/discord/rates';
import { DiscordControlClient } from '../../../../channel-gateway/src/discord/control';
import { createDiscordWebhook } from '../../../../channel-gateway/src/discord/http';
import { DiscordClient } from '../../../../channel-gateway/src/discord/client';
import { encryptCredential, decryptCredential } from '~/crypto/credentials';
import { ChannelWorker } from '../../../../channel-gateway/src/worker';
import { ChannelClient } from '../../../../channel-gateway/src/client';
import { loadConfig } from '../../../../channel-gateway/src/config';
import { createChannelResponseCredentials } from '../credentials';
import { createDiscordDmMessageHandlers } from './dmMessageHttp';
import { createChannelResponseProjection } from '../responses';
import { createDiscordDmMessageService } from './dmMessages';
import { createChannelExecutionAdapter } from '../execution';
import { createAgentRunEnvelope } from '~/agents/envelope';
import { createDiscordCommandExecutor } from './commands';
import { createDiscordInboxHandlers } from './inboxHttp';
import { createChannelAuthority } from '../authority';
import { createDiscordRouteResolver } from './routes';
import { createDiscordInboxService } from './inbox';
import { createChannelHandlers } from '../service';
import { createChannelRunHandlers } from '../runs';
import { createDiscordDmHandlers } from './dmHttp';
import { GenerationJobManager } from '~/stream';
import { createDiscordDmService } from './dm';

const db = new mongoose.Mongoose();
const models = createModels(db);
const methods = createMethods(db);
const tenantId = 'dm-runtime';
const ownerId = '000000000000000000000001';
const userId = '000000000000000000000002';
const applicationId = '123456789012345678';
const guildId = '234567890123456789';
const actorId = '345678901234567890';
const botId = '456789012345678901';
const parentId = '567890123456789012';
const dmId = '678901234567890123';
const token = 'private-test-service-token'.repeat(2);
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');
const snowflake = (at: number) => String((BigInt(at - 1420070400000) << BigInt(22)) + BigInt(1));
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
let mongo: MongoMemoryReplSet;
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri());
  await runAsSystem(() => Promise.all(Object.values(db.models).map((model) => model.init())));
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    for (const collection of Object.values(db.connection.collections))
      await collection.deleteMany({});
  });
});

async function fixture(ordinary = true) {
  const state = {
    enabled: true,
    gatewayEnabled: true,
    visible: true,
    crashAfterBind: false,
    inferenceCreates: 0,
  };
  const config = () =>
    channelConfigSchema.parse({
      enabled: true,
      discord: {
        enabled: true,
        gateway: { enabled: state.gatewayEnabled },
        dm: { enabled: state.enabled },
      },
    });
  const policy = () => config().discord!;
  const installations = createDiscordInstallationStorage(db);
  const routes = createDiscordRouteStorage(db);
  const selections = createDiscordDmStorage(db, async () => policy().dm);
  const gateway = createDiscordGatewayStorage(db, async () => ({
    ownershipLeaseMs: 30000,
    shardCount: 1,
  }));
  const runs = createChannelRunStorage(db);
  const identities = createChannelIdentityStorage(db);
  const responses = createResponseStorage(db);
  const authority = createChannelAuthority({
    channels: methods,
    identityStorage: identities,
    discordDm: selections,
    authorizeDestination: (channel, admission, principal) =>
      runs.authorizeDestination(
        {
          tenantId: channel.tenantId,
          channelId: channel.channelId,
          agentId: channel.agentId,
          principal,
          admission,
        },
        Date.now(),
      ),
    getConfig: async () => config(),
    findUser: (id) => methods.findUser({ _id: id }),
    getRole: (name) => models.Role.findOne({ name }),
    isPrincipalActive: (id) => methods.isAgentTriggerPrincipalActive(id),
    getAgentPermissions: async () => PermissionBits.VIEW,
  });
  const credentials = createChannelResponseCredentials({
    storage: runs,
    responses,
    getChannel: methods.getAgentChannelMetadata,
    resolvePrincipal: authority.resolvePrincipal,
    encrypt: encryptCredential,
    decrypt: decryptCredential,
    createKey: methods.createAgentApiKey,
    getKey: methods.getAgentApiKeyById,
    deleteKey: methods.deleteAgentApiKey,
    lifetimeMs: async () => 300000,
  });
  async function authorized(owner: ResponseOwner, agentId: string, keyId?: string) {
    if (!keyId) return false;
    const key = await methods.getAgentApiKeyById(keyId, owner.userId);
    return Boolean(
      key?.binding && (await credentials.authorizeSource(key.binding, keyId, owner, agentId)),
    );
  }
  const completion = createResponseCompletion({
    storage: responses,
    cleanupCheckpoint: async () => {},
    confirmExecution: createResponseExecutionConfirmation(GenerationJobManager),
    releaseExecution: createResponseExecutionRelease(GenerationJobManager),
  });
  // The external inference mock completes only the response actually enrolled by the worker.
  async function infer(record: StoredResponseRecord) {
    state.inferenceCreates++;
    const current = await responses.read(record, record.responseId);
    if (!current) throw new Error('Inference response missing');
    const response: AgentResponse = {
      ...buildPendingBackgroundResponse(current),
      status: 'completed',
      completed_at: Date.now() / 1000,
      output: [
        {
          id: 'answer',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'A private DM answer', annotations: [], logprobs: [] },
          ],
        },
      ],
    };
    const result = await responses.publish(record, record.responseId, current.revision, {
      status: 'completed',
      responseJSON: JSON.stringify(response),
    });
    if (!result.ok) throw new Error('Inference publication failed');
  }
  const background = createBackgroundResponseService({
    storage: responses,
    authorize: authorized,
    recoverTerminal: completion.finish,
    enqueue: infer,
    resolveContinuation: async (owner, previous) => {
      if (!previous)
        return { conversationId: randomUUID(), parentMessageId: String(Constants.NO_PARENT) };
      const stored = await responses.read(owner, previous);
      if (!stored) throw new Error('Continuation unavailable');
      return { conversationId: stored.conversationId, parentMessageId: previous };
    },
    observe: async () => null,
    cancel: async () => {
      throw new Error('Unexpected inference cancellation');
    },
  });
  const projection = createChannelResponseProjection({
    storage: responses,
    readResponse: background.retrieve,
    cancelResponse: background.cancel,
  });
  const execution = createChannelExecutionAdapter({
    responseProjection: projection,
    responseRetirement: async () => {
      throw new Error('Unexpected external retirement');
    },
  });
  const handlers = createChannelHandlers({
    db: methods,
    config: async () => config(),
    getAgent: (id) => methods.getAgent({ id }),
    serviceToken: () => token,
    verifySlackToken: async () => null,
    logError: () => {},
  });
  const runHandlers = createChannelRunHandlers({
    storage: runs,
    guard: handlers.service,
    resolvePrincipal: authority.resolvePrincipal,
    responseCredential: credentials.provision,
    advance: execution.advance,
    retireForAuthorityLoss: execution.retireForAuthorityLoss,
  });
  const dmService = createDiscordDmService({
    storage: selections,
    identities,
    installations,
    channels: methods,
    authority,
    settings: async () => policy().dm,
    principalAllowed: async (principal) =>
      principal.id === userId && principal.tenantId === tenantId,
  });
  const dmHandlers = createDiscordDmHandlers({ service: dmService, serviceToken: () => token });
  const messages = createDiscordDmMessageHandlers({
    serviceToken: () => token,
    service: createDiscordDmMessageService({
      selections,
      gateway,
      installations,
      channels: methods,
      messages: createDiscordMessageStorage(db),
      runs,
      authority,
      settings: async () => policy(),
    }),
  });
  const resolver = createDiscordRouteResolver({
    installations,
    routes,
    channels: methods,
    enabled: async () => true,
  });
  const commandInbox = createDiscordInboxStorage(db);
  const execute = createDiscordCommandExecutor({
    channels: methods,
    authority,
    runs,
    commands: createDiscordCommandStorage(db),
    enabled: async () => true,
    dmEnabled: async () => state.enabled,
    publicBaseUrl: 'https://chat.example/prefix/',
  });
  const inboxService = createDiscordInboxService({
    storage: commandInbox,
    resolver,
    encrypt: encryptCredential,
    decrypt: decryptCredential,
    execute,
    retryDelayMs: async () => 1000,
    dm: { selections, enabled: async () => state.enabled },
    inspection: { storage: createDiscordInboxResolutionStorage(db), execute },
  });
  const inboxHandlers = createDiscordInboxHandlers({
    service: inboxService,
    serviceToken: () => token,
  });
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => tenantStorage.run({ tenantId }, next));
  for (const [path, handler] of Object.entries({
    dm: inboxHandlers.submitDm,
    claim: inboxHandlers.claim,
    resolve: inboxHandlers.resolve,
    finish: inboxHandlers.finish,
    defer: inboxHandlers.defer,
  }))
    app.post(`/api/channels/discord/service/inbox/${path}`, handler);
  app.post('/api/channels/discord/service/dm/select', dmHandlers.select);
  app.post('/api/channels/discord/service/dm/prepare', messages.prepare);
  app.post('/api/channels/discord/service/dm/message', messages.submit);
  app.get('/api/channels/service/discord/:tenantId/:channelId', handlers.discordBundle);
  const root = '/api/channels/service/:channelId/runs';
  app.post(`${root}/claim`, runHandlers.claim);
  const operations = {
    advance: runHandlers.advance,
    renew: runHandlers.renew,
    yield: runHandlers.yieldLease,
    'response/prepare': runHandlers.prepareResponse,
    'response/bind': runHandlers.bindResponse,
    'progress/plan': runHandlers.planProgress,
    'progress/begin': runHandlers.beginProgress,
    'progress/settle': runHandlers.settleProgress,
    plan: runHandlers.plan,
    'delivery/begin': runHandlers.begin,
    'delivery/settle': runHandlers.settle,
    commit: runHandlers.commit,
  };
  for (const [path, handler] of Object.entries(operations))
    app.post(`${root}/:runId/${path}`, handler);
  app.use('/api/agents/v1/responses', async (req, res) => {
    const authenticated = await methods.validateBoundAgentApiKey(
      (req.get('authorization') || '').replace(/^Bearer /, ''),
    );
    const user = authenticated && (await methods.findUser({ _id: authenticated.userId }));
    if (
      !authenticated ||
      !user ||
      !(await credentials.authorizeRequest({ ...authenticated, user, request: req }))
    )
      return void res.sendStatus(403);
    const owner = { tenantId, userId: authenticated.userId };
    const result =
      req.method === 'POST'
        ? await background.create(
            createAgentRunEnvelope({
              protocol: 'responses',
              principal: { id: authenticated.userId, tenantId },
              requestId: randomUUID(),
              receivedAt: Date.now(),
              payload: req.body,
            }),
            req.get('idempotency-key'),
            authenticated.keyId,
          )
        : await background.retrieve(owner, req.path.slice(1));
    res
      .status(result.ok ? 200 : result.status)
      .json(result.ok ? result.response : { error: result.code });
  });
  let serverFailure: unknown;
  const fail: ErrorRequestHandler = (error, _req, res, _next) => {
    serverFailure = error;
    res.sendStatus(500);
  };
  app.use(fail);
  const writes: { method: string; path: string; content?: string }[] = [];
  const paths: string[] = [];
  let nextMessage = 700;
  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      const method = init?.method || 'GET';
      paths.push(url.pathname);
      if (url.hostname === 'discord.com') {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bot test-bot-token');
        if (method === 'GET') {
          if (url.pathname.includes('/members/'))
            return state.visible
              ? Response.json({ user: { id: actorId } })
              : Response.json({}, { status: 403 });
          if (url.pathname.includes('/permissions/member/'))
            return Response.json({
              permissions: url.pathname.endsWith(`/${botId}`) ? '68608' : '1024',
            });
          expect(url.pathname).toBe(`/api/v10/channels/${parentId}`);
          return Response.json({ id: parentId, guild_id: guildId, type: 0 });
        }
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        writes.push({ method, path: url.pathname, content: body.content });
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return Response.json({
          id: method === 'PATCH' ? url.pathname.split('/').at(-1) : String(++nextMessage),
          channel_id: dmId,
        });
      }
      const http =
        method === 'GET' ? request(app).get(url.pathname) : request(app).post(url.pathname);
      new Headers(init?.headers).forEach((value, key) => http.set(key, value));
      const response = await http.send(init?.body ? JSON.parse(String(init.body)) : undefined);
      if (response.status === 500 && serverFailure) throw serverFailure;
      if (
        state.crashAfterBind &&
        url.pathname.endsWith('/response/bind') &&
        response.status === 200
      ) {
        state.crashAfterBind = false;
        throw new Error('Simulated worker crash after canonical response binding');
      }
      return new Response(response.status === 204 ? null : response.text, {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    },
    { preconnect: () => {} },
  );
  await scoped(async () => {
    await models.User.create([
      { _id: ownerId, email: 'owner@fixture.test', provider: 'local', role: 'USER', tenantId },
      { _id: userId, email: 'actor@fixture.test', provider: 'local', role: 'USER', tenantId },
    ]);
    await models.Role.create({
      name: 'USER',
      permissions: {
        [PermissionTypes.AGENTS]: { [Permissions.USE]: true },
        [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: true },
      },
    });
    await models.Agent.create({
      id: 'agent',
      name: 'DM Agent',
      provider: 'openAI',
      model: 'fixture-model',
      author: ownerId,
      tenantId,
    });
    const configured = await installations.configureApplication({
      actorId: ownerId,
      applicationId,
      botUserId: botId,
      publicKey,
      encryptedBotToken: await encryptCredential('test-bot-token'),
      encryptedClientSecret: await encryptCredential('test-client-secret'),
    });
    if (!configured.ok) throw new Error(configured.error.code);
    const guild = await installations.connectGuild({
      actorId: ownerId,
      applicationId,
      applicationRevision: configured.value.revision,
      guildId,
      guildName: 'Source guild',
    });
    if (!guild.ok) throw new Error(guild.error.code);
    await methods.createAgentChannel({
      channelId: 'channel',
      revision: 'revision',
      agentId: 'agent',
      createdBy: ownerId,
      tenantId,
      type: 'discord',
      status: 'pending_install',
      credentialMode: 'per_user',
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      applicationRevision: configured.value.revision,
      discord: { applicationId, guildId, botUserId: botId, externalChannelId: parentId },
    });
    const assigned = await routes.assign({
      actorId: ownerId,
      applicationRevision: configured.value.revision,
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      channelId: 'channel',
      channelRevision: 'revision',
      externalChannelId: parentId,
    });
    if (!assigned.ok) throw new Error(assigned.error.code);
    const activated = await methods.getAgentChannelMetadata('channel');
    if (!activated || activated.type !== 'discord') throw new Error('Activated source missing');
    const saved = await identities.saveChannelIdentity(
      {
        tenantId,
        linkId: 'link',
        revision: 'link-revision',
        userId,
        state: 'active',
        ticketHash: 'a'.repeat(64),
        ticketExpiresAtMs: Date.now() + 600000,
        expiresAtMs: Date.now() + 172800000,
        identity: {
          tenantId,
          channelId: 'channel',
          channelRevision: activated.revision,
          agentId: 'agent',
          provider: 'discord',
          applicationId,
          guildId,
          externalUserId: actorId,
        },
      },
      null,
      configured.value.revision,
    );
    if (!saved) throw new Error('Source link unavailable');
    await models.ChannelIdentity.collection.updateOne(
      { linkId: 'link' },
      { $set: { discordActivatedAtMs: Date.now() - 5000 } },
    );
  });
  const application = await installations.lookupApplication(applicationId);
  if (!application) throw new Error('Application missing');
  const owner = {
    applicationId,
    applicationRevision: application.revision,
    ownerId: 'a'.repeat(32),
  };
  await scoped(async () => expect(await gateway.acquire(owner, 30000)).toBe(true));
  const connection = loadConfig({
    CHANNEL_SERVICE_TOKEN: token,
    CHANNEL_ID: 'channel',
    CHANNEL_TENANT_ID: tenantId,
    LIBRECHAT_INTERNAL_URL: 'http://internal.test',
  });
  const control = new DiscordControlClient(connection, transport);
  const webhook = createDiscordWebhook({
    capacity: policy().gateway.ingressConcurrency,
    policy: policy(),
    ready: () => true,
    security: resolver.security,
    submit: async () => {
      throw new Error('Unexpected guild submission');
    },
    select: control.select.bind(control),
    submitDm: control.submitDm.bind(control),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const signed = express();
  signed.post(`/discord/${applicationId}/interactions`, (req, res) => {
    void webhook.http(req, res);
  });
  const issued = await scoped(() =>
    dmService.issue(
      { id: userId, tenantId },
      { linkId: 'link', expectedLinkRevision: 'link-revision' },
    ),
  );
  if (!issued.ok) throw new Error(issued.error.code);
  const selectionEvent = snowflake(Date.now());
  const interaction = JSON.stringify({
    type: 2,
    id: selectionEvent,
    application_id: applicationId,
    token: 'private-interaction-token',
    version: 1,
    context: 1,
    authorizing_integration_owners: { '0': '0' },
    channel_id: dmId,
    user: { id: actorId },
    data: {
      id: '789012345678901234',
      name: 'librechat',
      type: 1,
      options: [
        { name: 'select', type: 1, options: [{ name: 'code', type: 3, value: issued.value.code }] },
      ],
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp), Buffer.from(interaction)]),
    keys.privateKey,
  ).toString('hex');
  const selected = await request(signed)
    .post(`/discord/${applicationId}/interactions`)
    .set('content-type', 'application/json')
    .set('x-signature-timestamp', timestamp)
    .set('x-signature-ed25519', signature)
    .send(interaction)
    .expect(200);
  expect(selected.body.data.content).toContain('selection is saved');
  const event: DiscordGatewayMessage = {
    ...owner,
    kind: 'message',
    shardId: 0,
    sequence: 1,
    messageId: snowflake(Date.now() + 1),
    channelId: dmId,
    channelType: 1,
    authorId: actorId,
    content: 'Answer privately',
    mentionsBot: false,
  };
  const rates = new DiscordRateCoordinator(policy().rateLimits);
  if (ordinary)
    await dispatchDiscordEvent(
      {
        owner,
        policy: policy(),
        application: {
          ...owner,
          botUserId: botId,
          botToken: 'test-bot-token',
          policy: policy().gateway,
        },
        rates,
        runtime: new DiscordRuntimeClient(connection, transport),
        gateway: new DiscordGatewayControlClient(connection, transport),
        transport,
      },
      event,
      new AbortController().signal,
    );
  const provider = createDiscordWorkerProvider({
    rates,
    owner,
    createClient: (bundle, coordinator) =>
      new DiscordClient(
        {
          botToken: bundle.credentials.botToken,
          timeoutMs: bundle.discord.requestTimeoutMs,
          maxResponseBytes: bundle.discord.maxResponseBytes,
        },
        transport,
        coordinator,
      ),
  });
  const client = () =>
    new ChannelClient(connection, transport, {
      type: 'discord',
      applicationRevision: owner.applicationRevision,
    });
  const worker = () =>
    new ChannelWorker(connection, client(), provider, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });
  return {
    async command(
      action: 'ask' | 'status' | 'cancel' | { reference: string; messageId: string },
      id = snowflake(Date.now()),
      channel = dmId,
    ) {
      const payload = JSON.stringify({
        type: typeof action === 'string' ? 2 : 3,
        id,
        application_id: applicationId,
        token: 'private-control-token',
        version: 1,
        context: 1,
        authorizing_integration_owners: { '0': '0' },
        channel_id: channel,
        user: { id: actorId },
        data:
          typeof action === 'string'
            ? {
                id: '789012345678901234',
                name: 'librechat',
                type: 1,
                options: [
                  {
                    name: action,
                    type: 1,
                    ...(action === 'ask'
                      ? { options: [{ name: 'prompt', type: 3, value: 'A signed private prompt' }] }
                      : {}),
                  },
                ],
              }
            : { component_type: 2, custom_id: discordRunControl('cancel', action.reference) },
        ...(typeof action === 'string' ? {} : { message: { id: action.messageId } }),
      });
      const time = String(Math.floor(Date.now() / 1000));
      return request(signed)
        .post(`/discord/${applicationId}/interactions`)
        .set('content-type', 'application/json')
        .set('x-signature-timestamp', time)
        .set(
          'x-signature-ed25519',
          sign(
            null,
            Buffer.concat([Buffer.from(time), Buffer.from(payload)]),
            keys.privateKey,
          ).toString('hex'),
        )
        .send(payload);
    },
    async reply() {
      const job = await control.claim(applicationId, owner.ownerId);
      if (!job) return null;
      const delivery =
        'inspection' in job
          ? await control.resolve({
              fence: job.fence,
              owner,
              source: await new DiscordClient(
                {
                  botToken: 'test-bot-token',
                  timeoutMs: policy().requestTimeoutMs,
                  maxResponseBytes: policy().maxResponseBytes,
                },
                transport,
                rates,
              ).inspectGuildTextActorSource({
                applicationId,
                botUserId: botId,
                guildId: job.inspection.guildId,
                channelId: job.inspection.externalChannelId,
                authorId: job.inspection.externalUserId,
              }),
            })
          : job;
      if (delivery) await control.finish(delivery.fence, 'completed');
      return delivery;
    },
    state,
    paths,
    writes,
    worker,
    runs,
    credentials,
    event,
    provider,
    client,
    selections,
    dmService,
    owner,
  };
}

it('runs a signed selected ordinary DM from queued admission through real first grant, Responses and actual DM delivery', async () => {
  const f = await fixture();
  await scoped(async () =>
    expect((await models.ChannelRun.findOne().lean())?.state).toBe('queued'),
  );
  await f.worker().tick(new AbortController().signal);
  await scoped(async () => {
    const run = await models.ChannelRun.findOne().lean();
    expect(run?.state).toBe('delivered');
    expect(run?.execution).toMatchObject({
      protocol: 'responses',
      apiKeyId: expect.any(String),
      responseId: expect.stringMatching(/^resp_/),
    });
    expect(run?.admission.actor).toMatchObject({ scope: 'dm', externalUserId: actorId });
    expect(run?.admission.actor).not.toHaveProperty('guildId');
    expect(run?.admission.externalChannelId).toBe(dmId);
    expect(await models.AgentApiKey.countDocuments()).toBe(1);
    expect(await models.StoredResponse.countDocuments()).toBe(1);
  });
  expect(f.state.inferenceCreates).toBe(1);
  expect(f.paths.findIndex((path) => path.endsWith('/response/prepare'))).toBeLessThan(
    f.paths.findIndex((path) => path === '/api/agents/v1/responses'),
  );
  expect(f.writes.some((write) => write.content === 'A private DM answer')).toBe(true);
  expect(f.writes.every((write) => write.path.includes(`/channels/${dmId}/`))).toBe(true);
});

it.each(['disabled', 'access'] as const)(
  'projects a restored DM after %s loss without a fresh grant or output',
  async (changed) => {
    const f = await fixture();
    f.state.crashAfterBind = true;
    await expect(f.worker().tick(new AbortController().signal)).rejects.toThrow(
      'Simulated worker crash after canonical response binding',
    );
    await scoped(async () => {
      const run = await models.ChannelRun.findOne().lean();
      expect(run?.execution?.responseId).toMatch(/^resp_/);
      await models.ChannelRun.updateOne(
        { runId: run?.runId },
        { $set: { leaseExpiresAt: Date.now() - 1 } },
      );
    });
    if (changed === 'disabled') f.state.enabled = false;
    else f.state.visible = false;
    f.paths.length = 0;
    f.writes.length = 0;
    await expect(f.worker().tick(new AbortController().signal)).rejects.toThrow();
    await scoped(async () => {
      const run = await models.ChannelRun.findOne().lean();
      expect(run?.snapshot).toMatchObject({ status: 'completed', text: 'A private DM answer' });
      expect(await models.AgentApiKey.countDocuments()).toBe(1);
    });
    expect(f.paths.some((path) => path.endsWith('/advance'))).toBe(true);
    expect(
      f.paths.some(
        (path) => path.endsWith('/response/prepare') || path.endsWith('/delivery/begin'),
      ),
    ).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.state.inferenceCreates).toBe(1);
  },
);

it.each(['revoked', 'expired', 'replaced'] as const)(
  'retires queued DM work after its selection is %s without minting credentials',
  async (changed) => {
    const f = await fixture();
    await scoped(async () => {
      const selected = await models.DiscordDmSelection.findOne().lean();
      if (!selected) throw new Error('Selected DM missing');
      if (changed === 'revoked')
        expect(await f.selections.revoke(userId, selected.selectionId, selected.revision)).toBe(
          true,
        );
      if (changed === 'expired')
        await models.DiscordDmSelection.updateOne(
          { selectionId: selected.selectionId },
          { $set: { expiresAtMs: Date.now() } },
        );
      if (changed === 'replaced') {
        const issued = await f.dmService.issue(
          { id: userId, tenantId },
          { linkId: 'link', expectedLinkRevision: 'link-revision' },
        );
        if (!issued.ok) throw new Error(issued.error.code);
        const result = await f.selections.consume(
          {
            applicationId,
            applicationRevision: f.owner.applicationRevision,
            externalUserId: actorId,
            dmChannelId: dmId,
            confirmationEventId: snowflake(Date.now()),
            codeHash: hashDiscordDmCode(issued.value.code),
          },
          Date.now(),
        );
        expect(result.ok).toBe(true);
      }
    });
    expect(await f.worker().tick(new AbortController().signal)).toBe(false);
    await scoped(async () => {
      const run = await models.ChannelRun.findOne().lean();
      expect(run).toMatchObject({
        state: 'cancelled',
        cancellationRequested: true,
        errorCode: 'channel_authority_changed',
      });
      expect(await models.AgentApiKey.countDocuments()).toBe(0);
    });
    expect(f.state.inferenceCreates).toBe(0);
    expect(f.writes).toEqual([]);
  },
);

it('admits a signed DM ask through fresh source inspection and delivers the actual DM, then returns private status while DM execution is off', async () => {
  const f = await fixture(false);
  f.state.gatewayEnabled = false;
  expect((await f.command('ask')).status).toBe(200);
  const queued = await f.reply();
  expect(queued?.reply.content).toContain('queued');
  await scoped(async () => {
    const row = await models.DiscordInbox.findOne().lean();
    expect(row?.dm?.source.guildId).toBe(guildId);
    expect(row).not.toHaveProperty('guildId');
    expect(row).not.toHaveProperty('action');
    expect((await models.ChannelRun.findOne().lean())?.admission).toMatchObject({
      actor: { scope: 'dm' },
      externalChannelId: dmId,
      input: 'A signed private prompt',
    });
  });
  await f.worker().tick(new AbortController().signal);
  f.state.enabled = false;
  expect((await f.command('status')).status).toBe(200);
  const status = await f.reply();
  expect(status?.reply.content).toContain('completed');
  expect(status?.reply.actions?.[0]).toMatchObject({
    url: expect.stringContaining('https://chat.example/prefix/c/'),
  });
  expect((await f.command('ask')).status).toBe(409);
  expect(f.writes.some((write) => write.content === 'A private DM answer')).toBe(true);
});
it('cancels only the current selected DM generation and validates the exact Stop receipt', async () => {
  const f = await fixture();
  await scoped(async () => {
    const run = await models.ChannelRun.findOne().lean();
    await models.ChannelRun.updateOne(
      { runId: run?.runId },
      { $set: { progress: { externalMessageKey: `${dmId}:777`, outcome: 'confirmed' } } },
    );
    expect((await f.command({ reference: run!.runId, messageId: '778' })).status).toBe(200);
    expect((await f.reply())?.reply.content).toContain('no active run');
    expect((await models.ChannelRun.findOne().lean())?.cancellationRequested).toBe(false);
    f.state.enabled = false;
    expect((await f.command({ reference: run!.runId, messageId: '777' })).status).toBe(200);
    expect((await f.reply())?.reply.content).toContain('Cancellation requested');
    expect((await models.ChannelRun.findOne().lean())?.cancellationRequested).toBe(true);
  });
});
it.each(['revoked', 'replaced', 'expired'] as const)(
  'erases a queued private command payload after selection %s and never admits its prompt',
  async (changed) => {
    const f = await fixture(false);
    expect((await f.command('ask')).status).toBe(200);
    await scoped(async () => {
      const selection = await models.DiscordDmSelection.findOne().lean();
      let update: object = { state: 'revoked' };
      if (changed === 'expired') update = { expiresAtMs: Date.now() - 1 };
      if (changed === 'replaced') update = { revision: 'replacement' };
      await models.DiscordDmSelection.updateOne(
        { selectionId: selection?.selectionId },
        { $set: update },
      );
    });
    expect(await f.reply()).toBeNull();
    await scoped(async () => {
      expect(await models.ChannelRun.countDocuments()).toBe(0);
      const row = await models.DiscordInbox.findOne()
        .select('+action +encryptedToken +encryptedReply')
        .lean();
      expect(row?.state).toBe('failed');
      expect(row).not.toHaveProperty('encryptedToken');
      expect(row).not.toHaveProperty('action');
    });
  },
);
it('rejects physical events predating DM confirmation and mismatched actual DM channels', async () => {
  const f = await fixture(false);
  const selected = await scoped(() => models.DiscordDmSelection.findOne().lean());
  expect((await f.command('ask', selected!.confirmationEventId)).status).toBe(409);
  expect((await f.command('status', snowflake(Date.now()), '678901234567890124')).status).toBe(409);
  await scoped(async () => expect(await models.DiscordInbox.countDocuments()).toBe(0));
});

it.each([
  ['guildId', guildId],
  ['eventId', 'invalid-restored-event'],
  ['dm', null],
  ['dm.source.userId', ownerId],
  ['dm.source.guildId', '234567890123456790'],
  ['dm.parentChannelId', '567890123456789013'],
] as const)('fails closed on a restored mixed or changed DM scope %s', async (field, value) => {
  const f = await fixture(false);
  expect((await f.command('ask')).status).toBe(200);
  await scoped(() =>
    models.DiscordInbox.collection.updateOne({ applicationId }, { $set: { [field]: value } }),
  );
  expect(await f.reply()).toBeNull();
  await scoped(async () => expect(await models.ChannelRun.countDocuments()).toBe(0));
});
it('refuses a signed prompt whose physical event predates the current native source consent', async () => {
  const f = await fixture(false);
  const event = snowflake(Date.now());
  expect((await f.command('ask', event)).status).toBe(200);
  await scoped(() =>
    models.ChannelIdentity.updateOne(
      { linkId: 'link' },
      { $set: { discordActivatedAtMs: Date.now() + 1000 } },
    ),
  );
  expect((await f.reply())?.reply.content).toContain('no longer authorized');
  await scoped(async () => expect(await models.ChannelRun.countDocuments()).toBe(0));
});

it('keeps private review metadata available while DM execution is disabled and cannot cancel a superseded selection', async () => {
  const f = await fixture();
  await scoped(() =>
    models.ChannelRun.updateOne(
      {},
      {
        $set: {
          state: 'requires_action',
          execution: { responseId: 'resp_private', conversationId: 'private-conversation' },
        },
      },
    ),
  );
  f.state.enabled = false;
  expect((await f.command('status')).status).toBe(200);
  expect((await f.reply())?.reply.actions?.[0]).toEqual({
    label: 'Review in LibreChat',
    url: 'https://chat.example/prefix/responses/resp_private/review',
  });
  await scoped(() =>
    models.DiscordDmSelection.updateOne({}, { $set: { revision: 'new-generation' } }),
  );
  expect((await f.command('cancel')).status).toBe(200);
  expect((await f.reply())?.reply.content).toContain('no active run');
  await scoped(async () =>
    expect((await models.ChannelRun.findOne().lean())?.cancellationRequested).toBe(false),
  );
});
