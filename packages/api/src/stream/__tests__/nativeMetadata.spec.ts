import type { FinalEvent } from '~/types';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '../GenerationJobManager';

jest.spyOn(console, 'log').mockImplementation();

describe('private native metadata at terminal stream boundaries', () => {
  let manager: GenerationJobManagerClass;
  let store: InMemoryJobStore;
  let transport: InMemoryEventTransport;
  const message = {
    messageId: 'response',
    fileContext: 'prompt-only-context',
    image_urls: ['prompt-only-image'],
    files: [{ file_id: 'input', text: 'prompt-only-file', _id: 'storage-only-id', __v: 1 }],
    attachments: [
      { file_id: 'output', text: 'Generated artifact', _id: 'storage-only-id', __v: 1 },
    ],
    metadata: {
      finish_reason: 'stop',
      thoughtSignatures: { 0: 'private-text' },
      nativeSignatures: { 1: { thoughtSignature: 'private-image' } },
    },
  };
  const event: FinalEvent = {
    final: true,
    requestMessage: message,
    responseMessage: message,
    runMessages: [message],
  };

  beforeEach(() => {
    store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    transport = new InMemoryEventTransport();
    manager = new GenerationJobManagerClass();
    manager.configure({ jobStore: store, eventTransport: transport, isRedis: false });
    manager.initialize();
  });
  afterEach(async () => manager.destroy());

  test.each(['complete', 'error', 'aborted'] as const)(
    'strips private signatures and prompt inputs from durable %s publication without mutating input',
    async (status) => {
      const job = await manager.createJob(status, 'user', status);
      const claim = await manager.claimTerminalJob(status, status, undefined, job.createdAt, {
        persistencePending: true,
      });
      expect(claim).not.toBeNull();
      const emitted = jest.spyOn(transport, 'emitDone');
      const result = await manager.publishTerminalClaim(claim!, event);
      expect(result.persistenceFailed).toBe(false);
      const serialized = (await store.getJob(status))?.finalEvent;
      expect(serialized).toContain('finish_reason');
      expect(serialized).not.toContain('Signatures');
      expect(serialized).not.toContain('prompt-only');
      expect(serialized).not.toContain('storage-only');
      expect(serialized).toContain('Generated artifact');
      expect(JSON.stringify(emitted.mock.calls)).not.toContain('private-');
      expect(message.metadata.nativeSignatures[1].thoughtSignature).toBe('private-image');
      expect(message.fileContext).toBe('prompt-only-context');
      expect(message.files[0].text).toBe('prompt-only-file');
      await manager.finishTerminalJob(claim!);
    },
  );

  test('sanitizes legacy stored final events when a client reconnects', async () => {
    await manager.createJob('replay', 'user', 'replay');
    await store.updateJob('replay', { status: 'complete', finalEvent: JSON.stringify(event) });
    let finishDelivery!: () => void;
    const delivered = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    const received = jest.fn((_event: import('~/types').ServerSentEvent) => finishDelivery());
    const subscription = await manager.subscribe('replay', () => {}, received);
    await delivered;
    expect(received).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(received.mock.calls)).not.toContain('Signatures');
    expect(JSON.stringify(received.mock.calls)).not.toContain('prompt-only');
    expect(JSON.stringify(received.mock.calls)).not.toContain('storage-only');
    expect(received.mock.calls[0][0]).toMatchObject({
      responseMessage: {
        metadata: { finish_reason: 'stop' },
        attachments: [{ file_id: 'output', text: 'Generated artifact' }],
      },
    });
    subscription?.unsubscribe();
  });

  test('sanitizes the direct terminal publication path before caching it', async () => {
    await manager.createJob('direct', 'user', 'direct');
    const emitted = jest.spyOn(transport, 'emitDone');
    await manager.emitDone('direct', event);
    expect(JSON.stringify(emitted.mock.calls)).not.toContain('Signatures');
    expect(JSON.stringify(emitted.mock.calls)).not.toContain('prompt-only');
    const serialized = (await store.getJob('direct'))?.finalEvent;
    expect(serialized).not.toContain('Signatures');
    expect(serialized).not.toContain('prompt-only');
    expect(serialized).not.toContain('storage-only');
    expect(serialized).toContain('Generated artifact');
  });

  test('sanitizes an older owner’s live terminal event before deferred resume caching', async () => {
    const job = await manager.createJob('deferred', 'user', 'deferred');
    const received = jest.fn();
    const resumed = await manager.subscribeWithResume('deferred', () => {}, received);
    expect(resumed.subscription).not.toBeNull();

    // Bypass the current producer boundary, as an older replica's transport would.
    transport.emitDone('deferred', event, job.createdAt);
    expect(received).not.toHaveBeenCalled();
    const cached = (
      manager as unknown as { runtimeState: Map<string, { finalEvent?: FinalEvent }> }
    ).runtimeState.get('deferred')?.finalEvent;
    expect(cached).toBeDefined();
    expect(JSON.stringify(cached)).not.toContain('Signatures');
    expect(JSON.stringify(cached)).not.toContain('prompt-only');
    expect(JSON.stringify(cached)).not.toContain('storage-only');
    expect(cached?.responseMessage).toMatchObject({
      metadata: { finish_reason: 'stop' },
      attachments: [{ file_id: 'output', text: 'Generated artifact' }],
    });

    resumed.subscription?.activate();
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(cached);
    expect(message.metadata.nativeSignatures[1].thoughtSignature).toBe('private-image');
    resumed.subscription?.unsubscribe();
  });
});
