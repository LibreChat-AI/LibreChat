import { createHash } from 'node:crypto';
import {
  discordChannelConfigSchema,
  DEFAULT_CHANNEL_GATEWAY_POLICY,
} from 'librechat-data-provider';
import type {
  ChannelDeliveryPlan,
  ChannelDeliveryReceipt,
  ChannelRunSummary,
  ChannelRunView,
  DiscordRunEffectAuthority,
  DiscordChannelServiceBundle,
} from 'librechat-data-provider';
import type { APIActionRowComponent, APIButtonComponent } from 'discord-api-types/v10';
import type { Lease, Logger } from '../types';
import {
  renderDiscordPlan,
  discordRendererVersion,
  discordLegacyRendererVersion,
  discordPlanRevision,
  sanitizeDiscordMentions,
  discordFeedbackPresentation,
  discordSessionRendererVersion,
} from './render';
import { createDiscordWorkerProvider, discordProgressText } from './worker';
import { DiscordClient, DiscordWriteError, discordNonce } from './client';
import { DiscordRateCoordinator } from './rates';
import { ChannelWorker } from '../worker';
import { ChannelClient } from '../client';
import { loadConfig } from '../config';

interface Mutation {
  discordAuthority?: DiscordRunEffectAuthority;
  revision?: number;
  rendererVersion?: string;
  text?: string;
  plan?: ChannelDeliveryPlan;
  operationId?: string;
  receipt?: ChannelDeliveryReceipt;
}
interface Write {
  document?: string;
  components?: APIActionRowComponent<APIButtonComponent>[];
  content?: string;
  nonce?: string;
  enforce_nonce?: boolean;
  allowed_mentions?: { parse: string[]; replied_user: boolean };
}
const json = (value: object, status = 200) => Response.json(value, { status });
const summary = (url: string): ChannelRunSummary => ({
  version: 1,
  scope: 'actor_lane',
  throughSequence: 1,
  includesCurrent: true,
  priorRuns: 0,
  expectedRuns: 1,
  observedRuns: 1,
  costUSD: { coverage: 'unavailable', coveredRuns: 0 },
  elapsedMs: { coverage: 'unavailable', coveredRuns: 0 },
  tokens: { coverage: 'unavailable', coveredRuns: 0 },
  session: { url },
});

function fixture(owned = false, thread = false, dm = false) {
  const config = loadConfig({
    CHANNEL_SERVICE_TOKEN: 'service-token',
    CHANNEL_ID: 'channel-1',
    CHANNEL_TENANT_ID: 'tenant-1',
    LIBRECHAT_INTERNAL_URL: 'http://backend.example',
  });
  const bundle: DiscordChannelServiceBundle = {
    channel: {
      channelId: config.CHANNEL_ID,
      tenantId: config.CHANNEL_TENANT_ID,
      agentId: 'agent-1',
      createdBy: 'user-1',
      credentialMode: 'per_user',
      type: 'discord',
      status: 'active',
      revision: 'channel-revision',
      installationId: 'installation-1',
      installationRevision: 'guild-revision',
      discord: { applicationId: '123', guildId: '456', botUserId: '789', externalChannelId: '111' },
    },
    credentials: { botToken: 'current-token' },
    applicationRevision: 'app-revision',
    agent: { id: 'agent-1' },
    delivery: { maxDeliveryParts: 100 },
    gateway: {
      version: 1,
      ...DEFAULT_CHANNEL_GATEWAY_POLICY,
      transport: 'webhook',
      nativeSessions: false,
      lifecycleReactions: false,
    },
    discord: discordChannelConfigSchema.parse({ enabled: true }),
  };
  const state: ChannelRunView = {
    runId: 'run-1',
    channelId: config.CHANNEL_ID,
    revision: bundle.channel.revision,
    sequence: 1,
    state: 'executing',
    cancellationRequested: false,
    receipts: [],
    admission: {
      eventId: '222',
      externalChannelId: '111',
      externalThreadKey: '111:222',
      externalMessageKey: '111:222',
      actor: { provider: 'discord', applicationId: '123', guildId: '456', externalUserId: '333' },
      input: 'private prompt',
    },
  };
  if (thread)
    state.admission = {
      ...state.admission,
      externalChannelId: '555',
      externalThreadKey: '555:555',
      externalMessageKey: '555:222',
      discordDestination: {
        kind: 'guild_thread',
        parentChannelId: '111',
        mappingRevision: 'thread-revision',
      },
    };
  if (dm) {
    bundle.discord.dm.enabled = true;
    state.admission = {
      ...state.admission,
      externalChannelId: '555',
      externalThreadKey: '555:444',
      externalMessageKey: '555:222',
      actor: {
        provider: 'discord',
        scope: 'dm',
        applicationId: '123',
        externalUserId: '333',
        selectionId: 'selection',
        selectionRevision: 'generation',
      },
      discordDestination: {
        kind: 'dm',
        parentChannelId: '111',
        selectionId: 'selection',
        selectionRevision: 'generation',
      },
    };
  }
  const lease: Lease = {
    run: state,
    fence: { runId: state.runId, owner: 'worker-1', epoch: 1 },
    leaseExpiresAt: Date.now() + 60_000,
  };
  const calls: { path: string; body: Mutation; headers: Headers }[] = [];
  const writes: { method: string; path: string; body: Write; headers: Headers }[] = [];
  const hooks: {
    advance?: () => void;
    begin?: () => void;
    commit?: () => Response;
    read?: (path: string) => Response | undefined;
    write?: () => Response;
  } = {};
  const backend = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body: Mutation = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body, headers: new Headers(init?.headers) });
      if (path.includes('/service/discord/')) return json(bundle);
      if (path.includes('/api/agents/v1/responses/'))
        return json({
          id: 'resp_123',
          object: 'response',
          model: bundle.agent.id,
          background: true,
          store: true,
          status: 'completed',
        });
      if (path.endsWith('/response/prepare'))
        return json({
          apiKey: 'sk-bound-test',
          requestKey: `channel:${state.runId}`,
          responseId: 'resp_123',
          request: {
            model: bundle.agent.id,
            input: state.admission.input,
            background: true,
            store: true,
          },
        });
      if (path.endsWith('/advance')) {
        if (hooks.advance) hooks.advance();
        else {
          state.state = 'delivering';
          state.snapshot = {
            status: 'completed',
            responseId: 'resp_123',
            text: 'Final answer',
            elapsedMs: 10,
          };
        }
      } else if (path.endsWith('/progress/plan')) {
        state.progress = {
          revision: body.revision ?? 0,
          rendererVersion: body.rendererVersion ?? '',
          text: body.text ?? '',
          outcome: 'planned',
          attempts: 0,
          externalMessageKey: state.progress?.externalMessageKey,
        };
      } else if (path.endsWith('/progress/begin')) {
        if (!state.progress) throw new Error('Missing test progress');
        state.progress.outcome = 'inflight';
        state.progress.attempts++;
      } else if (path.endsWith('/progress/settle')) {
        if (!state.progress || !body.receipt) throw new Error('Missing test progress receipt');
        state.progress = { ...state.progress, ...body.receipt };
      } else if (path.endsWith('/plan')) {
        state.plan = body.plan;
        state.receipts =
          body.plan?.parts.map((part) => ({
            operationId: part.operationId,
            attempts: 0,
            outcome: 'planned',
          })) ?? [];
      } else if (path.endsWith('/delivery/begin')) {
        if (hooks.begin) {
          hooks.begin();
          if (body.operationId?.includes(':trace:'))
            return json({ error: 'trace_unavailable' }, 409);
        }
        const receipt = state.receipts.find((item) => item.operationId === body.operationId);
        if (!receipt) throw new Error('Missing test receipt');
        receipt.outcome = 'inflight';
        receipt.attempts++;
      } else if (path.endsWith('/delivery/settle')) {
        const receipt = state.receipts.find(
          (item) => item.operationId === body.receipt?.operationId,
        );
        if (!receipt) throw new Error('Missing test settlement');
        Object.assign(receipt, body.receipt);
      } else if (path.endsWith('/commit')) {
        if (hooks.commit) return hooks.commit();
        state.state = 'delivered';
      } else throw new Error('Unexpected worker test operation');
      return json(state);
    },
  );
  let messageId = 1000;
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      const form = init?.body instanceof FormData ? init.body : undefined;
      const serialized = form ? form.get('payload_json') : init?.body;
      const body: Write = serialized ? JSON.parse(String(serialized)) : {};
      if (form) {
        const file = form.get('files[0]');
        if (!(file instanceof Blob)) throw new Error('Missing document');
        body.document = await file.text();
      }
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        const response = hooks.read?.(path);
        if (response) return response;
        if (path.includes('/guilds/') && path.includes('/members/'))
          return json({ user: { id: '333' } });
        if (path.includes('/permissions/member/')) {
          const botPermissions = thread
            ? String(BigInt(1024 | 65536) | (BigInt(1) << BigInt(38)))
            : '68608';
          return json({ permissions: path.endsWith('/333') ? '1024' : botPermissions });
        }
        return thread
          ? json({
              id: '555',
              guild_id: '456',
              parent_id: '111',
              type: 11,
              thread_metadata: { archived: false, locked: false },
            })
          : json({ id: '111', guild_id: '456', type: 0 });
      }
      writes.push({ path, body, method, headers: new Headers(init?.headers) });
      if (hooks.write) return hooks.write();
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (calls.at(-1)?.path.endsWith('/delivery/begin'))
        expect(state.receipts.some((item) => item.outcome === 'inflight')).toBe(true);
      return json({
        channel_id: path.split('/')[4],
        ...(body.document
          ? { attachments: [{ filename: 'reply.md', size: Buffer.byteLength(body.document) }] }
          : {}),
        id: method === 'PATCH' ? path.split('/').at(-1) : String(++messageId),
      });
    },
  );
  const rates = new DiscordRateCoordinator(bundle.discord.rateLimits);
  const createClient = jest.fn(
    (current: DiscordChannelServiceBundle, coordinator: DiscordRateCoordinator) =>
      new DiscordClient(
        {
          botToken: current.credentials.botToken,
          timeoutMs: current.discord.requestTimeoutMs,
          maxResponseBytes: current.discord.maxResponseBytes,
          apiBase: 'https://discord.test/api/v10',
        },
        transport,
        coordinator,
      ),
  );
  const provider = createDiscordWorkerProvider({
    rates,
    createClient,
    ...(owned
      ? {
          owner: {
            applicationId: '123',
            applicationRevision: bundle.applicationRevision,
            ownerId: 'a'.repeat(32),
          },
        }
      : {}),
  });
  const log: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const client = new ChannelClient(config, backend, { type: 'discord' });
  const worker = new ChannelWorker(config, client, provider, log);
  const controller = new AbortController();
  const execute = () =>
    worker.process({ ...lease, run: structuredClone(state) }, controller.signal);
  const savedPlan = (text = 'Saved final answer', session?: ChannelRunSummary) => {
    state.state = 'delivering';
    state.snapshot = {
      status: 'completed',
      text,
      responseId: 'resp_123',
      elapsedMs: 10,
      summary: session,
    };
    state.plan = undefined;
    state.plan = provider.makePlan(state, bundle);
    state.receipts = state.plan.parts.map((part) => ({
      operationId: part.operationId,
      outcome: 'planned',
      attempts: 0,
    }));
  };
  return {
    bundle,
    state,
    lease,
    calls,
    writes,
    hooks,
    backend,
    transport,
    rates,
    createClient,
    provider,
    controller,
    worker,
    execute,
    restartExecute: () =>
      new ChannelWorker(
        config,
        new ChannelClient(config, backend, { type: 'discord' }),
        createDiscordWorkerProvider({
          rates: new DiscordRateCoordinator(bundle.discord.rateLimits),
          createClient,
        }),
        log,
      ).process({ ...lease, run: structuredClone(state) }, controller.signal),
    savedPlan,
  };
}

describe('Discord durable worker delivery', () => {
  test.each(['0', '2048'])(
    'refuses a saved answer when actor visibility becomes %s after begin',
    async (permissions) => {
      const f = fixture();
      f.savedPlan();
      f.hooks.begin = () => {
        f.hooks.read = (path) =>
          path.includes('/permissions/member/333') ? json({ permissions }) : undefined;
      };
      await expect(f.execute()).rejects.toThrow('Delivery not confirmed');
      expect(f.writes).toEqual([]);
      expect(f.state.receipts[0]).toMatchObject({ outcome: 'permanent_failure' });
    },
  );

  test.each([403, 404])(
    'does not send when Discord reports the actor unavailable with %s',
    async (status) => {
      const f = fixture();
      f.savedPlan();
      f.hooks.read = (path) =>
        path.endsWith('/333') ? json({ message: 'private details' }, status) : undefined;
      await expect(f.execute()).rejects.toThrow('Delivery not confirmed');
      expect(f.writes).toEqual([]);
      expect(f.state.receipts[0].outcome).toBe('permanent_failure');
    },
  );

  test('retries failed permission reads without claiming an uncertain message write', async () => {
    const f = fixture();
    f.savedPlan();
    f.hooks.read = (path) => (path.includes('/permissions/member/333') ? json({}, 503) : undefined);
    await expect(f.execute()).rejects.toThrow('Delivery not confirmed');
    expect(f.writes).toEqual([]);
    expect(f.state.receipts[0]).toMatchObject({
      outcome: 'retryable',
      errorCode: 'transport_retryable',
    });
  });

  test.each(['1024', '8'])(
    'allows a currently visible read-only or administrator actor (%s)',
    async (permissions) => {
      const f = fixture();
      f.savedPlan();
      f.hooks.read = (path) =>
        path.includes('/permissions/member/333') ? json({ permissions }) : undefined;
      await f.execute();
      expect(f.writes).toHaveLength(1);
      expect(f.state.state).toBe('delivered');
    },
  );

  test.each([undefined, '111:777'])(
    'blocks progress creation or editing after actor access is lost (%s)',
    async (externalMessageKey) => {
      const f = fixture();
      f.state.progress = {
        revision: 1,
        rendererVersion: 'discord-progress-v1',
        text: 'Working...',
        outcome: 'inflight',
        attempts: 1,
        externalMessageKey,
      };
      f.hooks.read = (path) =>
        path.includes('/permissions/member/333') ? json({ permissions: '0' }) : undefined;
      await expect(
        f.provider.writeProgress(f.state, f.bundle, f.controller.signal),
      ).rejects.toMatchObject({ outcome: 'permanent' });
      expect(f.writes).toEqual([]);
    },
  );

  test('still removes stale progress after the actor loses channel access', async () => {
    const f = fixture();
    f.state.progress = {
      revision: 1,
      rendererVersion: 'discord-progress-v1',
      text: 'Working...',
      outcome: 'confirmed',
      attempts: 1,
      externalMessageKey: '111:777',
    };
    f.hooks.read = () => json({}, 403);
    await f.provider.deleteProgress(f.state, f.bundle, f.controller.signal);
    expect(f.writes.map((write) => write.method)).toEqual(['DELETE']);
  });

  test('refuses a channel that changed to an unsupported destination before delivery', async () => {
    const f = fixture();
    f.savedPlan();
    f.hooks.read = (path) =>
      path.endsWith('/channels/111') ? json({ id: '111', guild_id: '456', type: 11 }) : undefined;
    await expect(f.execute()).rejects.toThrow('Delivery not confirmed');
    expect(f.writes).toEqual([]);
    expect(f.state.receipts[0].outcome).toBe('permanent_failure');
  });

  test('uses the shared Responses flow and persists progress and answer receipts before writes', async () => {
    const f = fixture();
    await f.execute();
    expect(f.state.state).toBe('delivered');
    expect(f.writes.map((write) => write.method)).toEqual(['POST', 'PATCH', 'POST', 'DELETE']);
    expect(f.writes.map((write) => write.body.content)).toEqual([
      'Working...',
      'Reply ready; delivery is not confirmed yet. Use /librechat status if it does not arrive.',
      'Final answer',
      undefined,
    ]);
    expect(f.writes[0].body.components).toEqual([
      { type: 1, components: [{ type: 2, style: 4, label: 'Stop', custom_id: 'lc1:x:run-1' }] },
    ]);
    expect(f.writes[1].body.components).toEqual([]);
    expect(f.writes[0].body.nonce).toBe(discordNonce('run-1:progress:1'));
    expect(f.writes[2].body.nonce).toBe(discordNonce('run-1:discord:0'));
    for (const write of f.writes.filter((item) => item.method !== 'DELETE')) {
      expect(write.body.allowed_mentions).toEqual({ parse: [], replied_user: false });
      expect(write.headers.get('authorization')).toBe('Bot current-token');
    }
    const response = f.calls.find((call) => call.path.includes('/api/agents/v1/responses/'))!;
    expect(response.headers.get('X-Discord-Application-Revision')).toBeNull();
    expect(
      f.calls
        .find((call) => call.path.endsWith('/delivery/begin'))
        ?.headers.get('X-Discord-Application-Revision'),
    ).toBe('app-revision');
    expect(f.state.receipts[0]).toMatchObject({
      outcome: 'confirmed',
      externalMessageKey: '111:1002',
    });
  });

  test('an uncertain final write is held on recovery without replaying Responses or delivery', async () => {
    const f = fixture();
    f.savedPlan();
    f.hooks.write = () => {
      throw new DOMException('sensitive transport detail', 'TimeoutError');
    };
    await expect(f.execute()).rejects.toThrow('Delivery not confirmed');
    expect(f.state.receipts[0]).toMatchObject({
      outcome: 'unknown',
      errorCode: 'transport_uncertain',
    });
    await expect(f.execute()).rejects.toThrow('reconciliation');
    expect(f.writes).toHaveLength(1);
    expect(f.transport).toHaveBeenCalledTimes(5);
    expect(f.calls.some((call) => /response\/prepare|\/advance$/.test(call.path))).toBe(false);
  });

  test('a confirmed answer is not replayed after a failed commit', async () => {
    const f = fixture();
    f.savedPlan();
    f.hooks.commit = () => json({ error: 'unavailable' }, 503);
    await expect(f.execute()).rejects.toThrow('HTTP 503');
    f.hooks.commit = undefined;
    await f.execute();
    expect(f.state.state).toBe('delivered');
    expect(f.writes).toHaveLength(1);
    expect(f.transport).toHaveBeenCalledTimes(5);
  });

  test('safe rate-limit rejections remain retryable without immediate replay', async () => {
    const f = fixture();
    f.savedPlan();
    f.hooks.write = () => json({ retry_after: 2 }, 429);
    await expect(f.execute()).rejects.toThrow('Delivery not confirmed');
    expect(f.state.receipts[0]).toMatchObject({
      outcome: 'retryable',
      errorCode: 'transport_retryable',
    });
    expect(f.state.receipts[0].retryAt).toBeGreaterThan(Date.now());
    await expect(f.execute()).rejects.toThrow('reconciliation');
    expect(f.writes).toHaveLength(1);
    expect(f.transport).toHaveBeenCalledTimes(5);
  });

  test('each new worker turn uses refreshed credentials and the same rate coordinator', async () => {
    const f = fixture();
    f.savedPlan();
    await f.execute();
    f.bundle.credentials.botToken = 'rotated-token';
    f.bundle.applicationRevision = 'rotated-revision';
    f.state.runId = 'run-2';
    f.lease.fence.runId = 'run-2';
    f.savedPlan();
    await f.execute();
    expect(f.writes.map((write) => write.headers.get('authorization'))).toEqual([
      'Bot current-token',
      'Bot rotated-token',
    ]);
    expect(f.createClient.mock.calls.every(([, rates]) => rates === f.rates)).toBe(true);
    expect(
      f.calls
        .filter((call) => call.path.endsWith('/delivery/begin'))
        .map((call) => call.headers.get('X-Discord-Application-Revision')),
    ).toEqual(['app-revision', 'rotated-revision']);
  });

  test.each(['application', 'guild', 'actor', 'destination', 'thread'])(
    'rejects a changed %s binding before any provider effect',
    async (variant) => {
      const f = fixture();
      f.savedPlan();
      if (f.state.admission.actor.provider !== 'discord') throw new Error('Invalid test actor');
      if (variant === 'application') f.state.admission.actor.applicationId = '999';
      if (variant === 'guild') f.state.admission.actor.guildId = '999';
      if (variant === 'actor') f.state.admission.actor.externalUserId = '01';
      if (variant === 'destination') {
        f.state.admission.externalChannelId = '999';
        f.state.admission.externalThreadKey = '999:222';
        f.state.admission.externalMessageKey = '999:222';
      }
      if (variant === 'thread') f.state.admission.externalThreadKey = '111:222:333';
      await expect(f.execute()).rejects.toThrow();
      expect(f.transport).not.toHaveBeenCalled();
      expect(f.calls.some((call) => /progress\/begin|delivery\/begin/.test(call.path))).toBe(false);
    },
  );

  test('revalidates the destination returned after delivery/begin before sending', async () => {
    const f = fixture();
    f.savedPlan();
    f.hooks.begin = () => {
      f.state.admission.externalChannelId = '999';
      f.state.admission.externalThreadKey = '999:222';
      f.state.admission.externalMessageKey = '999:222';
    };
    await expect(f.execute()).rejects.toThrow('Run admission changed');
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.state.receipts[0].outcome).toBe('inflight');
  });

  test.each(['artifact', 'presentation'])(
    'rejects persisted %s plans before any receipt begins',
    async (variant) => {
      const f = fixture();
      f.savedPlan();
      if (variant === 'artifact') {
        f.state.plan!.parts[0].kind = 'artifact';
        f.state.plan!.parts[0].artifactId = 'private-file';
      } else f.state.plan!.parts[0].presentation = { format: 'untrusted', payload: '{}' };
      await expect(f.execute()).rejects.toThrow(
        variant === 'artifact'
          ? 'Unsupported Discord delivery part'
          : 'Invalid Discord feedback presentation',
      );
      expect(f.calls.some((call) => call.path.endsWith('/delivery/begin'))).toBe(false);
      expect(f.transport).not.toHaveBeenCalled();
    },
  );

  test('safely shortens fenced Unicode output under a reduced delivery budget', async () => {
    const f = fixture();
    f.bundle.delivery.maxDeliveryParts = 1;
    f.savedPlan('```typescript\n' + '😀'.repeat(2500) + '\n```');
    await f.execute();
    expect(f.writes).toHaveLength(1);
    const text = f.writes[0].body.content!;
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain('\n```\n\nReply shortened');
    expect(text).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(f.state.state).toBe('delivered');
  });

  test('delivers a currently authorized trace as a separate optional immutable operation', async () => {
    const f = fixture();
    const url = 'https://chat.company.com/trace/session';
    f.savedPlan('Answer', summary(url));
    await f.execute();
    expect(f.writes.map((write) => write.body.content)).toEqual([
      'Answer',
      `[View session](<${url}>)`,
    ]);
    expect(f.writes[1].body.nonce).toBe(discordNonce('run-1:trace:0'));
    expect(f.state.receipts[1].outcome).toBe('confirmed');
  });

  test('trace links remain optional and a revoked link never reaches Discord', async () => {
    const f = fixture();
    f.savedPlan('Answer', summary('https://chat.company.com/trace/session'));
    expect(f.state.plan?.parts.at(-1)).toMatchObject({
      required: false,
      traceUrl: 'https://chat.company.com/trace/session',
    });
    f.hooks.begin = () => {};
    await f.execute();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].body.content).toBe('Answer');
    expect(f.state.state).toBe('delivered');
  });

  test.each(['http://127.0.0.1/session', 'https://chat.company.com/session?token=secret'])(
    'omits unsafe trace URL %s',
    (url) => {
      const f = fixture();
      f.savedPlan('Answer', summary(url));
      expect(f.state.plan?.parts).toHaveLength(1);
    },
  );

  test('artifact snapshots preserve text with a notice and never produce uploads', async () => {
    const f = fixture();
    f.state.state = 'delivering';
    f.state.snapshot = {
      status: 'completed',
      text: 'Answer',
      elapsedMs: 10,
      responseId: 'resp_123',
      artifacts: [
        {
          artifactId: 'file',
          filename: 'private.txt',
          mediaType: 'text/plain',
          bytes: 1,
          sha256: createHash('sha256').update('a').digest('hex'),
        },
      ],
    };
    const plan = f.provider.makePlan(f.state, f.bundle);
    expect(plan.parts.every((part) => part.kind === 'message')).toBe(true);
    expect(plan.parts[0].text).toContain('For attachments, open the saved session');
    expect(JSON.stringify(plan)).not.toContain('private.txt');
  });

  test('failed output and recovery progress disclose safe guidance rather than diagnostics', () => {
    const f = fixture();
    f.state.snapshot = { status: 'failed', text: 'sensitive raw exception', elapsedMs: 10 };
    expect(JSON.stringify(f.provider.makePlan(f.state, f.bundle))).not.toContain(
      'sensitive raw exception',
    );
    f.state.snapshot = {
      status: 'requires_action',
      recovery: 'execution_state_unavailable',
      text: '',
      elapsedMs: 10,
      pendingAction: { kind: 'oauth', actionId: 'private', expiresAt: Date.now() + 60_000 },
    };
    expect(discordProgressText(f.state)).toContain('Status unavailable');
    expect(discordProgressText(f.state)).toContain('some actions may already have run');
    expect(discordProgressText(f.state)).toContain('Ask an administrator if it stays unavailable.');
    expect(discordProgressText(f.state)).not.toContain('private review');
  });

  test('removes Stop while cancellation is pending and gives an actionable private-review path', async () => {
    const f = fixture();
    f.state.cancellationRequested = true;
    f.state.progress = {
      revision: 1,
      rendererVersion: 'discord-progress-v1',
      text: 'Cancellation requested.',
      outcome: 'inflight',
      attempts: 1,
    };
    await f.provider.writeProgress(f.state, f.bundle, f.controller.signal);
    expect(f.writes[0].body.components).toEqual([]);
    f.state.cancellationRequested = false;
    f.state.snapshot = {
      status: 'requires_action',
      text: '',
      elapsedMs: 10,
      pendingAction: { kind: 'tool_approval', actionId: 'private', expiresAt: Date.now() + 60000 },
    };
    expect(discordProgressText(f.state)).toBe('Waiting for your review.');
    await f.provider.writeProgress(f.state, f.bundle, f.controller.signal);
    expect(f.writes.at(-1)?.body.components?.[0].components).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Review request' })]),
    );
  });

  test('progress address validation prevents edits or deletes in another channel', async () => {
    const f = fixture();
    f.state.progress = {
      revision: 1,
      rendererVersion: 'discord-progress-v1',
      text: 'Working...',
      outcome: 'inflight',
      attempts: 1,
      externalMessageKey: '999:1001',
    };
    await expect(f.provider.writeProgress(f.state, f.bundle, f.controller.signal)).rejects.toThrow(
      'Invalid Discord durable address',
    );
    await expect(f.provider.deleteProgress(f.state, f.bundle, f.controller.signal)).rejects.toThrow(
      'Invalid Discord durable address',
    );
    expect(f.transport).not.toHaveBeenCalled();
  });

  test('renderer identity and operation nonce remain tied to the immutable plan', () => {
    const f = fixture();
    const plan = renderDiscordPlan({ runId: f.state.runId, text: '@everyone <@123>' }, 1);
    expect(plan.rendererVersion).toBe(discordRendererVersion);
    expect(plan.parts[0].text).toBe('@\u200beveryone <@\u200b123>');
    expect(f.provider.classifyError(new DiscordWriteError('permanent'))).toEqual({
      outcome: 'permanent',
      retryAfterMs: 0,
    });
  });

  test('renders two fixed feedback controls on only the first completed answer part', async () => {
    const f = fixture();
    f.state.feedbackEnabled = true;
    f.savedPlan('Answer '.repeat(800), summary('https://chat.company.com/trace/session'));
    expect(f.state.plan?.rendererVersion).toBe('discord-text-v2');
    expect(f.state.plan?.parts.filter((part) => part.presentation)).toHaveLength(1);
    expect(f.state.plan?.parts[0].presentation).toEqual({
      format: 'discord-feedback-v1',
      payload: '{"runId":"run-1"}',
    });
    await f.execute();
    expect(f.writes[0].body.components).toEqual([
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            label: 'Thumbs up',
            emoji: { name: '👍' },
            custom_id: 'lc1:u:run-1',
          },
          {
            type: 2,
            style: 2,
            label: 'Thumbs down',
            emoji: { name: '👎' },
            custom_id: 'lc1:d:run-1',
          },
        ],
      },
    ]);
    expect(f.writes.slice(1).every((write) => write.body.components === undefined)).toBe(true);
    expect(f.writes.at(-1)?.body.content).toContain('View session');
    expect(f.state.state).toBe('delivered');
  });

  test.each(['failed', 'cancelled'] as const)(
    'never adds feedback controls to %s output',
    async (status) => {
      const f = fixture();
      f.state.feedbackEnabled = true;
      f.state.state = 'delivering';
      f.state.snapshot = { status, text: 'private diagnostic', elapsedMs: 1 };
      f.state.plan = f.provider.makePlan(f.state, f.bundle);
      f.state.receipts = f.state.plan.parts.map((part) => ({
        operationId: part.operationId,
        outcome: 'planned',
        attempts: 0,
      }));
      await f.execute();
      expect(f.state.plan.parts.every((part) => part.presentation === undefined)).toBe(true);
      expect(f.writes.every((write) => write.body.components === undefined)).toBe(true);
    },
  );

  test('keeps feedback controls on a shortened first part without consuming text budget', async () => {
    const f = fixture();
    f.state.feedbackEnabled = true;
    f.bundle.delivery.maxDeliveryParts = 1;
    f.savedPlan('😀'.repeat(2500));
    await f.execute();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].body.content?.length).toBeLessThanOrEqual(2000);
    expect(f.writes[0].body.content).toContain('Reply shortened');
    expect(f.writes[0].body.components?.[0].components).toHaveLength(2);
  });

  test('strips controls after fresh policy revocation without changing or losing the frozen answer', async () => {
    const f = fixture();
    f.state.feedbackEnabled = true;
    f.savedPlan();
    const plan = structuredClone(f.state.plan);
    f.hooks.begin = () => {
      f.state.feedbackEnabled = false;
    };
    await f.execute();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].body).toMatchObject({ content: 'Saved final answer' });
    expect(f.writes[0].body.components).toBeUndefined();
    expect(f.state.plan).toEqual(plan);
    expect(f.state.state).toBe('delivered');
  });

  test('a plan created ineligible never gains controls on a later eligible retry', async () => {
    const f = fixture();
    f.state.feedbackEnabled = false;
    f.savedPlan();
    const plan = structuredClone(f.state.plan);
    f.hooks.begin = () => {
      f.state.feedbackEnabled = true;
    };
    await f.execute();
    expect(f.writes[0].body.components).toBeUndefined();
    expect(f.state.plan).toEqual(plan);
  });

  test('recovers saved feedback presentation without regeneration or replaying a confirmed answer', async () => {
    const f = fixture();
    f.state.feedbackEnabled = true;
    f.savedPlan();
    const plan = structuredClone(f.state.plan);
    f.hooks.commit = () => json({ error: 'unavailable' }, 503);
    await expect(f.execute()).rejects.toThrow('HTTP 503');
    f.hooks.commit = undefined;
    await f.restartExecute();
    expect(f.transport).toHaveBeenCalledTimes(5);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].body.components?.[0].components).toHaveLength(2);
    expect(f.state.plan).toEqual(plan);
    expect(f.calls.filter((call) => call.path.endsWith('/plan'))).toHaveLength(0);
  });

  test('reads an old v1 saved answer unchanged and never retrofits controls', async () => {
    const f = fixture();
    f.savedPlan();
    f.state.feedbackEnabled = true;
    f.state.plan!.rendererVersion = discordLegacyRendererVersion;
    f.state.plan!.revision = discordPlanRevision(f.state.plan!);
    const plan = structuredClone(f.state.plan);
    await f.execute();
    expect(f.writes[0].body.components).toBeUndefined();
    expect(f.state.plan).toEqual(plan);
    expect(f.provider.supportsRenderer(discordLegacyRendererVersion)).toBe(true);
  });

  test('v1 still rejects every persisted presentation before beginning delivery', async () => {
    const f = fixture();
    f.state.feedbackEnabled = true;
    f.savedPlan();
    f.state.plan!.rendererVersion = discordLegacyRendererVersion;
    await expect(f.execute()).rejects.toThrow('Unsupported Discord delivery part');
    expect(f.calls.some((call) => call.path.endsWith('/delivery/begin'))).toBe(false);
    expect(f.transport).not.toHaveBeenCalled();
  });

  test.each([
    'foreign_run',
    'wrong_format',
    'malformed_json',
    'extra_field',
    'noncanonical',
    'oversized',
    'wrapper_extra',
    'duplicate_key',
    'optional',
    'trace',
    'later_part',
  ])('rejects persisted feedback presentation variant %s before any write', async (variant) => {
    const f = fixture();
    f.state.feedbackEnabled = true;
    f.savedPlan('Answer '.repeat(400), summary('https://chat.company.com/trace/session'));
    const part = f.state.plan!.parts[0];
    if (variant === 'foreign_run') part.presentation = discordFeedbackPresentation('foreign-run');
    if (variant === 'wrong_format') part.presentation!.format = 'untrusted';
    if (variant === 'malformed_json') part.presentation!.payload = '{';
    if (variant === 'extra_field') part.presentation!.payload = '{"runId":"run-1","components":[]}';
    if (variant === 'noncanonical') part.presentation!.payload = '{ "runId": "run-1" }';
    if (variant === 'oversized') part.presentation!.payload = 'x'.repeat(129);
    if (variant === 'wrapper_extra') Object.assign(part.presentation!, { components: [] });
    if (variant === 'duplicate_key')
      part.presentation!.payload = '{"runId":"run-1","runId":"run-1"}';
    if (variant === 'optional') part.required = false;
    if (variant === 'trace') {
      part.required = false;
      part.traceUrl = 'https://chat.company.com/trace/session';
    }
    if (variant === 'later_part') {
      f.state.plan!.parts[1].presentation = part.presentation;
      part.presentation = undefined;
    }
    await expect(f.execute()).rejects.toThrow();
    expect(f.calls.some((call) => call.path.endsWith('/delivery/begin'))).toBe(false);
    expect(f.transport).not.toHaveBeenCalled();
  });

  test('rejects a changed immutable source returned after delivery/begin before provider effects', async () => {
    const f = fixture();
    f.state.feedbackEnabled = true;
    f.savedPlan();
    f.hooks.begin = () => {
      f.state.plan!.parts[0].presentation = discordFeedbackPresentation('foreign-run');
    };
    await expect(f.execute()).rejects.toThrow('Delivery not confirmed');
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.state.receipts[0].outcome).toBe('unknown');
  });
});

describe('Discord session link with a shortened answer', () => {
  const link = 'https://chat.company.com/trace/session';
  const linkText = `[View session](<${link}>)`;
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  /** Needs more than `budget` parts, so the answer has to be shortened. */
  const overflow = (budget: number) => 'Answer '.repeat(Math.ceil((budget * 2000) / 7) + 100);
  function planned(budget: number, text: string, session?: ChannelRunSummary, feedback = false) {
    const f = fixture();
    f.bundle.delivery.maxDeliveryParts = budget;
    if (feedback) f.state.feedbackEnabled = true;
    f.savedPlan(text, session);
    return f;
  }

  test.each([2, 3, 10, 100])(
    'reserves the last part of a %i part budget for the link when the answer is shortened',
    (budget) => {
      const f = planned(budget, overflow(budget), summary(link));
      const parts = f.state.plan!.parts;
      const answer = parts.slice(0, -1);
      expect(parts).toHaveLength(budget);
      expect(answer.map((part) => part.operationId)).toEqual(
        answer.map((_, index) => `run-1:discord:${index}`),
      );
      expect(answer.every((part) => part.required && part.traceUrl === undefined)).toBe(true);
      expect(answer.slice(0, -1).some((part) => part.text.includes('Reply shortened'))).toBe(false);
      expect(answer.at(-1)?.text).toContain('Reply shortened');
      expect(answer.at(-1)?.text).toMatch(/saved execution\.$/);
      expect(parts.at(-1)).toEqual({
        operationId: 'run-1:trace:0',
        kind: 'message',
        required: false,
        text: linkText,
        traceUrl: link,
      });
      expect(parts.every((part) => part.text.length <= 2000)).toBe(true);
      expect(f.state.plan!.revision).toBe(discordPlanRevision(f.state.plan!));
      expect(f.state.plan!.rendererVersion).toBe(discordRendererVersion);
    },
  );

  test('delivers the shortened answer and then the link as its own optional operation', async () => {
    const f = planned(3, overflow(3), summary(link));
    const plan = structuredClone(f.state.plan);
    await f.execute();
    expect(f.writes.every((write) => write.body.components === undefined)).toBe(true);
    expect(f.writes).toHaveLength(3);
    expect(f.writes.map((write) => write.body.content)).toEqual(
      plan!.parts.map((part) => part.text),
    );
    expect(f.writes.at(-1)?.body.nonce).toBe(discordNonce('run-1:trace:0'));
    expect(f.state.receipts.map((receipt) => receipt.outcome)).toEqual([
      'confirmed',
      'confirmed',
      'confirmed',
    ]);
    expect(f.state.plan).toEqual(plan);
    expect(f.state.state).toBe('delivered');
  });

  test.each([
    ['too long for a button', `https://chat.company.com/${'a'.repeat(600)}`],
    ['not canonical', 'https://CHAT.company.com/trace/session'],
  ])('still sends a %s link as the trace operation when a part is spare', async (_name, url) => {
    const f = planned(3, overflow(3), summary(url));
    expect(f.state.plan!.rendererVersion).toBe(discordRendererVersion);
    expect(f.state.plan!.parts.at(-1)).toMatchObject({ required: false, traceUrl: url });
    await f.execute();
    expect(f.writes.at(-1)?.body.content).toBe(`[View session](<${url}>)`);
    expect(f.writes.every((write) => write.body.components === undefined)).toBe(true);
  });

  test('adds no link to a complete answer that already uses the whole one part budget', async () => {
    const f = planned(1, 'Answer', summary(link));
    expect(f.state.plan!.parts.map((part) => part.text)).toEqual(['Answer']);
    expect(f.state.plan!.rendererVersion).toBe(discordRendererVersion);
    await f.execute();
    expect(f.writes.map((write) => write.body.components)).toEqual([undefined]);
  });

  describe('one part budget', () => {
    const button = { type: 2, style: 5, label: 'View session', url: link };
    const thumbs = [
      {
        type: 2,
        style: 2,
        label: 'Thumbs up',
        emoji: { name: '👍' },
        custom_id: 'lc1:u:run-1',
      },
      {
        type: 2,
        style: 2,
        label: 'Thumbs down',
        emoji: { name: '👎' },
        custom_id: 'lc1:d:run-1',
      },
    ];
    const authorize = (f: ReturnType<typeof fixture>, session: ChannelRunSummary | undefined) => {
      f.hooks.begin = () => {
        f.state.snapshot!.summary = session;
      };
    };

    test('stamps the plan without persisting the URL or changing the single part', () => {
      const f = planned(1, overflow(1), summary(link), true);
      const plain = planned(1, overflow(1), undefined, true);
      const parts = f.state.plan!.parts;
      expect(parts).toHaveLength(1);
      expect(f.state.plan!.rendererVersion).toBe(discordSessionRendererVersion);
      expect(plain.state.plan!.rendererVersion).toBe(discordRendererVersion);
      expect(parts).toEqual(plain.state.plan!.parts);
      expect(parts[0]).toMatchObject({
        operationId: 'run-1:discord:0',
        required: true,
        presentation: discordFeedbackPresentation('run-1'),
      });
      expect(parts[0].text.length).toBeLessThanOrEqual(2000);
      expect(parts[0].text).toContain('Reply shortened');
      expect(JSON.stringify(f.state.plan)).not.toContain('chat.company.com');
      expect(f.state.plan!.revision).toBe(discordPlanRevision(f.state.plan!));
      expect(f.state.plan!.revision).not.toBe(plain.state.plan!.revision);
      expect(planned(1, overflow(1), summary(link), true).state.plan).toEqual(f.state.plan);
    });

    test('delivers the link as a button after the feedback controls', async () => {
      const f = planned(1, overflow(1), summary(link), true);
      const plan = structuredClone(f.state.plan);
      await f.execute();
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0].body.content).toBe(plan!.parts[0].text);
      expect(f.writes[0].body.components).toEqual([{ type: 1, components: [...thumbs, button] }]);
      expect(f.state.plan).toEqual(plan);
      expect(f.state.receipts.map((receipt) => receipt.outcome)).toEqual(['confirmed']);
      expect(f.state.state).toBe('delivered');
    });

    test('makes the button the only control when feedback is off', async () => {
      const f = planned(1, overflow(1), summary(link));
      await f.execute();
      expect(f.writes[0].body.components).toEqual([{ type: 1, components: [button] }]);
    });

    test('keeps only the link when feedback is revoked before the part begins', async () => {
      const f = planned(1, overflow(1), summary(link), true);
      f.hooks.begin = () => {
        f.state.feedbackEnabled = false;
      };
      await f.execute();
      expect(f.writes[0].body.components).toEqual([{ type: 1, components: [button] }]);
    });

    test('reads the URL from the view delivery/begin returned, not from plan time', async () => {
      const f = planned(1, overflow(1), summary(link));
      const rotated = 'https://chat.company.com/trace/rotated';
      authorize(f, summary(rotated));
      await f.execute();
      expect(f.writes[0].body.components).toEqual([
        { type: 1, components: [{ ...button, url: rotated }] },
      ]);
    });

    test.each([true, false])(
      'still delivers the answer without a button when the link is revoked (feedback %s)',
      async (feedback) => {
        const f = planned(1, overflow(1), summary(link), feedback);
        authorize(f, { ...summary(link), session: undefined });
        await f.execute();
        expect(f.writes).toHaveLength(1);
        expect(f.writes[0].body.components).toEqual(
          feedback ? [{ type: 1, components: thumbs }] : undefined,
        );
        expect(f.state.state).toBe('delivered');
      },
    );

    test.each<[string, ChannelRunSummary]>([
      ['unsafe scheme', summary('http://chat.company.com/trace/session')],
      ['private address', summary('https://127.0.0.1/trace/session')],
      ['query token', summary(`${link}?token=secret`)],
      ['too long for a button', summary(`https://chat.company.com/${'a'.repeat(500)}`)],
      ['uppercase host', summary('https://CHAT.company.com/trace/session')],
      ['non ASCII path', summary('https://chat.company.com/trace/é')],
      [
        'stale sequence',
        { ...summary(link), throughSequence: 2, expectedRuns: 2, observedRuns: 2, priorRuns: 1 },
      ],
      ['inconsistent run count', { ...summary(link), observedRuns: 2 }],
    ])('omits the button when the delivery view has a %s link', async (_name, session) => {
      const f = planned(1, overflow(1), summary(link));
      authorize(f, session);
      await f.execute();
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0].body.components).toBeUndefined();
      expect(f.state.state).toBe('delivered');
    });

    test.each<[string, ChannelRunSummary | undefined]>([
      ['unsafe scheme', summary('http://chat.company.com/trace/session')],
      ['private address', summary('https://127.0.0.1/trace/session')],
      ['query token', summary(`${link}?token=secret`)],
      ['embedded credential', summary('https://user:secret@chat.company.com/trace/session')],
      ['markup breaking', summary('https://chat.company.com/trace/<session>')],
      ['too long for a button', summary(`https://chat.company.com/${'a'.repeat(500)}`)],
      ['uppercase host', summary('https://CHAT.company.com/trace/session')],
      ['non ASCII path', summary('https://chat.company.com/trace/é')],
      ['oversized', summary(`https://chat.company.com/${'a'.repeat(1990)}`)],
      [
        'stale sequence',
        { ...summary(link), throughSequence: 2, expectedRuns: 2, observedRuns: 2, priorRuns: 1 },
      ],
      ['inconsistent run count', { ...summary(link), observedRuns: 2 }],
      ['missing session', { ...summary(link), session: undefined }],
      ['missing summary', undefined],
    ])('stamps nothing for a %s link and never gains a button later', async (_name, session) => {
      const f = planned(1, overflow(1), session, true);
      const plain = planned(1, overflow(1), undefined, true);
      expect(f.state.plan).toEqual(plain.state.plan);
      expect(f.state.plan!.rendererVersion).toBe(discordRendererVersion);
      authorize(f, summary(link));
      await f.execute();
      expect(f.writes[0].body.components).toEqual([{ type: 1, components: thumbs }]);
    });

    test.each([discordLegacyRendererVersion, discordRendererVersion])(
      'never retrofits a button onto a saved %s plan',
      async (version) => {
        const f = planned(1, overflow(1));
        f.state.plan!.rendererVersion = version;
        f.state.plan!.revision = discordPlanRevision(f.state.plan!);
        const plan = structuredClone(f.state.plan);
        authorize(f, summary(link));
        await f.execute();
        expect(f.writes[0].body.components).toBeUndefined();
        expect(f.state.plan).toEqual(plan);
      },
    );

    test('offers the button on the last required answer part only', async () => {
      const f = planned(3, 'x'.repeat(3000));
      f.state.plan!.rendererVersion = discordSessionRendererVersion;
      f.state.plan!.revision = discordPlanRevision(f.state.plan!);
      authorize(f, summary(link));
      await f.execute();
      expect(f.writes.map((write) => write.body.components)).toEqual([
        undefined,
        [{ type: 1, components: [button] }],
      ]);
    });

    test('keeps the fenced Unicode text and suppresses mentions exactly as without a link', async () => {
      const mentions = '@everyone @here <@123> <@!123> <@&123> <#123> ';
      const text = '```typescript\n' + `${mentions}${'😀'.repeat(400)}\n`.repeat(6) + '```';
      const f = planned(1, text, summary(link));
      const [part] = f.state.plan!.parts;
      expect(f.state.plan!.rendererVersion).toBe(discordSessionRendererVersion);
      expect(part).toEqual(planned(1, text).state.plan!.parts[0]);
      expect(part.text.length).toBeLessThanOrEqual(2000);
      expect(part.text.startsWith('```typescript\n')).toBe(true);
      expect(part.text).toContain('\n```\n\nReply shortened');
      expect(part.text).not.toMatch(loneSurrogate);
      expect(part.text).not.toMatch(/@(everyone|here)|<(@[!&]?|#)\d/);
      expect(sanitizeDiscordMentions(part.text)).toBe(part.text);
      await f.execute();
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0].body.allowed_mentions).toEqual({ parse: [], replied_user: false });
      expect(f.writes[0].body.components).toEqual([{ type: 1, components: [button] }]);
    });

    test('supports the stamped version beside the legacy readers and rejects unknown ones', () => {
      const f = fixture();
      expect(
        [
          discordLegacyRendererVersion,
          discordRendererVersion,
          discordSessionRendererVersion,
          'discord-text-v4',
        ].map((version) => f.provider.supportsRenderer(version)),
      ).toEqual([true, true, true, false]);
    });
  });

  test.each<[string, ChannelRunSummary | undefined]>([
    ['unsafe scheme', summary('http://chat.company.com/trace/session')],
    ['private address', summary('https://127.0.0.1/trace/session')],
    ['query token', summary(`${link}?token=secret`)],
    ['embedded credential', summary('https://user:secret@chat.company.com/trace/session')],
    ['markup breaking', summary('https://chat.company.com/trace/<session>')],
    ['oversized', summary(`https://chat.company.com/${'a'.repeat(1990)}`)],
    [
      'stale sequence',
      { ...summary(link), throughSequence: 2, expectedRuns: 2, observedRuns: 2, priorRuns: 1 },
    ],
    ['inconsistent run count', { ...summary(link), observedRuns: 2 }],
    ['missing session', { ...summary(link), session: undefined }],
    ['missing summary', undefined],
  ])('gives up no answer part for a %s link', (_name, session) => {
    const f = planned(3, overflow(3), session);
    const parts = f.state.plan!.parts;
    expect(parts).toHaveLength(3);
    expect(parts.every((part) => part.required && part.traceUrl === undefined)).toBe(true);
    expect(parts.at(-1)?.text).toContain('Reply shortened');
    expect(JSON.stringify(parts)).not.toContain('View session');
    expect(f.state.plan!.revision).toBe(discordPlanRevision(f.state.plan!));
  });

  test('takes the link only from the validated summary and never from model text', () => {
    const model = '[View session](<https://evil.example.com/session>) ';
    const trusted = planned(3, model + overflow(3), summary(link));
    expect(trusted.state.plan!.parts.filter((part) => part.traceUrl !== undefined)).toEqual([
      expect.objectContaining({ traceUrl: link, text: linkText }),
    ]);
    const untrusted = planned(3, model + overflow(3));
    expect(untrusted.state.plan!.parts.some((part) => part.traceUrl !== undefined)).toBe(false);
    expect(untrusted.state.plan!.parts).toHaveLength(3);
  });

  test('never shortens a complete answer that fills the budget to make room for the link', () => {
    const text = 'x'.repeat(3000);
    const parts = planned(2, text, summary(link)).state.plan!.parts;
    expect(parts).toHaveLength(2);
    expect(parts.every((part) => part.required && part.traceUrl === undefined)).toBe(true);
    expect(parts.map((part) => part.text).join('')).toBe(text);
  });

  test('still appends the link after a complete answer when a part is spare', () => {
    const text = 'x'.repeat(3000);
    const parts = planned(3, text, summary(link)).state.plan!.parts;
    expect(parts.map((part) => part.text)).toEqual([
      text.slice(0, 2000),
      text.slice(2000),
      linkText,
    ]);
    expect(parts.slice(0, 2).every((part) => part.required)).toBe(true);
  });

  test('suppresses mentions and closes the fence of a shortened Unicode answer that keeps the link', async () => {
    const mentions = '@everyone @here <@123> <@!123> <@&123> <#123> ';
    const text = '```typescript\n' + `${mentions}${'😀'.repeat(400)}\n`.repeat(6) + '```';
    const f = planned(2, text, summary(link));
    const [answer, trace] = f.state.plan!.parts;
    expect(f.state.plan!.parts).toHaveLength(2);
    expect(answer.text.length).toBeLessThanOrEqual(2000);
    expect(answer.text.startsWith('```typescript\n')).toBe(true);
    expect(answer.text).toContain('\n```\n\nReply shortened');
    expect(answer.text).not.toMatch(loneSurrogate);
    expect(answer.text).not.toMatch(/@(everyone|here)|<(@[!&]?|#)\d/);
    expect(sanitizeDiscordMentions(answer.text)).toBe(answer.text);
    expect(trace).toMatchObject({ required: false, text: linkText, traceUrl: link });
    await f.execute();
    expect(f.writes).toHaveLength(2);
    expect(
      f.writes.every(
        (write) =>
          sanitizeDiscordMentions(write.body.content!) === write.body.content &&
          write.body.allowed_mentions?.parse.length === 0 &&
          write.body.allowed_mentions.replied_user === false,
      ),
    ).toBe(true);
  });

  test('derives one revision per input and a different one when the link changes', () => {
    const first = planned(3, overflow(3), summary(link)).state.plan!;
    expect(planned(3, overflow(3), summary(link)).state.plan).toEqual(first);
    expect(first.revision).toBe(discordPlanRevision(first));
    const other = planned(3, overflow(3), summary('https://chat.company.com/trace/other'));
    expect(other.state.plan!.revision).not.toBe(first.revision);
    expect(planned(3, overflow(3)).state.plan!.revision).not.toBe(first.revision);
  });

  test('keeps the feedback controls on the first required answer part and off the link', async () => {
    const f = planned(3, overflow(3), summary(link), true);
    const plan = structuredClone(f.state.plan);
    expect(
      f.state.plan!.parts.map((part) => [
        part.operationId,
        part.required,
        part.presentation !== undefined,
      ]),
    ).toEqual([
      ['run-1:discord:0', true, true],
      ['run-1:discord:1', true, false],
      ['run-1:trace:0', false, false],
    ]);
    await f.execute();
    expect(f.writes).toHaveLength(3);
    expect(f.writes[0].body.components?.[0].components).toHaveLength(2);
    expect(f.writes.slice(1).every((write) => write.body.components === undefined)).toBe(true);
    expect(f.state.plan).toEqual(plan);
    expect(f.state.state).toBe('delivered');
  });

  test('still delivers the shortened answer when the link is revoked before its operation begins', async () => {
    const f = planned(3, overflow(3), summary(link));
    f.hooks.begin = () => {};
    await f.execute();
    expect(f.writes).toHaveLength(2);
    expect(f.writes.some((write) => write.body.content?.includes('View session'))).toBe(false);
    expect(f.state.state).toBe('delivered');
  });

  test('delivers a saved v1 plan that carries a shortened answer and a link unchanged', async () => {
    const f = planned(3, overflow(3), summary(link));
    f.state.plan!.rendererVersion = discordLegacyRendererVersion;
    f.state.plan!.revision = discordPlanRevision(f.state.plan!);
    const plan = structuredClone(f.state.plan);
    await f.execute();
    expect(f.writes.map((write) => write.body.content)).toEqual(
      plan!.parts.map((part) => part.text),
    );
    expect(f.state.plan).toEqual(plan);
    expect(f.state.state).toBe('delivered');
  });
});

describe('owned provider effect context', () => {
  it('uses the active application owner and current fresh actor proof before each durable begin', async () => {
    const f = fixture(true);
    f.savedPlan();
    await f.execute();
    const begun = f.calls.filter(
      (call) => call.path.endsWith('/delivery/begin') || call.path.endsWith('/progress/begin'),
    );
    expect(begun.length).toBeGreaterThan(0);
    for (const call of begun)
      expect(call.body.discordAuthority).toMatchObject({
        applicationRevision: 'app-revision',
        native: {
          kind: 'guild_text',
          owner: { applicationId: '123', ownerId: 'a'.repeat(32) },
          source: {
            applicationId: '123',
            guildId: '456',
            channelId: '111',
            authorId: '333',
            authorMember: true,
            authorPermissions: '1024',
          },
        },
      });
  });
  it('does not grant execution or begin output after an actor source read fails', async () => {
    const f = fixture(true);
    f.hooks.read = (path) =>
      path.includes('/members/333') ? json({ message: 'private-provider-error' }, 503) : undefined;
    await expect(f.execute()).rejects.toThrow('Discord operation was not confirmed');
    expect(
      f.calls.some(
        (call) =>
          call.path.endsWith('/response/prepare') ||
          call.path.endsWith('/delivery/begin') ||
          call.path.endsWith('/progress/begin'),
      ),
    ).toBe(false);
    expect(f.writes).toEqual([]);
  });
});

describe('native thread provider output', () => {
  it('sends only to the actual thread and forwards fresh thread proof before durable begins', async () => {
    const f = fixture(true, true);
    f.savedPlan();
    await f.execute();
    expect(f.writes.length).toBeGreaterThan(0);
    expect(f.writes.every((write) => write.path.includes('/channels/555/'))).toBe(true);
    const begin = f.calls.find((call) => call.path.endsWith('/delivery/begin'));
    expect(begin?.body.discordAuthority?.native).toMatchObject({
      kind: 'guild_thread',
      source: { threadChannelId: '555', parentChannelId: '111', authorId: '333' },
    });
  });
  it('rechecks the actual parent after a grant and refuses a moved thread before writing', async () => {
    const f = fixture(true, true);
    f.savedPlan();
    f.hooks.begin = () => {
      f.hooks.read = (path) =>
        path === '/api/v10/channels/555'
          ? json({
              id: '555',
              guild_id: '456',
              parent_id: '999',
              type: 11,
              thread_metadata: { archived: false, locked: false },
            })
          : undefined;
    };
    await expect(f.execute()).rejects.toThrow('Delivery not confirmed');
    expect(f.writes).toEqual([]);
  });
  it('does not accept a different mapping reference returned after delivery begin', async () => {
    const f = fixture(true, true);
    f.savedPlan();
    f.hooks.begin = () => {
      f.state.admission.discordDestination = {
        kind: 'guild_thread',
        parentChannelId: '111',
        mappingRevision: 'changed',
      };
    };
    await expect(f.execute()).rejects.toThrow('Run admission changed');
    expect(f.writes).toEqual([]);
  });
  it('keeps cosmetic progress deletion available after the actor loses access', async () => {
    const f = fixture(true, true);
    f.state.progress = {
      revision: 1,
      rendererVersion: 'discord-progress-v1',
      text: 'Working',
      outcome: 'confirmed',
      attempts: 1,
      externalMessageKey: '555:777',
    };
    f.hooks.read = () => json({ permissions: '0' });
    await f.provider.deleteProgress(f.state, f.bundle, f.controller.signal);
    expect(f.writes).toMatchObject([
      { method: 'DELETE', path: '/api/v10/channels/555/messages/777' },
    ]);
  });
});

it('projects a resumed bound response without requesting a fresh credential when external access is lost', async () => {
  const f = fixture(true, true);
  f.state.state = 'executing';
  f.hooks.read = () => json({ message: 'Access removed' }, 403);
  await expect(f.execute()).rejects.toThrow();
  expect(f.calls.some((call) => call.path.endsWith('/advance'))).toBe(true);
  expect(f.calls.some((call) => call.path.endsWith('/response/prepare'))).toBe(false);
  expect(f.calls.some((call) => call.path.endsWith('/delivery/begin'))).toBe(false);
  expect(f.state.snapshot?.status).toBe('completed');
  expect(f.writes).toEqual([]);
});

describe('native DM provider output', () => {
  it('sends only to the actual DM and proves current source-guild actor access before durable begins', async () => {
    const f = fixture(true, false, true);
    f.savedPlan();
    await f.execute();
    expect(f.writes.length).toBeGreaterThan(0);
    expect(f.writes.every((write) => write.path.includes('/channels/555/'))).toBe(true);
    const begin = f.calls.find((call) => call.path.endsWith('/delivery/begin'));
    expect(begin?.body.discordAuthority?.native).toMatchObject({
      kind: 'dm',
      source: { guildId: '456', channelId: '111', authorId: '333' },
    });
    expect(
      f.transport.mock.calls
        .filter(([, init]) => !init?.method || init.method === 'GET')
        .map(([input]) => new URL(String(input)).pathname),
    ).not.toContain('/api/v10/channels/555');
  });
  it('requires fresh real-parent proof before the first execution grant', async () => {
    const f = fixture(true, false, true);
    f.state.state = 'queued';
    await f.execute();
    expect(
      f.calls.find((call) => call.path.endsWith('/response/prepare'))?.body.discordAuthority
        ?.native,
    ).toMatchObject({ kind: 'dm', source: { guildId: '456', channelId: '111', authorId: '333' } });
  });
  it.each(['disabled', 'access'])(
    'projects a resumed DM response after %s loss without new credentials or output grants',
    async (changed) => {
      const f = fixture(true, false, true);
      if (changed === 'disabled') f.bundle.discord.dm.enabled = false;
      else f.hooks.read = () => json({ message: 'Access removed' }, 403);
      await expect(f.execute()).rejects.toThrow();
      expect(f.calls.some((call) => call.path.endsWith('/advance'))).toBe(true);
      expect(
        f.calls.some(
          (call) =>
            call.path.endsWith('/response/prepare') || call.path.endsWith('/delivery/begin'),
        ),
      ).toBe(false);
      expect(f.state.snapshot?.status).toBe('completed');
      expect(f.writes).toEqual([]);
    },
  );
  it('refuses source access lost after a grant before the actual DM write', async () => {
    const f = fixture(true, false, true);
    f.savedPlan();
    f.hooks.begin = () => {
      f.hooks.read = () => json({ message: 'Access removed' }, 403);
    };
    await expect(f.execute()).rejects.toThrow('Delivery not confirmed');
    expect(f.writes).toEqual([]);
    expect(f.state.receipts[0].outcome).toBe('permanent_failure');
  });
  it('refuses a different selection generation returned after delivery begins', async () => {
    const f = fixture(true, false, true);
    f.savedPlan();
    f.hooks.begin = () => {
      if (
        f.state.admission.actor.scope !== 'dm' ||
        f.state.admission.discordDestination?.kind !== 'dm'
      )
        throw new Error('Fixture DM scope missing');
      f.state.admission.actor.selectionRevision = 'other';
      f.state.admission.discordDestination.selectionRevision = 'other';
    };
    await expect(f.execute()).rejects.toThrow('Run admission changed');
    expect(f.writes).toEqual([]);
  });
  it('keeps exact cosmetic progress deletion available while DM is disabled or source access is lost', async () => {
    const f = fixture(true, false, true);
    f.bundle.discord.dm.enabled = false;
    f.state.progress = {
      revision: 1,
      rendererVersion: 'discord-progress-v1',
      text: 'Working',
      outcome: 'confirmed',
      attempts: 1,
      externalMessageKey: '555:777',
    };
    f.hooks.read = () => json({ message: 'Access removed' }, 403);
    await f.provider.deleteProgress(f.state, f.bundle, f.controller.signal);
    expect(f.writes).toMatchObject([
      { method: 'DELETE', path: '/api/v10/channels/555/messages/777' },
    ]);
  });
});

describe('Discord quiet drafts and complete documents', () => {
  test('previews only answer text when enabled and keeps status-only defaults', () => {
    const f = fixture();
    f.state.snapshot = {
      status: 'running',
      text: '',
      previewText: 'Hello @everyone 😀',
      elapsedMs: 1,
    };
    expect(f.provider.progressText(f.state, f.bundle)).toBe('Working...');
    f.bundle.discord.streaming.mode = 'partial';
    expect(f.provider.progressText(f.state, f.bundle)).toBe('_Draft_\n\nHello @\u200beveryone 😀');
    f.state.cancellationRequested = true;
    expect(f.provider.progressText(f.state, f.bundle)).not.toContain('Hello');
    f.state.cancellationRequested = false;
    f.state.snapshot.recovery = 'execution_state_unavailable';
    expect(f.provider.progressText(f.state, f.bundle)).not.toContain('Hello');
    delete f.state.snapshot.recovery;
    f.state.snapshot.status = 'requires_action';
    expect(f.provider.progressText(f.state, f.bundle)).not.toContain('Hello');
  });

  test('offers a native private review with Stop and never publishes the action ID', async () => {
    const f = fixture();
    f.state.snapshot = {
      status: 'requires_action',
      text: '',
      elapsedMs: 1,
      pendingAction: {
        kind: 'tool_approval',
        actionId: 'private-action',
        expiresAt: Date.now() + 60_000,
      },
    };
    f.state.progress = {
      revision: 1,
      rendererVersion: 'discord-progress-v1',
      text: discordProgressText(f.state),
      outcome: 'inflight',
      attempts: 1,
    };
    await f.provider.writeProgress(f.state, f.bundle, f.controller.signal);
    expect(f.writes[0].body.components?.[0].components).toEqual([
      expect.objectContaining({ label: 'Review request', custom_id: 'lc1:r:run-1' }),
      expect.objectContaining({ label: 'Stop' }),
    ]);
    expect(JSON.stringify(f.writes)).not.toContain('private-action');
  });

  test('delivers the entire Unicode answer as one immutable Markdown upload without inline duplication', async () => {
    const f = fixture();
    f.bundle.discord.longReply.inlineParts = 2;
    f.state.feedbackEnabled = true;
    const text = '```typescript\n' + '😀 <@123> @everyone\n'.repeat(1500) + '```';
    f.savedPlan(text, summary('https://chat.company.com/trace/session'));
    expect(f.state.plan?.rendererVersion).toBe('discord-document-v1');
    expect(JSON.stringify(f.state.plan)).not.toContain(text);
    await f.execute();
    expect(f.writes.filter((write) => write.body.document)).toHaveLength(1);
    expect(f.writes[0].body.document).toBe(text);
    expect(f.writes[0].body.content).toBe('The complete reply is attached as reply.md.');
    expect(f.writes).toHaveLength(1);
    expect(
      f.writes[0].body.components?.[0].components.map((button) =>
        'label' in button ? button.label : undefined,
      ),
    ).toEqual(['Thumbs up', 'Thumbs down', 'View session']);
    expect(f.writes[0].body.nonce).toBe(discordNonce('run-1:discord:0'));
    expect(f.writes[0].headers.get('Content-Type')).toBeNull();
    expect(f.writes[0].body.allowed_mentions).toEqual({ parse: [], replied_user: false });
    expect(f.state.state).toBe('delivered');
  });

  test('refuses changed document bytes before writing after a restart', async () => {
    const f = fixture();
    f.bundle.discord.longReply.inlineParts = 1;
    f.savedPlan('x'.repeat(5000));
    f.state.snapshot!.text = 'y'.repeat(5000);
    await expect(f.restartExecute()).rejects.toThrow('Delivery not confirmed');
    expect(f.writes).toEqual([]);
  });

  test('does not send a second fallback after an ambiguous upload and preserves its source', async () => {
    const f = fixture();
    f.bundle.discord.longReply.inlineParts = 1;
    const text = 'x'.repeat(5000);
    f.savedPlan(text);
    f.hooks.write = () => {
      throw new Error('private transport problem');
    };
    await expect(f.execute()).rejects.toThrow('Delivery not confirmed');
    expect(f.writes).toHaveLength(1);
    expect(f.state.receipts[0].outcome).toBe('unknown');
    expect(f.state.snapshot!.text).toBe(text);
    await expect(f.restartExecute()).rejects.toThrow('Delivery deferred or awaits reconciliation');
    expect(f.writes).toHaveLength(1);
  });

  test('respects the document byte budget and keeps existing inline delivery when disabled', () => {
    const f = fixture();
    f.savedPlan('x'.repeat(5000));
    expect(f.state.plan?.rendererVersion).toBe(discordRendererVersion);
    f.bundle.discord.longReply.inlineParts = 1;
    f.bundle.discord.longReply.maxAttachmentBytes = 1024;
    f.savedPlan('😀'.repeat(1500));
    expect(f.state.plan?.rendererVersion).toBe(discordRendererVersion);
  });
});

it('coalesces saturated drafts into one edited message and removes it after the final answer', async () => {
  const f = fixture();
  f.bundle.discord.streaming.mode = 'partial';
  let revision = 0;
  f.hooks.advance = () => {
    revision++;
    f.state.state = revision < 3 ? 'executing' : 'delivering';
    f.state.snapshot = {
      responseId: 'resp_123',
      elapsedMs: revision,
      status: revision < 3 ? 'running' : 'completed',
      text: revision < 3 ? '' : 'Final answer',
      ...(revision < 3 ? { previewText: 'x'.repeat(2000 + revision) } : {}),
    };
  };
  await f.execute();
  expect(f.writes.filter((write) => write.method === 'POST')).toHaveLength(2);
  const drafts = f.writes.filter((write) => write.body.content?.startsWith('_Draft_'));
  expect(drafts).toHaveLength(1);
  expect(drafts[0].method).toBe('PATCH');
  expect(drafts[0].body.content!.length).toBeLessThanOrEqual(2000);
  expect(f.writes.filter((write) => write.body.content === 'Final answer')).toHaveLength(1);
  expect(f.writes.at(-1)?.method).toBe('DELETE');
});

it('keeps an honest progress message and full source when Discord rejects the document', async () => {
  const f = fixture();
  f.bundle.discord.longReply.inlineParts = 1;
  const text = 'Complete answer '.repeat(500);
  f.savedPlan(text);
  f.state.progress = {
    revision: 2,
    rendererVersion: 'discord-progress-v1',
    text: discordProgressText(f.state),
    externalMessageKey: '111:777',
    outcome: 'confirmed',
    attempts: 1,
  };
  f.hooks.write = () => json({ message: 'private provider error' }, 403);
  await expect(f.execute()).rejects.toThrow('Delivery not confirmed');
  expect(f.state.receipts[0].outcome).toBe('permanent_failure');
  expect(f.state.progress.text).toContain('delivery is not confirmed');
  expect(f.state.snapshot?.text).toBe(text);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].method).toBe('POST');
});
