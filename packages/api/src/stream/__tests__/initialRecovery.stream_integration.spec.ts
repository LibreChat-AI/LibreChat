import { randomUUID } from 'crypto';
import type { ServerSentEvent, StreamSubscription } from '~/types';
import type { RedisTestClient } from './helpers/redis';
import {
  buildMCPAuthStepId,
  buildMCPAuthToolCall,
  buildMCPAuthRunStepEvent,
  buildMCPAuthRunStepDeltaEvent,
} from '~/mcp/oauth/events';
import {
  GenerationJobManagerClass,
  TERMINAL_PUBLICATION_RECONNECT_ERROR,
} from '../GenerationJobManager';
import { clearRedisTestPrefix, createRedisTestClient } from './helpers/redis';
import { RedisEventTransport } from '../implementations/RedisEventTransport';
import { RedisJobStore } from '../implementations/RedisJobStore';

jest.spyOn(console, 'log').mockImplementation();

const prefix = `initial-recovery:${randomUUID()}:`;
const managers: GenerationJobManagerClass[] = [];
const subscribers: RedisTestClient[] = [];
const subscriptions: StreamSubscription[] = [];
let redis: RedisTestClient;

function replica() {
  const subscriber = createRedisTestClient(prefix);
  subscribers.push(subscriber);
  const jobStore = new RedisJobStore(redis);
  const eventTransport = new RedisEventTransport(redis, subscriber);
  const manager = new GenerationJobManagerClass();
  manager.configure({ jobStore, eventTransport, isRedis: true });
  manager.initialize();
  managers.push(manager);
  return { manager, jobStore, eventTransport, subscriber };
}

async function prompt(manager: GenerationJobManagerClass, streamId: string) {
  const stepId = buildMCPAuthStepId('server');
  const toolCall = buildMCPAuthToolCall({ id: 'user:server:flow', serverName: 'server' });
  const events = [
    buildMCPAuthRunStepEvent({ stepId, toolCall }),
    buildMCPAuthRunStepDeltaEvent({
      stepId,
      toolCall,
      authURL: 'https://auth.example/authorize',
    }),
  ];
  for (const event of events) await manager.emitChunk(streamId, event);
  return events;
}

beforeAll(async () => {
  redis = createRedisTestClient(prefix);
  await redis.ping();
});

afterEach(async () => {
  for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
  await Promise.all(managers.splice(0).map((manager) => manager.destroy()));
  for (const subscriber of subscribers.splice(0)) subscriber.disconnect();
  await clearRedisTestPrefix(redis, prefix);
});

afterAll(async () => {
  await redis.quit();
});

describe('initial cross-replica durable recovery', () => {
  test.each([
    { timing: 'before attach', fenced: true },
    { timing: 'before attach', fenced: false },
    { timing: 'during attach', fenced: true },
    { timing: 'during attach', fenced: false },
  ])(
    'reconnects for a prompt emitted $timing (fenced: $fenced), then resumes it',
    async ({ timing, fenced }) => {
      const owner = replica();
      const viewer = replica();
      const streamId = randomUUID();
      const job = await owner.manager.createJob(streamId, 'user', streamId);
      if (timing === 'before attach') {
        await prompt(owner.manager, streamId);
      } else {
        const subscribe = viewer.eventTransport.subscribe.bind(viewer.eventTransport);
        jest.spyOn(viewer.eventTransport, 'subscribe').mockImplementation((...args) => {
          const subscription = subscribe(...args);
          return {
            ...subscription,
            ready: subscription.ready!.then(async () => {
              await prompt(owner.manager, streamId);
            }),
          };
        });
      }
      const received: ServerSentEvent[] = [];
      const onError = jest.fn();
      const subscription = await viewer.manager.subscribe(
        streamId,
        (event) => received.push(event),
        undefined,
        onError,
        fenced ? { expectedCreatedAt: job.createdAt } : undefined,
      );
      expect(subscription).not.toBeNull();
      subscriptions.push(subscription!);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(received).toEqual([]);
      expect(viewer.eventTransport.getSubscriberCount(streamId)).toBe(0);
      expect((await viewer.jobStore.getJob(streamId))?.error).toBeUndefined();

      jest.restoreAllMocks();
      const resumed = await viewer.manager.subscribeWithResume(
        streamId,
        (event) => received.push(event),
        undefined,
        onError,
        { expectedCreatedAt: job.createdAt },
      );
      expect(resumed.resumeState?.pendingOAuthPrompts).toEqual([
        expect.objectContaining({
          stepId: buildMCPAuthStepId('server'),
          toolCallId: 'user:server:flow',
          authURL: 'https://auth.example/authorize',
        }),
      ]);
      expect(resumed.subscription).not.toBeNull();
      subscriptions.push(resumed.subscription!);
      resumed.subscription!.activate();
      expect(onError).toHaveBeenCalledTimes(1);
    },
  );

  test('preserves a prompt published after validation but before sequence synchronization', async () => {
    const owner = replica();
    const viewer = replica();
    const streamId = randomUUID();
    const job = await owner.manager.createJob(streamId, 'user', streamId);
    const listeners = viewer.subscriber.listeners('message');
    const held: Array<[string, string]> = [];
    viewer.subscriber.removeAllListeners('message');
    viewer.subscriber.on('message', (channel: string, message: string) => {
      if (JSON.parse(message).type === 'chunk') {
        held.push([channel, message]);
      } else {
        for (const listener of listeners) listener(channel, message);
      }
    });
    const getJob = viewer.jobStore.getJob.bind(viewer.jobStore);
    let emitted = false;
    jest.spyOn(viewer.jobStore, 'getJob').mockImplementation(async (...args) => {
      const snapshot = await getJob(...args);
      if (!emitted && viewer.eventTransport.getSubscriberCount(streamId) > 0) {
        emitted = true;
        await prompt(owner.manager, streamId);
      }
      return snapshot;
    });
    const received: ServerSentEvent[] = [];
    const onError = jest.fn();
    const subscription = await viewer.manager.subscribe(
      streamId,
      (event) => received.push(event),
      undefined,
      onError,
      { expectedCreatedAt: job.createdAt },
    );
    subscriptions.push(subscription!);
    const deadline = Date.now() + 5_000;
    while (held.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(held).toHaveLength(2);
    for (const [channel, message] of held) {
      for (const listener of listeners) listener(channel, message);
    }
    expect(received.map((event) => ('event' in event ? event.event : undefined))).toEqual([
      'on_run_step',
      'on_run_step_delta',
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  test('keeps owner-local OAuth replay on the initial connection', async () => {
    const owner = replica();
    const streamId = randomUUID();
    const job = await owner.manager.createJob(streamId, 'user', streamId);
    const events = await prompt(owner.manager, streamId);
    const received: ServerSentEvent[] = [];
    const onError = jest.fn();
    const subscription = await owner.manager.subscribe(
      streamId,
      (event) => received.push(event),
      undefined,
      onError,
      { expectedCreatedAt: job.createdAt },
    );
    subscriptions.push(subscription!);
    expect(received).toEqual(events);
    expect(onError).not.toHaveBeenCalled();
  });

  test('keeps an empty remote attachment live without forcing a reconnect', async () => {
    const owner = replica();
    const viewer = replica();
    const streamId = randomUUID();
    const job = await owner.manager.createJob(streamId, 'user', streamId);
    const received: ServerSentEvent[] = [];
    const onError = jest.fn();
    const subscription = await viewer.manager.subscribe(
      streamId,
      (event) => received.push(event),
      undefined,
      onError,
      { expectedCreatedAt: job.createdAt },
    );
    subscriptions.push(subscription!);
    const events = await prompt(owner.manager, streamId);
    const deadline = Date.now() + 5_000;
    while (received.length < events.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(received).toEqual(events);
    expect(onError).not.toHaveBeenCalled();
  });
});
