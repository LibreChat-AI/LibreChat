import { StepEvents } from 'librechat-data-provider';
import type { SubagentContentFrame } from 'librechat-data-provider';
import type { ChildGenerationInput, ChildGenerationManager } from './subagentGeneration';
import type { ServerSentEvent } from '~/types';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { createChildGenerationHost, mergeDeltaFrames } from './subagentGeneration';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';

jest.spyOn(console, 'log').mockImplementation();

const threadId = 'child-thread';
const taskId = 'task-1';

const runStep = (id: string, index: number): SubagentContentFrame =>
  ({
    event: StepEvents.ON_RUN_STEP,
    data: {
      id,
      index,
      runId: 'sdk-run',
      stepDetails: { type: 'message_creation', message_creation: { message_id: id } },
    },
  }) as SubagentContentFrame;

const text = (id: string, value: string): SubagentContentFrame =>
  ({
    event: StepEvents.ON_MESSAGE_DELTA,
    data: { id, delta: { content: [{ type: 'text', text: value }] } },
  }) as SubagentContentFrame;

const reasoning = (id: string, value: string): SubagentContentFrame =>
  ({
    event: StepEvents.ON_REASONING_DELTA,
    data: { id, delta: { content: [{ type: 'think', think: value }] } },
  }) as SubagentContentFrame;

const final = {
  requestMessage: { messageId: `${taskId}:user`, conversationId: threadId, text: 'Do the thing' },
  responseMessage: { messageId: `${taskId}:assistant`, conversationId: threadId, text: 'Done' },
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('child generation host', () => {
  let manager: GenerationJobManagerClass;
  let onAbort: jest.Mock;

  const input = (): ChildGenerationInput => ({
    userId: 'owner',
    threadId,
    taskId,
    parentConversationId: 'parent-conversation',
    agentId: 'agent_child',
    sender: 'researcher',
    userMessage: { messageId: `${taskId}:user`, parentMessageId: 'root', text: 'Do the thing' },
    onAbort,
  });

  beforeEach(() => {
    onAbort = jest.fn();
    manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  it('opens a job keyed by the thread id and marked as a background child', async () => {
    const generation = await createChildGenerationHost(manager).open(input());

    expect(generation).not.toBeNull();
    const job = await manager.getJob(threadId);
    expect(job).toMatchObject({ status: 'running', createdAt: generation?.createdAt });
    expect(job?.metadata).toMatchObject({
      userId: 'owner',
      conversationId: threadId,
      responseMessageId: `${taskId}:assistant`,
      subagentTaskId: taskId,
      subagentParentConversationId: 'parent-conversation',
      sender: 'researcher',
      agent_id: 'agent_child',
    });
    await expect(manager.getActiveJobIdsForUser('owner')).resolves.toEqual([]);
  });

  it('streams frames in order to a subscriber, with run steps under the response id', async () => {
    const generation = await createChildGenerationHost(manager).open(input());
    const received: ServerSentEvent[] = [];
    await manager.subscribe(threadId, (event) => received.push(event));

    generation?.emit(runStep('s1', 0));
    generation?.emit(text('s1', 'Hello'));
    await flush();
    generation?.emit(text('s1', ' world'));
    await flush();

    const events = received.filter((event) => 'event' in event) as Array<{
      event: string;
      data: Record<string, unknown>;
    }>;
    expect(events.map((event) => event.event)).toEqual([
      StepEvents.ON_RUN_STEP,
      StepEvents.ON_MESSAGE_DELTA,
      StepEvents.ON_MESSAGE_DELTA,
    ]);
    expect(events[0].data.runId).toBe(`${taskId}:assistant`);
    expect(generation?.content()).toEqual([expect.objectContaining({ type: 'text' })]);
    expect(JSON.stringify(generation?.content())).toContain('Hello world');
  });

  it('gives a late subscriber the content gathered so far', async () => {
    const generation = await createChildGenerationHost(manager).open(input());
    generation?.emit(runStep('s1', 0));
    generation?.emit(text('s1', 'Before you arrived'));
    await flush();

    const state = await manager.getResumeState(threadId, generation?.createdAt);

    expect(JSON.stringify(state?.aggregatedContent)).toContain('Before you arrived');
    expect(state?.userMessage).toMatchObject({ messageId: `${taskId}:user` });
    expect(state?.responseMessageId).toBe(`${taskId}:assistant`);
  });

  it('merges deltas that queue behind a slow write and loses none of the text', async () => {
    let release: (() => void) | undefined;
    const written: ServerSentEvent[] = [];
    const slow: ChildGenerationManager = {
      createJob: manager.createJob.bind(manager),
      touchJob: manager.touchJob.bind(manager),
      setContentParts: manager.setContentParts.bind(manager),
      claimTerminalJob: manager.claimTerminalJob.bind(manager),
      publishTerminalClaim: manager.publishTerminalClaim.bind(manager),
      finishTerminalJob: manager.finishTerminalJob.bind(manager),
      emitChunk: async (_streamId, event) => {
        written.push(event);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    const generation = await createChildGenerationHost(slow).open(input());
    release?.();
    await flush();

    generation?.emit(runStep('s1', 0));
    for (const word of ['a', 'b', 'c', 'd']) generation?.emit(text('s1', word));
    release?.();
    await flush();
    release?.();
    await flush();

    const deltas = written.filter(
      (event) => 'event' in event && event.event === StepEvents.ON_MESSAGE_DELTA,
    );
    expect(deltas).toHaveLength(1);
    expect(JSON.stringify(deltas[0])).toContain('abcd');
    expect(JSON.stringify(generation?.content())).toContain('abcd');
  });

  it('publishes the final event only after the caller has persisted', async () => {
    const generation = await createChildGenerationHost(manager).open(input());
    const order: string[] = [];
    let done: ServerSentEvent | undefined;
    await manager.subscribe(
      threadId,
      () => undefined,
      (event) => {
        order.push('final');
        done = event;
      },
    );

    await generation?.settle(false, async () => {
      const job = await manager.getJob(threadId);
      order.push(`persist:${job?.status}:${job?.metadata.terminalPersistencePending}`);
      return final;
    });

    expect(order).toEqual(['persist:complete:true', 'final']);
    expect(done).toMatchObject({
      final: true,
      conversation: { conversationId: threadId },
      requestMessage: { messageId: `${taskId}:user` },
      responseMessage: { messageId: `${taskId}:assistant`, text: 'Done' },
    });
  });

  it('marks a cancelled child aborted in its final event', async () => {
    const generation = await createChildGenerationHost(manager).open(input());
    let done: ServerSentEvent | undefined;
    await manager.subscribe(
      threadId,
      () => undefined,
      (event) => {
        done = event;
      },
    );

    await generation?.settle(true, async () => final);

    expect(done).toMatchObject({ final: true, aborted: true });
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('tells a reader to refetch when persistence fails, and rethrows', async () => {
    const generation = await createChildGenerationHost(manager).open(input());
    let done: ServerSentEvent | undefined;
    await manager.subscribe(
      threadId,
      () => undefined,
      (event) => {
        done = event;
      },
    );

    await expect(
      generation?.settle(false, async () => {
        throw new Error('mongo down: secret detail');
      }),
    ).rejects.toThrow('mongo down');

    expect(done).toMatchObject({ final: true, reconcile: true });
    expect(JSON.stringify(done)).not.toContain('secret detail');
  });

  it('tells a reader to refetch when the caller had nothing to persist', async () => {
    const generation = await createChildGenerationHost(manager).open(input());
    let done: ServerSentEvent | undefined;
    await manager.subscribe(
      threadId,
      () => undefined,
      (event) => {
        done = event;
      },
    );

    await expect(generation?.settle(true, async () => null)).resolves.toBeUndefined();

    expect(done).toMatchObject({ final: true, reconcile: true });
    expect((await manager.getJob(threadId))?.status).toBe('aborted');
  });

  it('reports an abort from outside and still lets the caller persist', async () => {
    const generation = await createChildGenerationHost(manager).open(input());
    await manager.abortJob(threadId, { expectedCreatedAt: generation?.createdAt });

    expect(onAbort).toHaveBeenCalledTimes(1);
    const persist = jest.fn(async () => final);
    await expect(generation?.settle(true, persist)).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('returns null when the thread already has a live job', async () => {
    await manager.createJob(threadId, 'owner', threadId);

    await expect(createChildGenerationHost(manager).open(input())).resolves.toBeNull();
    expect((await manager.getJob(threadId))?.metadata.subagentTaskId).toBeUndefined();
  });

  it('keeps folding content after a write fails, and still persists', async () => {
    let fail = false;
    const flaky: ChildGenerationManager = {
      createJob: manager.createJob.bind(manager),
      touchJob: manager.touchJob.bind(manager),
      setContentParts: manager.setContentParts.bind(manager),
      claimTerminalJob: manager.claimTerminalJob.bind(manager),
      publishTerminalClaim: manager.publishTerminalClaim.bind(manager),
      finishTerminalJob: manager.finishTerminalJob.bind(manager),
      emitChunk: async (streamId, event, options) => {
        if (fail) throw new Error('redis unavailable');
        await manager.emitChunk(streamId, event, options);
      },
    };
    const generation = await createChildGenerationHost(flaky).open(input());
    generation?.emit(runStep('s1', 0));
    await flush();
    fail = true;
    generation?.emit(text('s1', 'kept '));
    await flush();
    generation?.emit(text('s1', 'whole'));

    expect(JSON.stringify(generation?.content())).toContain('kept whole');
    let done: ServerSentEvent | undefined;
    await manager.subscribe(
      threadId,
      () => undefined,
      (event) => {
        done = event;
      },
    );
    const persist = jest.fn(async () => final);
    await expect(generation?.settle(false, persist)).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(1);
    /** The stream stopped being written, but its job must not read as a live child. */
    expect((await manager.getJob(threadId))?.status).toBe('complete');
    expect(done).toMatchObject({ final: true, responseMessage: { text: 'Done' } });
  });

  it('keeps a detached stream alive on touch until it is settled', async () => {
    const flaky: ChildGenerationManager = {
      createJob: manager.createJob.bind(manager),
      touchJob: jest.fn(manager.touchJob.bind(manager)),
      setContentParts: manager.setContentParts.bind(manager),
      claimTerminalJob: manager.claimTerminalJob.bind(manager),
      publishTerminalClaim: manager.publishTerminalClaim.bind(manager),
      finishTerminalJob: manager.finishTerminalJob.bind(manager),
      emitChunk: async () => {
        throw new Error('redis unavailable');
      },
    };
    const generation = await createChildGenerationHost(flaky).open(input());
    await flush();

    await generation?.touch();

    expect(flaky.touchJob).toHaveBeenCalledWith(threadId, generation?.createdAt);
  });

  it('never throws into the child for a frame it cannot copy', async () => {
    const generation = await createChildGenerationHost(manager).open(input());
    const uncopyable = {
      event: StepEvents.ON_RUN_STEP_COMPLETED,
      data: { result: { id: 's1', callback: () => undefined, big: BigInt(1) } },
    } as unknown as SubagentContentFrame;

    expect(() => generation?.emit(uncopyable)).not.toThrow();
    generation?.emit(runStep('s1', 0));
    generation?.emit(text('s1', 'still folding'));

    expect(JSON.stringify(generation?.content())).toContain('still folding');
    const persist = jest.fn(async () => final);
    await expect(generation?.settle(false, persist)).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not hold the result behind a terminal claim that never answers', async () => {
    const stalled: ChildGenerationManager = {
      createJob: manager.createJob.bind(manager),
      touchJob: manager.touchJob.bind(manager),
      setContentParts: manager.setContentParts.bind(manager),
      emitChunk: manager.emitChunk.bind(manager),
      publishTerminalClaim: manager.publishTerminalClaim.bind(manager),
      finishTerminalJob: manager.finishTerminalJob.bind(manager),
      claimTerminalJob: () => new Promise(() => undefined),
    };
    const generation = await createChildGenerationHost(stalled, { settleTimeoutMs: 20 }).open(
      input(),
    );
    const persist = jest.fn(async () => final);

    await expect(generation?.settle(false, persist)).resolves.toBeUndefined();

    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('gives up on a stream that takes too long to open, and ends the job if it arrives', async () => {
    let createLate!: () => Promise<void>;
    const slow: ChildGenerationManager = {
      touchJob: manager.touchJob.bind(manager),
      setContentParts: manager.setContentParts.bind(manager),
      emitChunk: manager.emitChunk.bind(manager),
      claimTerminalJob: manager.claimTerminalJob.bind(manager),
      publishTerminalClaim: manager.publishTerminalClaim.bind(manager),
      finishTerminalJob: manager.finishTerminalJob.bind(manager),
      createJob: (...args) =>
        new Promise((resolve, reject) => {
          createLate = () => manager.createJob(...args).then(resolve, reject);
        }),
    };

    await expect(
      createChildGenerationHost(slow, { openTimeoutMs: 20 }).open(input()),
    ).resolves.toBeNull();
    expect(await manager.getJob(threadId)).toBeUndefined();

    await createLate();
    await flush();
    await flush();

    expect((await manager.getJob(threadId))?.status).toBe('aborted');
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('refreshes the idle clock on touch', async () => {
    const generation = await createChildGenerationHost(manager).open(input());
    const touch = jest.spyOn(manager, 'touchJob');

    await generation?.touch();

    expect(touch).toHaveBeenCalledWith(threadId, generation?.createdAt);
    await expect(touch.mock.results[0].value).resolves.toBe(true);
  });
});

describe('mergeDeltaFrames', () => {
  it('joins two text deltas for one step', () => {
    expect(mergeDeltaFrames(text('s1', 'ab'), text('s1', 'cd'))).toEqual(text('s1', 'abcd'));
  });

  it('joins two reasoning deltas for one step', () => {
    expect(mergeDeltaFrames(reasoning('s1', 'ab'), reasoning('s1', 'cd'))).toEqual(
      reasoning('s1', 'abcd'),
    );
  });

  it('leaves deltas for different steps or kinds apart', () => {
    expect(mergeDeltaFrames(text('s1', 'a'), text('s2', 'b'))).toBeNull();
    expect(mergeDeltaFrames(text('s1', 'a'), reasoning('s1', 'b'))).toBeNull();
    expect(mergeDeltaFrames(runStep('s1', 0), text('s1', 'b'))).toBeNull();
  });

  it('leaves a delta with any extra field apart', () => {
    const tagged = {
      event: StepEvents.ON_MESSAGE_DELTA,
      data: { id: 's1', delta: { content: [{ type: 'text', text: 'a', index: 2 }] } },
    } as unknown as SubagentContentFrame;
    const multi = {
      event: StepEvents.ON_MESSAGE_DELTA,
      data: {
        id: 's1',
        delta: {
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      },
    } as unknown as SubagentContentFrame;

    expect(mergeDeltaFrames(tagged, text('s1', 'b'))).toBeNull();
    expect(mergeDeltaFrames(text('s1', 'a'), multi)).toBeNull();
  });
});
