import { SocketModeClient } from '@slack/socket-mode';
import type { ChannelBundle } from './types';
import { BoundSocket, connectSocket } from './socket';
import { ChannelClient } from './client';
import { loadConfig } from './config';
import { SlackClient } from './slack';
import { GatewayApp } from './app';

const config = loadConfig({
  CHANNEL_SERVICE_TOKEN: 'test-service',
  CHANNEL_TENANT_ID: 'tenant',
  CHANNEL_ID: 'binding',
  SLACK_TRANSPORT: 'socket_mode',
  SLACK_APP_TOKEN: 'test-app',
});
const bundle: ChannelBundle = {
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
  credentials: { botToken: 'test-bot' },
};
const json = (body: object) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const envelope = () => ({
  type: 'event_callback',
  event_id: 'E1',
  team_id: 'T1',
  api_app_id: 'A1',
  event: {
    type: 'app_mention',
    user: 'U1',
    channel: 'C1',
    ts: '1793000000.123456',
    text: '<@B1> private prompt',
  },
});
const hello = (appId = 'A1') =>
  JSON.stringify({ type: 'hello', connection_info: { app_id: appId } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
class TestSocket extends BoundSocket {
  receive(data: string | ArrayBuffer, binary = false) {
    return this.onWebSocketMessage(data, binary);
  }
}
function setup() {
  const backend = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockImplementation(async (url) =>
      String(url).includes('/service/slack/')
        ? json(bundle)
        : json({ runId: 'run', duplicate: false }),
    );
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const slack = new SlackClient(config, log, async () => json({ ok: true }));
  return {
    backend,
    log,
    app: new GatewayApp(config, new ChannelClient(config, backend), slack, log),
  };
}
function event(ack = jest.fn().mockResolvedValue(undefined)) {
  return { type: 'events_api', envelope_id: 'envelope', body: envelope(), ack };
}

describe('Socket Mode app binding', () => {
  let start: jest.SpyInstance;
  let disconnect: jest.SpyInstance;
  beforeEach(() => {
    start = jest.spyOn(SocketModeClient.prototype, 'start').mockResolvedValue({ ok: true });
    disconnect = jest.spyOn(SocketModeClient.prototype, 'disconnect').mockResolvedValue(undefined);
  });

  test('validates hello app ID before making the connection ready', async () => {
    const state = jest.fn();
    const socket = new TestSocket('A1', state, config);
    await socket.receive(hello());
    expect(state).toHaveBeenCalledWith(true);
    expect(disconnect).not.toHaveBeenCalled();
  });

  test('SDK never receives application payloads before a verified hello', async () => {
    const socket = new TestSocket('A1', jest.fn(), config);
    const delivered = jest.fn();
    socket.on('slack_event', delivered);
    const wire = JSON.stringify({ type: 'events_api', envelope_id: 'wire', payload: envelope() });
    await socket.receive(wire);
    expect(delivered).not.toHaveBeenCalled();
    await socket.receive(hello());
    await socket.receive(wire);
    expect(delivered).toHaveBeenCalledTimes(1);
    socket.emit('reconnecting');
    await socket.receive(wire);
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  test('malformed hello removes an existing validation, not just readiness at startup', async () => {
    const state = jest.fn();
    const socket = new TestSocket('A1', state, config);
    const delivered = jest.fn();
    socket.on('slack_event', delivered);
    await socket.receive(hello());
    state.mockClear();
    await socket.receive(JSON.stringify({ type: 'hello', connection_info: {} }));
    expect(state).toHaveBeenCalledWith(false);
    await socket.receive(
      JSON.stringify({ type: 'events_api', envelope_id: 'wire', payload: envelope() }),
    );
    expect(delivered).not.toHaveBeenCalled();
  });

  test('disconnect failure cannot become an unhandled SDK callback rejection', async () => {
    const state = jest.fn();
    const socket = new TestSocket('A1', state, config);
    disconnect.mockRejectedValueOnce(new Error('private disconnect payload'));
    await expect(socket.receive(hello('wrong'))).resolves.toBeUndefined();
    expect(state).toHaveBeenCalledWith(false);
  });

  test('SDK logging cannot print raw prompts, tokens or malformed payloads', async () => {
    const prints = [
      jest.spyOn(console, 'debug'),
      jest.spyOn(console, 'log'),
      jest.spyOn(console, 'warn'),
      jest.spyOn(console, 'error'),
    ];
    const socket = new TestSocket('A1', jest.fn(), config);
    await socket.receive(hello());
    await socket.receive(
      JSON.stringify({ type: 'events_api', envelope_id: 'wire', payload: envelope() }),
    );
    await socket.receive('{private token malformed');
    expect(prints.flatMap((print) => print.mock.calls)).toEqual([]);
  });

  test.each(['different', '', undefined])(
    'wrong or missing hello app ID %p disables the socket',
    async (appId) => {
      const state = jest.fn();
      const socket = new TestSocket('A1', state, config);
      await socket.receive(JSON.stringify({ type: 'hello', connection_info: { app_id: appId } }));
      expect(state).toHaveBeenCalledWith(false);
      expect(state).not.toHaveBeenCalledWith(true);
      expect(disconnect).toHaveBeenCalledTimes(1);
    },
  );

  test('malformed/binary/oversized input never authenticates the socket', async () => {
    const state = jest.fn();
    const socket = new TestSocket('A1', state, config);
    for (const raw of [
      '{',
      'null',
      'true',
      JSON.stringify({ type: 'hello' }).padEnd(1024 * 1024 + 1, ' '),
    ])
      await socket.receive(raw);
    await socket.receive(hello(), true);
    expect(state).not.toHaveBeenCalledWith(true);
  });

  test('malformed events are contained rather than rejecting the SDK callback', async () => {
    const state = jest.fn();
    const socket = new TestSocket('A1', state, config);
    await socket.receive(hello());
    for (const payload of [
      { type: 'events_api' },
      { type: 'events_api', payload: {} },
      { type: 'events_api', payload: { event: null } },
    ])
      await expect(socket.receive(JSON.stringify(payload))).resolves.toBeUndefined();
  });

  test('events before verified hello cannot reach application dispatch', async () => {
    const { app, backend, log } = setup();
    const controller = new AbortController();
    const socket = await connectSocket(config, app, 'A1', log, controller.signal);
    const delivery = event();
    socket.emit('slack_event', delivery);
    await tick();
    expect(backend).not.toHaveBeenCalled();
    expect(delivery.ack).not.toHaveBeenCalled();
    controller.abort();
  });

  test('valid hello permits durable admission followed by acknowledgment', async () => {
    const { app, backend, log } = setup();
    const controller = new AbortController();
    const socket = await connectSocket(config, app, 'A1', log, controller.signal);
    socket.emit('ws_message', hello(), false);
    await tick();
    const delivery = event();
    socket.emit('slack_event', delivery);
    await tick();
    expect(app.connected).toBe(true);
    expect(backend).toHaveBeenCalledTimes(2);
    expect(delivery.ack).toHaveBeenCalledWith(undefined);
    controller.abort();
    expect(app.connected).toBe(false);
  });

  test('a wrong hello stops delivery and repeated wrong hello never becomes ready', async () => {
    const { app, backend, log } = setup();
    const controller = new AbortController();
    const socket = await connectSocket(config, app, 'A1', log, controller.signal);
    socket.emit('ws_message', hello('wrong'), false);
    await tick();
    socket.emit('slack_event', event());
    await tick();
    socket.emit('ws_message', hello('wrong'), false);
    await tick();
    socket.emit('slack_event', event());
    await tick();
    expect(app.connected).toBe(false);
    expect(backend).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(2);
    controller.abort();
  });

  test('reconnect requires another valid hello before accepting more events', async () => {
    const { app, backend, log } = setup();
    const controller = new AbortController();
    const socket = await connectSocket(config, app, 'A1', log, controller.signal);
    socket.emit('ws_message', hello(), false);
    await tick();
    socket.emit('reconnecting');
    socket.emit('slack_event', event());
    await tick();
    expect(app.connected).toBe(false);
    expect(backend).not.toHaveBeenCalled();
    socket.emit('ws_message', hello(), false);
    await tick();
    socket.emit('slack_event', event());
    await tick();
    expect(backend).toHaveBeenCalledTimes(2);
    controller.abort();
  });

  test('SDK error and rejected admission never log raw content or acknowledge failure', async () => {
    const { app, backend, log } = setup();
    const controller = new AbortController();
    backend.mockImplementation(async (url) =>
      String(url).includes('/service/slack/')
        ? json(bundle)
        : Promise.reject(new Error('private provider credential')),
    );
    const socket = await connectSocket(config, app, 'A1', log, controller.signal);
    socket.emit('ws_message', hello(), false);
    await tick();
    socket.emit('error', new Error('private Slack app token'));
    const delivery = event();
    socket.emit('slack_event', delivery);
    await tick();
    expect(delivery.ack).not.toHaveBeenCalled();
    expect(log.warn.mock.calls).toEqual([
      ['slack_socket_transport_error'],
      ['slack_socket_delivery_not_accepted'],
    ]);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private');
    controller.abort();
  });

  test('invalid SDK deliveries are ignored without authority or acknowledgement', async () => {
    const { app, backend, log } = setup();
    const controller = new AbortController();
    const socket = await connectSocket(config, app, 'A1', log, controller.signal);
    socket.emit('ws_message', hello(), false);
    await tick();
    for (const delivery of [
      { ...event(), envelope_id: '' },
      { ...event(), type: 'other' },
      { ...event(), ack: 'not a function' },
    ])
      socket.emit('slack_event', delivery);
    await tick();
    expect(backend).not.toHaveBeenCalled();
    controller.abort();
  });

  test('pre-aborted startup never starts the SDK', async () => {
    const { app, log } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(connectSocket(config, app, 'A1', log, controller.signal)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    expect(app.connected).toBe(false);
  });

  test('abort during startup rejects and cleans up a late successful start', async () => {
    const { app, log } = setup();
    const controller = new AbortController();
    let finish: (value: { ok: true }) => void = () => {};
    start.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = connectSocket(config, app, 'A1', log, controller.signal);
    controller.abort();
    finish({ ok: true });
    await expect(pending).rejects.toThrow();
    expect(disconnect).toHaveBeenCalled();
    expect(app.connected).toBe(false);
  });

  test('aborted active transport cannot dispatch or acknowledge later input', async () => {
    const { app, backend, log } = setup();
    const controller = new AbortController();
    const socket = await connectSocket(config, app, 'A1', log, controller.signal);
    socket.emit('ws_message', hello(), false);
    await tick();
    controller.abort();
    const delivery = event();
    socket.emit('slack_event', delivery);
    await tick();
    expect(backend).not.toHaveBeenCalled();
    expect(delivery.ack).not.toHaveBeenCalled();
    expect(app.connected).toBe(false);
  });
});
