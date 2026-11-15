/// <reference lib="es2022" />
import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import express from 'express';
import request from 'supertest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { sign, createHash } from 'node:crypto';
import { channelConfigSchema } from 'librechat-data-provider';
import { discordRunControl, discordChannelConfigSchema } from 'librechat-data-provider';
import {
  createResponseStorage,
  createDiscordRouteStorage,
  createDiscordThreadStorage,
  createDiscordInboxResolutionStorage,
} from '@librechat/data-schemas';
import type { DiscordGuildThreadSource, DiscordPrivateReply } from 'librechat-data-provider';
import type { StoredResponseRecord } from '@librechat/data-schemas';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Response as AgentResponse } from '~/agents/responses/types';
import {
  keys,
  db,
  tenantId,
  owner,
  applicationId,
  guildId,
  botUserId,
  externalChannelId,
  externalUserId,
  scope,
  models,
  channels,
  installations,
  inbox,
  runs,
  authority,
  execute,
  channel,
  applicationRevision,
  enabled,
  eventId,
  linked,
  allRuns,
} from './commands.helper';
import { createDiscordWorkerProvider } from '../../../../channel-gateway/src/discord/worker';
import { DiscordRateCoordinator } from '../../../../channel-gateway/src/discord/rates';
import { createDiscordWebhook } from '../../../../channel-gateway/src/discord/http';
import { DiscordClient } from '../../../../channel-gateway/src/discord/client';
import { buildPendingBackgroundResponse } from '~/agents/responses/background';
import { encryptCredential, decryptCredential } from '~/crypto/credentials';
import { ChannelWorker } from '../../../../channel-gateway/src/worker';
import { ChannelClient } from '../../../../channel-gateway/src/client';
import { loadConfig } from '../../../../channel-gateway/src/config';
import { createChannelResponseCredentials } from '../credentials';
import { createChannelResponseProjection } from '../responses';
import { createDiscordInboxHandlers } from './inboxHttp';
import { createDiscordRouteResolver } from './routes';
import { createDiscordInboxService } from './inbox';
import { createChannelRunHandlers } from '../runs';
import { createChannelHandlers } from '../service';
function externalResponse(record: StoredResponseRecord): AgentResponse {
  return {
    ...buildPendingBackgroundResponse(record),
    status: 'completed',
    completed_at: Math.floor(Date.now() / 1000),
    output: [
      {
        type: 'message',
        id: 'msg_thread',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Thread answer', annotations: [], logprobs: [] }],
      },
    ],
  };
}

describe('signed native thread commands', () => {
  const threadId = '678901234567890123';
  const serviceToken = 'private-thread-service-token'.repeat(2);
  const owned = () => ({ applicationId, applicationRevision, ownerId: 'a'.repeat(32) });
  const policy = discordChannelConfigSchema.parse({ enabled: true });
  let server: Server;
  let base: string;
  let control: express.Express;
  let inaccessible: boolean;
  let archived: boolean;
  let threadType: 11 | 12;
  let authorMember: boolean;
  let writes: { path: string; body: Record<string, unknown> }[];
  let client: DiscordClient;
  let submissionStatus: number;
  let submissionCode: string;
  let responseCreates: number;
  const json = (value: object, status = 200) => Response.json(value, { status });
  async function inspect(): Promise<DiscordGuildThreadSource | null> {
    return client.inspectGuildThreadSource(
      { applicationId, botUserId, guildId, threadChannelId: threadId, authorId: externalUserId },
      new AbortController().signal,
    );
  }
  async function signed(
    action: 'ask' | 'status' | 'cancel',
    prompt = 'Thread prompt',
    component?: { customId: string; messageId: string },
  ) {
    const id = eventId();
    const body = JSON.stringify({
      type: component ? 3 : 2,
      id,
      application_id: applicationId,
      token: 'private-signed-token',
      version: 1,
      guild_id: guildId,
      context: 0,
      authorizing_integration_owners: { '0': guildId },
      channel_id: threadId,
      // An untrusted partial channel must never select the canonical parent.
      channel: { id: threadId, type: 11, parent_id: '999999999999999999' },
      member: { user: { id: externalUserId } },
      ...(component ? { message: { id: component.messageId, channel_id: threadId } } : {}),
      data: component
        ? { component_type: 2, custom_id: component.customId }
        : {
            id: '789012345678901234',
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
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]),
      keys.privateKey,
    ).toString('hex');
    const send = () =>
      fetch(`${base}/discord/${applicationId}/interactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-timestamp': timestamp,
          'x-signature-ed25519': signature,
        },
        body,
      });
    const ack = await (await send()).json();
    expect([200, 201]).toContain(submissionStatus);
    expect(submissionCode).toBeUndefined();
    expect(ack).toEqual({ type: 5, data: { flags: 64 } });
    expect(await (await send()).json()).toEqual({ type: 5, data: { flags: 64 } });
    const claimed = await request(control)
      .post('/claim')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ applicationId, owner: 'thread-inbox-worker' })
      .expect(200);
    expect(claimed.body.inspection.externalChannelId).toBe(threadId);
    const source = await inspect();
    const resolved = await request(control)
      .post('/resolve')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ fence: claimed.body.fence, owner: owned(), source })
      .expect(200);
    await request(control)
      .post('/finish')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ fence: claimed.body.fence, result: 'completed' })
      .expect(204);
    return { id, reply: resolved.body.reply as DiscordPrivateReply };
  }
  beforeEach(async () => {
    inaccessible = archived = false;
    threadType = 11;
    authorMember = true;
    writes = [];
    responseCreates = 0;
    const transport = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const path = new URL(String(input)).pathname;
        if ((init?.method ?? 'GET') === 'GET') {
          if (inaccessible) return json({}, 403);
          if (path.includes('/thread-members/')) {
            const user = path.split('/').at(-1);
            return user === externalUserId && !authorMember
              ? json({}, 404)
              : json({ id: threadId, user_id: user });
          }
          if (path.includes('/permissions/member/'))
            return json({
              permissions: path.endsWith(`/${externalUserId}`)
                ? '1024'
                : String(BigInt(1024 | 65536) | (BigInt(1) << BigInt(38))),
            });
          return json({
            id: threadId,
            guild_id: guildId,
            parent_id: externalChannelId,
            type: threadType,
            thread_metadata: { archived, locked: false },
          });
        }
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        writes.push({ path, body: JSON.parse(String(init?.body)) });
        return json({ id: '789012345678901234', channel_id: threadId });
      },
      { preconnect: fetch.preconnect },
    );
    client = new DiscordClient(
      { botToken: 'private-bot-token', timeoutMs: 1000, maxResponseBytes: 16384 },
      transport,
      new DiscordRateCoordinator(policy.rateLimits),
    );
    const resolver = createDiscordRouteResolver({
      installations,
      routes: createDiscordRouteStorage(db),
      channels,
      enabled: async () => enabled,
    });
    const service = createDiscordInboxService({
      storage: inbox,
      resolver,
      execute,
      encrypt: encryptCredential,
      decrypt: decryptCredential,
      retryDelayMs: async () => 1000,
      inspection: {
        storage: createDiscordInboxResolutionStorage(db),
        threads: createDiscordThreadStorage(db, async () => ({ maxThreadRoutes: 10 })),
        execute,
      },
    });
    const handlers = createDiscordInboxHandlers({ service, serviceToken: () => serviceToken });
    control = express();
    control.use(express.json());
    for (const name of ['submit', 'claim', 'resolve', 'finish', 'defer'] as const)
      control.post(`/${name}`, handlers[name]);
    const channelHandlers = createChannelHandlers({
      db: channels,
      serviceToken: () => serviceToken,
      config: async () => channelConfigSchema.parse({ enabled: true, discord: policy }),
      getAgent: async (id) => ({ id }),
      verifySlackToken: async () => null,
      logError: () => undefined,
    });
    const responses = createResponseStorage(db);
    const credentials = createChannelResponseCredentials({
      storage: runs,
      responses,
      getChannel: channels.getAgentChannelMetadata,
      resolvePrincipal: authority.resolvePrincipal,
      createKey: channels.createAgentApiKey,
      getKey: channels.getAgentApiKeyById,
      deleteKey: channels.deleteAgentApiKey,
      lifetimeMs: async () => 60000,
      encrypt: encryptCredential,
      decrypt: decryptCredential,
    });
    const readResponse = async (
      owner: { userId: string; tenantId?: string },
      responseId: string,
    ) => {
      const record = await responses.read(owner, responseId);
      if (!record) return { ok: false as const, status: 404 as const, code: 'missing' };
      if (record.sourceKeyId) {
        const key = await channels.getAgentApiKeyById(record.sourceKeyId, owner.userId);
        if (
          !key?.binding ||
          !(await credentials.authorizeSource(key.binding, key.id, owner, record.agentId))
        )
          return { ok: false as const, status: 403 as const, code: 'forbidden' };
      }
      return { ok: true as const, response: externalResponse(record) };
    };
    control.post('/api/agents/v1/responses', async (req, res) =>
      scope(async () => {
        // This is the substituted Responses HTTP boundary. Its real channel key/source authorization is retained.
        const token = req.get('authorization')?.replace(/^Bearer /, '') ?? '';
        const authenticated = await channels.validateBoundAgentApiKey(token);
        const user = authenticated ? await channels.findUser({ _id: authenticated.userId }) : null;
        if (
          !authenticated ||
          !user ||
          !(await credentials.authorizeRequest({
            keyId: authenticated.keyId,
            binding: authenticated.binding,
            user,
            request: req,
          }))
        )
          return void res.sendStatus(403);
        const [channelId, runId] = authenticated.binding.id.split('/');
        const run = await runs.read(tenantId, channelId, runId);
        if (!run?.execution) return void res.sendStatus(409);
        const requestJSON = JSON.stringify(req.body);
        const reserved = await responses.reserve({
          tenantId,
          userId: authenticated.userId,
          agentId: run.agentId,
          sourceKeyId: authenticated.keyId,
          responseId: 'resp_thread',
          requestKey: req.get('idempotency-key') ?? '',
          fingerprint: createHash('sha256').update(requestJSON).digest('hex'),
          requestJSON,
          conversationId: run.execution.conversationId,
          parentMessageId: run.execution.parentMessageId,
        });
        if (!reserved.ok) return void res.sendStatus(409);
        responseCreates++;
        res.json(externalResponse(reserved.record));
      }),
    );
    control.get('/api/agents/v1/responses/:responseId', async (req, res) =>
      scope(async () => {
        const token = req.get('authorization')?.replace(/^Bearer /, '') ?? '';
        const authenticated = await channels.validateBoundAgentApiKey(token);
        const user = authenticated ? await channels.findUser({ _id: authenticated.userId }) : null;
        if (
          !authenticated ||
          !user ||
          !(await credentials.authorizeRequest({
            keyId: authenticated.keyId,
            binding: authenticated.binding,
            user,
            request: req,
          }))
        )
          return void res.sendStatus(403);
        const result = await readResponse(
          { tenantId, userId: authenticated.userId },
          req.params.responseId,
        );
        if (!result.ok) return void res.sendStatus(result.status);
        res.json(result.response);
      }),
    );
    const runHandlers = createChannelRunHandlers({
      storage: runs,
      guard: channelHandlers.service,
      resolvePrincipal: authority.resolvePrincipal,
      responseCredential: credentials.provision,
      advance: createChannelResponseProjection({
        storage: responses,
        readResponse,
        cancelResponse: readResponse,
      }),
      retireForAuthorityLoss: async () => 'stopped',
    });
    control.get(
      '/api/channels/service/discord/:tenantId/:channelId',
      channelHandlers.discordBundle,
    );
    const root = '/api/channels/service/:channelId/runs';
    control.post(`${root}/claim`, runHandlers.claim);
    for (const [path, handler] of [
      ['renew', runHandlers.renew],
      ['yield', runHandlers.yieldLease],
      ['advance', runHandlers.advance],
      ['response/prepare', runHandlers.prepareResponse],
      ['response/bind', runHandlers.bindResponse],
      ['progress/plan', runHandlers.planProgress],
      ['progress/begin', runHandlers.beginProgress],
      ['progress/settle', runHandlers.settleProgress],
      ['plan', runHandlers.plan],
      ['delivery/begin', runHandlers.begin],
      ['delivery/settle', runHandlers.settle],
      ['commit', runHandlers.commit],
    ] as const)
      control.post(`${root}/:runId/${path}`, handler);
    const webhook = createDiscordWebhook({
      policy: { maxBodyBytes: 8192, signatureToleranceSeconds: 300, interactionTimeoutMs: 2000 },
      capacity: 2,
      ready: () => true,
      security: (id) => resolver.security(id),
      submit: async (input) => {
        const result = await request(control)
          .post('/submit')
          .set('Authorization', `Bearer ${serviceToken}`)
          .send(input);
        submissionStatus = result.status;
        submissionCode = result.body.error?.code ?? result.body.error;
        if (result.status !== 200 && result.status !== 201) throw new Error('Submission failed');
        return 'accepted';
      },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    server = createServer((req, res) => {
      if (req.url?.startsWith('/discord/')) void webhook.http(req, res);
      else control(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server?.closeAllConnections();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });
  it.each([11, 12] as const)(
    'resumes an admitted signed type %s thread prompt and delivers through fresh owned REST',
    (type) =>
      scope(async () => {
        await linked();
        threadType = type;
        const sent = await signed('ask');
        expect(sent.reply.content).toContain('queued');
        const [stored] = await allRuns();
        expect(stored.admission).toMatchObject({
          eventId: sent.id,
          input: 'Thread prompt',
          externalChannelId: threadId,
          externalThreadKey: `${threadId}:${sent.id}`,
          discordDestination: { kind: 'guild_thread', parentChannelId: externalChannelId },
        });
        expect(await allRuns()).toHaveLength(1);
        const source = await inspect();
        if (!source) throw new Error('Missing fresh thread source');
        const proof = {
          applicationRevision,
          native: { kind: 'guild_thread' as const, owner: owned(), source },
        };
        const run = await runs.claim(
          tenantId,
          channel.channelId,
          'thread-run-worker',
          Date.now(),
          30000,
        );
        if (!run) throw new Error('Missing admitted run');
        const fence = { runId: run.runId, owner: run.leaseOwner!, epoch: run.leaseEpoch };
        await runs.prepareExecution(tenantId, fence, Date.now(), proof);
        // The external inference boundary supplies a retained Response with the real request identity.
        await models.StoredResponse.create({
          tenantId,
          userId: owner,
          responseId: 'resp_thread',
          requestKey: `channel:${run.runId}`,
          fingerprint: 'provider-request',
          agentId: channel.agentId,
          requestJSON: JSON.stringify({
            model: channel.agentId,
            input: run.admission.input,
            background: true,
            store: true,
          }),
          conversationId: 'thread-conversation',
          parentMessageId: 'thread-parent',
          status: 'completed',
          revision: 0,
        });
        const bound = await runs.bindResponse(tenantId, fence, 'resp_thread', Date.now());
        const config = loadConfig({
          CHANNEL_SERVICE_TOKEN: serviceToken,
          CHANNEL_ID: channel.channelId,
          CHANNEL_TENANT_ID: tenantId,
          LIBRECHAT_INTERNAL_URL: base,
        });
        const provider = createDiscordWorkerProvider({
          owner: owned(),
          rates: new DiscordRateCoordinator(policy.rateLimits),
          createClient: () => client,
        });
        const worker = new ChannelWorker(
          config,
          new ChannelClient(config, fetch, { type: 'discord' }),
          provider,
          { info: () => undefined, warn: () => undefined, error: () => undefined },
        );
        await worker.process(
          {
            run: { ...bound, revision: channel.revision },
            fence,
            leaseExpiresAt: bound.leaseExpiresAt,
          },
          new AbortController().signal,
        );
        expect((await allRuns())[0].state).toBe('delivered');
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({
          path: `/api/v10/channels/${threadId}/messages`,
          body: {
            content: 'Thread answer',
            allowed_mentions: { parse: [], replied_user: false },
            enforce_nonce: true,
          },
        });
        expect((await signed('status')).reply.content).toContain('completed');
      }),
  );
  it('takes a NEW signed thread prompt through worker credential issuance, Responses create/bind, projection and actual thread delivery', () =>
    scope(async () => {
      await linked();
      await signed('ask', 'First execution');
      expect((await allRuns())[0].execution).toBeUndefined();
      const config = loadConfig({
        CHANNEL_SERVICE_TOKEN: serviceToken,
        CHANNEL_ID: channel.channelId,
        CHANNEL_TENANT_ID: tenantId,
        LIBRECHAT_INTERNAL_URL: base,
      });
      const provider = createDiscordWorkerProvider({
        owner: owned(),
        rates: new DiscordRateCoordinator(policy.rateLimits),
        createClient: () => client,
      });
      const worker = new ChannelWorker(
        config,
        new ChannelClient(config, fetch, { type: 'discord' }),
        provider,
        { info: () => undefined, warn: () => undefined, error: () => undefined },
      );
      expect(await worker.tick(new AbortController().signal)).toBe(true);
      const [run] = await allRuns();
      expect(run.state).toBe('delivered');
      expect(run.execution).toMatchObject({ protocol: 'responses', responseId: 'resp_thread' });
      expect(run.execution?.apiKeyId).toBeTruthy();
      expect(await channels.getAgentApiKeyById(run.execution!.apiKeyId!, owner)).not.toBeNull();
      expect(responseCreates).toBe(1);
      expect(writes.some((write) => write.body.content === 'Thread answer')).toBe(true);
      for (const write of writes) {
        expect(write.path).toContain(`/channels/${threadId}/messages`);
        expect(write.body.allowed_mentions).toEqual({ parse: [], replied_user: false });
      }
    }));
  it('honors native Stop only for the confirmed message in the same mapped thread', () =>
    scope(async () => {
      await linked();
      await signed('ask');
      const run = await runs.claim(
        tenantId,
        channel.channelId,
        'progress-worker',
        Date.now(),
        30000,
      );
      if (!run || !run.leaseOwner) throw new Error('Missing run');
      const fence = { runId: run.runId, owner: run.leaseOwner, epoch: run.leaseEpoch };
      const source = await inspect();
      if (!source) throw new Error('Missing source');
      await runs.planProgress(
        tenantId,
        fence,
        { revision: 1, rendererVersion: 'discord-progress-v1', text: 'Working' },
        Date.now(),
      );
      await runs.beginProgress(tenantId, fence, 1, Date.now(), {
        applicationRevision,
        native: { kind: 'guild_thread', owner: owned(), source },
      });
      await runs.settleProgress(
        tenantId,
        fence,
        {
          revision: 1,
          outcome: 'confirmed',
          attempts: 1,
          externalMessageKey: `${threadId}:789012345678901235`,
        },
        Date.now(),
      );
      const customId = discordRunControl('cancel', run.runId);
      expect(
        (await signed('cancel', '', { customId, messageId: '789012345678901236' })).reply.content,
      ).toContain('no active run');
      expect((await allRuns())[0].cancellationRequested).toBe(false);
      expect(
        (await signed('cancel', '', { customId, messageId: '789012345678901235' })).reply.content,
      ).toContain('Cancellation requested');
      expect((await allRuns())[0].cancellationRequested).toBe(true);
    }));
  it('refuses a private thread after the actor loses membership', () =>
    scope(async () => {
      await linked();
      threadType = 12;
      authorMember = false;
      expect((await signed('ask')).reply.content).toContain('unavailable');
      expect(await allRuns()).toHaveLength(0);
      expect(writes).toEqual([]);
    }));
  it.each(['inaccessible', 'archived'])(
    'refuses %s thread inspection without creating a run',
    async (state) =>
      scope(async () => {
        await linked();
        inaccessible = state === 'inaccessible';
        archived = state === 'archived';
        expect((await signed('ask')).reply.content).toContain('unavailable');
        expect(await allRuns()).toHaveLength(0);
        expect(writes).toEqual([]);
      }),
  );
  it('does not replay an unlinked thread prompt after linking, and cancels only the actual thread actor destination', () =>
    scope(async () => {
      expect((await signed('ask', 'Do not replay')).reply.content).toContain(
        'will not run automatically',
      );
      expect(await allRuns()).toHaveLength(0);
      await linked();
      await signed('ask', 'Fresh prompt');
      expect((await signed('cancel')).reply.content).toContain('Cancellation requested');
      const [stored] = await allRuns();
      expect(stored.admission.input).toBe('Fresh prompt');
      expect(stored.cancellationRequested).toBe(true);
    }));
});
