import { ContentTypes } from 'librechat-data-provider';
import { tenantStorage } from '@librechat/data-schemas';
import { createContentAggregator } from '@librechat/agents';
import type { StoredResponseRecord } from '@librechat/data-schemas';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { createAggregatorEventHandlers, createResponseAggregator } from './service';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { enrollAgentExecution } from '../remote/lifecycle';
import { createResponsePreviewHandler } from './preview';

const scope = <T>(work: () => T | Promise<T>) =>
  tenantStorage.run({ tenantId: 'tenant-a' }, async () => work());
let manager: GenerationJobManagerClass;
afterEach(() => manager?.destroy());
async function fixture(maxChars = 128) {
  manager = new GenerationJobManagerClass();
  const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
  manager.configure({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  manager.initialize();
  const execution = await scope(() =>
    enrollAgentExecution(
      {
        runId: 'resp_preview',
        userId: 'user-a',
        agentId: 'agent-a',
        conversationId: 'conversation-a',
        protocol: 'responses',
        isPrincipalActive: async () => true,
      },
      { manager },
    ),
  );
  await execution.beginProviderExecution();
  const record: StoredResponseRecord = {
    responseId: 'resp_preview',
    userId: 'user-a',
    tenantId: 'tenant-a',
    agentId: 'agent-a',
    conversationId: 'conversation-a',
    parentMessageId: 'parent-a',
    requestKey: 'channel:run-a',
    fingerprint: 'hash',
    requestJSON: '{}',
    status: 'in_progress',
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    generationCreatedAt: execution.createdAt,
  };
  const aggregator = createResponseAggregator();
  const original = createAggregatorEventHandlers(aggregator).on_message_delta;
  const create = () =>
    createResponsePreviewHandler(original, { jobs: manager, record, execution, maxChars });
  const handler = create();
  const emit = (text: string) =>
    scope(() =>
      handler.handle('on_message_delta', {
        delta: { content: [{ type: ContentTypes.TEXT, text }] },
      }),
    );
  const read = () =>
    scope(() =>
      manager.getResumeState(record.responseId, execution.createdAt, { durableOnly: true }),
    );
  return { execution, record, handler, create, emit, read, store, aggregator };
}

it('publishes real Responses public text deltas into the actual resume-state path', async () => {
  const f = await fixture();
  await f.emit('Hello ');
  await f.emit('world');
  expect(f.aggregator.getText()).toBe('Hello world');
  expect((await f.read())?.aggregatedContent).toEqual([
    { type: ContentTypes.TEXT, text: 'Hello world' },
  ]);
});

it('records only bounded public message events that the real Redis reconstruction aggregator can replay', async () => {
  const f = await fixture();
  const append = jest.spyOn(f.store, 'appendChunk');
  await scope(() =>
    f.handler.handle('on_message_delta', {
      private: 'secret',
      delta: {
        content: [
          { type: ContentTypes.THINK, text: 'private reasoning' },
          { type: ContentTypes.TOOL_CALL, text: 'private arguments' },
          { type: ContentTypes.TEXT, text: 'a'.repeat(127) + '😀overflow' },
        ],
      },
    }),
  );
  await f.emit('more text after saturation');
  const events = append.mock.calls.map(([, event]) => event);
  expect(events).toHaveLength(2);
  expect(JSON.stringify(events)).not.toMatch(/secret|reasoning|arguments|overflow|saturation/);
  const replay = createContentAggregator();
  for (const recorded of events) {
    const event: Parameters<typeof replay.aggregateContent>[0] = JSON.parse(
      JSON.stringify(recorded),
    );
    replay.aggregateContent(event);
  }
  expect(replay.contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'a'.repeat(127) }]);
  expect((await f.read())?.aggregatedContent).toEqual(replay.contentParts);
});

it('a rebuilt handler resumes the existing prefix without duplicating its saved text', async () => {
  const f = await fixture();
  const append = jest.spyOn(f.store, 'appendChunk');
  await f.emit('Before review. ');
  const resumed = f.create();
  await scope(() =>
    resumed.handle('on_message_delta', {
      delta: { content: [{ type: ContentTypes.TEXT, text: 'After review.' }] },
    }),
  );
  expect((await f.read())?.aggregatedContent).toEqual([
    { type: ContentTypes.TEXT, text: 'Before review. After review.' },
  ]);
  const replay = createContentAggregator();
  for (const [, recorded] of append.mock.calls) {
    const event: Parameters<typeof replay.aggregateContent>[0] = JSON.parse(
      JSON.stringify(recorded),
    );
    replay.aggregateContent(event);
  }
  expect(replay.contentParts).toEqual((await f.read())?.aggregatedContent);
});

it('suppresses preview effects after cancellation without changing canonical output aggregation', async () => {
  const f = await fixture();
  f.execution.abort();
  const write = jest.spyOn(f.store, 'appendChunk');
  await f.emit('Final provider text');
  expect(write).not.toHaveBeenCalled();
  expect(f.aggregator.getText()).toBe('Final provider text');
});

it('preview transport failure degrades quietly and never aborts or replays canonical aggregation', async () => {
  const f = await fixture();
  const write = jest
    .spyOn(f.store, 'appendChunk')
    .mockRejectedValueOnce(new Error('private transport diagnostics'));
  await expect(f.emit('First')).resolves.toBeUndefined();
  await f.emit(' second');
  expect(f.aggregator.getText()).toBe('First second');
  expect(write).toHaveBeenCalledTimes(1);
});

it('refuses a mismatched owner before any preview publication', async () => {
  const f = await fixture();
  f.record.userId = 'other-user';
  const write = jest.spyOn(f.store, 'appendChunk');
  await f.emit('Private answer');
  expect(write).not.toHaveBeenCalled();
  expect((await f.read())?.aggregatedContent).toEqual([]);
});

it('checks the provider segment before every append after a same-generation owner change', async () => {
  const f = await fixture();
  const append = jest.spyOn(f.store, 'appendChunk');
  await f.emit('Before takeover');
  expect(append).toHaveBeenCalledTimes(2);
  await f.store.updateJob(
    f.record.responseId,
    { providerExecutionId: 'new-provider-segment' },
    f.execution.createdAt,
  );
  await f.emit(' stale text');
  expect(append).toHaveBeenCalledTimes(2);
  expect(f.aggregator.getText()).toBe('Before takeover stale text');
  expect((await f.read())?.aggregatedContent).toEqual([
    { type: ContentTypes.TEXT, text: 'Before takeover' },
  ]);
});
