import { logger } from '@librechat/data-schemas';
import type { AbortResult } from '~/stream/interfaces/IJobStore';
import type { AgentStartupTelemetry } from '~/agents/startup';
import type { ServerSentEvent } from '~/types';
import {
  REDIS_ABORT_ACK_TIMEOUT_MS,
  REDIS_ABORT_TERMINAL_GRACE_MS,
  REDIS_EVENT_REORDER_TIMEOUT_MS,
  REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS,
} from '~/stream/internal/timing';
import {
  GenerationJobManagerClass,
  TERMINAL_PUBLICATION_RECONNECT_ERROR,
} from '~/stream/GenerationJobManager';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { registerChunkPublicationCapability } from '~/stream/internal/chunkPublication';
import { buildPendingAction, buildToolApprovalPayload } from '~/agents/hitl/policy';
import { GenerationPublicationFencedError } from '~/stream/interfaces/IJobStore';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';

function createTelemetry(): jest.Mocked<AgentStartupTelemetry> {
  return {
    mark: jest.fn(),
    setStreamId: jest.fn(),
    recordGenerationEvent: jest.fn().mockReturnValue(false),
    end: jest.fn(),
  };
}

function createManager(): GenerationJobManagerClass {
  const manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  manager.initialize();
  return manager;
}

class DeferredEventTransport extends InMemoryEventTransport {
  private pendingDeliveries: Array<() => void> = [];

  override emitChunk(streamId: string, event: unknown, generationId?: number): void {
    this.pendingDeliveries.push(() => super.emitChunk(streamId, event, generationId));
  }

  override emitDone(streamId: string, event: unknown, generationId?: number): void {
    this.pendingDeliveries.push(() => super.emitDone(streamId, event, generationId));
  }

  flushDeliveries(): void {
    const deliveries = this.pendingDeliveries;
    this.pendingDeliveries = [];
    for (const deliver of deliveries) {
      deliver();
    }
  }
}

function getEventLabel(event: ServerSentEvent): string | undefined {
  if (!('data' in event) || typeof event.data !== 'object' || event.data == null) {
    return undefined;
  }
  return typeof event.data.label === 'string' ? event.data.label : undefined;
}

function createPendingAction(streamId: string) {
  return buildPendingAction(
    buildToolApprovalPayload([
      { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call-shutdown' },
    ]),
    {
      streamId,
      conversationId: streamId,
      runId: 'run-shutdown',
      responseMessageId: 'response-shutdown',
    },
  );
}

describe('GenerationJobManager startup telemetry', () => {
  it('returns sanitized initial metadata from the atomic job creation', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const updateJob = jest.spyOn(jobStore, 'updateJob');
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();

    const job = await manager.createJob('stream-initial-metadata', 'user-1', 'conversation-1', {
      initialMetadata: {
        userId: 'untrusted-user',
        tenantId: 'untrusted-tenant',
        conversationId: 'untrusted-conversation',
        userMessage: {
          messageId: 'message-1',
          parentMessageId: 'parent-1',
        },
        responseMessageId: 'response-1',
        isRegenerate: true,
        mcpRequestBody: {
          messageId: 'response-1',
          conversationId: 'overridden-conversation',
          parentMessageId: 'response-1',
        },
        sender: 'Agent',
        endpoint: 'agents',
        iconURL: 'https://example.com/icon.png',
        model: 'test-model',
        agent_id: 'agent-1',
        isTemporary: false,
        retentionExpiresAt: '2030-01-01T00:00:00.000Z',
        promptTokens: 0,
        discoveredTools: [],
        pendingAction: {
          actionId: 'untrusted-action',
          streamId: 'stream-initial-metadata',
          conversationId: 'conversation-1',
          payload: {
            type: 'ask_user_question',
            question: { question: 'Should not be persisted?' },
          },
          createdAt: Date.now(),
        },
      },
    });

    expect(job.metadata).toMatchObject({
      userId: 'user-1',
      conversationId: 'conversation-1',
      checkpointNamespace: expect.stringMatching(/^lcg:v2:[0-9a-f]{64}:[0-9a-f-]{36}$/),
      userMessage: {
        messageId: 'message-1',
        parentMessageId: 'parent-1',
      },
      responseMessageId: 'response-1',
      isRegenerate: true,
      mcpRequestBody: {
        messageId: 'response-1',
        conversationId: 'overridden-conversation',
        parentMessageId: 'response-1',
      },
      sender: 'Agent',
      endpoint: 'agents',
      iconURL: 'https://example.com/icon.png',
      model: 'test-model',
      agent_id: 'agent-1',
      isTemporary: false,
      retentionExpiresAt: '2030-01-01T00:00:00.000Z',
      promptTokens: 0,
      discoveredTools: [],
      providerExecutionId: expect.any(String),
      providerDrained: true,
    });
    expect(job.metadata.tenantId).toBeUndefined();
    expect(job.metadata.pendingAction).toBeUndefined();
    expect(updateJob).toHaveBeenCalledTimes(1);
    expect(updateJob).toHaveBeenCalledWith(
      'stream-initial-metadata',
      { providerAbortReady: true },
      job.createdAt,
    );

    await manager.destroy();
  });

  it('retains a terminal generation until its exact provider segment has drained', async () => {
    const manager = createManager();
    const streamId = 'stream-provider-drain-retention';
    const job = await manager.createJob(streamId, 'user-1');
    const providerExecutionId = job.metadata.providerExecutionId!;
    await expect(
      manager.beginProviderExecution(streamId, job.createdAt, providerExecutionId),
    ).resolves.toBe(true);

    await expect(manager.abortJob(streamId)).resolves.toMatchObject({ success: true });
    await expect(manager.getActiveJobIdsForUser('user-1')).resolves.toEqual([]);
    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([streamId]);
    await expect(manager.getJobStore().getJob(streamId)).resolves.toMatchObject({
      status: 'aborted',
      providerExecutionId,
      providerDrained: false,
    });

    await expect(
      manager.markProviderExecutionDrained(streamId, job.createdAt, 'different-segment'),
    ).resolves.toBe(false);
    await expect(manager.getJobStore().getJob(streamId)).resolves.toMatchObject({
      providerDrained: false,
    });

    await expect(
      manager.markProviderExecutionDrained(streamId, job.createdAt, providerExecutionId),
    ).resolves.toBe(true);
    await expect(manager.getJobStore().getJob(streamId)).resolves.toBeNull();
    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([]);
    await manager.destroy();
  });

  it('keeps an undrained stale approval visible to destructive cleanup only', async () => {
    const manager = createManager();
    const streamId = 'stream-provider-drain-stale-approval';
    const job = await manager.createJob(streamId, 'user-1');
    await manager.beginProviderExecution(
      streamId,
      job.createdAt,
      job.metadata.providerExecutionId!,
    );
    await manager.getJobStore().transitionStatus(streamId, {
      from: 'running',
      to: 'requires_action',
      expectCreatedAt: job.createdAt,
    });

    await expect(manager.getActiveJobIdsForUser('user-1')).resolves.toEqual([]);
    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([streamId]);
    await manager.markProviderExecutionDrained(
      streamId,
      job.createdAt,
      job.metadata.providerExecutionId!,
    );
    await manager.destroy();
  });

  it('waits for provider-owner drain proof before destructive abort returns', async () => {
    const manager = createManager();
    const streamId = 'stream-provider-drain-wait';
    const job = await manager.createJob(streamId, 'user-1');
    await expect(
      manager.beginProviderExecution(streamId, job.createdAt, job.metadata.providerExecutionId!),
    ).resolves.toBe(true);
    let abortSettled = false;
    const aborting = manager
      .abortJob(streamId, { awaitProviderDrain: true })
      .finally(() => (abortSettled = true));

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(job.abortController.signal.aborted).toBe(true);
    expect(abortSettled).toBe(false);

    await manager.markProviderExecutionDrained(
      streamId,
      job.createdAt,
      job.metadata.providerExecutionId!,
    );
    await expect(aborting).resolves.toMatchObject({ success: true });
    expect(abortSettled).toBe(true);
    await manager.destroy();
  });

  it('waits for provider-owner drain before settling an event-driven abort', async () => {
    const manager = createManager();
    const handler = jest.fn().mockResolvedValue(undefined);
    manager.setTerminalHostActionHandler(handler);
    const streamId = 'stream-event-provider-drain-wait';
    const job = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { agentEventDeliveryKey: 'delivery-1' },
    });
    await expect(
      manager.beginProviderExecution(streamId, job.createdAt, job.metadata.providerExecutionId!),
    ).resolves.toBe(true);

    let abortSettled = false;
    const aborting = manager.abortJob(streamId).finally(() => (abortSettled = true));

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(job.abortController.signal.aborted).toBe(true);
    expect(abortSettled).toBe(false);
    expect(handler).not.toHaveBeenCalled();

    await manager.markProviderExecutionDrained(
      streamId,
      job.createdAt,
      job.metadata.providerExecutionId!,
    );
    await expect(aborting).resolves.toMatchObject({ success: true });
    expect(handler).toHaveBeenCalledWith(
      streamId,
      expect.objectContaining({ agentEventDeliveryKey: 'delivery-1', status: 'aborted' }),
      [],
      expect.any(Array),
    );
    await manager.destroy();
  });

  it('finishes a destructive abort immediately when the provider never started', async () => {
    const manager = createManager();
    const streamId = 'stream-provider-never-started';
    await manager.createJob(streamId, 'user-1');

    await expect(manager.abortJob(streamId, { awaitProviderDrain: true })).resolves.toMatchObject({
      success: true,
    });
    await expect(manager.getJobStore().getJob(streamId)).resolves.toBeNull();
    await manager.destroy();
  });

  it('rechecks provider drain when provider startup races the destructive abort', async () => {
    const manager = createManager();
    const streamId = 'stream-provider-drain-start-race';
    const job = await manager.createJob(streamId, 'user-1');
    const jobStore = manager.getJobStore();
    const transition = jobStore.transitionStatusAndDrainSteers.bind(jobStore);
    jest
      .spyOn(jobStore, 'transitionStatusAndDrainSteers')
      .mockImplementationOnce(async (...args) => {
        await expect(
          manager.beginProviderExecution(
            streamId,
            job.createdAt,
            job.metadata.providerExecutionId!,
          ),
        ).resolves.toBe(true);
        return transition(...args);
      });

    let abortSettled = false;
    const aborting = manager
      .abortJob(streamId, { awaitProviderDrain: true })
      .finally(() => (abortSettled = true));

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(job.abortController.signal.aborted).toBe(true);
    expect(abortSettled).toBe(false);

    await manager.markProviderExecutionDrained(
      streamId,
      job.createdAt,
      job.metadata.providerExecutionId!,
    );
    await expect(aborting).resolves.toMatchObject({ success: true });
    expect(abortSettled).toBe(true);
    await manager.destroy();
  });

  it('does not expose a replacement until its overwritten provider segment drains', async () => {
    const manager = createManager();
    const streamId = 'stream-provider-drain-replacement';
    const predecessor = await manager.createJob(streamId, 'user-1');
    await expect(
      manager.beginProviderExecution(
        streamId,
        predecessor.createdAt,
        predecessor.metadata.providerExecutionId!,
      ),
    ).resolves.toBe(true);
    let replacementSettled = false;
    const replacing = manager
      .createJob(streamId, 'user-1')
      .finally(() => (replacementSettled = true));

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(predecessor.abortController.signal.aborted).toBe(true);
    expect(replacementSettled).toBe(false);

    // The replacement already owns the job hash, so the predecessor can only
    // publish its exact cross-replica proof; it must not mark the new segment.
    await expect(
      manager.markProviderExecutionDrained(
        streamId,
        predecessor.createdAt,
        predecessor.metadata.providerExecutionId!,
      ),
    ).resolves.toBe(false);

    const replacement = await replacing;
    expect(replacement.createdAt).not.toBe(predecessor.createdAt);
    expect(replacementSettled).toBe(true);
    await manager.destroy();
  });

  it('clears omitted per-turn identity when an in-memory job is replaced', async () => {
    const manager = createManager();
    await manager.createJob('stream-replaced-metadata', 'user-1', 'conversation-1', {
      initialMetadata: {
        agent_id: 'agent-1',
        isTemporary: true,
        discoveredTools: ['deferred-tool'],
      },
    });

    const replacement = await manager.createJob(
      'stream-replaced-metadata',
      'user-1',
      'conversation-1',
    );

    expect(replacement.metadata.agent_id).toBeUndefined();
    expect(replacement.metadata.isTemporary).toBeUndefined();
    expect(replacement.metadata.discoveredTools).toBeUndefined();

    await manager.destroy();
  });

  it('preserves updateMetadata truthiness semantics through the shared sanitizer', async () => {
    const manager = createManager();
    await manager.createJob('stream-metadata-update', 'user-1', 'conversation-1', {
      initialMetadata: {
        sender: 'Agent',
        agent_id: 'agent-1',
        isTemporary: true,
        promptTokens: 42,
        discoveredTools: ['deferred-tool'],
      },
    });

    await manager.updateMetadata('stream-metadata-update', {
      sender: '',
      agent_id: '',
      isTemporary: false,
      promptTokens: 0,
      discoveredTools: [],
    });

    const updated = await manager.getJob('stream-metadata-update');
    expect(updated?.metadata).toMatchObject({
      sender: 'Agent',
      agent_id: 'agent-1',
      isTemporary: false,
      promptTokens: 0,
      discoveredTools: [],
    });

    await manager.destroy();
  });

  it('records accepted events centrally and detaches after the first content delta', async () => {
    const manager = createManager();
    const telemetry = createTelemetry();
    telemetry.recordGenerationEvent.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await manager.createJob('stream-1', 'user-1', 'conversation-1', {
      startupTelemetry: telemetry,
    });

    await manager.emitChunk('stream-1', {
      created: true,
      message: {
        messageId: 'message-1',
        sender: 'User',
        isCreatedByUser: true,
      },
      streamId: 'stream-1',
    });
    await manager.emitChunk('stream-1', {
      event: 'on_run_step',
      data: { id: 'step-1' },
    });
    await manager.emitChunk('stream-1', {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: 'Hello' }] } },
    });
    await manager.emitChunk('stream-1', {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: ' later token' }] } },
    });

    expect(telemetry.mark).toHaveBeenCalledWith('request_message_queued');
    expect(telemetry.recordGenerationEvent).toHaveBeenCalledTimes(2);
    expect(telemetry.recordGenerationEvent).toHaveBeenNthCalledWith(1, {
      event: 'on_run_step',
      data: { id: 'step-1' },
    });
    expect(telemetry.recordGenerationEvent).toHaveBeenNthCalledWith(2, {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: 'Hello' }] } },
    });

    await manager.destroy();
  });

  it('records a final-only response event before completion', async () => {
    const manager = createManager();
    const telemetry = createTelemetry();
    await manager.createJob('stream-2', 'user-1', 'conversation-2', {
      startupTelemetry: telemetry,
    });

    const finalEvent: ServerSentEvent = {
      final: true,
      responseMessage: {
        messageId: 'response-1',
        content: [{ type: 'text', text: 'Complete response' }],
      },
    };
    await manager.emitDone('stream-2', finalEvent);
    await manager.completeJob('stream-2');

    expect(telemetry.recordGenerationEvent).toHaveBeenCalledWith(finalEvent);
    expect(telemetry.end).toHaveBeenCalledWith('completed_without_delta');

    await manager.destroy();
  });

  it('does not record an event when delivery is rejected for an active subscriber', async () => {
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport,
      isRedis: false,
    });
    manager.initialize();
    const telemetry = createTelemetry();
    await manager.createJob('stream-3', 'user-1', 'conversation-3', {
      startupTelemetry: telemetry,
    });
    const subscription = await manager.subscribe('stream-3', () => undefined);
    registerChunkPublicationCapability(eventTransport, async () => false);

    await manager.emitChunk('stream-3', {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: 'Dropped' }] } },
    });

    expect(telemetry.recordGenerationEvent).not.toHaveBeenCalled();

    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('keeps active-only publication receipts after startup telemetry completes', async () => {
    const eventTransport = new InMemoryEventTransport();
    const emitChunk = jest.spyOn(eventTransport, 'emitChunk');
    const publishWithReceipt = jest.fn().mockResolvedValue(0);
    registerChunkPublicationCapability(eventTransport, publishWithReceipt);
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport,
      isRedis: false,
    });
    manager.initialize();
    const telemetry = createTelemetry();
    telemetry.recordGenerationEvent.mockReturnValue(true);
    const job = await manager.createJob('stream-hot-path', 'user-1', 'conversation-1', {
      startupTelemetry: telemetry,
    });
    const subscription = await manager.subscribe('stream-hot-path', () => undefined);
    const firstDelta: ServerSentEvent = {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: 'First' }] } },
    };
    const laterDelta: ServerSentEvent = {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: ' later' }] } },
    };

    await manager.emitChunk('stream-hot-path', firstDelta);
    await manager.emitChunk('stream-hot-path', laterDelta);

    expect(publishWithReceipt).toHaveBeenCalledTimes(2);
    expect(publishWithReceipt).toHaveBeenNthCalledWith(
      1,
      'stream-hot-path',
      firstDelta,
      job.createdAt,
    );
    expect(publishWithReceipt).toHaveBeenNthCalledWith(
      2,
      'stream-hot-path',
      laterDelta,
      job.createdAt,
    );
    expect(emitChunk).not.toHaveBeenCalled();

    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('does not let a later delta overtake a created event metadata write', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const originalUpdateJob = jobStore.updateJob.bind(jobStore);
    let signalCreatedWriteStarted: (() => void) | undefined;
    const createdWriteStarted = new Promise<void>((resolve) => {
      signalCreatedWriteStarted = resolve;
    });
    let releaseCreatedWrite: (() => void) | undefined;
    const createdWriteGate = new Promise<void>((resolve) => {
      releaseCreatedWrite = resolve;
    });
    jest
      .spyOn(jobStore, 'updateJob')
      .mockImplementation(async (streamId, updates, expectedCreatedAt) => {
        if (updates.createdEventEmitted === true) {
          signalCreatedWriteStarted?.();
          await createdWriteGate;
        }
        return originalUpdateJob(streamId, updates, expectedCreatedAt);
      });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();
    await manager.createJob('stream-created-order', 'user-1', 'conversation-1');

    const createdEvent: ServerSentEvent = {
      created: true,
      message: {
        messageId: 'message-1',
        conversationId: 'conversation-1',
        sender: 'User',
        isCreatedByUser: true,
      },
      streamId: 'stream-created-order',
    };
    const deltaEvent: ServerSentEvent = {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: 'Hello' }] } },
    };
    const createdPublication = manager.emitChunk('stream-created-order', createdEvent);
    await createdWriteStarted;

    let deltaSettled = false;
    const deltaPublication = manager.emitChunk('stream-created-order', deltaEvent).then(() => {
      deltaSettled = true;
    });
    await Promise.resolve();
    expect(deltaSettled).toBe(false);

    releaseCreatedWrite?.();
    await Promise.all([createdPublication, deltaPublication]);

    const received: ServerSentEvent[] = [];
    const subscription = await manager.subscribe('stream-created-order', (event) =>
      received.push(event),
    );
    expect(received).toEqual([createdEvent, deltaEvent]);

    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('ends an active startup when the manager shuts down', async () => {
    const manager = createManager();
    const telemetry = createTelemetry();
    const job = await manager.createJob('stream-4', 'user-1', 'conversation-4', {
      startupTelemetry: telemetry,
    });

    await manager.destroy();

    expect(telemetry.end).toHaveBeenCalledWith('aborted');
    expect(job.abortController.signal.aborted).toBe(true);
  });

  it('ends replaced startup telemetry before aborting the old runtime', async () => {
    const manager = createManager();
    const telemetry = createTelemetry();
    const oldJob = await manager.createJob('stream-5', 'user-1', 'conversation-5', {
      startupTelemetry: telemetry,
    });
    oldJob.abortController.signal.addEventListener('abort', () => {
      expect(telemetry.end).toHaveBeenCalledWith('replaced');
    });

    await manager.createJob('stream-5', 'user-1', 'conversation-5');

    expect(oldJob.abortController.signal.aborted).toBe(true);
    expect(telemetry.end).toHaveBeenCalledWith('replaced');
    await manager.destroy();
  });

  it('closes predecessor subscribers with a handoff event when createJob replaces the stream', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    const streamId = 'stream-active-replacement-handoff';
    const predecessor = await manager.createJob(streamId, 'user-1', streamId);
    const onDone = jest.fn();
    const subscription = await manager.subscribe(streamId, () => undefined, onDone);
    const predecessorRuntime = (
      manager as unknown as {
        runtimeState: Map<string, { subscriberLeaseTimer?: ReturnType<typeof setInterval> }>;
      }
    ).runtimeState.get(streamId)!;
    expect(predecessorRuntime.subscriberLeaseTimer).toBeDefined();

    const replacement = await manager.createJob(streamId, 'user-1', streamId);

    expect(replacement.createdAt).not.toBe(predecessor.createdAt);
    expect(onDone).toHaveBeenCalledWith({
      final: true,
      reconcile: true,
      reconcileReason: 'generation_replaced',
      generationCreatedAt: predecessor.createdAt,
      conversation: { conversationId: streamId },
    });
    expect(predecessor.abortController.signal.aborted).toBe(true);
    expect(predecessorRuntime.subscriberLeaseTimer).toBeUndefined();
    expect(replacement.abortController.signal.aborted).toBe(false);
    expect(eventTransport.getSubscriberCount(streamId)).toBe(0);
    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('notifies and stops the exact predecessor installed after the pre-create lookup', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const abortHandlers = new Set<(generationId?: number) => void>();
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn(async (_streamId: string, handler: (generationId?: number) => void) => {
        abortHandlers.add(handler);
        return () => abortHandlers.delete(handler);
      }),
      emitAbort: jest.fn((_streamId: string, generationId?: number) => {
        for (const handler of [...abortHandlers]) {
          handler(generationId);
        }
      }),
    });
    const firstManager = new GenerationJobManagerClass();
    const secondManager = new GenerationJobManagerClass();
    firstManager.configure({ jobStore, eventTransport, isRedis: false });
    secondManager.configure({ jobStore, eventTransport, isRedis: false });
    firstManager.initialize();
    secondManager.initialize();
    const streamId = 'stream-atomic-replacement-predecessor';
    await firstManager.createJob(streamId, 'user-1', streamId);

    const originalCreateJob = jobStore.createJob.bind(jobStore);
    let signalLastCreateReachedStore: (() => void) | undefined;
    const lastCreateReachedStore = new Promise<void>((resolve) => {
      signalLastCreateReachedStore = resolve;
    });
    let releaseLastCreate: (() => void) | undefined;
    const lastCreateGate = new Promise<void>((resolve) => {
      releaseLastCreate = resolve;
    });
    jest.spyOn(jobStore, 'createJob').mockImplementation(async (...args) => {
      if (args[4]?.model === 'last-creator') {
        signalLastCreateReachedStore?.();
        await lastCreateGate;
      }
      return originalCreateJob(...args);
    });

    try {
      // This manager has already pre-read the first epoch when its atomic
      // store create is gated. A second replica installs the true predecessor
      // in the gap.
      const creatingLast = firstManager.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { model: 'last-creator' },
      });
      await lastCreateReachedStore;

      const exactPredecessor = await secondManager.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { model: 'middle-creator' },
      });
      const onDone = jest.fn();
      const subscription = await secondManager.subscribe(streamId, () => undefined, onDone);

      releaseLastCreate?.();
      const replacement = await creatingLast;

      expect(replacement.createdAt).toBeGreaterThan(exactPredecessor.createdAt);
      expect(onDone).toHaveBeenCalledWith({
        final: true,
        reconcile: true,
        reconcileReason: 'generation_replaced',
        generationCreatedAt: exactPredecessor.createdAt,
        conversation: { conversationId: streamId },
      });
      expect(exactPredecessor.abortController.signal.aborted).toBe(true);
      expect(replacement.abortController.signal.aborted).toBe(false);
      subscription?.unsubscribe();
    } finally {
      releaseLastCreate?.();
      await Promise.all([firstManager.destroy(), secondManager.destroy()]);
    }
  });

  it('shares one lazy runtime across concurrent first subscriptions', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    await jobStore.createJob('stream-lazy-concurrent', 'user-1', 'conversation-1');

    const originalGetJob = jobStore.getJob.bind(jobStore);
    let lookupCount = 0;
    let signalLookupsStarted: (() => void) | undefined;
    const lookupsStarted = new Promise<void>((resolve) => {
      signalLookupsStarted = resolve;
    });
    let releaseLookups: (() => void) | undefined;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    jest.spyOn(jobStore, 'getJob').mockImplementation(async (...args) => {
      const job = await originalGetJob(...args);
      if (lookupCount < 2) {
        lookupCount++;
        if (lookupCount === 2) {
          signalLookupsStarted?.();
        }
        await lookupGate;
      }
      return job;
    });
    const allSubscribersLeftSpy = jest.spyOn(eventTransport, 'onAllSubscribersLeft');

    const firstSubscription = manager.subscribe('stream-lazy-concurrent', () => undefined);
    const secondSubscription = manager.subscribe('stream-lazy-concurrent', () => undefined);
    await lookupsStarted;
    releaseLookups?.();

    const [first, second] = await Promise.all([firstSubscription, secondSubscription]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(allSubscribersLeftSpy).toHaveBeenCalledTimes(1);
    expect(eventTransport.getSubscriberCount('stream-lazy-concurrent')).toBe(2);

    first?.unsubscribe();
    second?.unsubscribe();
    await manager.destroy();
  });

  it('does not attach a subscription to a runtime replaced during the job lookup', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    const oldJob = await manager.createJob('stream-runtime-replaced', 'user-1', 'conversation-1');

    const originalGetJob = jobStore.getJob.bind(jobStore);
    let signalLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    let releaseLookup: (() => void) | undefined;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    jest
      .spyOn(jobStore, 'getJob')
      .mockImplementation(originalGetJob)
      .mockImplementationOnce(async (...args) => {
        const job = await originalGetJob(...args);
        signalLookupStarted?.();
        await lookupGate;
        return job;
      });

    const staleSubscription = manager.subscribe('stream-runtime-replaced', () => undefined);
    await lookupStarted;
    now.mockReturnValue(2000);
    const replacementJob = await manager.createJob(
      'stream-runtime-replaced',
      'user-1',
      'conversation-1',
    );
    now.mockRestore();
    releaseLookup?.();

    await expect(staleSubscription).resolves.toBeNull();
    expect(oldJob.abortController.signal.aborted).toBe(true);
    expect(replacementJob.abortController.signal.aborted).toBe(false);
    expect(eventTransport.getSubscriberCount('stream-runtime-replaced')).toBe(0);

    const currentSubscription = await manager.subscribe('stream-runtime-replaced', () => undefined);
    expect(currentSubscription).not.toBeNull();

    currentSubscription?.unsubscribe();
    await manager.destroy();
  });

  it('fences initial and resume subscriptions to the requested generation epoch', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const manager = createManager();
    const oldJob = await manager.createJob('stream-epoch-fence', 'user-1', 'conversation-1');
    now.mockReturnValue(2000);
    const replacement = await manager.createJob('stream-epoch-fence', 'user-1', 'conversation-1');
    now.mockRestore();
    const onChunk = jest.fn();

    const initial = await manager.subscribe('stream-epoch-fence', onChunk, undefined, undefined, {
      expectedCreatedAt: oldJob.createdAt,
    });
    const resumed = await manager.subscribeWithResume(
      'stream-epoch-fence',
      onChunk,
      undefined,
      undefined,
      { expectedCreatedAt: oldJob.createdAt },
    );

    expect(replacement.createdAt).not.toBe(oldJob.createdAt);
    expect(initial).toBeNull();
    expect(resumed).toEqual({ subscription: null, resumeState: null, pendingEvents: [] });
    expect(onChunk).not.toHaveBeenCalled();

    await manager.destroy();
  });

  it('delivers only matching generation-tagged chunks after terminal cleanup before done', async () => {
    const streamId = 'stream-terminal-delayed-chunk';
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new DeferredEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    const job = await manager.createJob(streamId, 'user-1', 'conversation-1');
    const order: string[] = [];
    const subscription = await manager.subscribe(
      streamId,
      (event) => {
        const label = getEventLabel(event);
        if (label != null) {
          order.push(label);
        }
      },
      () => order.push('done'),
    );

    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { label: 'matching' },
      } as ServerSentEvent);
      eventTransport.emitChunk(streamId, { data: { label: 'untagged' } });
      eventTransport.emitChunk(streamId, { data: { label: 'mismatched' } }, job.createdAt + 1);

      await expect(manager.abortJob(streamId)).resolves.toMatchObject({ success: true });
      await manager.markProviderExecutionDrained(
        streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      );
      await expect(jobStore.getJob(streamId)).resolves.toBeNull();
      expect(order).toEqual([]);

      eventTransport.flushDeliveries();

      expect(order).toEqual(['matching', 'done']);
    } finally {
      subscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('rejects a delayed predecessor chunk after a replacement runtime is installed', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const streamId = 'stream-delayed-predecessor-chunk';
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new DeferredEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    const predecessor = await manager.createJob(streamId, 'user-1', 'conversation-1');
    const received: string[] = [];
    const subscription = await manager.subscribe(streamId, (event) => {
      const label = getEventLabel(event);
      if (label != null) {
        received.push(label);
      }
    });

    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { label: 'predecessor' },
      } as ServerSentEvent);
      now.mockReturnValue(2000);
      const replacement = await manager.createJob(streamId, 'user-1', 'conversation-1');

      expect(replacement.createdAt).toBeGreaterThan(predecessor.createdAt);
      eventTransport.flushDeliveries();

      expect(received).toEqual([]);
    } finally {
      now.mockRestore();
      subscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('lets a matching terminal drain win after a pre-signal durable fence', async () => {
    const streamId = 'stream-fenced-terminal-drain';
    const eventTransport = new InMemoryEventTransport();
    registerChunkPublicationCapability(eventTransport, async () => false);
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport,
      isRedis: false,
    });
    manager.initialize();
    const job = await manager.createJob(streamId, 'user-1', 'conversation-1');
    const onDone = jest.fn();
    const onError = jest.fn();
    const subscription = await manager.subscribe(streamId, () => undefined, onDone, onError);
    jest.useFakeTimers();

    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });

      expect(job.abortController.signal.aborted).toBe(true);
      expect(onError).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(
        REDIS_ABORT_ACK_TIMEOUT_MS + REDIS_EVENT_REORDER_TIMEOUT_MS,
      );
      expect(onError).not.toHaveBeenCalled();

      eventTransport.emitDone(streamId, { final: true }, job.createdAt);
      expect(onDone).toHaveBeenCalledWith({ final: true });

      await jest.advanceTimersByTimeAsync(REDIS_EVENT_REORDER_TIMEOUT_MS);
      expect(onError).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
    } finally {
      jest.useRealTimers();
      subscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('keeps a fenced predecessor attached while its durable handoff receipt is pending', async () => {
    const streamId = 'stream-fenced-handoff-pending';
    const clientRequestId = 'req-fenced-handoff-pending';
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    registerChunkPublicationCapability(eventTransport, async () => false);
    const owner = new GenerationJobManagerClass();
    const replacer = new GenerationJobManagerClass();
    owner.configure({ jobStore, eventTransport, isRedis: false });
    replacer.configure({ jobStore, eventTransport, isRedis: false });
    owner.initialize();
    replacer.initialize();
    const predecessor = await owner.createJob(streamId, 'user-1', 'conversation-1');
    const predecessorDone = jest.fn();
    const predecessorError = jest.fn();
    const predecessorSubscription = await owner.subscribe(
      streamId,
      () => undefined,
      predecessorDone,
      predecessorError,
    );
    const claim = await replacer.claimGeneration(
      'user-1',
      clientRequestId,
      streamId,
      'conversation-1',
      2,
    );
    const actualMarkStarted = jobStore.markIdempotencyKeyStarted.bind(jobStore);
    let signalLegacyMarkStarted: (() => void) | undefined;
    const legacyMarkStarted = new Promise<void>((resolve) => {
      signalLegacyMarkStarted = resolve;
    });
    let releaseLegacyMark: (() => void) | undefined;
    const legacyMarkGate = new Promise<void>((resolve) => {
      releaseLegacyMark = resolve;
    });
    const markStartedSpy = jest
      .spyOn(jobStore, 'markIdempotencyKeyStarted')
      .mockImplementationOnce(async (...args) => {
        signalLegacyMarkStarted?.();
        await legacyMarkGate;
        return actualMarkStarted(...args);
      });
    let creatingReplacement: ReturnType<typeof replacer.createJob> | undefined;
    jest.useFakeTimers();

    try {
      creatingReplacement = replacer.createJob(streamId, 'user-1', 'conversation-1', {
        idempotencyClientRequestId: clientRequestId,
        idempotencyClaimToken: claim.existing!.claimToken,
        initialMetadata: { generationProtocolVersion: 2 },
      });
      await legacyMarkStarted;

      await owner.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });
      expect(predecessor.abortController.signal.aborted).toBe(true);

      await jest.advanceTimersByTimeAsync(REDIS_ABORT_TERMINAL_GRACE_MS);

      expect(predecessorDone).not.toHaveBeenCalled();
      expect(predecessorError).not.toHaveBeenCalled();
      expect(eventTransport.getSubscriberCount(streamId)).toBe(1);

      releaseLegacyMark?.();
      const replacement = await creatingReplacement;

      expect(replacement.createdAt).toBeGreaterThan(predecessor.createdAt);
      expect(predecessorDone).toHaveBeenCalledWith(
        expect.objectContaining({
          final: true,
          reconcile: true,
          reconcileReason: 'generation_replaced',
          generationCreatedAt: predecessor.createdAt,
        }),
      );

      await jest.advanceTimersByTimeAsync(REDIS_ABORT_TERMINAL_GRACE_MS);
      expect(predecessorError).not.toHaveBeenCalled();
      expect(owner.getRuntimeStats()).toMatchObject({
        runtimeStateSize: 0,
        fencedRuntimeRetirements: 0,
      });

      await jest.advanceTimersByTimeAsync(REDIS_EVENT_REORDER_TIMEOUT_MS * 2);
      expect(predecessorError).not.toHaveBeenCalled();
      expect(owner.getRuntimeStats().runtimeStateSize).toBe(0);
    } finally {
      jest.useRealTimers();
      releaseLegacyMark?.();
      await creatingReplacement?.catch(() => undefined);
      markStartedSpy.mockRestore();
      predecessorSubscription?.unsubscribe();
      await Promise.all([owner.destroy(), replacer.destroy()]);
    }
  });

  it('bounds a stalled replacement lookup before recycling the fenced subscriber', async () => {
    const streamId = 'stream-fenced-handoff-lookup-stalled';
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    registerChunkPublicationCapability(eventTransport, async () => false);
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    const job = await manager.createJob(streamId, 'user-1', 'conversation-1');
    const onError = jest.fn();
    const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
    const getJobSpy = jest.spyOn(jobStore, 'getJob');
    jest.useFakeTimers();

    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });
      getJobSpy.mockImplementation(() => new Promise<null>(() => undefined));

      expect(job.abortController.signal.aborted).toBe(true);
      await jest.advanceTimersByTimeAsync(REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS);

      expect(onError).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);

      await jest.advanceTimersByTimeAsync(REDIS_EVENT_REORDER_TIMEOUT_MS * 2);

      expect(onError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
    } finally {
      jest.useRealTimers();
      getJobSpy.mockRestore();
      subscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('lets queued predecessor done drain after its successor job disappears', async () => {
    const streamId = 'stream-fenced-handoff-successor-gone';
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new DeferredEventTransport();
    registerChunkPublicationCapability(eventTransport, async () => false);
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    const predecessor = await manager.createJob(streamId, 'user-1', 'conversation-1');
    const onDone = jest.fn();
    const onError = jest.fn();
    const subscription = await manager.subscribe(streamId, () => undefined, onDone, onError);
    jest.useFakeTimers();

    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });
      await jest.advanceTimersByTimeAsync(1);
      const successor = await jobStore.createJob(
        streamId,
        'user-1',
        'conversation-1',
        undefined,
        { generationProtocolVersion: 2 },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'successor-gone-attempt',
      );
      eventTransport.emitDone(streamId, { final: true }, predecessor.createdAt);
      await jobStore.deleteJob(streamId, successor.createdAt);

      await jest.advanceTimersByTimeAsync(REDIS_ABORT_TERMINAL_GRACE_MS - 1);

      expect(onDone).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);

      eventTransport.flushDeliveries();

      expect(onDone).toHaveBeenCalledWith({ final: true });
      await jest.advanceTimersByTimeAsync(REDIS_EVENT_REORDER_TIMEOUT_MS * 2);
      expect(onError).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
    } finally {
      jest.useRealTimers();
      subscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('preserves a full terminal drain when a pending handoff settles at its deadline', async () => {
    const streamId = 'stream-fenced-handoff-deadline-drain';
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new DeferredEventTransport();
    registerChunkPublicationCapability(eventTransport, async () => false);
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    const predecessor = await manager.createJob(streamId, 'user-1', 'conversation-1');
    const onDone = jest.fn();
    const onError = jest.fn();
    const subscription = await manager.subscribe(streamId, () => undefined, onDone, onError);
    jest.useFakeTimers();

    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });
      await jest.advanceTimersByTimeAsync(1);
      const successor = await jobStore.createJob(
        streamId,
        'user-1',
        'conversation-1',
        undefined,
        { generationProtocolVersion: 2 },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'deadline-successor-attempt',
      );

      await jest.advanceTimersByTimeAsync(REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS - 2);
      eventTransport.emitDone(streamId, { final: true }, predecessor.createdAt);
      await jobStore.acknowledgeReplacedJobs?.(streamId, successor.creationAttemptId!, [
        predecessor.createdAt,
      ]);
      await jest.advanceTimersByTimeAsync(1);

      expect(onDone).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);

      eventTransport.flushDeliveries();

      expect(onDone).toHaveBeenCalledWith({ final: true });
      await jest.advanceTimersByTimeAsync(REDIS_EVENT_REORDER_TIMEOUT_MS * 2);
      expect(onError).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
    } finally {
      jest.useRealTimers();
      subscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('retires a durably fenced runtime immediately when no subscriber is attached', async () => {
    const streamId = 'stream-fenced-without-subscriber';
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      recordAbortAcknowledgement: jest.fn().mockResolvedValue(true),
    });
    registerChunkPublicationCapability(eventTransport, async () => false);
    const getJob = jest.spyOn(jobStore, 'getJob');
    const clearContentState = jest.spyOn(jobStore, 'clearContentState');
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: true });
    manager.initialize();
    const job = await manager.createJob(streamId, 'user-1', 'conversation-1');
    getJob.mockClear();
    clearContentState.mockClear();

    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });

      expect(job.abortController.signal.aborted).toBe(true);
      expect(manager.getRuntimeStats()).toMatchObject({
        runtimeStateSize: 0,
        earlyBufferedEvents: 0,
        earlyBufferedBytes: 0,
      });
      expect(clearContentState).toHaveBeenCalledWith(streamId, job.createdAt);
      expect(getJob).not.toHaveBeenCalled();
      expect(eventTransport.recordAbortAcknowledgement).toHaveBeenCalledWith(
        streamId,
        job.createdAt,
      );
    } finally {
      await manager.destroy();
    }
  });

  it('does not record abort proof for a runtime this manager does not own', async () => {
    const streamId = 'stream-fenced-non-owner';
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      recordAbortAcknowledgement: jest.fn().mockResolvedValue(true),
    });
    registerChunkPublicationCapability(eventTransport, async () => false);
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: true });
    manager.initialize();
    const durableJob = await jobStore.createJob(streamId, 'user-1', 'conversation-1');

    try {
      await expect(manager.getJob(streamId)).resolves.toBeDefined();
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });

      expect(eventTransport.recordAbortAcknowledgement).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
      await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
        createdAt: durableJob.createdAt,
        status: 'running',
      });
    } finally {
      await manager.destroy();
    }
  });

  it('cancels a fenced retirement when its last subscriber detaches', async () => {
    const streamId = 'stream-fenced-before-subscriber-detach';
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    registerChunkPublicationCapability(eventTransport, async () => false);
    const originalGetJob = jobStore.getJob.bind(jobStore);
    const getJob = jest.spyOn(jobStore, 'getJob');
    const clearContentState = jest.spyOn(jobStore, 'clearContentState');
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: true });
    jest.useFakeTimers();
    manager.initialize();
    const job = await manager.createJob(streamId, 'user-1', 'conversation-1');
    const onAllSubscribersLeft = jest.fn();
    job.emitter.on('allSubscribersLeft', onAllSubscribersLeft);
    const onError = jest.fn();
    const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
    await jest.advanceTimersByTimeAsync(0);
    getJob.mockClear();
    clearContentState.mockClear();
    let signalLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    let releaseLookup: (() => void) | undefined;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    getJob.mockImplementationOnce(async (...args) => {
      signalLookupStarted?.();
      await lookupGate;
      return originalGetJob(...args);
    });
    const timerCountBeforeFence = jest.getTimerCount();
    let detached = false;

    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });

      expect(job.abortController.signal.aborted).toBe(true);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);
      expect(jest.getTimerCount()).toBe(timerCountBeforeFence + 1);

      await jest.advanceTimersByTimeAsync(REDIS_ABORT_TERMINAL_GRACE_MS);
      await lookupStarted;

      subscription?.unsubscribe();
      detached = true;
      await jest.advanceTimersByTimeAsync(0);

      expect(manager.getRuntimeStats()).toMatchObject({
        runtimeStateSize: 0,
        earlyBufferedEvents: 0,
        earlyBufferedBytes: 0,
      });
      expect(clearContentState).toHaveBeenCalledWith(streamId, job.createdAt);
      expect(getJob).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(onAllSubscribersLeft).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(timerCountBeforeFence - 1);

      releaseLookup?.();
      await jest.advanceTimersByTimeAsync(0);

      await jest.advanceTimersByTimeAsync(
        REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS + REDIS_EVENT_REORDER_TIMEOUT_MS * 2,
      );

      expect(getJob).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(onAllSubscribersLeft).not.toHaveBeenCalled();
    } finally {
      releaseLookup?.();
      getJob.mockRestore();
      if (!detached) {
        subscription?.unsubscribe();
      }
      await manager.destroy();
      jest.useRealTimers();
    }
  });

  it.each(['manual', 'timer'] as const)(
    'does not apply a %s fenced predecessor detach to an unattached successor',
    async (detachment) => {
      const streamId = 'stream-fenced-detach-with-successor';
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
      const eventTransport = new DeferredEventTransport();
      registerChunkPublicationCapability(eventTransport, async () => false);
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore, eventTransport, isRedis: false });
      jest.useFakeTimers();
      manager.initialize();
      const predecessor = await manager.createJob(streamId, 'user-1', 'conversation-1');
      const predecessorError = jest.fn();
      const predecessorSubscription = await manager.subscribe(
        streamId,
        () => undefined,
        undefined,
        predecessorError,
      );

      try {
        await manager.emitChunk(streamId, {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
        });
        expect(predecessor.abortController.signal.aborted).toBe(true);
        expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(1);

        const successor = await manager.createJob(streamId, 'user-1', 'conversation-2');
        const successorAllSubscribersLeft = jest.fn();
        successor.emitter.on('allSubscribersLeft', successorAllSubscribersLeft);
        const updateJob = jest.spyOn(jobStore, 'updateJob');
        updateJob.mockClear();

        if (detachment === 'manual') {
          predecessorSubscription?.unsubscribe();
        } else {
          await jest.advanceTimersByTimeAsync(REDIS_ABORT_TERMINAL_GRACE_MS);
          await jest.advanceTimersByTimeAsync(REDIS_EVENT_REORDER_TIMEOUT_MS * 2);
        }
        await jest.advanceTimersByTimeAsync(0);

        expect(successor.abortController.signal.aborted).toBe(false);
        if (detachment === 'timer') {
          expect(predecessorError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
        } else {
          expect(predecessorError).not.toHaveBeenCalled();
        }
        expect(successorAllSubscribersLeft).not.toHaveBeenCalled();
        expect(updateJob).not.toHaveBeenCalled();
        expect(manager.getRuntimeStats()).toMatchObject({
          runtimeStateSize: 1,
          fencedRuntimeRetirements: 0,
        });
        await expect(manager.hasJob(streamId)).resolves.toBe(true);
      } finally {
        predecessorSubscription?.unsubscribe();
        await manager.destroy();
        jest.useRealTimers();
      }
    },
  );

  it('cancels a scheduled fenced retirement when services are reconfigured', async () => {
    const streamId = 'stream-fenced-before-reconfigure';
    const oldJobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const oldEventTransport = new InMemoryEventTransport();
    registerChunkPublicationCapability(oldEventTransport, async () => false);
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore: oldJobStore, eventTransport: oldEventTransport, isRedis: false });
    jest.useFakeTimers();
    manager.initialize();
    const oldJob = await manager.createJob(streamId, 'user-1', 'conversation-1');
    const oldError = jest.fn();
    const oldSubscription = await manager.subscribe(streamId, () => undefined, undefined, oldError);
    await jest.advanceTimersByTimeAsync(0);

    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });
      expect(oldJob.abortController.signal.aborted).toBe(true);
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(1);

      const currentJobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
      const currentEventTransport = new InMemoryEventTransport();
      const currentGetJob = jest.spyOn(currentJobStore, 'getJob');
      const currentClearContentState = jest.spyOn(currentJobStore, 'clearContentState');
      manager.configure({
        jobStore: currentJobStore,
        eventTransport: currentEventTransport,
        isRedis: false,
      });
      await manager.createJob(streamId, 'user-1', 'conversation-2');
      currentGetJob.mockClear();
      currentClearContentState.mockClear();
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(0);

      await jest.advanceTimersByTimeAsync(
        REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS + REDIS_EVENT_REORDER_TIMEOUT_MS * 2,
      );

      expect(oldError).not.toHaveBeenCalled();
      expect(currentGetJob).not.toHaveBeenCalled();
      expect(currentClearContentState).not.toHaveBeenCalled();
      await expect(manager.hasJob(streamId)).resolves.toBe(true);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);
    } finally {
      jest.useRealTimers();
      oldSubscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('cancels an in-flight fenced retirement lookup when services are reconfigured', async () => {
    const streamId = 'stream-fenced-lookup-before-reconfigure';
    const oldJobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const oldEventTransport = new InMemoryEventTransport();
    registerChunkPublicationCapability(oldEventTransport, async () => false);
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore: oldJobStore, eventTransport: oldEventTransport, isRedis: false });
    jest.useFakeTimers();
    manager.initialize();
    const oldJob = await manager.createJob(streamId, 'user-1', 'conversation-1');
    const oldError = jest.fn();
    const oldSubscription = await manager.subscribe(streamId, () => undefined, undefined, oldError);
    await jest.advanceTimersByTimeAsync(0);
    const originalGetJob = oldJobStore.getJob.bind(oldJobStore);
    let signalLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    let releaseLookup: (() => void) | undefined;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const getJobSpy = jest.spyOn(oldJobStore, 'getJob').mockImplementationOnce(async (...args) => {
      signalLookupStarted?.();
      await lookupGate;
      return originalGetJob(...args);
    });

    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });
      expect(oldJob.abortController.signal.aborted).toBe(true);
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(1);

      await jest.advanceTimersByTimeAsync(REDIS_ABORT_TERMINAL_GRACE_MS);
      await lookupStarted;

      const currentJobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
      const currentEventTransport = new InMemoryEventTransport();
      const currentGetJob = jest.spyOn(currentJobStore, 'getJob');
      const currentClearContentState = jest.spyOn(currentJobStore, 'clearContentState');
      manager.configure({
        jobStore: currentJobStore,
        eventTransport: currentEventTransport,
        isRedis: false,
      });
      await manager.createJob(streamId, 'user-1', 'conversation-2');
      currentGetJob.mockClear();
      currentClearContentState.mockClear();
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(0);
      releaseLookup?.();
      await Promise.resolve();

      await jest.advanceTimersByTimeAsync(
        REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS + REDIS_EVENT_REORDER_TIMEOUT_MS * 2,
      );

      expect(oldError).not.toHaveBeenCalled();
      expect(currentGetJob).not.toHaveBeenCalled();
      expect(currentClearContentState).not.toHaveBeenCalled();
      await expect(manager.hasJob(streamId)).resolves.toBe(true);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);
    } finally {
      releaseLookup?.();
      getJobSpy.mockRestore();
      jest.useRealTimers();
      oldSubscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('cancels fenced retirement timers when the manager is destroyed', async () => {
    const streamId = 'stream-fenced-before-destroy';
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    registerChunkPublicationCapability(eventTransport, async () => false);
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    jest.useFakeTimers();
    const timerCountBeforeInitialize = jest.getTimerCount();
    manager.initialize();
    const job = await manager.createJob(streamId, 'user-1', 'conversation-1');
    const onError = jest.fn();
    const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
    await jest.advanceTimersByTimeAsync(0);

    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });
      expect(job.abortController.signal.aborted).toBe(true);
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(1);

      await manager.destroy();
      const errorCountAfterDestroy = onError.mock.calls.length;

      expect(onError).not.toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(0);
      /** Shutdown finishes cancelling on the tick after `destroy()` resolves, so settle the
       * queue before counting. Without this the count only came back to the baseline when
       * something else — a console write from the logger — happened to yield first. */
      await jest.advanceTimersByTimeAsync(0);
      expect(jest.getTimerCount()).toBe(timerCountBeforeInitialize);

      await jest.advanceTimersByTimeAsync(
        REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS + REDIS_EVENT_REORDER_TIMEOUT_MS * 2,
      );

      expect(onError).toHaveBeenCalledTimes(errorCountAfterDestroy);
      expect(onError).not.toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(jest.getTimerCount()).toBe(timerCountBeforeInitialize);
    } finally {
      jest.useRealTimers();
      subscription?.unsubscribe();
    }
  });

  it('does not start a fenced retirement after shutdown preparation', async () => {
    const streamId = 'stream-fenced-during-shutdown';
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    let signalPublicationStarted: (() => void) | undefined;
    const publicationStarted = new Promise<void>((resolve) => {
      signalPublicationStarted = resolve;
    });
    let resolvePublication: ((published: false) => void) | undefined;
    const publicationGate = new Promise<false>((resolve) => {
      resolvePublication = resolve;
    });
    registerChunkPublicationCapability(eventTransport, async () => {
      signalPublicationStarted?.();
      return publicationGate;
    });
    const clearContentState = jest.spyOn(jobStore, 'clearContentState');
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    jest.useFakeTimers();
    manager.initialize();
    const job = await manager.createJob(streamId, 'user-1', 'conversation-1');
    const subscription = await manager.subscribe(streamId, () => undefined);
    clearContentState.mockClear();
    let emitting: Promise<void> | undefined;

    try {
      emitting = manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });
      await publicationStarted;

      manager.prepareForShutdown();
      resolvePublication?.(false);
      await emitting;

      expect(job.abortController.signal.aborted).toBe(true);
      expect(clearContentState).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);
    } finally {
      resolvePublication?.(false);
      await emitting?.catch(() => undefined);
      subscription?.unsubscribe();
      await manager.destroy();
      jest.useRealTimers();
    }
  });

  it('reconnect-closes a fenced generation when no terminal arrives within the drain window', async () => {
    const streamId = 'stream-fenced-terminal-missing';
    const eventTransport = new InMemoryEventTransport();
    registerChunkPublicationCapability(eventTransport, async () => false);
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport,
      isRedis: false,
    });
    manager.initialize();
    const job = await manager.createJob(streamId, 'user-1', 'conversation-1');
    const onError = jest.fn();
    const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
    jest.useFakeTimers();

    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });

      expect(job.abortController.signal.aborted).toBe(true);
      expect(onError).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(REDIS_ABORT_TERMINAL_GRACE_MS - 1);
      expect(onError).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(onError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
    } finally {
      jest.useRealTimers();
      subscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('reconnect-closes only the fenced predecessor after a replacement installs during grace', async () => {
    const streamId = 'stream-fenced-predecessor-replaced';
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new DeferredEventTransport();
    registerChunkPublicationCapability(eventTransport, async () => false);
    const owner = new GenerationJobManagerClass();
    const replacer = new GenerationJobManagerClass();
    owner.configure({ jobStore, eventTransport, isRedis: false });
    replacer.configure({ jobStore, eventTransport, isRedis: false });
    owner.initialize();
    replacer.initialize();
    const predecessor = await owner.createJob(streamId, 'user-1', 'conversation-1');
    const predecessorError = jest.fn();
    const predecessorSubscription = await owner.subscribe(
      streamId,
      () => undefined,
      undefined,
      predecessorError,
    );
    let replacementSubscription: Awaited<ReturnType<typeof owner.subscribe>> = null;
    jest.useFakeTimers();

    try {
      await owner.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'tail' }] } },
      });
      expect(predecessor.abortController.signal.aborted).toBe(true);

      const replacement = await replacer.createJob(streamId, 'user-1', 'conversation-1');
      const current = await owner.getJob(streamId);
      const replacementDone = jest.fn();
      const replacementError = jest.fn();
      replacementSubscription = await owner.subscribe(
        streamId,
        () => undefined,
        replacementDone,
        replacementError,
        { expectedCreatedAt: replacement.createdAt },
      );

      expect(replacement.createdAt).toBeGreaterThan(predecessor.createdAt);
      expect(current?.createdAt).toBe(replacement.createdAt);
      expect(replacementSubscription).not.toBeNull();

      await jest.advanceTimersByTimeAsync(REDIS_ABORT_TERMINAL_GRACE_MS);

      expect(predecessorError).not.toHaveBeenCalled();
      expect(replacementError).not.toHaveBeenCalled();
      expect(replacementDone).not.toHaveBeenCalled();
      expect(owner.getRuntimeStats().runtimeStateSize).toBe(1);
      expect(eventTransport.getSubscriberCount(streamId)).toBe(2);

      eventTransport.flushDeliveries();

      expect(predecessorError).not.toHaveBeenCalled();
      expect(replacementError).not.toHaveBeenCalled();
      expect(replacementDone).not.toHaveBeenCalled();
      expect(owner.getRuntimeStats().runtimeStateSize).toBe(1);
      expect(eventTransport.getSubscriberCount(streamId)).toBe(1);

      await jest.advanceTimersByTimeAsync(REDIS_EVENT_REORDER_TIMEOUT_MS * 2);

      expect(predecessorError).not.toHaveBeenCalled();
      expect(replacementError).not.toHaveBeenCalled();
      expect(replacementDone).not.toHaveBeenCalled();
      expect(owner.getRuntimeStats().runtimeStateSize).toBe(1);
      expect(eventTransport.getSubscriberCount(streamId)).toBe(1);
    } finally {
      jest.useRealTimers();
      predecessorSubscription?.unsubscribe();
      replacementSubscription?.unsubscribe();
      await Promise.all([owner.destroy(), replacer.destroy()]);
    }
  });

  it('does not return a lazy runtime replaced while its abort listener activates', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    let signalAbortRegistrationStarted: (() => void) | undefined;
    const abortRegistrationStarted = new Promise<void>((resolve) => {
      signalAbortRegistrationStarted = resolve;
    });
    let releaseAbortRegistration: (() => void) | undefined;
    const abortRegistrationGate = new Promise<void>((resolve) => {
      releaseAbortRegistration = resolve;
    });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest
        .fn()
        .mockImplementationOnce(async () => {
          signalAbortRegistrationStarted?.();
          await abortRegistrationGate;
        })
        .mockResolvedValue(undefined),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();

    try {
      await jobStore.createJob('stream-lazy-abort-race', 'user-1');
      const staleLookup = manager.getJob('stream-lazy-abort-race');
      await abortRegistrationStarted;

      now.mockReturnValue(2000);
      const replacement = await jobStore.createJob('stream-lazy-abort-race', 'user-1');
      releaseAbortRegistration?.();

      await expect(staleLookup).resolves.toBeUndefined();
      await expect(manager.getJob('stream-lazy-abort-race')).resolves.toMatchObject({
        createdAt: replacement.createdAt,
      });
      expect(eventTransport.onAbort).toHaveBeenCalledTimes(2);
    } finally {
      releaseAbortRegistration?.();
      now.mockRestore();
      await manager.destroy();
    }
  });

  it('keeps a replacement generation intact when its predecessor completes late', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();

    try {
      const predecessor = await manager.createJob('stream-late-complete', 'user-1');
      now.mockReturnValue(2000);
      const replacement = await manager.createJob('stream-late-complete', 'user-1');
      const replacementDone = jest.fn();
      const subscription = await manager.subscribe(
        'stream-late-complete',
        () => undefined,
        replacementDone,
      );
      const staleFinal: ServerSentEvent = {
        final: true,
        responseMessage: { text: 'stale' },
      };

      await manager.emitDone('stream-late-complete', staleFinal, predecessor.createdAt);
      await expect(
        manager.completeJob('stream-late-complete', undefined, predecessor.createdAt),
      ).resolves.toBe(false);

      await expect(jobStore.getJob('stream-late-complete')).resolves.toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
      });
      expect((await jobStore.getJob('stream-late-complete'))?.finalEvent).toBeUndefined();
      expect(replacement.abortController.signal.aborted).toBe(false);
      expect(replacementDone).not.toHaveBeenCalled();

      subscription?.unsubscribe();
    } finally {
      now.mockRestore();
      await manager.destroy();
    }
  });

  it('does not abort a replacement installed while an abort lookup is pending', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const abortDisposers: jest.Mock[] = [];
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn(async () => {
        const dispose = jest.fn();
        abortDisposers.push(dispose);
        return dispose;
      }),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();

    let signalLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    let releaseLookup: (() => void) | undefined;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });

    try {
      const predecessor = await manager.createJob('stream-abort-lookup-race', 'user-1');
      await jobStore.deleteJob('stream-abort-lookup-race', predecessor.createdAt);
      jest.spyOn(jobStore, 'getJob').mockImplementationOnce(async () => {
        signalLookupStarted?.();
        await lookupGate;
        return null;
      });

      const aborting = manager.abortJob('stream-abort-lookup-race');
      await lookupStarted;
      const replacement = await manager.createJob('stream-abort-lookup-race', 'user-1');
      releaseLookup?.();

      await expect(aborting).resolves.toMatchObject({ success: false, jobData: null });
      expect(replacement.abortController.signal.aborted).toBe(false);
      expect(abortDisposers).toHaveLength(2);
      expect(abortDisposers[0]).toHaveBeenCalledTimes(1);
      expect(abortDisposers[1]).not.toHaveBeenCalled();
    } finally {
      releaseLookup?.();
      await manager.destroy();
    }
  });

  it('refuses to abort a replacement when the caller pins the predecessor epoch', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const manager = createManager();
    try {
      const streamId = 'stream-abort-route-epoch-fence';
      const predecessor = await manager.createJob(streamId, 'user-1');

      now.mockReturnValue(2000);
      const replacement = await manager.createJob(streamId, 'user-1');

      await expect(
        manager.abortJob(streamId, { expectedCreatedAt: predecessor.createdAt }),
      ).resolves.toMatchObject({
        success: false,
        failureReason: 'generation_replaced',
      });
      await expect(manager.getJob(streamId)).resolves.toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
      });
      expect(replacement.abortController.signal.aborted).toBe(false);
    } finally {
      now.mockRestore();
      await manager.destroy();
    }
  });

  it('releases its exact runtime when completion loses to a terminal transition', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const abortDisposer = jest.fn();
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn(async () => abortDisposer),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    const originalTransition = jobStore.transitionStatus.bind(jobStore);
    let signalTransitionStarted: (() => void) | undefined;
    const transitionStarted = new Promise<void>((resolve) => {
      signalTransitionStarted = resolve;
    });
    let releaseTransition: (() => void) | undefined;
    const transitionGate = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });

    try {
      const job = await manager.createJob('stream-complete-cas-loss', 'user-1');
      const subscription = await manager.subscribe('stream-complete-cas-loss', () => undefined);
      jest.spyOn(jobStore, 'transitionStatus').mockImplementationOnce(async (...args) => {
        signalTransitionStarted?.();
        await transitionGate;
        return originalTransition(...args);
      });

      const completing = manager.completeJob('stream-complete-cas-loss', undefined, job.createdAt);
      await transitionStarted;
      await originalTransition('stream-complete-cas-loss', {
        from: 'running',
        to: 'error',
        expectCreatedAt: job.createdAt,
        patch: { completedAt: Date.now(), error: 'competing terminal transition' },
      });
      releaseTransition?.();
      await completing;

      expect(job.abortController.signal.aborted).toBe(true);
      expect(abortDisposer).toHaveBeenCalledTimes(1);
      expect(eventTransport.getSubscriberCount('stream-complete-cas-loss')).toBe(1);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);
      subscription?.unsubscribe();
    } finally {
      releaseTransition?.();
      await manager.destroy();
    }
  });

  it('lets abort win while completion is blocked at the terminal CAS', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      emitDone: jest.fn(),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: false });
    manager.initialize();
    const originalTransition = jobStore.transitionStatusAndDrainSteers.bind(jobStore);
    let signalCompletionAtCas: (() => void) | undefined;
    const completionAtCas = new Promise<void>((resolve) => {
      signalCompletionAtCas = resolve;
    });
    let releaseCompletionCas: (() => void) | undefined;
    const completionCasGate = new Promise<void>((resolve) => {
      releaseCompletionCas = resolve;
    });
    let gateCompletion = true;
    jest.spyOn(jobStore, 'transitionStatusAndDrainSteers').mockImplementation(async (...args) => {
      if (gateCompletion && args[1].to === 'complete') {
        gateCompletion = false;
        signalCompletionAtCas?.();
        await completionCasGate;
      }
      return originalTransition(...args);
    });

    try {
      const streamId = 'stream-abort-wins-completion-persistence-race';
      const job = await manager.createJob(streamId, 'user-1', streamId);
      const completionClaimPromise = manager.claimTerminalJob(
        streamId,
        'complete',
        undefined,
        job.createdAt,
        { persistencePending: true },
      );
      await completionAtCas;

      await expect(
        manager.abortJob(streamId, { expectedCreatedAt: job.createdAt }),
      ).resolves.toMatchObject({
        success: true,
        finalEvent: expect.objectContaining({ final: true, aborted: true }),
      });
      releaseCompletionCas?.();

      await expect(completionClaimPromise).resolves.toBeNull();
      expect(eventTransport.emitDone).toHaveBeenCalledTimes(1);
      expect(eventTransport.emitDone).toHaveBeenCalledWith(
        streamId,
        expect.objectContaining({ final: true, aborted: true }),
        job.createdAt,
      );
      await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
        createdAt: job.createdAt,
        status: 'aborted',
        terminalPersistencePending: false,
        finalEvent: expect.any(String),
      });
    } finally {
      releaseCompletionCas?.();
      await manager.destroy();
    }
  });

  it('lets completion persist and publish when abort is blocked at the terminal CAS', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      emitDone: jest.fn(),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: false });
    manager.initialize();
    const originalTransition = jobStore.transitionStatusAndDrainSteers.bind(jobStore);
    let signalAbortAtCas: (() => void) | undefined;
    const abortAtCas = new Promise<void>((resolve) => {
      signalAbortAtCas = resolve;
    });
    let releaseAbortCas: (() => void) | undefined;
    const abortCasGate = new Promise<void>((resolve) => {
      releaseAbortCas = resolve;
    });
    let gateAbort = true;
    jest.spyOn(jobStore, 'transitionStatusAndDrainSteers').mockImplementation(async (...args) => {
      if (gateAbort && args[1].to === 'aborted') {
        gateAbort = false;
        signalAbortAtCas?.();
        await abortCasGate;
      }
      return originalTransition(...args);
    });

    try {
      const streamId = 'stream-completion-wins-abort-persistence-race';
      const job = await manager.createJob(streamId, 'user-1', streamId);
      const aborting = manager.abortJob(streamId, { expectedCreatedAt: job.createdAt });
      await abortAtCas;

      const completionClaim = await manager.claimTerminalJob(
        streamId,
        'complete',
        undefined,
        job.createdAt,
        { persistencePending: true },
      );
      expect(completionClaim).not.toBeNull();
      releaseAbortCas?.();
      await expect(aborting).resolves.toMatchObject({ success: false, finalEvent: null });

      const completionFinal = {
        final: true,
        conversation: { conversationId: streamId },
        responseMessage: { messageId: 'response-completion-winner', unfinished: false },
      } as const;
      await expect(
        manager.publishTerminalClaim(completionClaim!, completionFinal),
      ).resolves.toEqual({ finalEvent: completionFinal, persistenceFailed: false });
      await manager.finishTerminalJob(completionClaim!);

      expect(eventTransport.emitDone).toHaveBeenCalledTimes(1);
      expect(eventTransport.emitDone).toHaveBeenCalledWith(
        streamId,
        completionFinal,
        job.createdAt,
      );
      await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
        createdAt: job.createdAt,
        status: 'complete',
        terminalPersistencePending: false,
        finalEvent: JSON.stringify(completionFinal),
      });
    } finally {
      releaseAbortCas?.();
      await manager.destroy();
    }
  });

  it('wakes a live subscriber and retains the durable final when DONE publication fails', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    jest.spyOn(eventTransport, 'emitDone').mockImplementation(() => {
      throw new Error('DONE transport down');
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: true });
    manager.initialize();
    const streamId = 'stream-terminal-done-publication-fails';

    try {
      const job = await manager.createJob(streamId, 'user-1', streamId);
      const onDone = jest.fn();
      const onError = jest.fn();
      await manager.subscribe(streamId, () => undefined, onDone, onError, {
        expectedCreatedAt: job.createdAt,
      });
      const claim = await manager.claimTerminalJob(streamId, 'complete', undefined, job.createdAt, {
        persistencePending: true,
      });
      expect(claim).not.toBeNull();
      const finalEvent = {
        final: true,
        conversation: { conversationId: streamId },
        responseMessage: { messageId: 'response-durable-final', unfinished: false },
      } as const;

      await expect(manager.publishTerminalClaim(claim!, finalEvent)).rejects.toThrow(
        'DONE transport down',
      );

      expect(onDone).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);

      // Even a reconnect that wins the race with finishTerminalJob must see
      // the durable final, not the process-local signal used to recycle SSE.
      jest.spyOn(eventTransport, 'emitDone').mockRestore();
      const replayDone = jest.fn();
      const replayError = jest.fn();
      await manager.subscribe(streamId, () => undefined, replayDone, replayError, {
        expectedCreatedAt: job.createdAt,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(replayDone).toHaveBeenCalledWith(finalEvent);
      expect(replayError).not.toHaveBeenCalled();

      await manager.finishTerminalJob(claim!);
      await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
        createdAt: job.createdAt,
        status: 'complete',
        terminalPersistencePending: false,
        finalEvent: JSON.stringify(finalEvent),
      });
    } finally {
      await manager.destroy();
    }
  });

  it('treats a replacement-fenced terminal publication as a superseded outcome', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    jest.spyOn(eventTransport, 'emitDone').mockImplementation((streamId, _event, generationId) => {
      throw new GenerationPublicationFencedError('done', streamId, generationId);
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: true });
    manager.initialize();
    const streamId = 'stream-terminal-done-publication-fenced';

    try {
      const job = await manager.createJob(streamId, 'user-1', streamId);
      const claim = await manager.claimTerminalJob(streamId, 'complete', undefined, job.createdAt, {
        persistencePending: true,
      });
      expect(claim).not.toBeNull();
      const finalEvent = {
        final: true,
        conversation: { conversationId: streamId },
        responseMessage: { messageId: 'response-fenced-final', unfinished: false },
      } as const;

      await expect(manager.publishTerminalClaim(claim!, finalEvent)).resolves.toEqual({
        finalEvent,
        persistenceFailed: false,
        publicationFenced: true,
      });
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();

      await manager.finishTerminalJob(claim!);

      const failedStreamId = `${streamId}-persistence-failed`;
      const failedJob = await manager.createJob(failedStreamId, 'user-1', failedStreamId);
      const failedClaim = await manager.claimTerminalJob(
        failedStreamId,
        'complete',
        undefined,
        failedJob.createdAt,
        { persistencePending: true },
      );
      expect(failedClaim).not.toBeNull();
      await expect(manager.publishTerminalClaim(failedClaim!, null)).resolves.toMatchObject({
        persistenceFailed: true,
        publicationFenced: true,
      });
      await manager.finishTerminalJob(failedClaim!);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      await manager.destroy();
    }
  });

  it('releases its exact runtime when abort loses to a terminal transition', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const abortDisposer = jest.fn();
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn(async () => abortDisposer),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    const originalTransition = jobStore.transitionStatus.bind(jobStore);
    let signalTransitionStarted: (() => void) | undefined;
    const transitionStarted = new Promise<void>((resolve) => {
      signalTransitionStarted = resolve;
    });
    let releaseTransition: (() => void) | undefined;
    const transitionGate = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });

    try {
      const job = await manager.createJob('stream-abort-cas-loss', 'user-1');
      const subscription = await manager.subscribe('stream-abort-cas-loss', () => undefined);
      jest.spyOn(jobStore, 'transitionStatus').mockImplementationOnce(async (...args) => {
        signalTransitionStarted?.();
        await transitionGate;
        return originalTransition(...args);
      });

      const aborting = manager.abortJob('stream-abort-cas-loss');
      await transitionStarted;
      await originalTransition('stream-abort-cas-loss', {
        from: 'running',
        to: 'complete',
        expectCreatedAt: job.createdAt,
        patch: { completedAt: Date.now() },
      });
      releaseTransition?.();

      await expect(aborting).resolves.toMatchObject({ success: false, finalEvent: null });
      expect(job.abortController.signal.aborted).toBe(true);
      expect(abortDisposer).toHaveBeenCalledTimes(1);
      expect(eventTransport.getSubscriberCount('stream-abort-cas-loss')).toBe(1);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);
      subscription?.unsubscribe();
    } finally {
      releaseTransition?.();
      await manager.destroy();
    }
  });

  it('does not misclassify a generation deleted during abort CAS as a replacement', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    const originalTransition = jobStore.transitionStatus.bind(jobStore);
    let signalTransitionStarted: (() => void) | undefined;
    const transitionStarted = new Promise<void>((resolve) => {
      signalTransitionStarted = resolve;
    });
    let releaseTransition: (() => void) | undefined;
    const transitionGate = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });

    try {
      const streamId = 'stream-abort-deleted-race';
      const job = await manager.createJob(streamId, 'user-1');
      jest.spyOn(jobStore, 'transitionStatus').mockImplementationOnce(async (...args) => {
        signalTransitionStarted?.();
        await transitionGate;
        return originalTransition(...args);
      });

      const aborting = manager.abortJob(streamId, { expectedCreatedAt: job.createdAt });
      await transitionStarted;
      await jobStore.deleteJob(streamId, job.createdAt);
      releaseTransition?.();

      const result = await aborting;
      expect(result).toMatchObject({ success: false, finalEvent: null });
      // Deletion is named for what it is. The point of this test is that it is NOT
      // reported as a replacement — nothing took the conversation over.
      expect(result.failureReason).toBe('job_not_found');
      expect(job.abortController.signal.aborted).toBe(true);
    } finally {
      releaseTransition?.();
      await manager.destroy();
    }
  });

  it('retries and stops a same-epoch run that resumes while abort is claiming terminal state', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    const abortDisposer = jest.fn();
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn(async () => abortDisposer),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    const originalTransition = jobStore.transitionStatus.bind(jobStore);
    let signalAbortTransitionStarted: (() => void) | undefined;
    const abortTransitionStarted = new Promise<void>((resolve) => {
      signalAbortTransitionStarted = resolve;
    });
    let releaseAbortTransition: (() => void) | undefined;
    const abortTransitionGate = new Promise<void>((resolve) => {
      releaseAbortTransition = resolve;
    });
    let gateAbortTransition = true;
    jest.spyOn(jobStore, 'transitionStatus').mockImplementation(async (...args) => {
      if (gateAbortTransition && args[1].to === 'aborted') {
        gateAbortTransition = false;
        signalAbortTransitionStarted?.();
        await abortTransitionGate;
      }
      return originalTransition(...args);
    });

    try {
      const streamId = 'stream-abort-resume-race';
      const job = await manager.createJob(streamId, 'user-1');
      const queuedSteer = {
        steerId: 'steer-survives-abort-cas-loss',
        text: 'keep this on the resumed run',
        userId: 'user-1',
        createdAt: Date.now(),
      };
      await expect(manager.steering.enqueue(streamId, queuedSteer)).resolves.toBe(1);
      const pendingAction = createPendingAction(streamId);
      await expect(manager.approvals.pause(streamId, pendingAction)).resolves.toBe(true);

      const aborting = manager.abortJob(streamId);
      await abortTransitionStarted;
      await expect(manager.approvals.resolve(streamId, pendingAction.actionId)).resolves.toBe(true);
      releaseAbortTransition?.();

      await expect(aborting).resolves.toMatchObject({
        success: true,
        finalEvent: expect.objectContaining({ aborted: true }),
      });
      expect(job.abortController.signal.aborted).toBe(true);
      expect(abortDisposer).toHaveBeenCalledTimes(1);
      await manager.markProviderExecutionDrained(
        streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      );
      await expect(jobStore.getJob(streamId)).resolves.toBeNull();
      await expect(manager.steering.peek(streamId, job.createdAt)).resolves.toEqual([]);
    } finally {
      releaseAbortTransition?.();
      if (manager.getRuntimeStats().runtimeStateSize > 0) {
        await manager.destroy();
      }
    }
  });

  it.each([
    { label: 'successful completion', error: undefined, terminalStatus: 'complete' as const },
    { label: 'error completion', error: 'boom', terminalStatus: 'error' as const },
  ])(
    'does not drain a queued steer when $label loses to a pause',
    async ({ error, terminalStatus }) => {
      const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
      jest.spyOn(jobStore, 'destroy').mockResolvedValue();
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
      });
      manager.initialize();
      const originalTransition = jobStore.transitionStatus.bind(jobStore);
      let signalCompletionTransitionStarted: (() => void) | undefined;
      const completionTransitionStarted = new Promise<void>((resolve) => {
        signalCompletionTransitionStarted = resolve;
      });
      let releaseCompletionTransition: (() => void) | undefined;
      const completionTransitionGate = new Promise<void>((resolve) => {
        releaseCompletionTransition = resolve;
      });
      jest.spyOn(jobStore, 'transitionStatus').mockImplementation(async (...args) => {
        if (args[1].to === terminalStatus) {
          signalCompletionTransitionStarted?.();
          await completionTransitionGate;
        }
        return originalTransition(...args);
      });

      try {
        const streamId = `stream-completion-pause-race-${terminalStatus}`;
        const job = await manager.createJob(streamId, 'user-1');
        const queuedSteer = {
          steerId: `steer-survives-${terminalStatus}-cas-loss`,
          text: 'keep this while paused',
          userId: 'user-1',
          createdAt: Date.now(),
        };
        await expect(manager.steering.enqueue(streamId, queuedSteer)).resolves.toBe(1);

        const completing = manager.completeJob(streamId, error, job.createdAt);
        await completionTransitionStarted;
        const pendingAction = createPendingAction(streamId);
        await expect(
          jobStore.transitionStatus(streamId, {
            from: 'running',
            to: 'requires_action',
            expectCreatedAt: job.createdAt,
            patch: {
              pendingAction,
              pendingActionId: pendingAction.actionId,
            },
          }),
        ).resolves.toBe(true);
        releaseCompletionTransition?.();
        await completing;

        await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
          createdAt: job.createdAt,
          status: 'requires_action',
        });
        await expect(manager.steering.peek(streamId, job.createdAt)).resolves.toEqual([
          queuedSteer,
        ]);
      } finally {
        releaseCompletionTransition?.();
        manager.prepareForShutdown();
        await manager.destroy();
      }
    },
  );

  it('releases ownership but keeps the abort runtime when completion observes a pause', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    const abortDisposer = jest.fn();
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn(async () => abortDisposer),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    const streamId = 'stream-complete-paused';
    const job = await manager.createJob(streamId, 'user-1');
    await jobStore.transitionStatus(streamId, {
      from: 'running',
      to: 'requires_action',
      expectCreatedAt: job.createdAt,
    });

    await manager.completeJob(streamId, undefined, job.createdAt);

    expect(job.abortController.signal.aborted).toBe(false);
    expect(abortDisposer).not.toHaveBeenCalled();
    await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
      createdAt: job.createdAt,
      status: 'requires_action',
    });

    await jobStore.transitionStatus(streamId, {
      from: 'requires_action',
      to: 'running',
      expectCreatedAt: job.createdAt,
    });
    manager.prepareForShutdown();
    await manager.destroy();
    await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
      createdAt: job.createdAt,
      status: 'running',
    });
  });

  it('releases ownership when completion observes that its durable job is missing', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    const abortDisposer = jest.fn();
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn(async () => abortDisposer),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();

    try {
      const streamId = 'stream-complete-missing';
      const job = await manager.createJob(streamId, 'user-1');
      await jobStore.deleteJob(streamId, job.createdAt);

      await manager.completeJob(streamId, undefined, job.createdAt);

      expect(job.abortController.signal.aborted).toBe(true);
      expect(abortDisposer).toHaveBeenCalledTimes(1);
      const restored = await jobStore.createJob(streamId, 'user-1');
      expect(restored.createdAt).toBeGreaterThan(job.createdAt);

      manager.prepareForShutdown();
      await manager.destroy();
      await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
        createdAt: restored.createdAt,
        status: 'running',
      });
    } finally {
      now.mockRestore();
      if (manager.getRuntimeStats().runtimeStateSize > 0) {
        await manager.destroy();
      }
    }
  });

  it('releases ownership when abort observes that its durable job is missing', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    const abortDisposer = jest.fn();
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn(async () => abortDisposer),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();

    try {
      const streamId = 'stream-abort-missing';
      const job = await manager.createJob(streamId, 'user-1');
      await jobStore.deleteJob(streamId, job.createdAt);

      await expect(manager.abortJob(streamId)).resolves.toMatchObject({
        success: false,
        jobData: null,
      });

      expect(job.abortController.signal.aborted).toBe(true);
      expect(abortDisposer).toHaveBeenCalledTimes(1);
      const restored = await jobStore.createJob(streamId, 'user-1');
      expect(restored.createdAt).toBeGreaterThan(job.createdAt);

      manager.prepareForShutdown();
      await manager.destroy();
      await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
        createdAt: restored.createdAt,
        status: 'running',
      });
    } finally {
      now.mockRestore();
      if (manager.getRuntimeStats().runtimeStateSize > 0) {
        await manager.destroy();
      }
    }
  });

  it('releases ownership when abort observes an already-terminal durable job', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    const abortDisposer = jest.fn();
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn(async () => abortDisposer),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    const streamId = 'stream-abort-terminal';
    const job = await manager.createJob(streamId, 'user-1');
    await jobStore.transitionStatus(streamId, {
      from: 'running',
      to: 'complete',
      expectCreatedAt: job.createdAt,
      patch: { completedAt: Date.now() },
    });

    await expect(manager.abortJob(streamId)).resolves.toMatchObject({
      success: false,
      jobData: expect.objectContaining({
        createdAt: job.createdAt,
        status: 'complete',
      }),
    });

    expect(job.abortController.signal.aborted).toBe(true);
    expect(abortDisposer).toHaveBeenCalledTimes(1);
    await jobStore.transitionStatus(streamId, {
      from: 'complete',
      to: 'running',
      expectCreatedAt: job.createdAt,
    });

    manager.prepareForShutdown();
    await manager.destroy();
    await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
      createdAt: job.createdAt,
      status: 'running',
    });
  });

  it('does not let a delayed predecessor metadata write contaminate a replacement', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const originalUpdateJob = jobStore.updateJob.bind(jobStore);
    let signalTitleWriteStarted: (() => void) | undefined;
    const titleWriteStarted = new Promise<void>((resolve) => {
      signalTitleWriteStarted = resolve;
    });
    let releaseTitleWrite: (() => void) | undefined;
    const titleWriteGate = new Promise<void>((resolve) => {
      releaseTitleWrite = resolve;
    });
    jest
      .spyOn(jobStore, 'updateJob')
      .mockImplementation(async (streamId, updates, expectedCreatedAt) => {
        if (updates.titleEvent) {
          signalTitleWriteStarted?.();
          await titleWriteGate;
        }
        return originalUpdateJob(streamId, updates, expectedCreatedAt);
      });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();

    try {
      await manager.createJob('stream-metadata-epoch', 'user-1');
      const emitting = manager.emitChunk('stream-metadata-epoch', {
        event: 'title',
        data: { title: 'stale title' },
      });
      await titleWriteStarted;
      now.mockReturnValue(2000);
      const replacement = await manager.createJob('stream-metadata-epoch', 'user-1');
      releaseTitleWrite?.();
      await emitting;

      await expect(jobStore.getJob('stream-metadata-epoch')).resolves.toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
      });
      expect((await jobStore.getJob('stream-metadata-epoch'))?.titleEvent).toBeUndefined();
    } finally {
      releaseTitleWrite?.();
      now.mockRestore();
      await manager.destroy();
    }
  });

  it('does not let predecessor producers repopulate replacement volatile state', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();

    try {
      const predecessor = await manager.createJob('stream-volatile-epoch', 'user-1');
      now.mockReturnValue(2000);
      const replacement = await manager.createJob('stream-volatile-epoch', 'user-1');
      const staleContent: Parameters<typeof manager.setContentParts>[1] = [
        { type: 'text', text: 'predecessor' },
      ];
      const staleGraph = {
        contentData: [{ id: 'predecessor-step' }],
      };

      manager.setContentParts('stream-volatile-epoch', staleContent, predecessor.createdAt);
      manager.setCollectedUsage(
        'stream-volatile-epoch',
        [{ input_tokens: 10 }],
        predecessor.createdAt,
      );
      manager.setGraph('stream-volatile-epoch', staleGraph as never, predecessor.createdAt);

      await expect(jobStore.getContentParts('stream-volatile-epoch')).resolves.toBeNull();
      expect(jobStore.getCollectedUsage('stream-volatile-epoch')).toEqual([]);
      await expect(jobStore.getRunSteps('stream-volatile-epoch')).resolves.toEqual([]);

      const currentContent: Parameters<typeof manager.setContentParts>[1] = [
        { type: 'text', text: 'replacement' },
      ];
      const currentGraph = {
        contentData: [{ id: 'replacement-step' }],
      };
      manager.setContentParts('stream-volatile-epoch', currentContent, replacement.createdAt);
      manager.setCollectedUsage(
        'stream-volatile-epoch',
        [{ input_tokens: 20 }],
        replacement.createdAt,
      );
      manager.setGraph('stream-volatile-epoch', currentGraph as never, replacement.createdAt);

      await expect(jobStore.getContentParts('stream-volatile-epoch')).resolves.toEqual({
        content: currentContent,
      });
      expect(jobStore.getCollectedUsage('stream-volatile-epoch')).toEqual([{ input_tokens: 20 }]);
      await expect(jobStore.getRunSteps('stream-volatile-epoch')).resolves.toEqual(
        currentGraph.contentData,
      );
    } finally {
      now.mockRestore();
      await manager.destroy();
    }
  });

  it('reconciles a stale local runtime before delivering a replacement terminal event', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: false });
    manager.initialize();

    try {
      const predecessor = await manager.createJob('stream-runtime-epoch', 'user-1');
      now.mockReturnValue(2000);
      const replacement = await jobStore.createJob('stream-runtime-epoch', 'user-1');
      const onDone = jest.fn();
      const subscription = await manager.subscribe('stream-runtime-epoch', () => undefined, onDone);
      const finalEvent: ServerSentEvent = {
        final: true,
        responseMessage: { text: 'replacement' },
      };

      eventTransport.emitDone('stream-runtime-epoch', finalEvent, replacement.createdAt);

      expect(subscription).not.toBeNull();
      expect(predecessor.abortController.signal.aborted).toBe(true);
      expect(onDone).toHaveBeenCalledWith(finalEvent);
      subscription?.unsubscribe();
    } finally {
      now.mockRestore();
      await manager.destroy();
    }
  });

  it('publishes a generation-scoped error when direct completion fails an active job', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    const job = await manager.createJob('stream-direct-error', 'user-1');
    const onError = jest.fn();
    const subscription = await manager.subscribe(
      'stream-direct-error',
      () => undefined,
      undefined,
      onError,
    );

    await manager.completeJob('stream-direct-error', 'initialization failed', job.createdAt);

    expect(onError).toHaveBeenCalledWith('initialization failed');
    await expect(jobStore.getJob('stream-direct-error')).resolves.toMatchObject({
      createdAt: job.createdAt,
      status: 'error',
      error: 'initialization failed',
    });
    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('holds terminal error publication until required persistence finishes', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    const streamId = 'stream-error-persistence-barrier';
    const job = await manager.createJob(streamId, 'user-1');
    const onError = jest.fn();
    const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
    let releasePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });

    const completing = manager.completeJob(streamId, 'initialization failed', job.createdAt, {
      beforeErrorPublication: () => persistence,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(onError).not.toHaveBeenCalled();
    await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
      status: 'error',
      error: 'initialization failed',
      terminalPersistencePending: true,
    });

    releasePersistence();
    await expect(completing).resolves.toBe(true);

    expect(onError).toHaveBeenCalledWith('initialization failed');
    await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
      status: 'error',
      error: 'initialization failed',
      terminalPersistencePending: false,
    });
    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('publishes reconciliation when required error persistence fails', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    const streamId = 'stream-error-persistence-fails';
    const job = await manager.createJob(streamId, 'user-1');
    const onDone = jest.fn();
    const onError = jest.fn();
    const subscription = await manager.subscribe(streamId, () => undefined, onDone, onError);

    await expect(
      manager.completeJob(streamId, 'initialization failed', job.createdAt, {
        beforeErrorPublication: async () => {
          throw new Error('message store unavailable');
        },
      }),
    ).resolves.toBe(true);

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        final: true,
        reconcile: true,
        terminalStatus: 'error',
      }),
    );
    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('atomically terminalizes a paused job when post-HITL persistence fails', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    const streamId = 'stream-paused-persistence-error';
    const job = await manager.createJob(streamId, 'user-1');
    const pendingAction = createPendingAction(streamId);
    await expect(manager.approvals.pause(streamId, pendingAction)).resolves.toBe(true);

    await manager.completeJob(streamId, 'paused user row unavailable', job.createdAt);

    expect(job.abortController.signal.aborted).toBe(true);
    await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
      createdAt: job.createdAt,
      status: 'error',
      error: 'paused user row unavailable',
    });
    const terminalJob = await jobStore.getJob(streamId);
    expect(terminalJob?.pendingAction).toBeUndefined();
    expect(terminalJob?.pendingActionId).toBeUndefined();
    await manager.destroy();
  });

  it('releases the claimed runtime when terminal error publication throws', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      emitError: jest.fn(async () => {
        throw new Error('transport unavailable');
      }),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    const job = await manager.createJob('stream-error-publish-fails', 'user-1');
    const onError = jest.fn();
    const subscription = await manager.subscribe(
      'stream-error-publish-fails',
      () => undefined,
      undefined,
      onError,
    );

    await expect(
      manager.completeJob('stream-error-publish-fails', 'provider failed', job.createdAt),
    ).resolves.toBe(true);

    expect(onError).toHaveBeenCalledWith('provider failed');
    expect(job.abortController.signal.aborted).toBe(true);
    await expect(jobStore.getJob('stream-error-publish-fails')).resolves.toMatchObject({
      createdAt: job.createdAt,
      status: 'error',
      error: 'provider failed',
    });
    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('does not invoke local error fallback when terminal error publication is fenced', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      emitError: jest.fn(async (streamId: string, _error: string, generationId?: number) => {
        throw new GenerationPublicationFencedError('error', streamId, generationId);
      }),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: false });
    manager.initialize();
    const streamId = 'stream-error-publish-fenced';
    const job = await manager.createJob(streamId, 'user-1');
    const onError = jest.fn();
    const subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);

    await expect(
      manager.completeJob(streamId, 'stale provider failure', job.createdAt),
    ).resolves.toBe(true);

    expect(onError).not.toHaveBeenCalled();
    expect(job.abortController.signal.aborted).toBe(true);
    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('finishes abort runtime cleanup but retains its durable final when publication throws', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      emitDone: jest.fn(async () => {
        throw new Error('done transport unavailable');
      }),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: true });
    manager.initialize();
    const job = await manager.createJob('stream-abort-publish-fails', 'user-1');

    await expect(manager.abortJob('stream-abort-publish-fails')).rejects.toThrow(
      'done transport unavailable',
    );

    expect(job.abortController.signal.aborted).toBe(true);
    await expect(jobStore.getJob('stream-abort-publish-fails')).resolves.toMatchObject({
      createdAt: job.createdAt,
      status: 'aborted',
      terminalPersistencePending: false,
      finalEvent: expect.any(String),
    });
    expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
    await manager.destroy();
  });

  it('awaits required persistence before publishing the normal abort FINAL', async () => {
    const order: string[] = [];
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      emitDone: jest.fn(() => {
        order.push('publish');
      }),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: true });
    manager.initialize();
    const streamId = 'stream-abort-persist-before-final';
    const job = await manager.createJob(streamId, 'user-1');
    const beforePublish = jest.fn(async (result: AbortResult) => {
      order.push('persist');
      const terminalJob = await jobStore.getJob(streamId);
      expect(terminalJob).toMatchObject({
        createdAt: job.createdAt,
        status: 'aborted',
        terminalPersistencePending: true,
      });
      expect(terminalJob?.finalEvent).toBeUndefined();
      expect(result).toMatchObject({ success: true, finalEvent: { final: true, aborted: true } });
    });

    const result = await manager.abortJob(streamId, {
      expectedCreatedAt: job.createdAt,
      beforePublish,
    });
    expect(result).toMatchObject({ success: true });
    expect(result.persistenceFailed).toBeUndefined();

    expect(beforePublish).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['persist', 'publish']);
    await manager.destroy();
  });

  it('holds a late subscriber until abort persistence finishes', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: true });
    manager.initialize();
    const streamId = 'stream-abort-persistence-late-subscriber';
    const job = await manager.createJob(streamId, 'user-1', streamId);
    let signalPersistenceStarted: (() => void) | undefined;
    const persistenceStarted = new Promise<void>((resolve) => {
      signalPersistenceStarted = resolve;
    });
    let releasePersistence: (() => void) | undefined;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });

    try {
      const aborting = manager.abortJob(streamId, {
        expectedCreatedAt: job.createdAt,
        beforePublish: async () => {
          signalPersistenceStarted?.();
          await persistenceGate;
        },
      });
      await persistenceStarted;

      const onDone = jest.fn();
      const subscription = await manager.subscribe(streamId, () => undefined, onDone, undefined, {
        expectedCreatedAt: job.createdAt,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(onDone).not.toHaveBeenCalled();
      await expect(manager.getJob(streamId)).resolves.toMatchObject({
        metadata: { terminalPersistencePending: true },
      });

      releasePersistence?.();
      await expect(aborting).resolves.toMatchObject({ success: true });
      expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ final: true, aborted: true }));
      subscription?.unsubscribe();
    } finally {
      releasePersistence?.();
      await manager.destroy();
    }
  });

  it('recovers a stale abort-persistence marker to conservative reconciliation', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    const streamId = 'stream-abort-persistence-owner-crashed';
    const job = await manager.createJob(streamId, 'user-1', streamId);
    await jobStore.transitionStatusAndDrainSteers(streamId, {
      from: 'running',
      to: 'aborted',
      expectCreatedAt: job.createdAt,
      patch: {
        completedAt: Date.now() - 60_000,
        terminalPersistencePending: true,
        terminalPersistenceStartedAt: Date.now() - 60_000,
      },
    });
    const onDone = jest.fn();

    const subscription = await manager.subscribe(streamId, () => undefined, onDone);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onDone).toHaveBeenCalledWith({
      final: true,
      reconcile: true,
      reconcileReason: 'abort_persistence_failed',
      terminalStatus: 'aborted',
      generationCreatedAt: job.createdAt,
      conversation: { conversationId: streamId },
    });
    await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
      terminalPersistencePending: false,
      finalEvent: expect.any(String),
    });
    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('returns the successor when stale terminal recovery publication is fenced', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: false });
    manager.initialize();
    const streamId = 'stream-terminal-recovery-replaced';
    const predecessor = await manager.createJob(streamId, 'user-1', streamId);
    const predecessorDone = jest.fn();
    const predecessorError = jest.fn();
    const predecessorSubscription = await manager.subscribe(
      streamId,
      () => undefined,
      predecessorDone,
      predecessorError,
    );
    await jobStore.transitionStatusAndDrainSteers(streamId, {
      from: 'running',
      to: 'aborted',
      expectCreatedAt: predecessor.createdAt,
      patch: {
        completedAt: Date.now() - 60_000,
        terminalPersistencePending: true,
        terminalPersistenceStartedAt: Date.now() - 60_000,
      },
    });
    const finalize = jobStore.finalizeTerminalPersistence.bind(jobStore);
    let successorCreatedAt = 0;
    jest.spyOn(jobStore, 'finalizeTerminalPersistence').mockImplementation(async (...args) => {
      const finalized = await finalize(...args);
      const successor = await jobStore.createJob(streamId, 'user-1', streamId);
      successorCreatedAt = successor.createdAt;
      await manager.getJob(streamId);
      return finalized;
    });
    jest.spyOn(eventTransport, 'emitDone').mockImplementation((_streamId, _event, generationId) => {
      throw new GenerationPublicationFencedError('done', streamId, generationId);
    });
    jest.useFakeTimers();

    try {
      const successor = await manager.getJob(streamId);
      expect(successor).toMatchObject({
        createdAt: expect.any(Number),
        status: 'running',
      });
      expect(successor?.createdAt).toBe(successorCreatedAt);
      expect(successor?.abortController.signal.aborted).toBe(false);
      expect(predecessor.abortController.signal.aborted).toBe(true);
      expect(predecessorDone).not.toHaveBeenCalled();
      expect(predecessorError).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(1);

      await jest.advanceTimersByTimeAsync(
        REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS + REDIS_EVENT_REORDER_TIMEOUT_MS * 2,
      );

      expect(predecessorDone).not.toHaveBeenCalled();
      expect(predecessorError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(successor?.abortController.signal.aborted).toBe(false);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);
    } finally {
      jest.useRealTimers();
      predecessorSubscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('reconnect-closes a predecessor that attaches during stale finalization', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: false });
    manager.initialize();
    const streamId = 'stream-terminal-recovery-late-attachment';
    const predecessor = await jobStore.createJob(streamId, 'user-1', streamId);
    await jobStore.transitionStatusAndDrainSteers(streamId, {
      from: 'running',
      to: 'aborted',
      expectCreatedAt: predecessor.createdAt,
      patch: {
        completedAt: Date.now() - 60_000,
        terminalPersistencePending: true,
        terminalPersistenceStartedAt: Date.now() - 60_000,
      },
    });
    const finalize = jobStore.finalizeTerminalPersistence.bind(jobStore);
    let finalizeEntered!: () => void;
    const finalizationStarted = new Promise<void>((resolve) => {
      finalizeEntered = resolve;
    });
    let releaseFinalize!: () => void;
    const finalizeReleased = new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    });
    let successorCreatedAt = 0;
    jest.spyOn(jobStore, 'finalizeTerminalPersistence').mockImplementation(async (...args) => {
      finalizeEntered();
      await finalizeReleased;
      const finalized = await finalize(...args);
      const successor = await jobStore.createJob(streamId, 'user-1', streamId);
      successorCreatedAt = successor.createdAt;
      return finalized;
    });
    jest.spyOn(eventTransport, 'emitDone').mockImplementation((_streamId, _event, generationId) => {
      throw new GenerationPublicationFencedError('done', streamId, generationId);
    });
    const predecessorError = jest.fn();
    const recovery = manager.getJob(streamId);
    await finalizationStarted;
    const pendingPredecessor = await jobStore.getJob(streamId);
    const lateRuntime = await (
      manager as unknown as {
        getOrCreateRuntimeState: (
          id: string,
          job: typeof pendingPredecessor,
        ) => Promise<{
          createdAt: number;
          abortController: AbortController;
          localErrorHandlers: Set<(error: string) => void>;
        } | null>;
      }
    ).getOrCreateRuntimeState(streamId, pendingPredecessor);
    lateRuntime?.localErrorHandlers.add(predecessorError);
    jest.useFakeTimers();

    try {
      expect(lateRuntime?.createdAt).toBe(predecessor.createdAt);
      releaseFinalize();
      const successor = await recovery;

      expect(successor?.createdAt).toBe(successorCreatedAt);
      expect(successor?.abortController.signal.aborted).toBe(false);
      expect(predecessorError).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(1);

      await jest.advanceTimersByTimeAsync(
        REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS + REDIS_EVENT_REORDER_TIMEOUT_MS * 2,
      );

      expect(predecessorError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(successor?.abortController.signal.aborted).toBe(false);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);
    } finally {
      releaseFinalize();
      jest.useRealTimers();
      await manager.destroy();
    }
  });

  it('reconnect-closes the predecessor when a successor wins stale finalization', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: false });
    manager.initialize();
    const streamId = 'stream-terminal-recovery-finalize-replaced';
    const predecessor = await manager.createJob(streamId, 'user-1', streamId);
    const predecessorDone = jest.fn();
    const predecessorError = jest.fn();
    const predecessorSubscription = await manager.subscribe(
      streamId,
      () => undefined,
      predecessorDone,
      predecessorError,
    );
    await jobStore.transitionStatusAndDrainSteers(streamId, {
      from: 'running',
      to: 'aborted',
      expectCreatedAt: predecessor.createdAt,
      patch: {
        completedAt: Date.now() - 60_000,
        terminalPersistencePending: true,
        terminalPersistenceStartedAt: Date.now() - 60_000,
      },
    });
    const finalize = jobStore.finalizeTerminalPersistence.bind(jobStore);
    let successorCreatedAt = 0;
    jest.spyOn(jobStore, 'finalizeTerminalPersistence').mockImplementation(async (...args) => {
      const successor = await jobStore.createJob(streamId, 'user-1', streamId);
      successorCreatedAt = successor.createdAt;
      return finalize(...args);
    });
    jest.useFakeTimers();

    try {
      const successor = await manager.getJob(streamId);
      expect(successor?.createdAt).toBe(successorCreatedAt);
      expect(successor?.abortController.signal.aborted).toBe(false);
      expect(predecessor.abortController.signal.aborted).toBe(true);
      expect(predecessorDone).not.toHaveBeenCalled();
      expect(predecessorError).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(1);

      await jest.advanceTimersByTimeAsync(
        REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS + REDIS_EVENT_REORDER_TIMEOUT_MS * 2,
      );

      expect(predecessorDone).not.toHaveBeenCalled();
      expect(predecessorError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(successor?.abortController.signal.aborted).toBe(false);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);
    } finally {
      jest.useRealTimers();
      predecessorSubscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('reconnect-closes a predecessor instead of delivering a terminal successor', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: false });
    manager.initialize();
    const streamId = 'stream-terminal-recovery-successor-error';
    const predecessor = await manager.createJob(streamId, 'user-1', streamId);
    const predecessorDone = jest.fn();
    const predecessorError = jest.fn();
    const predecessorSubscription = await manager.subscribe(
      streamId,
      () => undefined,
      predecessorDone,
      predecessorError,
    );
    await jobStore.transitionStatusAndDrainSteers(streamId, {
      from: 'running',
      to: 'aborted',
      expectCreatedAt: predecessor.createdAt,
      patch: {
        completedAt: Date.now() - 60_000,
        terminalPersistencePending: true,
        terminalPersistenceStartedAt: Date.now() - 60_000,
      },
    });
    const finalize = jobStore.finalizeTerminalPersistence.bind(jobStore);
    jest.spyOn(jobStore, 'finalizeTerminalPersistence').mockImplementation(async (...args) => {
      const finalized = await finalize(...args);
      const successor = await jobStore.createJob(streamId, 'user-1', streamId);
      await jobStore.updateJob(
        streamId,
        { status: 'error', error: 'successor provider failure', completedAt: Date.now() },
        successor.createdAt,
      );
      return finalized;
    });
    jest.spyOn(eventTransport, 'emitDone').mockImplementation((_streamId, _event, generationId) => {
      throw new GenerationPublicationFencedError('done', streamId, generationId);
    });
    jest.useFakeTimers();

    try {
      await jest.advanceTimersByTimeAsync(0);

      expect(predecessorDone).not.toHaveBeenCalled();
      expect(predecessorError).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(1);

      await jest.advanceTimersByTimeAsync(
        REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS + REDIS_EVENT_REORDER_TIMEOUT_MS * 2,
      );

      expect(predecessorError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
    } finally {
      jest.useRealTimers();
      predecessorSubscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('retires a predecessor when a local successor handoff frame is lost', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: false });
    manager.initialize();
    const streamId = 'stream-local-successor-handoff-lost';
    const predecessor = await manager.createJob(streamId, 'user-1', streamId);
    const predecessorDone = jest.fn();
    const predecessorError = jest.fn();
    jest.spyOn(eventTransport, 'emitDone').mockImplementation(() => undefined);
    jest.useFakeTimers();
    const predecessorSubscription = await manager.subscribe(
      streamId,
      () => undefined,
      predecessorDone,
      predecessorError,
    );

    try {
      const successor = await manager.createJob(streamId, 'user-1', streamId);
      await jest.advanceTimersByTimeAsync(0);

      expect(successor.createdAt).toBeGreaterThan(predecessor.createdAt);
      expect(predecessorDone).not.toHaveBeenCalled();
      expect(predecessorError).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(1);

      await jest.advanceTimersByTimeAsync(
        REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS + REDIS_EVENT_REORDER_TIMEOUT_MS * 2,
      );

      expect(predecessorError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(manager.getRuntimeStats()).toMatchObject({
        runtimeStateSize: 1,
        fencedRuntimeRetirements: 0,
      });
      await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
        createdAt: successor.createdAt,
      });
    } finally {
      jest.useRealTimers();
      predecessorSubscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('schedules predecessor retirement after a successor releases its transport hold', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    let signalHandoffStarted: (() => void) | undefined;
    const handoffStarted = new Promise<void>((resolve) => {
      signalHandoffStarted = resolve;
    });
    let releaseHandoff: (() => void) | undefined;
    const handoffGate = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    jest.spyOn(eventTransport, 'emitDone').mockImplementation(async () => {
      signalHandoffStarted?.();
      await handoffGate;
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: false });
    manager.initialize();
    const streamId = 'stream-successor-transport-hold-retirement';
    const predecessor = await manager.createJob(streamId, 'user-1', streamId);
    const predecessorError = jest.fn();
    jest.useFakeTimers();
    const predecessorSubscription = await manager.subscribe(
      streamId,
      () => undefined,
      undefined,
      predecessorError,
    );
    let creatingSuccessor: ReturnType<typeof manager.createJob> | undefined;

    try {
      creatingSuccessor = manager.createJob(streamId, 'user-1', streamId);
      await handoffStarted;
      await jest.advanceTimersByTimeAsync(0);

      expect(predecessor.abortController.signal.aborted).toBe(true);
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(0);

      releaseHandoff?.();
      const successor = await creatingSuccessor;

      expect(successor.createdAt).toBeGreaterThan(predecessor.createdAt);
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(1);

      await jest.advanceTimersByTimeAsync(
        REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS + REDIS_EVENT_REORDER_TIMEOUT_MS * 2,
      );
      expect(predecessorError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(manager.getRuntimeStats()).toMatchObject({
        runtimeStateSize: 1,
        fencedRuntimeRetirements: 0,
      });
    } finally {
      releaseHandoff?.();
      await creatingSuccessor?.catch(() => undefined);
      jest.useRealTimers();
      predecessorSubscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('retains the abort listener while stored-terminal abort proof is unavailable', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const abortHandlers = new Set<(generationId?: number) => void | boolean>();
    let signalProofStarted: (() => void) | undefined;
    const proofStarted = new Promise<void>((resolve) => {
      signalProofStarted = resolve;
    });
    let resolveProof: ((confirmed: boolean) => void) | undefined;
    const proofResult = new Promise<boolean>((resolve) => {
      resolveProof = resolve;
    });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn(async (_streamId: string, handler: (generationId?: number) => boolean) => {
        abortHandlers.add(handler);
        return () => abortHandlers.delete(handler);
      }),
      recordAbortAcknowledgement: jest.fn(async () => {
        signalProofStarted?.();
        return proofResult;
      }),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: true, cleanupOnComplete: false });
    manager.initialize();
    const streamId = 'stream-successor-discovery-abort-proof';
    const predecessor = await manager.createJob(streamId, 'user-1', streamId);
    const predecessorSubscription = await manager.subscribe(streamId, () => undefined);
    const successor = await jobStore.createJob(streamId, 'user-1', streamId);

    try {
      await proofStarted;

      expect(predecessor.abortController.signal.aborted).toBe(true);
      expect(abortHandlers).toHaveProperty('size', 1);
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(0);

      resolveProof?.(false);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(successor.createdAt).toBeGreaterThan(predecessor.createdAt);
      expect(eventTransport.recordAbortAcknowledgement).toHaveBeenCalledWith(
        streamId,
        predecessor.createdAt,
      );
      expect(abortHandlers).toHaveProperty('size', 1);
      expect([...abortHandlers][0]?.(predecessor.createdAt)).toBe(true);
      expect(manager.getRuntimeStats().fencedRuntimeRetirements).toBe(1);
    } finally {
      resolveProof?.(false);
      predecessorSubscription?.unsubscribe();
      await manager.destroy();
    }
  });

  it('closes an already-live subscriber when abort finalization storage fails', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: true,
    });
    manager.initialize();
    const streamId = 'stream-abort-finalization-store-fails';
    const job = await manager.createJob(streamId, 'user-1', streamId);
    const onDone = jest.fn();
    const subscription = await manager.subscribe(streamId, () => undefined, onDone);
    jest
      .spyOn(jobStore, 'finalizeTerminalPersistence')
      .mockRejectedValueOnce(new Error('terminal store unavailable'));

    const result = await manager.abortJob(streamId, { expectedCreatedAt: job.createdAt });

    expect(result).toMatchObject({ success: true, persistenceFailed: true });
    expect(onDone).toHaveBeenCalledWith({
      final: true,
      reconcile: true,
      reconcileReason: 'abort_persistence_failed',
      terminalStatus: 'aborted',
      generationCreatedAt: job.createdAt,
      conversation: { conversationId: streamId },
    });
    await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
      createdAt: job.createdAt,
      terminalPersistencePending: true,
    });
    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('publishes reconciliation instead of a normal abort FINAL when required persistence fails', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      emitDone: jest.fn(),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false, cleanupOnComplete: true });
    manager.initialize();
    const streamId = 'stream-abort-persistence-fails';
    const job = await manager.createJob(streamId, 'user-1', streamId);

    await expect(
      manager.abortJob(streamId, {
        expectedCreatedAt: job.createdAt,
        beforePublish: async () => {
          throw new Error('partial response save failed');
        },
      }),
    ).resolves.toMatchObject({
      success: true,
      persistenceFailed: true,
      finalEvent: {
        final: true,
        reconcile: true,
        reconcileReason: 'abort_persistence_failed',
        terminalStatus: 'aborted',
        generationCreatedAt: job.createdAt,
      },
    });

    expect(eventTransport.emitDone).toHaveBeenCalledWith(
      streamId,
      expect.objectContaining({
        final: true,
        reconcile: true,
        reconcileReason: 'abort_persistence_failed',
      }),
      job.createdAt,
    );
    expect(eventTransport.emitDone).not.toHaveBeenCalledWith(
      streamId,
      expect.objectContaining({ aborted: true }),
      job.createdAt,
    );
    await manager.markProviderExecutionDrained(
      streamId,
      job.createdAt,
      job.metadata.providerExecutionId!,
    );
    await expect(jobStore.getJob(streamId)).resolves.toBeNull();
    expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
    await manager.destroy();
  });

  it('a delayed terminal finish cannot clean up a same-stream replacement runtime', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: true,
    });
    manager.initialize();

    try {
      const predecessor = await manager.createJob('stream-delayed-finish', 'user-1');
      const claim = await manager.claimTerminalJob(
        'stream-delayed-finish',
        'complete',
        undefined,
        predecessor.createdAt,
      );
      expect(claim).not.toBeNull();

      now.mockReturnValue(2000);
      const replacement = await manager.createJob('stream-delayed-finish', 'user-1');
      await manager.finishTerminalJob(claim!);

      expect(replacement.abortController.signal.aborted).toBe(false);
      await expect(jobStore.getJob('stream-delayed-finish')).resolves.toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
      });
    } finally {
      now.mockRestore();
      await manager.destroy();
    }
  });

  it('closes a late subscriber with a reconcile event when terminal payload publication was lost', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    const streamId = 'stream-terminal-payload-lost';
    const job = await manager.createJob(streamId, 'user-1', streamId);
    const claim = await manager.claimTerminalJob(streamId, 'complete', undefined, job.createdAt);
    expect(claim).not.toBeNull();
    const onDone = jest.fn();

    const subscription = await manager.subscribe(streamId, () => undefined, onDone);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();

    expect(onDone).toHaveBeenCalledWith({
      final: true,
      reconcile: true,
      reconcileReason: 'terminal_payload_missing',
      terminalStatus: 'complete',
      generationCreatedAt: job.createdAt,
      conversation: { conversationId: streamId },
    });
    expect(subscription).not.toBeNull();
    expect(eventTransport.getSubscriberCount(streamId)).toBe(0);
    await manager.finishTerminalJob(claim!);
    await manager.destroy();
  });

  it('finalizes the exact durable job when abort-listener setup fails before createJob returns', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn().mockRejectedValue(new Error('abort listener unavailable')),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();

    await expect(manager.createJob('stream-partial-create', 'user-1')).rejects.toThrow(
      'abort listener unavailable',
    );
    await expect(jobStore.getJob('stream-partial-create')).resolves.toMatchObject({
      status: 'error',
      error: 'abort listener unavailable',
    });

    await manager.destroy();
  });

  it('does not return a job replaced while its abort listener activates', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    let signalAbortRegistrationStarted: (() => void) | undefined;
    const abortRegistrationStarted = new Promise<void>((resolve) => {
      signalAbortRegistrationStarted = resolve;
    });
    let releaseAbortRegistration: (() => void) | undefined;
    const abortRegistrationGate = new Promise<void>((resolve) => {
      releaseAbortRegistration = resolve;
    });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest
        .fn()
        .mockImplementationOnce(async () => {
          signalAbortRegistrationStarted?.();
          await abortRegistrationGate;
        })
        .mockResolvedValue(undefined),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();

    try {
      const predecessorCreation = manager.createJob('stream-create-replaced', 'user-1');
      await abortRegistrationStarted;
      const replacement = await manager.createJob('stream-create-replaced', 'user-1');
      releaseAbortRegistration?.();

      await expect(predecessorCreation).rejects.toThrow(
        'Generation job was replaced during initialization',
      );
      await expect(jobStore.getJob('stream-create-replaced')).resolves.toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
      });
      expect(replacement.abortController.signal.aborted).toBe(false);
    } finally {
      releaseAbortRegistration?.();
      await manager.destroy();
    }
  });

  it('rechecks durable ownership after its abort listener activates', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    let signalAbortRegistrationStarted: (() => void) | undefined;
    const abortRegistrationStarted = new Promise<void>((resolve) => {
      signalAbortRegistrationStarted = resolve;
    });
    let releaseAbortRegistration: (() => void) | undefined;
    const abortRegistrationGate = new Promise<void>((resolve) => {
      releaseAbortRegistration = resolve;
    });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn(async () => {
        signalAbortRegistrationStarted?.();
        await abortRegistrationGate;
      }),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();

    try {
      const predecessorCreation = manager.createJob('stream-remote-replacement', 'user-1');
      await abortRegistrationStarted;
      const replacement = await jobStore.createJob('stream-remote-replacement', 'user-1');
      releaseAbortRegistration?.();

      await expect(predecessorCreation).rejects.toThrow(
        'Generation job was replaced during initialization',
      );
      await expect(jobStore.getJob('stream-remote-replacement')).resolves.toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
      });
      await expect(manager.getJob('stream-remote-replacement')).resolves.toMatchObject({
        createdAt: replacement.createdAt,
      });
    } finally {
      releaseAbortRegistration?.();
      await manager.destroy();
    }
  });

  it('terminalizes a created epoch when shutdown starts during abort-listener readiness', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    let signalAbortRegistrationStarted: (() => void) | undefined;
    const abortRegistrationStarted = new Promise<void>((resolve) => {
      signalAbortRegistrationStarted = resolve;
    });
    let releaseAbortRegistration: (() => void) | undefined;
    const abortRegistrationGate = new Promise<void>((resolve) => {
      releaseAbortRegistration = resolve;
    });
    const eventTransport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn(async () => {
        signalAbortRegistrationStarted?.();
        await abortRegistrationGate;
        return jest.fn();
      }),
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    const streamId = 'stream-create-shutdown-readiness';

    try {
      const creating = manager.createJob(streamId, 'user-1');
      await abortRegistrationStarted;
      manager.prepareForShutdown();
      releaseAbortRegistration?.();

      await expect(creating).rejects.toThrow('Generation job manager is shutting down');
      await manager.destroy();
      await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
        status: 'error',
        error: 'Generation interrupted because its server shut down',
        completedAt: expect.any(Number),
      });
    } finally {
      releaseAbortRegistration?.();
      if (manager.getRuntimeStats().runtimeStateSize > 0) {
        await manager.destroy();
      }
    }
  });

  it('does not install a delayed older create over a completed replacement create', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    const createJob = jobStore.createJob.bind(jobStore);
    let signalFirstDurableWrite: (() => void) | undefined;
    const firstDurableWrite = new Promise<void>((resolve) => {
      signalFirstDurableWrite = resolve;
    });
    let releaseFirstCreate: (() => void) | undefined;
    const firstCreateGate = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    let creationCount = 0;
    jest.spyOn(jobStore, 'createJob').mockImplementation(async (...args) => {
      const job = await createJob(...args);
      creationCount++;
      if (creationCount === 1) {
        signalFirstDurableWrite?.();
        await firstCreateGate;
      }
      return job;
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();

    try {
      const predecessorCreation = manager.createJob('stream-delayed-create', 'user-1');
      await firstDurableWrite;
      const replacement = await manager.createJob('stream-delayed-create', 'user-1');
      releaseFirstCreate?.();

      await expect(predecessorCreation).rejects.toThrow(
        'Generation job was replaced during initialization',
      );
      expect(replacement.abortController.signal.aborted).toBe(false);
      await expect(manager.getJob('stream-delayed-create')).resolves.toMatchObject({
        createdAt: replacement.createdAt,
      });
      await expect(jobStore.getJob('stream-delayed-create')).resolves.toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
      });

      manager.prepareForShutdown();
      await manager.destroy();
      await expect(jobStore.getJob('stream-delayed-create')).resolves.toMatchObject({
        createdAt: replacement.createdAt,
        status: 'error',
      });
    } finally {
      releaseFirstCreate?.();
      if (manager.getRuntimeStats().runtimeStateSize > 0) {
        await manager.destroy();
      }
    }
  });

  it('closes local subscribers before drain without broadcasting an abort', async () => {
    const manager = createManager();
    const telemetry = createTelemetry();
    const job = await manager.createJob('stream-6', 'user-1', 'conversation-6', {
      startupTelemetry: telemetry,
    });
    const onError = jest.fn();
    const subscription = await manager.subscribe('stream-6', () => undefined, undefined, onError);

    manager.prepareForShutdown();

    expect(onError).toHaveBeenCalledWith('Server is shutting down');
    expect(telemetry.end).toHaveBeenCalledWith('aborted');
    expect(job.abortController.signal.aborted).toBe(false);
    await expect(manager.createJob('stream-after-shutdown', 'user-1')).rejects.toThrow(
      'Generation job manager is shutting down',
    );

    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('durably finalizes locally owned running jobs after the HTTP drain', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    const eventTransport = new InMemoryEventTransport();
    const emitError = jest.spyOn(eventTransport, 'emitError');
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport,
      isRedis: false,
    });
    manager.initialize();
    const job = await manager.createJob('stream-shutdown-owned', 'user-1');

    manager.prepareForShutdown();
    await manager.destroy();

    await expect(jobStore.getJob('stream-shutdown-owned')).resolves.toMatchObject({
      status: 'error',
      error: 'Generation interrupted because its server shut down',
      completedAt: expect.any(Number),
    });
    expect(emitError).toHaveBeenCalledWith(
      'stream-shutdown-owned',
      'Generation interrupted because its server shut down',
      job.createdAt,
    );
  });

  it('persists a partial response before shutdown terminal cleanup without a local subscriber', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();
    const job = await manager.createJob('stream-shutdown-partial', 'user-1');
    const partial = [{ type: 'text', text: 'partial response' }];
    jest.spyOn(jobStore, 'getContentParts').mockResolvedValue({ content: partial });
    const persisted = jest.fn(async (parts) => {
      expect(parts).toEqual(partial);
      await expect(jobStore.getJob('stream-shutdown-partial')).resolves.toMatchObject({
        status: 'running',
      });
    });
    job.emitter.on('allSubscribersLeft', persisted);

    manager.prepareForShutdown();
    await manager.destroy();

    expect(persisted).toHaveBeenCalledTimes(1);
    await expect(jobStore.getJob('stream-shutdown-partial')).resolves.toMatchObject({
      status: 'error',
      error: 'Generation interrupted because its server shut down',
    });
  });

  const configureShutdownManager = () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    return { manager, jobStore, eventTransport };
  };

  it('waits for a begun provider execution to record its drain before shutdown completes', async () => {
    const { manager, eventTransport } = configureShutdownManager();
    const streamId = 'stream-shutdown-open-execution';
    const job = await manager.createJob(streamId, 'user-1');
    const providerExecutionId = job.metadata.providerExecutionId!;
    await expect(
      manager.beginProviderExecution(streamId, job.createdAt, providerExecutionId),
    ).resolves.toBe(true);
    const recordProviderDrain = jest.spyOn(eventTransport, 'recordProviderDrain');

    manager.prepareForShutdown();
    let destroyed = false;
    const destroying = manager.destroy({ settlementBudgetMs: 5_000 }).then(() => {
      destroyed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(destroyed).toBe(false);

    /** The execution records its own drain — from the controller's `.finally`, after its
     *  trailing writes — and that is what releases shutdown. No registration involved. */
    await manager.markProviderExecutionDrained(streamId, job.createdAt, providerExecutionId);
    await destroying;

    expect(destroyed).toBe(true);
    expect(recordProviderDrain).toHaveBeenCalledWith(streamId, job.createdAt, providerExecutionId);
  });

  it('keeps waiting for every execution begun before shutdown, not only the first to drain', async () => {
    const { manager } = configureShutdownManager();
    const first = await manager.createJob('stream-shutdown-first', 'user-1');
    const second = await manager.createJob('stream-shutdown-second', 'user-1');
    const firstExecution = first.metadata.providerExecutionId!;
    const secondExecution = second.metadata.providerExecutionId!;
    await manager.beginProviderExecution('stream-shutdown-first', first.createdAt, firstExecution);
    await manager.beginProviderExecution(
      'stream-shutdown-second',
      second.createdAt,
      secondExecution,
    );

    manager.prepareForShutdown();
    let destroyed = false;
    const destroying = manager.destroy({ settlementBudgetMs: 5_000 }).then(() => {
      destroyed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    /** The first draining must not release shutdown while the second is still open. */
    await manager.markProviderExecutionDrained(
      'stream-shutdown-first',
      first.createdAt,
      firstExecution,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(destroyed).toBe(false);

    await manager.markProviderExecutionDrained(
      'stream-shutdown-second',
      second.createdAt,
      secondExecution,
    );
    await destroying;
    expect(destroyed).toBe(true);
  });

  it('does not delay shutdown for a provider execution that already drained', async () => {
    const { manager } = configureShutdownManager();
    const streamId = 'stream-shutdown-drained';
    const job = await manager.createJob(streamId, 'user-1');
    const providerExecutionId = job.metadata.providerExecutionId!;
    await manager.beginProviderExecution(streamId, job.createdAt, providerExecutionId);
    await manager.markProviderExecutionDrained(streamId, job.createdAt, providerExecutionId);

    manager.prepareForShutdown();
    await expect(manager.destroy({ settlementBudgetMs: 5_000 })).resolves.toBeUndefined();
  });

  it('keeps waiting when the provider-begin reply is lost after the store may have committed', async () => {
    const { manager, jobStore } = configureShutdownManager();
    const streamId = 'stream-shutdown-ambiguous-begin';
    const job = await manager.createJob(streamId, 'user-1');
    const providerExecutionId = job.metadata.providerExecutionId!;
    jest
      .spyOn(jobStore, 'beginProviderExecution')
      .mockRejectedValueOnce(new Error('reply lost after commit'));
    await expect(
      manager.beginProviderExecution(streamId, job.createdAt, providerExecutionId),
    ).rejects.toThrow('reply lost after commit');

    manager.prepareForShutdown();
    let destroyed = false;
    const destroying = manager.destroy({ settlementBudgetMs: 5_000 }).then(() => {
      destroyed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    /** The caller treats the rejection as possibly-started and still records the drain from
     *  its cleanup; shutdown has to wait for that rather than assume nothing began. */
    expect(destroyed).toBe(false);

    await manager.markProviderExecutionDrained(streamId, job.createdAt, providerExecutionId);
    await destroying;
    expect(destroyed).toBe(true);
  });

  it('does not carry undrained executions into a re-initialized manager', async () => {
    const { manager } = configureShutdownManager();
    const streamId = 'stream-shutdown-stale-execution';
    const job = await manager.createJob(streamId, 'user-1');
    await manager.beginProviderExecution(
      streamId,
      job.createdAt,
      job.metadata.providerExecutionId!,
    );

    /** A bare reset: zero budget, so the execution is still open when teardown runs. */
    manager.prepareForShutdown();
    await manager.destroy();

    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    manager.configure({ jobStore, eventTransport: new InMemoryEventTransport(), isRedis: false });
    manager.initialize();

    manager.prepareForShutdown();
    let destroyed = false;
    const destroying = manager.destroy({ settlementBudgetMs: 5_000 }).then(() => {
      destroyed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    /** Resolved without consuming the budget: nothing from the previous store is left to wait
     *  on. Asserted before awaiting, or a 5s stale wait would pass this test too. */
    expect(destroyed).toBe(true);
    await destroying;
  });

  it('does not carry undrained executions across a reconfigure', async () => {
    const { manager } = configureShutdownManager();
    const streamId = 'stream-shutdown-reconfigure';
    const job = await manager.createJob(streamId, 'user-1');
    await manager.beginProviderExecution(
      streamId,
      job.createdAt,
      job.metadata.providerExecutionId!,
    );

    /** Reconfiguring after initialization replaces the store and transport the open
     *  execution belongs to; its tracker must go with them. */
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    manager.configure({ jobStore, eventTransport: new InMemoryEventTransport(), isRedis: false });

    manager.prepareForShutdown();
    let destroyed = false;
    const destroying = manager.destroy({ settlementBudgetMs: 5_000 }).then(() => {
      destroyed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(destroyed).toBe(true);
    await destroying;
  });

  it('releases an abandoned provider execution without recording a drain', async () => {
    const { manager, eventTransport } = configureShutdownManager();
    const streamId = 'stream-shutdown-abandoned';
    const job = await manager.createJob(streamId, 'user-1');
    const providerExecutionId = job.metadata.providerExecutionId!;
    await manager.beginProviderExecution(streamId, job.createdAt, providerExecutionId);
    const recordProviderDrain = jest.spyOn(eventTransport, 'recordProviderDrain');

    /** A remote run that settled its provider work but failed terminalization twice
     *  deliberately publishes no drain marker; it must still stop shutdown waiting on it. */
    manager.abandonProviderExecution(streamId, job.createdAt, providerExecutionId);

    manager.prepareForShutdown();
    let destroyed = false;
    const destroying = manager.destroy({ settlementBudgetMs: 5_000 }).then(() => {
      destroyed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(destroyed).toBe(true);
    await destroying;
    expect(recordProviderDrain).not.toHaveBeenCalled();
  });

  it('refuses to begin a provider execution once shutdown has started', async () => {
    const { manager, jobStore } = configureShutdownManager();
    const streamId = 'stream-shutdown-late-begin';
    const job = await manager.createJob(streamId, 'user-1');
    const providerExecutionId = job.metadata.providerExecutionId!;
    const storeBegin = jest.spyOn(jobStore, 'beginProviderExecution');

    manager.prepareForShutdown();
    /** Began after the settlement wait could have observed it: must not start, must not
     *  commit `providerDrained: false`, and must leave nothing for shutdown to wait on. */
    await expect(
      manager.beginProviderExecution(streamId, job.createdAt, providerExecutionId),
    ).resolves.toBe(false);
    expect(storeBegin).not.toHaveBeenCalled();

    let destroyed = false;
    const destroying = manager.destroy({ settlementBudgetMs: 5_000 }).then(() => {
      destroyed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(destroyed).toBe(true);
    await destroying;
  });

  it('does not let late success overwrite or delete a shutdown error', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    const originalTransition = jobStore.transitionStatus.bind(jobStore);
    let signalCompletionStarted: (() => void) | undefined;
    const completionStarted = new Promise<void>((resolve) => {
      signalCompletionStarted = resolve;
    });
    let releaseCompletion: (() => void) | undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    jest.spyOn(jobStore, 'transitionStatus').mockImplementation(async (...args) => {
      if (args[1].to === 'complete') {
        signalCompletionStarted?.();
        await completionGate;
      }
      return originalTransition(...args);
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();
    const job = await manager.createJob('stream-shutdown-wins', 'user-1');

    const completing = manager.completeJob('stream-shutdown-wins', undefined, job.createdAt);
    await completionStarted;
    manager.prepareForShutdown();
    await manager.destroy();
    releaseCompletion?.();
    await completing;

    await expect(jobStore.getJob('stream-shutdown-wins')).resolves.toMatchObject({
      createdAt: job.createdAt,
      status: 'error',
      error: 'Generation interrupted because its server shut down',
    });
  });

  it('parks accepted steers before shutdown terminal cleanup removes the queue', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();
    await manager.createJob('stream-shutdown-steer', 'user-1');
    await manager.steering.enqueue('stream-shutdown-steer', {
      steerId: 'steer-shutdown',
      text: 'keep this',
      userId: 'user-1',
      createdAt: Date.now(),
    });

    manager.prepareForShutdown();
    await manager.destroy();

    await expect(
      manager.steering.claim('stream-shutdown-steer', { userId: 'user-1' }),
    ).resolves.toEqual([expect.objectContaining({ steerId: 'steer-shutdown', text: 'keep this' })]);
  });

  it('does not finalize a running job owned by a different replica', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    await jobStore.createJob('stream-remote-owner', 'user-1');
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();
    const subscription = await manager.subscribe('stream-remote-owner', () => undefined);

    manager.prepareForShutdown();
    await manager.destroy();

    await expect(jobStore.getJob('stream-remote-owner')).resolves.toMatchObject({
      status: 'running',
    });
    subscription?.unsubscribe();
  });

  it('transfers shutdown ownership to the replica that resumes a paused job', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    const owner = new GenerationJobManagerClass();
    const resumer = new GenerationJobManagerClass();
    owner.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    resumer.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });

    await owner.createJob('stream-owner-transfer', 'user-1');
    const pendingAction = createPendingAction('stream-owner-transfer');
    await expect(owner.approvals.pause('stream-owner-transfer', pendingAction)).resolves.toBe(true);
    await expect(
      resumer.approvals.resolve('stream-owner-transfer', pendingAction.actionId),
    ).resolves.toBe(true);

    await owner.destroy();
    await expect(jobStore.getJob('stream-owner-transfer')).resolves.toMatchObject({
      status: 'running',
    });

    await resumer.destroy();
    await expect(jobStore.getJob('stream-owner-transfer')).resolves.toMatchObject({
      status: 'error',
      error: 'Generation interrupted because its server shut down',
    });
  });

  it('rejects a job when shutdown starts while its store write is pending', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    jest.spyOn(jobStore, 'destroy').mockResolvedValue();
    const originalCreateJob = jobStore.createJob.bind(jobStore);
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    jest.spyOn(jobStore, 'createJob').mockImplementation(async (...args) => {
      await createGate;
      return originalCreateJob(...args);
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();

    const creating = manager.createJob('stream-7', 'user-1', 'conversation-7');
    manager.prepareForShutdown();
    releaseCreate?.();

    await expect(creating).rejects.toThrow('Generation job manager is shutting down');
    await manager.destroy();
    await expect(jobStore.getJob('stream-7')).resolves.toMatchObject({
      status: 'error',
      error: 'Generation interrupted because its server shut down',
    });
  });

  it('does not attach a subscriber when shutdown starts during the job lookup', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    await manager.createJob('stream-8', 'user-1', 'conversation-8');

    const originalGetJob = jobStore.getJob.bind(jobStore);
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    jest.spyOn(jobStore, 'getJob').mockImplementation(async (...args) => {
      signalReadStarted?.();
      await readGate;
      return originalGetJob(...args);
    });

    const onError = jest.fn();
    const subscribing = manager.subscribe('stream-8', () => undefined, undefined, onError);
    await readStarted;
    manager.prepareForShutdown();
    releaseRead?.();

    await expect(subscribing).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith('Server is shutting down');
    expect(eventTransport.getSubscriberCount('stream-8')).toBe(0);
    await manager.destroy();
  });

  it('drains asynchronous disconnect handlers before destroying the job store', async () => {
    const manager = createManager();
    const job = await manager.createJob('stream-9', 'user-1', 'conversation-9');
    let signalHandlerStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      signalHandlerStarted = resolve;
    });
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    job.emitter.on('allSubscribersLeft', async () => {
      signalHandlerStarted?.();
      await handlerGate;
    });
    const subscription = await manager.subscribe('stream-9', () => undefined);

    manager.prepareForShutdown();
    await handlerStarted;

    let destroySettled = false;
    const destroying = manager.destroy().then(() => {
      destroySettled = true;
    });
    await Promise.resolve();

    expect(destroySettled).toBe(false);
    releaseHandler?.();
    await destroying;
    expect(destroySettled).toBe(true);
    subscription?.unsubscribe();
  });

  it('drains replaced services without destroying the newly configured services', async () => {
    const replacedJobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const replacedEventTransport = new InMemoryEventTransport();
    const replacedStoreDestroy = jest.spyOn(replacedJobStore, 'destroy');
    const replacedTransportDestroy = jest.spyOn(replacedEventTransport, 'destroy');
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: replacedJobStore,
      eventTransport: replacedEventTransport,
      isRedis: false,
    });
    manager.initialize();
    const job = await manager.createJob('stream-reconfigure-old', 'user-1');
    let signalCleanupStarted: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      signalCleanupStarted = resolve;
    });
    let releaseCleanup: (() => void) | undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    job.emitter.on('allSubscribersLeft', async () => {
      signalCleanupStarted?.();
      await cleanupGate;
    });
    const oldSubscription = await manager.subscribe('stream-reconfigure-old', () => undefined);
    oldSubscription?.unsubscribe();
    await cleanupStarted;

    const currentJobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const currentEventTransport = new InMemoryEventTransport();
    const currentStoreDestroy = jest.spyOn(currentJobStore, 'destroy');
    const currentTransportDestroy = jest.spyOn(currentEventTransport, 'destroy');
    manager.configure({
      jobStore: currentJobStore,
      eventTransport: currentEventTransport,
      isRedis: false,
    });
    manager.initialize();
    await manager.createJob('stream-reconfigure-current', 'user-1');

    expect(replacedTransportDestroy).toHaveBeenCalledTimes(1);
    expect(currentStoreDestroy).not.toHaveBeenCalled();
    expect(currentTransportDestroy).not.toHaveBeenCalled();

    releaseCleanup?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(replacedStoreDestroy).toHaveBeenCalledTimes(1);
    expect(currentStoreDestroy).not.toHaveBeenCalled();
    expect(currentTransportDestroy).not.toHaveBeenCalled();
    await expect(manager.hasJob('stream-reconfigure-current')).resolves.toBe(true);

    await manager.destroy();
    expect(currentStoreDestroy).toHaveBeenCalledTimes(1);
    expect(currentTransportDestroy).toHaveBeenCalledTimes(1);
  });

  it('does not deliver a stored terminal event after the subscriber detaches', async () => {
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    await manager.createJob('stream-10', 'user-1', 'conversation-10');
    const finalEvent: ServerSentEvent = {
      final: true,
      responseMessage: {
        messageId: 'response-10',
        content: [{ type: 'text', text: 'Complete response' }],
      },
    };
    await manager.emitDone('stream-10', finalEvent);
    await manager.completeJob('stream-10');

    const onDone = jest.fn();
    const subscription = await manager.subscribe('stream-10', () => undefined, onDone);
    subscription?.unsubscribe();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onDone).not.toHaveBeenCalled();
    await manager.destroy();
  });

  it('does not run partial-disconnect persistence after terminal delivery', async () => {
    const eventTransport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport,
      isRedis: false,
    });
    manager.initialize();
    const job = await manager.createJob('stream-terminal-disconnect', 'user-1');
    const onAllSubscribersLeft = jest.fn();
    job.emitter.on('allSubscribersLeft', onAllSubscribersLeft);
    const onDone = jest.fn();
    const subscription = await manager.subscribe(
      'stream-terminal-disconnect',
      () => undefined,
      onDone,
    );
    const finalEvent: ServerSentEvent = {
      final: true,
      responseMessage: {
        messageId: 'response-terminal',
        content: [{ type: 'text', text: 'Complete response' }],
      },
    };

    await manager.emitDone('stream-terminal-disconnect', finalEvent);
    await Promise.resolve();

    expect(onDone).toHaveBeenCalledWith(finalEvent);
    expect(onAllSubscribersLeft).not.toHaveBeenCalled();
    expect(eventTransport.getSubscriberCount('stream-terminal-disconnect')).toBe(0);

    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('waits for transport readiness before scheduling a stored terminal event', async () => {
    const eventTransport = new InMemoryEventTransport();
    const originalSubscribe = eventTransport.subscribe.bind(eventTransport);
    let releaseReady: (() => void) | undefined;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    jest.spyOn(eventTransport, 'subscribe').mockImplementation((streamId, handlers) => ({
      ...originalSubscribe(streamId, handlers),
      ready: readyGate,
    }));
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    await manager.createJob('stream-terminal-ready', 'user-1');
    const finalEvent: ServerSentEvent = {
      final: true,
      responseMessage: {
        messageId: 'response-ready',
        content: [{ type: 'text', text: 'Complete response' }],
      },
    };
    await manager.emitDone('stream-terminal-ready', finalEvent);
    await manager.completeJob('stream-terminal-ready');

    const onDone = jest.fn();
    let subscribeSettled = false;
    const subscribing = manager
      .subscribe('stream-terminal-ready', () => undefined, onDone)
      .then((result) => {
        subscribeSettled = true;
        return result;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(subscribeSettled).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
    expect(eventTransport.getSubscriberCount('stream-terminal-ready')).toBe(1);

    releaseReady?.();
    const subscription = await subscribing;
    expect(onDone).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onDone).toHaveBeenCalledWith(finalEvent);
    expect(eventTransport.getSubscriberCount('stream-terminal-ready')).toBe(0);

    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('refreshes terminal state that changes while the transport attaches', async () => {
    const eventTransport = new InMemoryEventTransport();
    const originalSubscribe = eventTransport.subscribe.bind(eventTransport);
    let releaseReady: (() => void) | undefined;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    jest.spyOn(eventTransport, 'subscribe').mockImplementation((streamId, handlers) => ({
      ...originalSubscribe(streamId, handlers),
      ready: readyGate,
    }));
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    await manager.createJob('stream-terminal-race', 'user-1');
    const finalEvent: ServerSentEvent = {
      final: true,
      responseMessage: {
        messageId: 'response-race',
        content: [{ type: 'text', text: 'Complete response' }],
      },
    };
    const onDone = jest.fn();
    const subscribing = manager.subscribe('stream-terminal-race', () => undefined, onDone);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await jobStore.updateJob('stream-terminal-race', {
      status: 'complete',
      completedAt: Date.now(),
      finalEvent: JSON.stringify(finalEvent),
    });
    releaseReady?.();
    const subscription = await subscribing;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();

    expect(onDone).toHaveBeenCalledWith(finalEvent);
    expect(eventTransport.getSubscriberCount('stream-terminal-race')).toBe(0);

    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('detaches the transport when subscription readiness rejects', async () => {
    const eventTransport = new InMemoryEventTransport();
    const originalSubscribe = eventTransport.subscribe.bind(eventTransport);
    jest.spyOn(eventTransport, 'subscribe').mockImplementation((streamId, handlers) => ({
      ...originalSubscribe(streamId, handlers),
      ready: Promise.reject(new Error('readiness failed')),
    }));
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    await manager.createJob('stream-terminal-reject', 'user-1');
    const finalEvent: ServerSentEvent = {
      final: true,
      responseMessage: {
        messageId: 'response-reject',
        content: [{ type: 'text', text: 'Complete response' }],
      },
    };
    await manager.emitDone('stream-terminal-reject', finalEvent);
    await manager.completeJob('stream-terminal-reject');
    const onDone = jest.fn();

    await expect(
      manager.subscribe('stream-terminal-reject', () => undefined, onDone),
    ).rejects.toThrow('readiness failed');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onDone).not.toHaveBeenCalled();
    expect(eventTransport.getSubscriberCount('stream-terminal-reject')).toBe(0);
    await manager.destroy();
  });

  it('does not duplicate an event already included by the in-memory resume snapshot', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const originalGetRunSteps = jobStore.getRunSteps.bind(jobStore);
    let signalSnapshotInProgress: (() => void) | undefined;
    const snapshotInProgress = new Promise<void>((resolve) => {
      signalSnapshotInProgress = resolve;
    });
    let releaseSnapshot: (() => void) | undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    jest.spyOn(jobStore, 'getRunSteps').mockImplementationOnce(async (...args) => {
      const runSteps = await originalGetRunSteps(...args);
      signalSnapshotInProgress?.();
      await snapshotGate;
      return runSteps;
    });

    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();
    await manager.createJob('stream-resume-snapshot', 'user-1');
    const contentParts: Parameters<typeof manager.setContentParts>[1] = [
      { type: 'text', text: 'before' },
    ];
    manager.setContentParts('stream-resume-snapshot', contentParts);

    const liveEvents: ServerSentEvent[] = [];
    const resuming = manager.subscribeWithResume('stream-resume-snapshot', (event) =>
      liveEvents.push(event),
    );
    await snapshotInProgress;

    const snapshotEvent: ServerSentEvent = {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: 'during snapshot' }] } },
    };
    contentParts.push({ type: 'text', text: 'during snapshot' });
    await manager.emitChunk('stream-resume-snapshot', snapshotEvent);
    releaseSnapshot?.();

    const result = await resuming;
    expect(result.resumeState?.aggregatedContent).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'during snapshot' },
    ]);
    expect(result.pendingEvents).toEqual([]);
    result.subscription?.activate();
    expect(liveEvents).toEqual([]);

    result.subscription?.unsubscribe();
    await manager.destroy();
  });

  it('does not recapture an emission that started before the snapshot frontier', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const originalUpdateJob = jobStore.updateJob.bind(jobStore);
    let signalTitlePersisted: (() => void) | undefined;
    const titlePersisted = new Promise<void>((resolve) => {
      signalTitlePersisted = resolve;
    });
    let releaseTitleWrite: (() => void) | undefined;
    const titleWriteGate = new Promise<void>((resolve) => {
      releaseTitleWrite = resolve;
    });
    jest
      .spyOn(jobStore, 'updateJob')
      .mockImplementation(async (streamId, updates, expectedCreatedAt) => {
        await originalUpdateJob(streamId, updates, expectedCreatedAt);
        if (updates.titleEvent) {
          signalTitlePersisted?.();
          await titleWriteGate;
        }
      });

    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();
    await manager.createJob('stream-resume-inflight', 'user-1');
    const titleEvent: ServerSentEvent = {
      event: 'title',
      data: { title: 'Snapshot title' },
    };
    const emitting = manager.emitChunk('stream-resume-inflight', titleEvent);
    await titlePersisted;

    const liveEvents: ServerSentEvent[] = [];
    const resuming = manager.subscribeWithResume('stream-resume-inflight', (event) =>
      liveEvents.push(event),
    );
    releaseTitleWrite?.();
    const result = await resuming;
    await emitting;

    expect(result.resumeState?.titleEvent).toEqual(titleEvent);
    expect(result.pendingEvents).toEqual([]);
    result.subscription?.activate();
    expect(liveEvents).toEqual([]);

    result.subscription?.unsubscribe();
    await manager.destroy();
  });

  it('preserves an in-memory resume event emitted after snapshot before transport readiness', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const originalGetContentParts = jobStore.getContentParts.bind(jobStore);
    let signalSnapshotTaken: (() => void) | undefined;
    const snapshotTaken = new Promise<void>((resolve) => {
      signalSnapshotTaken = resolve;
    });
    let releaseSnapshot: (() => void) | undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    jest.spyOn(jobStore, 'getContentParts').mockImplementationOnce(async (...args) => {
      const snapshot = await originalGetContentParts(...args);
      signalSnapshotTaken?.();
      await snapshotGate;
      return snapshot;
    });

    const eventTransport = new InMemoryEventTransport();
    const originalSubscribe = eventTransport.subscribe.bind(eventTransport);
    let signalTransportSubscribed: (() => void) | undefined;
    const transportSubscribed = new Promise<void>((resolve) => {
      signalTransportSubscribed = resolve;
    });
    let releaseReady: (() => void) | undefined;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    jest.spyOn(eventTransport, 'subscribe').mockImplementationOnce((streamId, handlers) => {
      const subscription = originalSubscribe(streamId, handlers);
      signalTransportSubscribed?.();
      return { ...subscription, ready: readyGate };
    });

    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    await manager.createJob('stream-resume-gap', 'user-1');

    const liveEvents: ServerSentEvent[] = [];
    const resuming = manager.subscribeWithResume('stream-resume-gap', (event) =>
      liveEvents.push(event),
    );
    await snapshotTaken;
    releaseSnapshot?.();
    await transportSubscribed;

    const gapEvent: ServerSentEvent = {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: 'gap' }] } },
    };
    await manager.emitChunk('stream-resume-gap', gapEvent);
    expect(liveEvents).toEqual([]);

    releaseReady?.();
    const result = await resuming;
    expect(result.pendingEvents).toEqual([gapEvent]);
    expect(liveEvents).toEqual([]);

    const deliveredEvents = [...result.pendingEvents];
    result.subscription?.activate();
    deliveredEvents.push(...liveEvents);
    expect(deliveredEvents).toEqual([gapEvent]);

    result.subscription?.unsubscribe();
    await manager.destroy();
  });

  it('captures the same in-memory gap independently for overlapping resume subscribers', async () => {
    const eventTransport = new InMemoryEventTransport();
    const originalSubscribe = eventTransport.subscribe.bind(eventTransport);
    let transportSubscriptions = 0;
    let signalBothTransportSubscribed: (() => void) | undefined;
    const bothTransportSubscribed = new Promise<void>((resolve) => {
      signalBothTransportSubscribed = resolve;
    });
    let releaseReady: (() => void) | undefined;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    jest.spyOn(eventTransport, 'subscribe').mockImplementation((streamId, handlers) => {
      const subscription = originalSubscribe(streamId, handlers);
      transportSubscriptions++;
      if (transportSubscriptions === 2) {
        signalBothTransportSubscribed?.();
      }
      return { ...subscription, ready: readyGate };
    });

    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport,
      isRedis: false,
    });
    manager.initialize();
    await manager.createJob('stream-overlapping-resumes', 'user-1');

    let snapshotsStarted = 0;
    let signalSnapshotsStarted: (() => void) | undefined;
    const bothSnapshotsStarted = new Promise<void>((resolve) => {
      signalSnapshotsStarted = resolve;
    });
    let releaseSnapshots: (() => void) | undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshots = resolve;
    });
    jest.spyOn(manager, 'getResumeState').mockImplementation(async () => {
      snapshotsStarted++;
      if (snapshotsStarted === 2) {
        signalSnapshotsStarted?.();
      }
      await snapshotGate;
      return { runSteps: [], aggregatedContent: [] };
    });

    const firstLiveEvents: ServerSentEvent[] = [];
    const secondLiveEvents: ServerSentEvent[] = [];
    const firstResume = manager.subscribeWithResume('stream-overlapping-resumes', (event) =>
      firstLiveEvents.push(event),
    );
    const secondResume = manager.subscribeWithResume('stream-overlapping-resumes', (event) =>
      secondLiveEvents.push(event),
    );
    await bothSnapshotsStarted;
    releaseSnapshots?.();
    await bothTransportSubscribed;

    const gapEvent: ServerSentEvent = {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: 'gap' }] } },
    };
    await manager.emitChunk('stream-overlapping-resumes', gapEvent);
    releaseReady?.();

    const [firstResult, secondResult] = await Promise.all([firstResume, secondResume]);
    expect(firstResult.pendingEvents).toEqual([gapEvent]);
    expect(secondResult.pendingEvents).toEqual([gapEvent]);

    const liveEvent: ServerSentEvent = {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: 'live' }] } },
    };
    await manager.emitChunk('stream-overlapping-resumes', liveEvent);
    expect(firstLiveEvents).toEqual([]);
    expect(secondLiveEvents).toEqual([]);

    firstResult.subscription?.activate();
    expect(firstLiveEvents).toEqual([liveEvent]);
    expect(secondLiveEvents).toEqual([]);
    secondResult.subscription?.activate();
    expect(secondLiveEvents).toEqual([liveEvent]);

    firstResult.subscription?.unsubscribe();
    secondResult.subscription?.unsubscribe();
    await manager.destroy();
  });

  it('restores in-memory gap events when a resume attachment is canceled', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const originalGetContentParts = jobStore.getContentParts.bind(jobStore);
    let signalSnapshotTaken: (() => void) | undefined;
    const snapshotTaken = new Promise<void>((resolve) => {
      signalSnapshotTaken = resolve;
    });
    let releaseSnapshot: (() => void) | undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    jest.spyOn(jobStore, 'getContentParts').mockImplementationOnce(async (...args) => {
      const snapshot = await originalGetContentParts(...args);
      signalSnapshotTaken?.();
      await snapshotGate;
      return snapshot;
    });

    const eventTransport = new InMemoryEventTransport();
    const originalSubscribe = eventTransport.subscribe.bind(eventTransport);
    let signalTransportSubscribed: (() => void) | undefined;
    const transportSubscribed = new Promise<void>((resolve) => {
      signalTransportSubscribed = resolve;
    });
    let releaseReady: (() => void) | undefined;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    jest.spyOn(eventTransport, 'subscribe').mockImplementationOnce((streamId, handlers) => {
      const subscription = originalSubscribe(streamId, handlers);
      signalTransportSubscribed?.();
      return { ...subscription, ready: readyGate };
    });

    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    await manager.createJob('stream-resume-cancel', 'user-1');

    const attachmentAbortController = new AbortController();
    const resuming = manager.subscribeWithResume(
      'stream-resume-cancel',
      () => undefined,
      undefined,
      undefined,
      { signal: attachmentAbortController.signal },
    );
    await snapshotTaken;
    releaseSnapshot?.();
    await transportSubscribed;

    const gapEvent: ServerSentEvent = {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: 'gap' }] } },
    };
    await manager.emitChunk('stream-resume-cancel', gapEvent);

    attachmentAbortController.abort();
    await expect(resuming).resolves.toEqual(
      expect.objectContaining({ subscription: null, pendingEvents: [] }),
    );

    const replayed: ServerSentEvent[] = [];
    const subscription = await manager.subscribe('stream-resume-cancel', (event) =>
      replayed.push(event),
    );
    expect(replayed).toEqual([gapEvent]);

    releaseReady?.();
    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('restores gap events and detaches when resume reconciliation rejects', async () => {
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const originalGetContentParts = jobStore.getContentParts.bind(jobStore);
    let signalSnapshotTaken: (() => void) | undefined;
    const snapshotTaken = new Promise<void>((resolve) => {
      signalSnapshotTaken = resolve;
    });
    let releaseSnapshot: (() => void) | undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    jest.spyOn(jobStore, 'getContentParts').mockImplementationOnce(async (...args) => {
      const snapshot = await originalGetContentParts(...args);
      signalSnapshotTaken?.();
      await snapshotGate;
      return snapshot;
    });
    const originalPeekSteers = jobStore.peekSteers.bind(jobStore);
    jest
      .spyOn(jobStore, 'peekSteers')
      .mockImplementationOnce(originalPeekSteers)
      .mockRejectedValueOnce(new Error('reconciliation failed'));

    const eventTransport = new InMemoryEventTransport();
    const originalSubscribe = eventTransport.subscribe.bind(eventTransport);
    let signalTransportSubscribed: (() => void) | undefined;
    const transportSubscribed = new Promise<void>((resolve) => {
      signalTransportSubscribed = resolve;
    });
    let releaseReady: (() => void) | undefined;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    jest.spyOn(eventTransport, 'subscribe').mockImplementationOnce((streamId, handlers) => {
      const subscription = originalSubscribe(streamId, handlers);
      signalTransportSubscribed?.();
      return { ...subscription, ready: readyGate };
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: false });
    manager.initialize();
    await manager.createJob('stream-resume-reject', 'user-1');

    const resuming = manager.subscribeWithResume('stream-resume-reject', () => undefined);
    await snapshotTaken;
    releaseSnapshot?.();
    await transportSubscribed;

    const gapEvent: ServerSentEvent = {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: 'gap' }] } },
    };
    await manager.emitChunk('stream-resume-reject', gapEvent);
    releaseReady?.();

    await expect(resuming).rejects.toThrow('reconciliation failed');
    expect(eventTransport.getSubscriberCount('stream-resume-reject')).toBe(0);

    const replayed: ServerSentEvent[] = [];
    const subscription = await manager.subscribe('stream-resume-reject', (event) =>
      replayed.push(event),
    );
    expect(replayed).toEqual([gapEvent]);

    subscription?.unsubscribe();
    await manager.destroy();
  });
});
