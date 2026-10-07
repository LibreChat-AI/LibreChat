import { EventEmitter } from 'node:events';
import { createServer, get } from 'node:http';
import type { IConversation, IMessage } from '@librechat/data-schemas';
import type { SubagentUpdateEvent } from '@librechat/agents';
import type { AddressInfo } from 'node:net';
import type { Response } from 'express';
import type { SubagentActivityEnvelope, SubagentActivityUpdateEvent } from './subagentActivity';
import type { IEventTransport } from '~/stream/interfaces/IJobStore';
import type { ServerRequest } from '~/types';
import {
  SubagentActivityStream,
  createSubagentActivityStreamHandler,
  subagentActivityStreamId,
} from './subagentActivity';

class TestTransport implements IEventTransport {
  readonly handlers = new Map<
    string,
    Map<
      number,
      {
        onChunk: (event: unknown) => void;
        onDone?: (event: unknown) => void;
        onError?: (error: string) => void;
      }
    >
  >();

  readonly emitted: Array<{ streamId: string; event: unknown }> = [];
  readonly completed: Array<{ streamId: string; event: unknown }> = [];
  readonly cleaned: string[] = [];
  readonly synchronized: string[] = [];
  readonly subscribeOptions: unknown[] = [];
  readonly closed: Array<{ streamId: string; error: string }> = [];

  demanded = true;
  subscriptionReady?: Promise<void>;
  private nextSubscriberId = 0;

  subscribe(
    streamId: string,
    handlers: {
      onChunk: (event: unknown) => void;
      onDone?: (event: unknown) => void;
      onError?: (error: string) => void;
    },
    options?: unknown,
  ) {
    this.subscribeOptions.push(options);
    const subscribers = this.handlers.get(streamId) ?? new Map();
    const subscriberId = ++this.nextSubscriberId;
    subscribers.set(subscriberId, handlers);
    this.handlers.set(streamId, subscribers);
    return {
      ...(this.subscriptionReady == null ? {} : { ready: this.subscriptionReady }),
      syncReorderBuffer: () => {
        if (this.handlers.get(streamId) !== subscribers) return;
        this.syncReorderBuffer(streamId);
      },
      unsubscribe: () => {
        subscribers.delete(subscriberId);
        if (subscribers.size === 0) this.handlers.delete(streamId);
      },
    };
  }

  syncReorderBuffer(streamId: string): void {
    this.synchronized.push(streamId);
  }

  emitChunk(streamId: string, event: unknown): void {
    this.emitted.push({ streamId, event });
    for (const handlers of this.handlers.get(streamId)?.values() ?? []) {
      handlers.onChunk(event);
    }
  }

  emitDone(streamId: string, event: unknown): void {
    this.completed.push({ streamId, event });
    for (const handlers of this.handlers.get(streamId)?.values() ?? []) {
      handlers.onDone?.(event);
    }
  }

  emitError(streamId: string, error: string): void {
    for (const handlers of this.handlers.get(streamId)?.values() ?? []) {
      handlers.onError?.(error);
    }
  }

  renewDemand(): void {
    this.demanded = true;
  }

  hasDemand(): boolean {
    return this.demanded;
  }

  getSubscriberCount(streamId: string): number {
    return this.handlers.get(streamId)?.size ?? 0;
  }

  isFirstSubscriber(streamId: string): boolean {
    return this.getSubscriberCount(streamId) === 1;
  }

  onAllSubscribersLeft(): void {}

  cleanup(streamId: string): void {
    this.cleaned.push(streamId);
    this.handlers.delete(streamId);
  }

  getTrackedStreamIds(): string[] {
    return [...this.handlers.keys()];
  }

  closeLocalSubscribers(streamId: string, error: string): void {
    this.closed.push({ streamId, error });
    const subscribers = this.handlers.get(streamId);
    if (subscribers == null) return;
    for (const handlers of [...subscribers.values()]) {
      handlers.onError?.(error);
    }
  }

  destroy(): void {
    this.handlers.clear();
  }
}

const update = (
  overrides: Partial<SubagentActivityUpdateEvent> = {},
): SubagentActivityUpdateEvent => ({
  runId: 'root-run',
  parentRunId: 'parent-run',
  subagentRunId: 'child-run',
  subagentType: 'researcher',
  subagentKind: 'agent',
  subagentAgentId: 'agent-1',
  parentToolCallId: 'tool-call',
  depth: 1,
  ancestry: [
    {
      subagentRunId: 'parent-run',
      subagentType: 'parent',
      subagentKind: 'agent',
      subagentAgentId: 'parent-agent',
      parentRunId: 'root-run',
    },
  ],
  phase: 'message_delta',
  data: { delta: 'Working.' },
  label: 'Drafting the report',
  timestamp: '2026-08-21T20:00:00.000Z',
  ...overrides,
});

describe('detached subagent activity stream', () => {
  it('uses a stable opaque stream id and forwards the existing update envelope', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);
    const received: unknown[] = [];
    const streamId = subagentActivityStreamId('child-thread', 'task-1');
    const subscription = stream.subscribe('child-thread', 'task-1', {
      onEvent: (event) => received.push(event),
    });
    await subscription.ready;

    await stream.publish(
      'child-thread',
      'task-1',
      update({ activityEventId: 'task-1:7', activitySequence: 7 }),
    );

    expect(streamId).toMatch(/^subagent-activity:[A-Za-z0-9_-]{32}$/);
    expect(transport.subscribeOptions).toEqual([
      { deferSequenceDelivery: true, captureSequenceFrontier: true },
    ]);
    expect(transport.synchronized).toEqual([streamId]);
    expect(received).toEqual([
      expect.objectContaining({
        event: 'on_subagent_update',
        data: expect.objectContaining({
          label: 'Drafting the report',
          activityEventId: 'task-1:7',
          activitySequence: 7,
        }),
      }),
    ]);
    subscription.unsubscribe();
  });

  it('omits an invalid activity sequence from the public envelope', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);

    await stream.publish(
      'child-thread',
      'task-1',
      update({ activityEventId: 'task-1:invalid', activitySequence: -1 }),
    );

    expect((transport.emitted[0]?.event as SubagentActivityEnvelope).data).not.toHaveProperty(
      'activitySequence',
    );
  });

  it('does not resynchronize when another local subscriber joins an active stream', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);
    const first = stream.subscribe('child-thread', 'task-1', { onEvent: jest.fn() });
    await first.ready;

    const second = stream.subscribe('child-thread', 'task-1', { onEvent: jest.fn() });
    await second.ready;

    expect(transport.subscribeOptions).toEqual([
      { deferSequenceDelivery: true, captureSequenceFrontier: true },
      { deferSequenceDelivery: false, captureSequenceFrontier: false },
    ]);
    expect(transport.synchronized).toEqual([subagentActivityStreamId('child-thread', 'task-1')]);
    first.unsubscribe();
    second.unsubscribe();
  });

  it('closes local activity subscribers before HTTP drain', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);
    const onError = jest.fn();
    const streamId = subagentActivityStreamId('child-thread', 'task-1');
    const subscription = stream.subscribe('child-thread', 'task-1', {
      onEvent: jest.fn(),
      onError,
    });
    await subscription.ready;

    stream.prepareForShutdown();

    expect(transport.closed).toEqual([{ streamId, error: 'Server is shutting down' }]);
    expect(onError).toHaveBeenCalledWith('Server is shutting down');
    expect(transport.getSubscriberCount(streamId)).toBe(0);
  });

  it('finishes first-attachment synchronization for a surviving second subscriber', async () => {
    const transport = new TestTransport();
    let markReady!: () => void;
    transport.subscriptionReady = new Promise<void>((resolve) => (markReady = resolve));
    const stream = new SubagentActivityStream(transport);
    const first = stream.subscribe('child-thread', 'task-1', { onEvent: jest.fn() });
    const second = stream.subscribe('child-thread', 'task-1', { onEvent: jest.fn() });

    first.unsubscribe();
    markReady();
    await Promise.all([first.ready, second.ready]);

    expect(transport.getSubscriberCount(subagentActivityStreamId('child-thread', 'task-1'))).toBe(
      1,
    );
    expect(transport.synchronized).toEqual([subagentActivityStreamId('child-thread', 'task-1')]);
    second.unsubscribe();
  });

  it('does not let a stale attachment synchronize recreated transport state', async () => {
    const transport = new TestTransport();
    let markOldReady!: () => void;
    transport.subscriptionReady = new Promise<void>((resolve) => (markOldReady = resolve));
    const stream = new SubagentActivityStream(transport);
    const stale = stream.subscribe('child-thread', 'task-1', { onEvent: jest.fn() });
    stale.unsubscribe();
    await Promise.resolve();

    transport.subscriptionReady = Promise.resolve();
    const replacement = stream.subscribe('child-thread', 'task-1', { onEvent: jest.fn() });
    await replacement.ready;
    markOldReady();
    await stale.ready;

    expect(transport.synchronized).toEqual([subagentActivityStreamId('child-thread', 'task-1')]);
    replacement.unsubscribe();
  });

  it('publishes only while a panel has renewed live-view demand', async () => {
    const transport = new TestTransport();
    transport.demanded = false;
    const stream = new SubagentActivityStream(transport);

    await stream.publish('child-thread', 'task-1', update());
    expect(transport.emitted).toHaveLength(0);

    const subscription = stream.subscribe('child-thread', 'task-1', { onEvent: jest.fn() });
    await subscription.ready;
    await stream.publish('child-thread', 'task-1', update());

    expect(transport.emitted).toHaveLength(1);
    subscription.unsubscribe();
    await Promise.resolve();
    expect(transport.cleaned).toEqual([subagentActivityStreamId('child-thread', 'task-1')]);
  });

  it('does not cache a replica-local no-demand observation', async () => {
    const transport = new TestTransport();
    transport.demanded = false;
    const stream = new SubagentActivityStream(transport);

    await stream.publish('child-thread', 'task-1', update());
    transport.demanded = true;
    await stream.publish('child-thread', 'task-1', update());

    expect(transport.emitted).toHaveLength(1);
  });

  it('evicts cached no-demand state when a task reaches terminal state', async () => {
    const transport = new TestTransport();
    transport.demanded = false;
    const stream = new SubagentActivityStream(transport);

    await stream.publish('child-thread', 'task-1', update());
    await stream.complete('child-thread', 'task-1', 'completed');
    transport.demanded = true;
    await stream.publish('child-thread', 'task-1', update());

    expect(transport.emitted).toHaveLength(1);
  });

  it('removes local demand state when renewal finishes after disconnect', async () => {
    const transport = new TestTransport();
    let markRenewing!: () => void;
    let finishRenewal!: () => void;
    const renewing = new Promise<void>((resolve) => (markRenewing = resolve));
    transport.renewDemand = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRenewal = resolve;
          markRenewing();
        }),
    );
    const stream = new SubagentActivityStream(transport);

    const subscription = stream.subscribe('child-thread', 'task-1', { onEvent: jest.fn() });
    await renewing;
    subscription.unsubscribe();
    finishRenewal();
    await subscription.ready;
    transport.demanded = false;
    await stream.publish('child-thread', 'task-1', update());

    expect(transport.emitted).toHaveLength(0);
  });

  it('drops oversized payload data while retaining lifecycle identity and bounds', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);

    await stream.publish(
      'child-thread',
      'task-1',
      update({ data: { delta: 'x'.repeat(256 * 1024) }, label: 'y'.repeat(4096) }),
    );

    const envelope = transport.emitted[0]?.event as {
      data: SubagentUpdateEvent;
    };
    expect(envelope.data.data).toBeUndefined();
    expect(envelope.data.label?.length).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('transports bounded reasoning deltas to the detached panel like other phases', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);

    await stream.publish(
      'child-thread',
      'task-1',
      update({
        phase: 'reasoning_delta',
        data: { delta: { content: [{ think: 'Visible reasoning' }] } },
      }),
    );

    expect((transport.emitted[0]?.event as SubagentActivityEnvelope).data.data).toEqual({
      delta: { content: [{ think: 'Visible reasoning' }] },
    });
  });

  it('delivers terminal state before the subscriber releases its task stream', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);
    const done: unknown[] = [];
    stream.subscribe('child-thread', 'task-1', {
      onEvent: jest.fn(),
      onDone: (event) => done.push(event),
    });

    await stream.complete('child-thread', 'task-1', 'completed');

    expect(done).toEqual([{ final: true, subagentActivity: true, status: 'completed' }]);
    expect(transport.completed).toHaveLength(1);
    expect(transport.handlers.size).toBe(0);
    await Promise.resolve();
    expect(transport.cleaned).toEqual([subagentActivityStreamId('child-thread', 'task-1')]);
  });
});

type StreamResponse = Response &
  EventEmitter & {
    chunks: string[];
    writableEnded: boolean;
  };

const response = (): StreamResponse => {
  const emitter = new EventEmitter() as StreamResponse;
  emitter.chunks = [];
  emitter.writableEnded = false;
  emitter.status = jest.fn(() => emitter);
  emitter.json = jest.fn(() => emitter);
  emitter.setHeader = jest.fn();
  emitter.flushHeaders = jest.fn();
  emitter.write = jest.fn((chunk: string) => {
    emitter.chunks.push(chunk);
    return true;
  });
  emitter.end = jest.fn(() => {
    emitter.writableEnded = true;
    return emitter;
  });
  return emitter;
};

describe('subagent activity stream authorization', () => {
  const parentConversationId = 'parent-conversation';
  const threadId = 'child-thread';
  const taskId = 'task-1';
  const parent = { tenantId: 'tenant-1' } as IConversation;
  const child = {
    tenantId: 'tenant-1',
    subagentThread: { parentConversationId },
    subagentThreadLease: {
      token: 'lease',
      taskId,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    },
  } as unknown as IConversation;
  const request = () => {
    const req = new EventEmitter() as ServerRequest & EventEmitter;
    req.params = { parentConversationId, threadId, taskId };
    req.user = { id: 'user-1', tenantId: 'tenant-1' } as ServerRequest['user'];
    return req;
  };

  it('streams only the exact active task through its owning parent', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);
    const handler = createSubagentActivityStreamHandler(
      {
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
        getMessages: jest.fn().mockResolvedValue([]),
      },
      stream,
    );
    const req = request();
    const res = response();

    await handler(req, res);
    await stream.publish(threadId, taskId, update());

    expect(res.status).not.toHaveBeenCalled();
    expect(res.chunks.join('')).toContain('"event":"on_subagent_update"');
    expect(res.chunks.join('')).toContain('Drafting the report');
    res.emit('close');
  });

  it('redacts private event-binding identity from live child activity', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);
    const handler = createSubagentActivityStreamHandler(
      {
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest.fn().mockResolvedValue({
          ...child,
          actorId: 'actor-a',
          subagentThread: {
            ...child.subagentThread,
            parentToolCallId: 'event-binding:private-binding-id',
          },
        }),
        getMessages: jest.fn().mockResolvedValue([]),
      },
      stream,
    );
    const res = response();

    await handler(request(), res);
    await stream.publish(
      threadId,
      taskId,
      update({
        parentToolCallId: 'event-binding:private-binding-id',
        ancestry: [
          {
            subagentRunId: 'parent-run',
            subagentType: 'parent',
            subagentKind: 'agent',
            subagentAgentId: 'parent-agent',
            parentRunId: 'root-run',
            parentToolCallId: 'event-binding:private-ancestor-id',
          },
        ],
      }),
    );

    const output = res.chunks.join('');
    expect(output).toContain('event-thread:child-thread');
    expect(output).not.toContain('private-binding-id');
    expect(output).not.toContain('private-ancestor-id');
    res.emit('close');
  });

  it('recognizes an ordinary persisted event assistant row as terminal', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);
    const handler = createSubagentActivityStreamHandler(
      {
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
        getMessages: jest
          .fn()
          .mockResolvedValue([{ messageId: `${taskId}:assistant`, error: false }]),
      },
      stream,
    );
    const res = response();

    await handler(request(), res);

    expect(res.chunks.join('')).toContain('"status":"completed"');
    expect(transport.handlers.size).toBe(0);
  });

  it('keeps streaming through an unfinished snapshot while the exact lease is active', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);
    const handler = createSubagentActivityStreamHandler(
      {
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
        getMessages: jest
          .fn()
          .mockResolvedValue([{ messageId: `${taskId}:assistant`, unfinished: true }]),
      },
      stream,
    );
    const res = response();

    await handler(request(), res);

    expect(res.chunks.join('')).toContain('"ready":true');
    expect(res.chunks.join('')).not.toContain('"final":true');
    expect(transport.handlers.size).toBe(1);
    res.emit('close');
  });

  it('returns the same 404 for a mismatched task without subscribing', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);
    const handler = createSubagentActivityStreamHandler(
      {
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
        getMessages: jest.fn().mockResolvedValue([]),
      },
      stream,
    );
    const req = request();
    (req.params as Record<string, string>).taskId = 'different-task';
    const res = response();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(transport.handlers.size).toBe(0);
  });

  it('does not subscribe when the client disconnects during authorization', async () => {
    let resolveParent!: (value: IConversation) => void;
    let resolveChild!: (value: IConversation) => void;
    const stream = { subscribe: jest.fn() };
    const handler = createSubagentActivityStreamHandler(
      {
        getConvoOwnership: jest.fn(
          () => new Promise<IConversation>((resolve) => (resolveParent = resolve)),
        ),
        getSubagentThreadForParent: jest.fn(
          () => new Promise<IConversation>((resolve) => (resolveChild = resolve)),
        ),
        getMessages: jest.fn().mockResolvedValue([]),
      },
      stream,
    );
    const req = request();
    const res = response();

    const pending = handler(req, res);
    res.emit('close');
    resolveParent(parent);
    resolveChild(child);
    await pending;

    expect(stream.subscribe).not.toHaveBeenCalled();
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });

  it('ends the SSE and releases its subscription when readiness fails', async () => {
    const transport = new TestTransport();
    let rejectReady!: (error: Error) => void;
    transport.subscriptionReady = new Promise<void>((_resolve, reject) => {
      rejectReady = reject;
    });
    const stream = new SubagentActivityStream(transport);
    const handler = createSubagentActivityStreamHandler(
      {
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
        getMessages: jest.fn().mockResolvedValue([]),
      },
      stream,
    );
    const res = response();
    const pending = handler(request(), res);
    while (transport.handlers.size === 0) {
      await Promise.resolve();
    }
    Object.defineProperty(res, 'headersSent', { value: true, configurable: true });

    rejectReady(new Error('Redis subscription unavailable'));
    await pending;

    expect(res.chunks.join('')).toContain('Subagent activity stream unavailable');
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(transport.handlers.size).toBe(0);
  });

  it('closes with durable terminal state when completion races stream readiness', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);
    const handler = createSubagentActivityStreamHandler(
      {
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
        getMessages: jest.fn().mockResolvedValue([
          {
            messageId: `${taskId}:assistant`,
            subagentTask: { status: 'completed' },
          } as IMessage,
        ]),
      },
      stream,
    );
    const res = response();

    await handler(request(), res);

    expect(res.chunks.join('')).toContain('"final":true');
    expect(res.chunks.join('')).toContain('"status":"completed"');
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(transport.handlers.size).toBe(0);
  });

  it('waits for drain before sending buffered activity and the terminal event', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);
    const handler = createSubagentActivityStreamHandler(
      {
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
        getMessages: jest.fn().mockResolvedValue([]),
      },
      stream,
    );
    const res = response();
    let writes = 0;
    (res.write as jest.Mock).mockImplementation((chunk: string) => {
      res.chunks.push(chunk);
      writes += 1;
      return writes === 1;
    });

    await handler(request(), res);
    await stream.publish(threadId, taskId, update());

    await stream.publish(threadId, taskId, update({ label: 'buffered' }));
    await stream.complete(threadId, taskId, 'completed');
    expect(res.end).not.toHaveBeenCalled();
    expect(res.chunks.join('')).not.toContain('buffered');
    (res.write as jest.Mock).mockImplementation((chunk: string) => {
      res.chunks.push(chunk);
      return true;
    });
    res.emit('drain');
    expect(res.chunks.join('')).toContain('buffered');
    expect(res.chunks.join('')).toContain('"status":"completed"');
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.listenerCount('drain')).toBe(0);
    expect(transport.handlers.size).toBe(0);
  });

  it('closes an over-budget blocked reader so it can recover through replay', async () => {
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);
    const handler = createSubagentActivityStreamHandler(
      {
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
        getMessages: jest.fn().mockResolvedValue([]),
      },
      stream,
    );
    const res = response();
    (res.write as jest.Mock).mockImplementation((chunk: string) => {
      res.chunks.push(chunk);
      return false;
    });
    await handler(request(), res);
    for (let index = 0; index < 110; index++) await stream.publish(threadId, taskId, update());
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.listenerCount('drain')).toBe(0);
    expect(transport.handlers.size).toBe(0);
  });

  it('writes a bounded live event whose public identity exceeds the waiting-queue budget', async () => {
    const eventThreadId = `${'\u0001'.repeat(498)}x`;
    const req = request();
    req.params = { parentConversationId, threadId: eventThreadId, taskId };
    const transport = new TestTransport();
    const stream = new SubagentActivityStream(transport);
    const handler = createSubagentActivityStreamHandler(
      {
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest.fn().mockResolvedValue({
          ...child,
          subagentThread: { ...child.subagentThread, parentToolCallId: 'event-binding:private' },
        }),
        getMessages: jest.fn().mockResolvedValue([]),
      },
      stream,
    );
    const res = response();
    await handler(req, res);
    await stream.publish(
      eventThreadId,
      taskId,
      update({ parentToolCallId: undefined, ancestry: [], data: { text: 'x'.repeat(64_000) } }),
    );
    const publicFrame = res.chunks.find((chunk) => chunk.includes('on_subagent_update'))!;
    expect(Buffer.byteLength(publicFrame)).toBeGreaterThan(65_536);
    expect(res.end).not.toHaveBeenCalled();
    expect(transport.getSubscriberCount(subagentActivityStreamId(eventThreadId, taskId))).toBe(1);
    res.emit('close');
    stream.destroy();
  });

  it.each([false, true])(
    'delivers an expanded event-thread snapshot without closing (blocked: %s)',
    async (blocked) => {
      const transport = new TestTransport();
      const stream = new SubagentActivityStream(transport);
      const eventThreadId = 'x'.repeat(499);
      const req = request();
      req.params = { parentConversationId, threadId: eventThreadId, taskId };
      const entries: SubagentActivityEnvelope[] = Array.from({ length: 100 }, (_, sequence) => ({
        event: 'on_subagent_update',
        data: update({
          parentToolCallId: undefined,
          ancestry: [],
          activitySequence: sequence,
          data: { text: 'a'.repeat(250) },
        }),
      }));
      const retainedBytes = entries.reduce(
        (total, data, seq) =>
          total + Buffer.byteLength(JSON.stringify({ type: 'chunk', seq, data })),
        0,
      );
      expect(retainedBytes).toBeLessThanOrEqual(65_536);
      const unsubscribe = jest.fn();
      const handler = createSubagentActivityStreamHandler(
        {
          getConvoOwnership: jest.fn().mockResolvedValue(parent),
          getSubagentThreadForParent: jest.fn().mockResolvedValue({
            ...child,
            subagentThread: {
              ...child.subagentThread,
              parentToolCallId: 'event-binding:private',
            },
          }),
          getMessages: jest.fn().mockResolvedValue([]),
        },
        {
          subscribe: (_thread, _task, subscriber) => ({
            unsubscribe,
            ready: Promise.resolve().then(() => {
              if (blocked)
                subscriber.onEvent({
                  event: 'on_subagent_update',
                  data: update({ label: 'before-snapshot' }),
                });
              subscriber.onEvent({ event: 'subagent_activity_replay', data: entries });
              subscriber.onEvent({
                event: 'on_subagent_update',
                data: update({ activitySequence: 100, label: 'live-tail' }),
              });
            }),
          }),
        },
      );
      const res = response();
      if (blocked)
        (res.write as jest.Mock).mockImplementationOnce((frame: string) => {
          res.chunks.push(frame);
          return false;
        });
      await handler(req, res);
      expect(res.end).not.toHaveBeenCalled();
      if (blocked) {
        expect(res.chunks.join('')).not.toContain('subagent_activity_replay');
        res.emit('drain');
      }
      const frames = res.chunks
        .filter((chunk) => chunk.startsWith('data: '))
        .map((chunk) => JSON.parse(chunk.slice(6)));
      const replay = frames.find((frame) => frame.event === 'subagent_activity_replay');
      expect(Buffer.byteLength(JSON.stringify(replay))).toBeGreaterThan(65_536);
      expect(replay.data).toHaveLength(100);
      expect(
        replay.data.map((entry: SubagentActivityEnvelope) => entry.data.activitySequence),
      ).toEqual(Array.from({ length: 100 }, (_, index) => index));
      expect(replay.data[0].data.parentToolCallId).toBe(`event-thread:${eventThreadId}`);
      expect(res.chunks.join('')).not.toContain('event-binding:');
      expect(res.chunks.join('')).toContain('live-tail');
      res.emit('close');
      expect(unsubscribe).toHaveBeenCalled();
      expect(res.listenerCount('drain')).toBe(0);
      stream.destroy();
    },
  );

  it('streams a full snapshot and concurrent buffered frames through actual HTTP backpressure', async () => {
    const unsubscribe = jest.fn();
    const activity = (sequence: number, text: string): SubagentActivityEnvelope => ({
      event: 'on_subagent_update',
      data: update({ activitySequence: sequence, data: { text } }),
    });
    const handler = createSubagentActivityStreamHandler(
      {
        getConvoOwnership: jest.fn().mockResolvedValue(parent),
        getSubagentThreadForParent: jest.fn().mockResolvedValue(child),
        getMessages: jest.fn().mockResolvedValue([]),
      },
      {
        subscribe: (_thread, _task, subscriber) => ({
          unsubscribe,
          ready: Promise.resolve().then(() => {
            subscriber.onEvent({
              event: 'subagent_activity_replay',
              data: [activity(0, 'x'.repeat(52_000))],
            });
            for (let sequence = 1; sequence <= 4; sequence++)
              subscriber.onEvent(activity(sequence, 'y'.repeat(10_000)));
            subscriber.onDone?.({ final: true, subagentActivity: true, status: 'completed' });
          }),
        }),
      },
    );
    let backpressure = 0;
    const server = createServer((req, res) => {
      const write = res.write.bind(res);
      jest.spyOn(res, 'write').mockImplementation((...args: Parameters<typeof res.write>) => {
        const accepted = write(...args);
        if (!accepted) backpressure++;
        return accepted;
      });
      Object.assign(req, { params: request().params, user: request().user });
      void handler(req as ServerRequest, res as Response).catch(() => res.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const chunks: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const client = get(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => chunks.push(chunk));
          res.on('end', resolve);
          res.on('error', reject);
        });
        client.on('error', reject);
      });
      expect(backpressure).toBeGreaterThan(0);
      const frames = chunks
        .join('')
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: '))
        .map((frame) => JSON.parse(frame.slice(6)));
      expect(frames[0].data[0].data.activitySequence).toBe(0);
      expect(frames.slice(1, 5).map((frame) => frame.data.activitySequence)).toEqual([1, 2, 3, 4]);
      expect(frames[5]).toMatchObject({ final: true, status: 'completed' });
      expect(unsubscribe).toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
