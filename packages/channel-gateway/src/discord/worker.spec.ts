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
  DiscordChannelServiceBundle,
} from 'librechat-data-provider';
import type { APIActionRowComponent, APIButtonComponent } from 'discord-api-types/v10';
import type { Lease, Logger } from '../types';
import {
  renderDiscordPlan,
  discordRendererVersion,
  discordLegacyRendererVersion,
  discordPlanRevision,
  discordFeedbackPresentation,
} from './render';
import { createDiscordWorkerProvider, discordProgressText } from './worker';
import { DiscordClient, DiscordWriteError, discordNonce } from './client';
import { DiscordRateCoordinator } from './rates';
import { ChannelWorker } from '../worker';
import { ChannelClient } from '../client';
import { loadConfig } from '../config';

interface Mutation {
  revision?: number;
  rendererVersion?: string;
  text?: string;
  plan?: ChannelDeliveryPlan;
  operationId?: string;
  receipt?: ChannelDeliveryReceipt;
}
interface Write {
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

function fixture() {
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
  const lease: Lease = {
    run: state,
    fence: { runId: state.runId, owner: 'worker-1', epoch: 1 },
    leaseExpiresAt: Date.now() + 60_000,
  };
  const calls: { path: string; body: Mutation; headers: Headers }[] = [];
  const writes: { method: string; path: string; body: Write; headers: Headers }[] = [];
  const hooks: {
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
        state.state = 'delivering';
        state.snapshot = {
          status: 'completed',
          responseId: 'resp_123',
          text: 'Final answer',
          elapsedMs: 10,
        };
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
      const body: Write = init?.body ? JSON.parse(String(init.body)) : {};
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        const response = hooks.read?.(path);
        if (response) return response;
        if (path.includes('/permissions/member/'))
          return json({ permissions: path.endsWith('/333') ? '1024' : '68608' });
        return json({ id: '111', guild_id: '456', type: 0 });
      }
      writes.push({ path, body, method, headers: new Headers(init?.headers) });
      if (hooks.write) return hooks.write();
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (calls.at(-1)?.path.endsWith('/delivery/begin'))
        expect(state.receipts.some((item) => item.outcome === 'inflight')).toBe(true);
      return json({
        channel_id: path.split('/')[4],
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
  const provider = createDiscordWorkerProvider({ rates, createClient });
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
        f.hooks.read = (path) => (path.endsWith('/333') ? json({ permissions }) : undefined);
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
    f.hooks.read = (path) => (path.endsWith('/333') ? json({}, 503) : undefined);
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
      f.hooks.read = (path) => (path.endsWith('/333') ? json({ permissions }) : undefined);
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
      f.hooks.read = (path) => (path.endsWith('/333') ? json({ permissions: '0' }) : undefined);
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
      'Completed.',
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
    expect(f.transport).toHaveBeenCalledTimes(4);
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
    expect(f.transport).toHaveBeenCalledTimes(4);
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
    expect(f.transport).toHaveBeenCalledTimes(4);
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
    await expect(f.execute()).rejects.toThrow('Delivery not confirmed');
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.state.receipts[0].outcome).toBe('unknown');
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
    expect(plan.parts[0].text).toContain('Attachments are unavailable');
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
    expect(discordProgressText(f.state)).toContain('Completion is not confirmed');
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
    expect(discordProgressText(f.state)).toContain('/librechat status');
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
    expect(f.transport).toHaveBeenCalledTimes(4);
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
