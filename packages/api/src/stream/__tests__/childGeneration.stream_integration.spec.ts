import { randomUUID } from 'crypto';
import { StepEvents } from 'librechat-data-provider';
import type { SubagentContentFrame } from 'librechat-data-provider';
import type { FinalEvent, ServerSentEvent, StreamSubscription } from '~/types';
import type { ChildGenerationManager } from '~/agents/subagentGeneration';
import type { RedisTestClient } from './helpers/redis';
import { clearRedisTestPrefix, createRedisTestClient } from './helpers/redis';
import { RedisEventTransport } from '../implementations/RedisEventTransport';
import { createChildGenerationHost } from '~/agents/subagentGeneration';
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { RedisJobStore } from '../implementations/RedisJobStore';

jest.spyOn(console, 'log').mockImplementation();

const prefix = `child-generation:${randomUUID()}:`;
const managers: GenerationJobManagerClass[] = [];
const subscribers: RedisTestClient[] = [];
const subscriptions: StreamSubscription[] = [];
let redis: RedisTestClient;

function replica() {
  const subscriber = createRedisTestClient(prefix);
  subscribers.push(subscriber);
  const manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: new RedisJobStore(redis),
    eventTransport: new RedisEventTransport(redis, subscriber),
    isRedis: true,
    cleanupOnComplete: false,
  });
  manager.initialize();
  managers.push(manager);
  return manager;
}

const runStep = (id: string): SubagentContentFrame =>
  ({
    event: StepEvents.ON_RUN_STEP,
    data: {
      id,
      index: 0,
      stepDetails: { type: 'message_creation', message_creation: { message_id: id } },
    },
  }) as SubagentContentFrame;

const text = (id: string, value: string): SubagentContentFrame =>
  ({
    event: StepEvents.ON_MESSAGE_DELTA,
    data: { id, delta: { content: [{ type: 'text', text: value }] } },
  }) as SubagentContentFrame;

async function waitUntil(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
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

describe('a background child read from another replica', () => {
  test('resumes with everything streamed so far, then follows it to the final event', async () => {
    const owner = replica();
    const viewer = replica();
    const threadId = randomUUID();
    const taskId = randomUUID();
    const generation = await createChildGenerationHost(owner).open({
      userId: 'user',
      threadId,
      taskId,
      parentConversationId: randomUUID(),
      sender: 'researcher',
      userMessage: { messageId: `${taskId}:user`, parentMessageId: 'root', text: 'Look into it' },
      onAbort: jest.fn(),
    });
    expect(generation).not.toBeNull();
    generation!.emit(runStep('step-1'));
    generation!.emit(text('step-1', 'Before the reader '));
    generation!.emit(text('step-1', 'arrived.'));
    await waitUntil(
      async () =>
        JSON.stringify(
          (await viewer.getResumeState(threadId, generation!.createdAt))?.aggregatedContent ?? [],
        ).includes('arrived.'),
      'the durable chunk log',
    );

    const live: ServerSentEvent[] = [];
    let final: FinalEvent | undefined;
    const resumed = await viewer.subscribeWithResume(
      threadId,
      (event) => live.push(event),
      (event) => {
        final = event as FinalEvent;
      },
      undefined,
      { expectedCreatedAt: generation!.createdAt },
    );
    expect(resumed.subscription).not.toBeNull();
    subscriptions.push(resumed.subscription!);
    resumed.subscription!.activate();

    expect(JSON.stringify(resumed.resumeState?.aggregatedContent)).toContain(
      'Before the reader arrived.',
    );
    expect(resumed.resumeState?.userMessage).toMatchObject({ messageId: `${taskId}:user` });
    expect(resumed.resumeState?.responseMessageId).toBe(`${taskId}:assistant`);
    expect((await viewer.getJob(threadId))?.metadata.subagentTaskId).toBe(taskId);
    await expect(viewer.getActiveJobIdsForUser('user')).resolves.toEqual([]);

    generation!.emit(text('step-1', ' After.'));
    await waitUntil(() => JSON.stringify(live).includes(' After.'), 'the live delta');
    expect(JSON.stringify(live)).not.toContain('Before the reader');

    await generation!.settle(false, async () => ({
      requestMessage: { messageId: `${taskId}:user`, text: 'Look into it' },
      responseMessage: { messageId: `${taskId}:assistant`, text: 'Done' },
    }));

    await waitUntil(() => final != null, 'the final event');
    expect(final).toMatchObject({
      final: true,
      conversation: { conversationId: threadId },
      responseMessage: { messageId: `${taskId}:assistant`, text: 'Done' },
    });
  });

  test('resumes whole after an unwatched child outgrows the early event buffer', async () => {
    const owner = replica();
    const viewer = replica();
    const threadId = randomUUID();
    const taskId = randomUUID();
    let written = 0;
    let onWritten: (() => void) | undefined;
    const counted: ChildGenerationManager = {
      createJob: owner.createJob.bind(owner),
      touchJob: owner.touchJob.bind(owner),
      setContentParts: owner.setContentParts.bind(owner),
      claimTerminalJob: owner.claimTerminalJob.bind(owner),
      publishTerminalClaim: owner.publishTerminalClaim.bind(owner),
      finishTerminalJob: owner.finishTerminalJob.bind(owner),
      emitChunk: async (...args) => {
        await owner.emitChunk(...args);
        written += 1;
        onWritten?.();
      },
    };
    const generation = await createChildGenerationHost(counted).open({
      userId: 'user',
      threadId,
      taskId,
      parentConversationId: randomUUID(),
      sender: 'researcher',
      userMessage: { messageId: `${taskId}:user`, parentMessageId: 'root', text: 'Look into it' },
      onAbort: jest.fn(),
    });
    /** One write per delta, as at an ordinary token rate: each emit waits for the previous
     *  write to land, so nothing queues and nothing merges. */
    const emitAndWait = async (frame: SubagentContentFrame) => {
      const target = written + 1;
      generation!.emit(frame);
      while (written < target) {
        await new Promise<void>((resolve) => {
          onWritten = resolve;
        });
      }
    };
    await waitUntil(() => written === 1, 'the created event');
    await emitAndWait(runStep('step-1'));
    const deltas = 5_200;
    for (let index = 0; index < deltas; index += 1) {
      await emitAndWait(text('step-1', `${index} `));
    }
    expect(written).toBe(deltas + 2);
    /** The buffer did overflow, so the resumes below really take the recovery path. */
    expect((await owner.getJob(threadId))?.metadata.earlyBufferOverflow).toBeDefined();
    const expected = Array.from({ length: deltas }, (_, index) => `${index} `).join('');
    const textOf = (content: unknown): string =>
      (content as Array<{ type?: string; text?: string }> | undefined)
        ?.filter((part) => part?.type === 'text')
        .map((part) => part.text ?? '')
        .join('') ?? '';
    await waitUntil(
      async () =>
        textOf((await viewer.getResumeState(threadId, generation!.createdAt))?.aggregatedContent)
          .length === expected.length,
      'the whole chunk log',
    );

    expect((await owner.getJob(threadId))?.status).toBe('running');
    const remote = await viewer.subscribeWithResume(
      threadId,
      () => undefined,
      undefined,
      undefined,
      {
        expectedCreatedAt: generation!.createdAt,
      },
    );
    subscriptions.push(remote.subscription!);
    const local = await owner.subscribeWithResume(threadId, () => undefined, undefined, undefined, {
      expectedCreatedAt: generation!.createdAt,
    });
    subscriptions.push(local.subscription!);

    expect(textOf(remote.resumeState?.aggregatedContent)).toBe(expected);
    expect(textOf(local.resumeState?.aggregatedContent)).toBe(expected);
    expect((await owner.getJob(threadId))?.status).toBe('running');
  }, 120_000);

  test('keeps a silent child alive across replicas while its owner touches it', async () => {
    const owner = replica();
    const viewer = replica();
    const threadId = randomUUID();
    const taskId = randomUUID();
    const generation = await createChildGenerationHost(owner).open({
      userId: 'user',
      threadId,
      taskId,
      parentConversationId: randomUUID(),
      sender: 'researcher',
      userMessage: { messageId: `${taskId}:user`, parentMessageId: 'root', text: 'Look into it' },
      onAbort: jest.fn(),
    });
    const jobKey = `stream:{${threadId}}:job`;
    const staleAt = Date.now() - 3_600_000;
    await waitUntil(async () => (await viewer.getJob(threadId)) != null, 'the job');
    await redis.hset(jobKey, 'lastActiveAt', String(staleAt));

    await generation!.touch();

    expect(Number(await redis.hget(jobKey, 'lastActiveAt'))).toBeGreaterThan(staleAt);
    expect((await viewer.getJob(threadId))?.status).toBe('running');
  });
});
