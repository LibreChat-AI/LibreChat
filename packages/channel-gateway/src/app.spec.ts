import { createHmac } from 'node:crypto';
import { SocketModeClient } from '@slack/socket-mode';
import { createServer, request as httpRequest } from 'node:http';
import { DEFAULT_CHANNEL_GATEWAY_POLICY } from 'librechat-data-provider';
import type { AddressInfo } from 'node:net';
import type { ChannelBundle } from './types';
import { loadConfig, resolveGatewayConfig } from './config';
import { ChannelClient } from './client';
import { connectSocket } from './socket';
import { SlackClient } from './slack';
import { GatewayApp } from './app';

const bundle: ChannelBundle = {
  gateway: { version: 1, ...DEFAULT_CHANNEL_GATEWAY_POLICY, transport: 'webhook' },
  channel: {
    channelId: 'binding',
    tenantId: 'tenant',
    agentId: 'agent',
    createdBy: 'owner',
    type: 'slack',
    status: 'active',
    credentialMode: 'per_user',
    revision: 'r1',
    slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
  },
  agent: { id: 'agent' },
  credentials: { botToken: 'test-bot', signingSecret: 'test-signing' },
};
const envelope = (event: object = {}) => ({
  type: 'event_callback',
  event_id: 'E1',
  team_id: 'T1',
  api_app_id: 'A1',
  event: {
    type: 'app_mention',
    user: 'U1',
    channel: 'C1',
    ts: '1793000000.123456',
    text: '<@B1> hello',
    ...event,
  },
});
const callback = (
  action = 'channel_run_cancel',
  value = JSON.stringify({ runId: 'run', revision: 'r1' }),
) => ({
  type: 'block_actions',
  team: { id: 'T1' },
  api_app_id: 'A1',
  user: { id: 'U1' },
  channel: { id: 'C1' },
  container: { channel_id: 'C1' },
  actions: [{ action_id: action, value }],
});
const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function setup(env: NodeJS.ProcessEnv = {}) {
  const currentBundle: ChannelBundle = {
    ...bundle,
    gateway: {
      ...bundle.gateway,
      transport: env.SLACK_TRANSPORT === 'socket_mode' ? 'socket_mode' : 'webhook',
    },
  };
  const config = resolveGatewayConfig(
    loadConfig({
      CHANNEL_SERVICE_TOKEN: 'test-service',
      SLACK_TRANSPORT: 'webhook',
      CHANNEL_TENANT_ID: 'tenant',
      CHANNEL_ID: 'binding',
      ...env,
    }),
    currentBundle.gateway,
  );
  const backend = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockImplementation(async (url) =>
      String(url).includes('/service/slack/')
        ? json(currentBundle)
        : json({ runId: 'run', duplicate: false }),
    );
  const slack = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockImplementation(async () => json({ ok: true }));
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const app = new GatewayApp(
    config,
    new ChannelClient(config, backend),
    new SlackClient(config, undefined, slack),
    log,
  );
  return { app, backend, slack, log, config, bundle: currentBundle };
}
async function serve(app: GatewayApp, check: (base: string) => Promise<void>) {
  const server = createServer((request, response) => {
    void app.http(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await check(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
function signed(body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'Content-Type': 'application/json',
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature':
      'v0=' + createHmac('sha256', 'test-signing').update(`v0:${timestamp}:${body}`).digest('hex'),
  };
}

describe('durable Slack ingress', () => {
  test('does not acknowledge until admission has been durably confirmed', async () => {
    const { app, backend } = setup();
    let accept: (response: Response) => void = () => {};
    const admission = new Promise<Response>((resolve) => {
      accept = resolve;
    });
    backend.mockImplementation(async (url) =>
      String(url).includes('/service/slack/') ? json(bundle) : admission,
    );
    let acknowledged = false;
    const pending = app.dispatch(envelope(), false).then(() => {
      acknowledged = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(acknowledged).toBe(false);
    accept(json({ runId: 'run', duplicate: false }));
    await pending;
    expect(acknowledged).toBe(true);
    expect(JSON.parse(String(backend.mock.calls[1][1]?.body))).toMatchObject({
      input: 'hello',
      actor: { externalUserId: 'U1', teamId: 'T1', appId: 'A1' },
    });
  });

  test.each(['team_id', 'api_app_id'])('does not admit a foreign %s', async (field) => {
    const { app, backend } = setup();
    await expect(app.dispatch({ ...envelope(), [field]: 'foreign' }, false)).rejects.toThrow();
    expect(backend).toHaveBeenCalledTimes(1);
  });

  test('native Stop is constrained to its actor, thread and occurrence time', async () => {
    const { app, backend } = setup();
    await app.dispatch(
      envelope({
        type: 'agent_session_stopped',
        thread_ts: '1792999999.5',
        event_ts: '1793000001.123456',
      }),
      false,
    );
    expect(String(backend.mock.calls[1][0])).toContain('/runs/stop-thread');
    expect(JSON.parse(String(backend.mock.calls[1][1]?.body))).toEqual({
      actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
      externalThreadKey: 'C1:1792999999.5',
      externalChannelId: 'C1',
      eventAt: 1793000001123,
    });
  });

  test('native Stop remains available when native emission is disabled', async () => {
    const { app, backend } = setup();
    await app.dispatch(
      envelope({
        type: 'agent_session_stopped',
        thread_ts: '1792999999.5',
        event_ts: '1793000001.1',
      }),
      false,
    );
    expect(backend).toHaveBeenCalledTimes(2);
    expect(String(backend.mock.calls[1][0])).toContain('/runs/stop-thread');
  });

  test.each([400, 403])('native Stop reports a safe diagnostic for backend %i', async (status) => {
    const { app, backend, log } = setup();
    backend.mockImplementation(async (url) =>
      String(url).includes('/service/slack/')
        ? json(bundle)
        : json({ error: 'private stop content' }, status),
    );
    const dispatch = app.dispatch(
      envelope({
        type: 'agent_session_stopped',
        thread_ts: '1792999999.5',
        event_ts: '1793000001.1',
      }),
      false,
    );
    if (status === 400) await expect(dispatch).rejects.toThrow();
    else await dispatch;
    expect(log.warn.mock.calls).toEqual([
      [status === 400 ? 'native_stop_invalid_request' : 'native_stop_forbidden'],
    ]);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private');
  });

  test('native Stop malformed envelope and binding errors are distinguishable without payload logging', async () => {
    const { app, log } = setup();
    const stop = envelope({
      type: 'agent_session_stopped',
      thread_ts: '1792999999.5',
      event_ts: '1793000001.1',
    });
    await expect(app.dispatch({ ...stop, team_id: 'foreign' }, false)).rejects.toThrow();
    await expect(app.dispatch({ ...stop, event_id: undefined }, false)).rejects.toThrow();
    await expect(
      app.dispatch(envelope({ type: 'agent_session_stopped', event_ts: '1793000001.1' }), false),
    ).rejects.toThrow();
    expect(log.warn.mock.calls).toEqual([
      ['native_stop_binding_rejected'],
      ['native_stop_envelope_rejected'],
      ['native_stop_event_rejected'],
    ]);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('foreign');
  });

  test.each(['1793000000.1', '1793000010.1'])(
    'forwards future Stop %s immediately with its original occurrence time for durable service normalization',
    async (event_ts) => {
      const { app, backend } = setup();
      jest.spyOn(Date, 'now').mockReturnValue(1793000000000);
      await app.dispatch(
        envelope({ type: 'agent_session_stopped', thread_ts: '1792999999.5', event_ts }),
        false,
      );
      expect(JSON.parse(String(backend.mock.calls[1][1]?.body)).eventAt).toBe(
        Math.floor(Number(event_ts) * 1000),
      );
    },
  );

  test('already-aborted Stop does not reach the backend', async () => {
    const { app, backend } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      app.dispatch(
        envelope({
          type: 'agent_session_stopped',
          thread_ts: '1792999999.5',
          event_ts: '1793000001.1',
        }),
        false,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(backend).not.toHaveBeenCalled();
  });

  test('Socket Mode leaves rejected Stop unacknowledged for redelivery', async () => {
    const { app, backend, log, config, bundle } = setup({
      SLACK_TRANSPORT: 'socket_mode',
      SLACK_APP_TOKEN: 'test-app',
    });
    backend.mockImplementation(async (url) =>
      String(url).includes('/service/slack/')
        ? json(bundle)
        : json({ error: 'invalid_run_action' }, 400),
    );
    jest.spyOn(SocketModeClient.prototype, 'start').mockResolvedValue({ ok: true });
    jest.spyOn(SocketModeClient.prototype, 'disconnect').mockResolvedValue(undefined);
    const controller = new AbortController();
    const socket = await connectSocket(config, app, 'A1', log, controller.signal);
    socket.emit(
      'ws_message',
      JSON.stringify({ type: 'hello', connection_info: { app_id: 'A1' } }),
      false,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const ack = jest.fn().mockResolvedValue(undefined);
    socket.emit('slack_event', {
      type: 'events_api',
      envelope_id: 'stop',
      body: envelope({
        type: 'agent_session_stopped',
        thread_ts: '1792999999.5',
        event_ts: '1793000001.1',
      }),
      ack,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(ack).not.toHaveBeenCalled();
    expect(log.warn.mock.calls).toContainEqual(['native_stop_invalid_request']);
    expect(log.warn.mock.calls).toContainEqual(['slack_socket_delivery_not_accepted']);
    controller.abort();
  });

  test('only explicit link_required invokes private linking', async () => {
    const { app, backend, slack } = setup();
    backend.mockImplementation(async (url) => {
      if (String(url).includes('/service/slack/')) return json(bundle);
      if (String(url).endsWith('/runs')) return json({ error: 'channel_link_required' }, 403);
      if (String(url).endsWith('/identity/U1')) return json({ ok: true, value: null });
      return json({
        ok: true,
        value: {
          url: `https://chat.example/channels/link#${'a'.repeat(43)}`,
          expiresAtMs: Date.now() + 60000,
        },
      });
    });
    await app.dispatch(envelope(), false);
    expect(slack).toHaveBeenCalledTimes(1);
    expect(String(slack.mock.calls[0][0])).toContain('chat.postEphemeral');
  });

  test.each([{ error: 'forbidden' }, { error: 'expired' }, { message: 'channel_link_required' }])(
    'does not reinterpret arbitrary 403 as linking %p',
    async (failure) => {
      const { app, backend, slack } = setup();
      backend.mockImplementation(async (url) =>
        String(url).includes('/service/slack/') ? json(bundle) : json(failure, 403),
      );
      await expect(app.dispatch(envelope(), false)).rejects.toThrow();
      expect(slack).not.toHaveBeenCalled();
      expect(backend).toHaveBeenCalledTimes(2);
    },
  );

  test('rejects foreign interaction workspace/app and mismatched container', async () => {
    const { app, backend } = setup();
    for (const body of [
      { ...callback(), team: { id: 'other' } },
      { ...callback(), api_app_id: 'other' },
      { ...callback(), container: { channel_id: 'other' } },
    ])
      await expect(app.dispatch(body, true)).rejects.toThrow();
    expect(backend.mock.calls.every(([url]) => String(url).includes('/service/slack/'))).toBe(true);
  });

  test('stale controls cannot cancel work', async () => {
    const { app, backend, slack } = setup();
    await app.dispatch(
      callback('channel_run_cancel', JSON.stringify({ runId: 'run', revision: 'old' })),
      true,
    );
    expect(backend).toHaveBeenCalledTimes(1);
    expect(slack).toHaveBeenCalledTimes(1);
  });

  test('keeps overload unacknowledged rather than queueing memory', async () => {
    const { app, backend } = setup();
    let release: (response: Response) => void = () => {};
    const waiting = new Promise<Response>((resolve) => {
      release = resolve;
    });
    backend.mockImplementation(async () => waiting.then(() => json(bundle)));
    const pending = Array.from({ length: 64 }, () =>
      app.dispatch(envelope({ bot_id: 'bot' }), false),
    );
    await expect(app.dispatch(envelope(), false)).rejects.toThrow('capacity');
    expect(backend).toHaveBeenCalledTimes(64);
    release(json(bundle));
    await Promise.all(pending);
    backend.mockImplementation(async () => json(bundle));
    await expect(app.dispatch(envelope({ bot_id: 'bot' }), false)).resolves.toBeUndefined();
  });
});

describe('signed webhook boundary', () => {
  test('does not echo a challenge after the ingress deadline expires during channel lookup', async () => {
    const { app, backend } = setup();
    backend.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2100));
      return json(bundle);
    });
    await serve(app, async (base) => {
      const body = JSON.stringify({ type: 'url_verification', challenge: 'too-late' });
      const response = await fetch(base + '/slack/events/tenant/binding', {
        method: 'POST',
        headers: signed(body),
        body,
      });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('too-late');
    });
  });
  test('echoes only an authenticated installation challenge without admitting a run', async () => {
    const { app, backend } = setup();
    await serve(app, async (base) => {
      const body = JSON.stringify({ type: 'url_verification', challenge: 'verified-challenge' });
      const response = await fetch(base + '/slack/events/tenant/binding', {
        method: 'POST',
        headers: signed(body),
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ challenge: 'verified-challenge' });
      const tampered = await fetch(base + '/slack/events/tenant/binding', {
        method: 'POST',
        headers: signed(body + 'changed'),
        body,
      });
      expect(tampered.status).toBe(401);
    });
    expect(backend.mock.calls.every(([url]) => String(url).includes('/service/slack/'))).toBe(true);
  });

  test('fails closed and becomes unhealthy if the current server policy changes ingress', async () => {
    const { app, backend, bundle: current } = setup();
    app.ready = true;
    backend.mockImplementation(async () =>
      json({ ...current, gateway: { ...current.gateway, transport: 'socket_mode' } }),
    );
    await serve(app, async (base) => {
      const body = JSON.stringify(envelope());
      expect(
        (
          await fetch(base + '/slack/events/tenant/binding', {
            method: 'POST',
            headers: signed(body),
            body,
          })
        ).status,
      ).toBe(503);
      expect((await fetch(base + '/healthz')).status).toBe(503);
    });
    expect(backend).toHaveBeenCalledTimes(1);
  });

  test('rejects unsigned installation challenges before echoing their payload', async () => {
    const { app, backend } = setup();
    await serve(app, async (base) => {
      const response = await fetch(base + '/slack/events/tenant/binding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'url_verification', challenge: 'must-authenticate-first' }),
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain('must-authenticate-first');
      expect(backend).toHaveBeenCalledTimes(1);
    });
  });

  test('HTTP leaves rejected Stop retryable rather than acknowledging it', async () => {
    const { app, backend } = setup();
    backend.mockImplementation(async (url) =>
      String(url).includes('/service/slack/')
        ? json(bundle)
        : json({ error: 'invalid_run_action' }, 400),
    );
    await serve(app, async (base) => {
      const body = JSON.stringify(
        envelope({
          type: 'agent_session_stopped',
          thread_ts: '1792999999.5',
          event_ts: '1793000001.1',
        }),
      );
      const response = await fetch(base + '/slack/events/tenant/binding', {
        method: 'POST',
        headers: signed(body),
        body,
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'delivery_not_accepted' });
    });
  });
  test('bounds incomplete incoming bodies by the acknowledgement deadline', async () => {
    const { app, backend } = setup();
    await serve(app, async (base) => {
      let request: ReturnType<typeof httpRequest> | undefined;
      const response = new Promise<number | string>((resolve) => {
        request = httpRequest(
          base + '/slack/events/tenant/binding',
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (incoming) => {
            incoming.resume();
            resolve(incoming.statusCode ?? 0);
          },
        );
        request.on('error', () => resolve('closed'));
        request.write('{');
      });
      const result = await Promise.race([
        response,
        new Promise<string>((resolve) => setTimeout(() => resolve('stalled'), 2600)),
      ]);
      request?.destroy();
      expect(result).not.toBe('stalled');
      expect(backend).not.toHaveBeenCalled();
    });
  });

  test('bounds webhook capacity before backend channel lookup', async () => {
    const { app, backend } = setup();
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.mockImplementation(async () => {
      await waiting;
      return json(bundle);
    });
    await serve(app, async (base) => {
      const body = JSON.stringify(envelope({ bot_id: 'bot' }));
      const pending = Array.from({ length: 65 }, () =>
        fetch(base + '/slack/events/tenant/binding', {
          method: 'POST',
          headers: signed(body),
          body,
        }),
      );
      for (let i = 0; i < 100 && backend.mock.calls.length < 64; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const lookups = backend.mock.calls.length;
      release();
      const results = await Promise.all(pending);
      await Promise.all(results.map((result) => result.arrayBuffer()));
      expect(lookups).toBeLessThanOrEqual(64);
      expect(results.filter((result) => result.status === 503)).toHaveLength(1);
    });
  });

  test('rejects unsigned/tampered requests without admitting work', async () => {
    const { app, backend } = setup();
    await serve(app, async (base) => {
      const body = JSON.stringify(envelope());
      const response = await fetch(base + '/slack/events/tenant/binding', {
        method: 'POST',
        headers: signed(body + 'tampered'),
        body,
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'invalid_signature' });
    });
    expect(backend.mock.calls.every(([url]) => String(url).includes('/service/slack/'))).toBe(true);
  });

  test('accepts exact signed payload only after durable admission', async () => {
    const { app, backend } = setup();
    await serve(app, async (base) => {
      const body = JSON.stringify(envelope());
      const response = await fetch(base + '/slack/events/tenant/binding', {
        method: 'POST',
        headers: signed(body),
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
    });
    expect(backend.mock.calls.filter(([url]) => String(url).endsWith('/runs'))).toHaveLength(1);
  });

  test('requires exact configured route and rejects webhook use in Socket Mode', async () => {
    const { app, backend } = setup({ SLACK_TRANSPORT: 'socket_mode', SLACK_APP_TOKEN: 'test-app' });
    await serve(app, async (base) => {
      const body = JSON.stringify(envelope());
      for (const path of ['/slack/events/tenant/binding', '/slack/events/other/binding'])
        expect(
          (await fetch(base + path, { method: 'POST', headers: signed(body), body })).status,
        ).toBe(404);
    });
    expect(backend).not.toHaveBeenCalled();
  });

  test('failed admission returns retryable HTTP failure, not false success', async () => {
    const { app, backend, log } = setup();
    backend.mockImplementation(async (url) =>
      String(url).includes('/service/slack/')
        ? json(bundle)
        : json({ error: 'private-secret-details' }, 500),
    );
    await serve(app, async (base) => {
      const body = JSON.stringify(envelope());
      const response = await fetch(base + '/slack/events/tenant/binding', {
        method: 'POST',
        headers: signed(body),
        body,
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'delivery_not_accepted' });
    });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private-secret-details');
  });

  test('interactions require signed form encoding and one payload', async () => {
    const { app, backend } = setup();
    await serve(app, async (base) => {
      const body = JSON.stringify(callback());
      expect(
        (
          await fetch(base + '/slack/interactions/tenant/binding', {
            method: 'POST',
            headers: signed(body),
            body,
          })
        ).status,
      ).toBe(400);
      const form = new URLSearchParams({
        payload: JSON.stringify(callback('channel_link_open')),
      }).toString();
      const response = await fetch(base + '/slack/interactions/tenant/binding', {
        method: 'POST',
        headers: { ...signed(form), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      expect(response.status).toBe(200);
    });
    expect(backend.mock.calls.every(([url]) => String(url).includes('/service/slack/'))).toBe(true);
  });
});

test.each([false, true])(
  'pending modal work owns ingress capacity until settlement (failure=%s)',
  async (fail) => {
    const { app, backend } = setup();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const reference = {
      runId: 'run',
      revision: 'r1',
      actionId: 'action',
      channelId: 'C1',
      actorId: 'U1',
      expiresAt: Date.now() + 60000,
    };
    backend.mockImplementation(async () => {
      reads++;
      await waiting;
      if (fail) throw new Error('outage');
      return json({
        actionId: 'action',
        pendingAction: {
          actionId: 'action',
          expiresAt: reference.expiresAt,
          payload: { type: 'ask_user_question', question: { question: 'Answer this' } },
        },
      });
    });
    const body = {
      type: 'view_submission',
      team: { id: 'T1' },
      api_app_id: 'A1',
      user: { id: 'U1' },
      view: {
        callback_id: 'channel_native_review',
        private_metadata: JSON.stringify(reference),
        state: { values: {} },
      },
    };
    const pending = Array.from({ length: 64 }, () => app.dispatch(body, true, undefined, bundle));
    for (let attempt = 0; attempt < 20 && reads < 64; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      expect(reads).toBe(64);
      await expect(app.dispatch(envelope(), false, undefined, bundle)).rejects.toThrow('capacity');
    } finally {
      release();
      await Promise.all(pending);
    }
    await expect(
      app.dispatch(envelope({ bot_id: 'bot' }), false, undefined, bundle),
    ).resolves.toBeUndefined();
  },
);
