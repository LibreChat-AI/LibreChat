import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import {
  channelConfigSchema,
  channelGatewayWirePolicySchema,
  sharedSlackGatewayPolicySchema,
} from 'librechat-data-provider';
import type { SharedSlackGatewayBootstrap, ChannelServiceBundle } from 'librechat-data-provider';
import type { AddressInfo } from 'node:net';
import { SlackClient, SlackWriteError } from '../slack';
import { WorkspaceClient } from './client';
import { slackRouteLookup } from './route';
import { loadBootstrap } from '../config';
import { SharedGatewayApp } from './app';

const settings: SharedSlackGatewayBootstrap = {
  gateway: channelGatewayWirePolicySchema.parse({
    ...channelConfigSchema.parse({ transport: 'webhook' }),
    version: 1,
  }),
  workers: sharedSlackGatewayPolicySchema.parse({ ingressConcurrency: 1 }),
};
const envelope = (team = 'T1') => ({
  type: 'event_callback',
  event_id: `event-${team}`,
  team_id: team,
  api_app_id: 'A1',
  event: {
    type: 'app_mention',
    user: 'UACTOR',
    channel: 'C1',
    ts: '1.000001',
    text: '<@UBOT> hello',
  },
});
const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fixture() {
  const bootstrap = loadBootstrap({
    CHANNEL_SERVICE_TOKEN: 'test-service-token-32-characters-minimum',
  });
  if (bootstrap.mode !== 'shared') throw new Error('Expected shared config');
  const calls: Array<{ path: string; tenant: string | null; body: Record<string, unknown> }> = [];
  let unmapped: 'unmapped' | 'retired_thread' | undefined;
  let routingGate: Promise<void> | undefined;
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? '{}'));
      const tenant = new Headers(init?.headers).get('X-Tenant-Id');
      calls.push({ path, tenant, body });
      if (path.endsWith('/service/workspaces')) return json(settings);
      if (path.endsWith('/app'))
        return json({
          tenantId: body.tenantId,
          appId: body.appId,
          signingSecret: body.appId === 'A1' ? 'test-signature' : 'second-signature',
        });
      if (path.endsWith('/resolve')) {
        await routingGate;
        const suffix = body.teamId === 'T1' ? 'a' : 'b';
        if (unmapped)
          return json({
            kind: unmapped,
            workspace: {
              tenantId: 'org.a',
              workspaceId: 'workspace-a',
              appId: 'A1',
              teamId: 'T1',
              teamName: 'Sandbox',
              botUserId: 'UBOT',
              status: 'active',
              revision: 'r1',
              scopes: [],
            },
            botToken: 'xoxb-test-token',
          });
        return json({
          kind: 'bound',
          tenantId: `org.${suffix}`,
          workspaceId: `workspace-${suffix}`,
          channelId: `binding-${suffix}`,
        });
      }
      if (path.endsWith('/lifecycle')) return new Response(null, { status: 204 });
      if (path.includes('/service/slack/')) {
        const suffix = path.endsWith('binding-a') ? 'a' : 'b';
        return json({
          channel: {
            channelId: `binding-${suffix}`,
            tenantId: `org.${suffix}`,
            workspaceId: `workspace-${suffix}`,
            agentId: 'agent',
            createdBy: 'owner',
            type: 'slack',
            status: 'active',
            credentialMode: 'per_user',
            revision: 'r1',
            slack: { teamId: suffix === 'a' ? 'T1' : 'T2', appId: 'A1', botUserId: 'UBOT' },
          },
          credentials: { botToken: 'xoxb-test-token', signingSecret: 'test-signature' },
          agent: { id: 'agent' },
          delivery: { maxDeliveryParts: 100 },
          gateway: settings.gateway,
        } satisfies ChannelServiceBundle);
      }
      if (path.endsWith('/runs')) return json({ runId: 'durable-run' });
      throw new Error(`Unexpected fixture path ${path}`);
    },
  );
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const client = new WorkspaceClient(bootstrap.config, transport);
  const app = new SharedGatewayApp(bootstrap.config, client, settings, log, transport);
  app.ready = true;
  return {
    app,
    calls,
    transport,
    log,
    setUnmapped: (kind: 'unmapped' | 'retired_thread' = 'unmapped') => {
      unmapped = kind;
    },
    setGate: (gate: Promise<void>) => {
      routingGate = gate;
    },
  };
}

describe('shared signed Slack HTTP ingress', () => {
  let current: ReturnType<typeof fixture>;
  let server: ReturnType<typeof createServer>;
  let base: string;
  beforeEach(async () => {
    current = fixture();
    server = createServer((req, res) => void current.app.http(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    jest.restoreAllMocks();
  });
  function send(body: object, valid = true, tenantId = 'org.a', appId = 'A1') {
    const bytes = JSON.stringify(body),
      timestamp = String(Math.floor(Date.now() / 1000));
    const secret = appId === 'A1' ? 'test-signature' : 'second-signature';
    const signature =
      'v0=' +
      createHmac('sha256', valid ? secret : 'wrong')
        .update(`v0:${timestamp}:${bytes}`)
        .digest('hex');
    return fetch(base + `/slack/events/${tenantId}/${appId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Signature': signature,
        'X-Slack-Request-Timestamp': timestamp,
      },
      body: bytes,
    });
  }
  it('verifies original bytes before workspace routing or URL verification', async () => {
    expect((await send(envelope(), false)).status).toBe(401);
    expect(current.calls.some(({ path }) => path.endsWith('/resolve'))).toBe(false);
    const challenge = await send({ type: 'url_verification', challenge: 'test-challenge' });
    expect(await challenge.json()).toEqual({ challenge: 'test-challenge' });
    expect(current.calls.filter(({ path }) => path.endsWith('/resolve'))).toHaveLength(0);
  });
  it('uses each resolved tenant/binding for durable admission without forwarding a caller tenant', async () => {
    expect((await send(envelope())).status).toBe(200);
    expect((await send(envelope('T2'), true, 'org.b')).status).toBe(200);
    const admissions = current.calls.filter(({ path }) => path.endsWith('/runs'));
    expect(admissions.map(({ path, tenant }) => ({ path, tenant }))).toEqual([
      { path: '/api/channels/service/binding-a/runs', tenant: 'org.a' },
      { path: '/api/channels/service/binding-b/runs', tenant: 'org.b' },
    ]);
    expect(
      current.calls
        .filter(({ path }) => path.includes('/service/workspaces'))
        .every(({ tenant }) => tenant === null),
    ).toBe(true);
  });
  it('isolates callback tenants and validates each app with its own secret', async () => {
    const wrongTenant = await send(envelope(), true, 'org.b');
    expect(wrongTenant.status).toBe(503);
    expect(current.calls.some(({ path }) => path.endsWith('/runs'))).toBe(false);
    const challenge = await send(
      { type: 'url_verification', challenge: 'second-app' },
      true,
      'org.b',
      'A2',
    );
    expect(await challenge.json()).toEqual({ challenge: 'second-app' });
    expect((await send(envelope(), true, 'org.a', 'A2')).status).toBe(503);
    expect(current.calls.some(({ path }) => path.endsWith('/runs'))).toBe(false);
  });
  it('leaves overload unacknowledged for redelivery rather than queueing another request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    current.setGate(gate);
    const first = send(envelope());
    while (!current.calls.some(({ path }) => path.endsWith('/resolve')))
      await new Promise((resolve) => setImmediate(resolve));
    try {
      expect((await send(envelope('T2'), true, 'org.b')).status).toBe(503);
    } finally {
      release();
    }
    expect((await first).status).toBe(200);
    expect(current.calls.filter(({ path }) => path.endsWith('/resolve'))).toHaveLength(1);
  });
  it('reports an unmapped agent privately without admitting a run', async () => {
    current.setUnmapped();
    const notice = jest.spyOn(SlackClient.prototype, 'ephemeral').mockResolvedValue();
    expect((await send(envelope())).status).toBe(200);
    expect(notice).toHaveBeenCalledWith(
      'xoxb-test-token',
      expect.objectContaining({
        channel: 'C1',
        user: 'UACTOR',
        text: expect.stringContaining('No agent'),
      }),
      expect.any(AbortSignal),
    );
    expect(current.calls.some(({ path }) => path.endsWith('/runs'))).toBe(false);
  });
  it.each(['unmapped', 'retired_thread'] as const)(
    'acknowledges permanently rejected %s notices but retries uncertain or temporary failures',
    async (kind) => {
      current.setUnmapped(kind);
      const notice = jest.spyOn(SlackClient.prototype, 'ephemeral');
      for (const outcome of ['permanent', 'retryable', 'unknown'] as const) {
        notice.mockRejectedValueOnce(new SlackWriteError(outcome));
        expect((await send(envelope())).status).toBe(outcome === 'permanent' ? 200 : 503);
      }
      expect(current.calls.some(({ path }) => path.endsWith('/runs'))).toBe(false);
    },
  );
  it.each(['file', 'file_comment', 'invalid'])(
    'acknowledges unsupported %s reactions without routing or admission',
    async (type) => {
      for (const eventType of ['reaction_added', 'reaction_removed']) {
        const result = await send({
          ...envelope(),
          event: {
            type: eventType,
            user: 'UACTOR',
            reaction: 'thumbsup',
            event_ts: '1.000001',
            item: { type, id: 'file-a' },
          },
        });
        expect(result.status).toBe(200);
      }
      expect(
        current.calls.some(({ path }) => path.endsWith('/resolve') || path.endsWith('/runs')),
      ).toBe(false);
    },
  );

  it('checks lifecycle notifications with the service instead of disconnecting from event timestamps', async () => {
    expect((await send({ ...envelope(), event: { type: 'app_uninstalled' } })).status).toBe(200);
    expect(current.calls.find(({ path }) => path.endsWith('/lifecycle'))?.body).toEqual({
      tenantId: 'org.a',
      appId: 'A1',
      teamId: 'T1',
    });
    expect(current.calls.some(({ path }) => path.endsWith('/runs'))).toBe(false);
  });
});

it('routes action references by durable run/link/message identity and rejects a different app', () => {
  const payload = {
    type: 'block_actions',
    api_app_id: 'A1',
    team: { id: 'T1' },
    user: { id: 'UACTOR' },
    actions: [
      {
        action_id: 'channel_link_confirm',
        value: JSON.stringify({ linkId: 'link-a', revision: 'r1' }),
      },
    ],
  };
  expect(slackRouteLookup({ kind: 'interaction', payload }, 'A1')?.target).toEqual({
    kind: 'link',
    linkId: 'link-a',
  });
  expect(
    slackRouteLookup(
      {
        kind: 'interaction',
        payload: {
          ...payload,
          actions: [
            {
              action_id: 'channel_run_cancel',
              value: JSON.stringify({ runId: 'run-a', revision: 'r1' }),
            },
          ],
        },
      },
      'A1',
    )?.target,
  ).toEqual({ kind: 'run', runId: 'run-a' });
  expect(() => slackRouteLookup({ kind: 'interaction', payload }, 'A2')).toThrow(
    'Slack app mismatch',
  );
});
