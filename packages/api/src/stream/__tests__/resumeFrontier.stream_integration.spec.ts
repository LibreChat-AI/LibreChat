import { logger } from '@librechat/data-schemas';
import { createContentAggregator } from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';
import type { Redis, Cluster } from 'ioredis';
import type { IJobStore } from '~/stream/interfaces/IJobStore';
import type * as t from '~/types';
import {
  ioredisClient as staticRedisClient,
  keyvRedisClient as staticKeyvClient,
  keyvRedisClientReady,
} from '~/cache/redisClients';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createStreamServices } from '~/stream/createStreamServices';

logger.silent = true;

type AggregatedEvent = Parameters<
  ReturnType<typeof createContentAggregator>['aggregateContent']
>[0];

type HostContentStore = IJobStore & Required<Pick<IJobStore, 'copyHostContent'>>;

/** Where in the attachment the run produces its next delta. */
type Window = 'before-subscribe' | 'after-subscribe' | 'after-snapshot';

const STEP_ID = 'step-message';

const delta = (text: string): t.ServerSentEvent => ({
  event: 'on_message_delta',
  data: { id: STEP_ID, delta: { content: { type: 'text', text } } },
});

const PROMPT_EVENT = 'on_run_step_delta';

const PROMPT: t.ServerSentEvent = {
  event: PROMPT_EVENT,
  data: { id: 'step-prompt', delta: { type: 'tool_calls', auth: 'https://example.test/sign-in' } },
};

const deltaText = (event: t.ServerSentEvent): string => {
  const data = (event as { data?: { delta?: { content?: { text?: string } } } }).data;
  return data?.delta?.content?.text ?? '';
};

/**
 * A resuming client holds the sync frame's snapshot, then its pending events, then what the
 * subscription delivers. On the replica that hosts the run the snapshot is the run's own
 * content, so every delta has to land in exactly one of the three.
 *
 * Run with: USE_REDIS=true npx jest resumeFrontier
 */
describe('Resume snapshot frontier on the hosting replica (real Redis)', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let ioredisClient: Redis | Cluster | null = null;
  let dynamicKeyvClient: unknown = null;
  let dynamicKeyvReady: Promise<unknown> | null = null;
  const testPrefix = 'ResumeFrontier-Test';

  beforeAll(async () => {
    originalEnv = { ...process.env };
    process.env.USE_REDIS = process.env.USE_REDIS ?? 'true';
    process.env.REDIS_URI = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    process.env.REDIS_KEY_PREFIX = testPrefix;
    jest.resetModules();
    const redisModule = await import('~/cache/redisClients');
    ioredisClient = redisModule.ioredisClient;
    dynamicKeyvClient = redisModule.keyvRedisClient;
    dynamicKeyvReady = redisModule.keyvRedisClientReady;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    jest.resetModules();
    if (!ioredisClient) {
      return;
    }
    try {
      const keys = await ioredisClient.keys(`${testPrefix}*`);
      const streamKeys = await ioredisClient.keys('stream:*');
      await Promise.all([...keys, ...streamKeys].map((key) => ioredisClient!.del(key)));
    } catch {
      // Ignore cleanup errors
    }
  });

  afterAll(async () => {
    for (const ready of [keyvRedisClientReady, dynamicKeyvReady]) {
      await ready?.catch(() => {});
    }
    for (const client of [ioredisClient, staticRedisClient, staticKeyvClient, dynamicKeyvClient]) {
      try {
        await (client as { disconnect: () => void | Promise<void> } | null)?.disconnect();
      } catch {
        /* ignore */
      }
    }
    process.env = originalEnv;
  });

  /**
   * Resumes a run that produces `two ` in the named window and `three` once delivery is live,
   * and returns the text a client would hold beside the run's own. A reconnect has had a
   * subscriber before, which is what lets the run batch its deltas on the way to Redis.
   */
  async function resumeWhileStreaming(
    window: Window,
    attachment: 'first' | 'reconnect',
  ): Promise<{ client: string; host: string; prompts: number }> {
    const manager = new GenerationJobManagerClass();
    const services = createStreamServices({ useRedis: true, redisClient: ioredisClient! });
    manager.configure(services);
    manager.initialize();

    const streamId = `resume-frontier-${window}-${attachment}-${Date.now()}`;
    await manager.createJob(streamId, 'user-1');
    const { contentParts, aggregateContent } = createContentAggregator();
    manager.setContentParts(streamId, contentParts as Agents.MessageContentComplex[]);
    /** The order the run's own handlers use: fold into the content, then emit. */
    const emit = async (event: t.ServerSentEvent): Promise<void> => {
      aggregateContent(event as unknown as AggregatedEvent);
      await manager.emitChunk(streamId, event);
    };
    await emit({
      event: 'on_run_step',
      data: { id: STEP_ID, runId: 'run-1', index: 0, stepDetails: { type: 'message_creation' } },
    });
    if (attachment === 'reconnect') {
      const earlier = await manager.subscribe(streamId, () => {});
      await emit(delta('zero '));
      earlier!.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await emit(delta('one '));

    let fired = false;
    const produce = async (): Promise<void> => {
      if (!fired) {
        fired = true;
        await emit(delta('two '));
        /** A sign-in prompt is emitted without being folded into the run's content. */
        await manager.emitChunk(streamId, PROMPT);
      }
    };
    const getResumeState = manager.getResumeState.bind(manager);
    const stateReads = jest.spyOn(manager, 'getResumeState').mockImplementation(async (...args) => {
      const state = await getResumeState(...args);
      if (window === 'before-subscribe') {
        await produce();
      }
      return state;
    });
    const transport = services.eventTransport;
    const sync = transport.syncReorderBuffer!.bind(transport);
    jest.spyOn(transport, 'syncReorderBuffer').mockImplementation(async (...args) => {
      await sync(...args);
      if (window === 'after-subscribe') {
        await produce();
      }
    });
    const store = services.jobStore as HostContentStore;
    const copyHostContent = store.copyHostContent.bind(store);
    jest.spyOn(store, 'copyHostContent').mockImplementation((...args) => {
      const content = copyHostContent(...args);
      if (window === 'after-snapshot') {
        /** As soon as the manager's synchronous step around the copy has finished. */
        queueMicrotask(() => void produce());
      }
      return content;
    });

    const live: t.ServerSentEvent[] = [];
    const { subscription, resumeState, pendingEvents } = await manager.subscribeWithResume(
      streamId,
      (event) => live.push(event),
    );
    expect(fired).toBe(true);
    expect(subscription).not.toBeNull();
    /** The copy is local: a hosted resume reads the resume state from Redis once. */
    expect(stateReads).toHaveBeenCalledTimes(1);
    /** The route serializes the frame here, and only then lets live delivery start. */
    const frame = JSON.parse(JSON.stringify({ resumeState, pendingEvents })) as {
      resumeState: t.ResumeState;
      pendingEvents: t.ServerSentEvent[];
    };
    subscription!.activate();
    await emit(delta('three'));

    const deadline = Date.now() + 3000;
    while (!live.some((event) => deltaText(event) === 'three') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const snapshot = (frame.resumeState.aggregatedContent ?? []) as Array<{ text?: string }>;
    const client =
      (snapshot[0]?.text ?? '') +
      frame.pendingEvents.map(deltaText).join('') +
      live.map(deltaText).join('');
    const host = (contentParts[0] as { text?: string }).text ?? '';
    const prompts = [...frame.pendingEvents, ...live].filter(
      (event) => (event as { event?: string }).event === PROMPT_EVENT,
    ).length;
    subscription!.unsubscribe();
    await manager.destroy();
    return { client, host, prompts };
  }

  describe.each(['first', 'reconnect'] as const)('%s attachment', (attachment) => {
    const expected = attachment === 'reconnect' ? 'zero one two three' : 'one two three';

    test.each(['before-subscribe', 'after-subscribe', 'after-snapshot'] as const)(
      'a delta produced %s reaches the resuming client exactly once',
      async (window) => {
        if (!ioredisClient) {
          console.warn('Redis not available, skipping test');
          return;
        }
        const { client, host } = await resumeWhileStreaming(window, attachment);
        expect(host).toBe(expected);
        expect(client).toBe(expected);
      },
    );

    test('a run-step delta the run did not fold into its content is still delivered', async () => {
      if (!ioredisClient) {
        console.warn('Redis not available, skipping test');
        return;
      }
      const { prompts } = await resumeWhileStreaming('after-subscribe', attachment);
      expect(prompts).toBe(1);
    });
  });
});
