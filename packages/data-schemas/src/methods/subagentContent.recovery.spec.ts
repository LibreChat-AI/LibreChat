import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { CommandStartedEvent, Collection } from 'mongodb';
import type { Model } from 'mongoose';
import type { SubagentContentBatch, SubagentContentScope } from './subagentContent';
import type { ISubagentContentChunk } from '../models/subagentContent';
import { createSubagentContentModel } from '../models/subagentContent';
import { createSubagentContentMethods } from './subagentContent';

let mongo: MongoMemoryServer;
let Content: Model<ISubagentContentChunk>;
let collection: Collection<ISubagentContentChunk>;
const scope: SubagentContentScope = {
  tenantId: 'tenant',
  user: 'owner',
  parentConversationId: 'parent',
  conversationId: 'child',
  taskId: 'task',
};
const methods = createSubagentContentMethods(mongoose);
const queries: CommandStartedEvent['command'][] = [];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  Content = createSubagentContentModel(mongoose);
  await mongoose.connect(mongo.getUri(), { monitorCommands: true });
  await Content.init();
  collection = mongoose.connection.db!.collection<ISubagentContentChunk>(Content.collection.name);
  mongoose.connection.getClient().on('commandStarted', (event: CommandStartedEvent) => {
    if (event.commandName === 'find' && event.command.find === 'subagentcontents') {
      queries.push(event.command);
    }
  });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Content.deleteMany({});
  queries.length = 0;
});

function records(revision: number, target = scope, expiredAt?: Date): ISubagentContentChunk[] {
  const payload = JSON.stringify([{ sequence: revision * 3 - 3 }, { sequence: revision * 3 - 1 }]);
  const { tenantId, ...identity } = target;
  const base = {
    ...identity,
    ...(tenantId == null ? {} : { tenantId }),
    revision,
    fromSequence: revision * 3 - 3,
    throughSequence: revision * 3 - 1,
    fragments: 1,
    digest: createHash('sha256').update(payload).digest('hex'),
    ...(expiredAt == null ? {} : { expiredAt }),
  };
  return [
    { ...base, _id: randomUUID(), fragment: -1 },
    { ...base, _id: randomUUID(), fragment: 0, payload },
  ];
}

async function read(throughRevision: number, afterSequence = -1, target = scope) {
  const batches: SubagentContentBatch[] = [];
  for await (const batch of methods.streamSubagentContentBatches(
    target,
    throughRevision,
    afterSequence,
  )) {
    batches.push(batch);
  }
  return batches;
}

async function stats() {
  const result = [];
  for (const command of queries.splice(0)) {
    const { find, filter, sort, hint, limit, projection } = command;
    const explain = await mongoose.connection.db!.command({
      explain: {
        find,
        filter,
        sort,
        ...(hint ? { hint } : {}),
        ...(limit ? { limit } : {}),
        ...(projection ? { projection } : {}),
      },
      verbosity: 'executionStats',
    });
    result.push(explain.executionStats);
    if (filter.fragment === -1 && sort.throughSequence === 1) {
      expect(hint).toBeUndefined();
      expect(JSON.stringify(explain.queryPlanner.winningPlan)).toContain(
        'subagent_content_sequence',
      );
    }
    expect(JSON.stringify(explain.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
    expect(JSON.stringify(explain.queryPlanner.winningPlan)).not.toContain('"stage":"SORT"');
  }
  return {
    queries: result.length,
    documents: result.reduce((sum, item) => sum + item.totalDocsExamined, 0),
    keys: result.reduce((sum, item) => sum + item.totalKeysExamined, 0),
  };
}

it.each([100, 1000, 5000])(
  'seeks suffixes independently of %i retained revisions',
  async (count) => {
    await collection.insertMany(
      Array.from({ length: count }, (_, index) => records(index + 1)).flat(),
    );
    queries.length = 0;
    expect(await methods.getSubagentContentHead(scope)).toEqual({
      revision: count,
      throughSequence: count * 3 - 1,
    });
    const head = await stats();
    expect(head.documents).toBe(1);
    expect(head.keys).toBeLessThanOrEqual(3);
    expect(await methods.getSubagentContentHead(scope, Math.floor(count / 2))).toEqual({
      revision: Math.floor(count / 2),
      throughSequence: Math.floor(count / 2) * 3 - 1,
    });
    const pinnedHead = await stats();
    expect(pinnedHead.documents).toBe(1);
    expect(pinnedHead.keys).toBeLessThanOrEqual(3);
    expect((await read(count, count * 3 - 4)).map((batch) => batch.revision)).toEqual([count]);
    const suffix = await stats();
    expect(suffix).toMatchObject({ queries: 2, documents: 3 });
    expect(suffix.keys).toBeLessThanOrEqual(5);

    expect(await read(count, count * 3 - 1)).toEqual([]);
    const empty = await stats();
    expect(empty).toMatchObject({ queries: 1, documents: 0 });
    expect(empty.keys).toBeLessThanOrEqual(1);

    expect((await read(count)).length).toBe(count);
    const initial = await stats();
    expect(initial).toMatchObject({ queries: 1, documents: count * 2, keys: count * 2 });

    const pin = Math.floor(count / 2);
    // Resume inside the last pinned batch, not just at a batch boundary.
    expect((await read(pin, pin * 3 - 3)).map((batch) => batch.revision)).toEqual([pin]);
    const midBatch = await stats();
    expect(midBatch.documents).toBe(3);
    expect(midBatch.keys).toBeLessThanOrEqual(5);
    expect(await read(pin, pin * 3 - 1)).toEqual([]);
    const pinnedEmpty = await stats();
    expect(pinnedEmpty).toMatchObject({ queries: 1, documents: 1, keys: 1 });
    console.log(
      JSON.stringify({
        measurement: 'indexed_recovery',
        revisions: count,
        head,
        pinnedHead,
        suffix,
        empty,
        initial,
        midBatch,
        pinnedEmpty,
      }),
    );
  },
);

it('keeps the sampled pin after later commits and isolates every scope field', async () => {
  const neighbors = [
    { ...scope, tenantId: 'foreign' },
    { ...scope, user: 'foreign' },
    { ...scope, parentConversationId: 'foreign' },
    { ...scope, conversationId: 'foreign' },
    { ...scope, taskId: 'foreign' },
    { ...scope, tenantId: undefined },
  ];
  // The unique revision index intentionally rejects reusing a child/task in another parent.
  await collection.insertMany([
    ...records(1),
    ...records(2),
    ...neighbors
      .filter((item) => item.parentConversationId === scope.parentConversationId)
      .flatMap((item) => records(1, item)),
  ]);
  const pin = await methods.getSubagentContentHead(scope);
  await collection.insertMany(records(3));
  expect((await read(pin!.revision, 3)).map((batch) => batch.revision)).toEqual([2]);
  expect(await read(pin!.revision, 5)).toEqual([]);
  for (const neighbor of neighbors) {
    const batches = await read(3, -1, neighbor);
    expect(batches.map((batch) => batch.revision)).toEqual(
      neighbor.parentConversationId === 'foreign' ? [] : [1],
    );
  }
});

it('excludes actively expired commits and fragments without relying on TTL cleanup', async () => {
  await collection.insertMany([...records(1), ...records(2, scope, new Date(0))]);
  expect(await methods.getSubagentContentHead(scope)).toEqual({ revision: 1, throughSequence: 2 });
  expect((await read(2)).map((batch) => batch.revision)).toEqual([1]);
  expect(await read(2, 2)).toEqual([]);
});

it.each(['missing', 'digest', 'fragment'] as const)(
  'rejects %s payload corruption after an indexed seek',
  async (failure) => {
    await collection.insertMany([...records(1), ...records(2)]);
    const filter = { ...scope, revision: 2, fragment: 0 };
    if (failure === 'missing') await Content.deleteOne(filter);
    if (failure === 'digest') await Content.updateOne(filter, { $set: { payload: 'tampered' } });
    if (failure === 'fragment') await Content.updateOne(filter, { $set: { fragment: 1 } });
    const errors = {
      missing: 'Incomplete committed',
      digest: 'Invalid committed subagent content digest',
      fragment: 'Invalid committed subagent content fragment',
    };
    await expect(read(2, 2)).rejects.toThrow(errors[failure]);
  },
);

it('reads safely before the sequence index is built, then restores the test index', async () => {
  await collection.insertMany([...records(1), ...records(2)]);
  await collection.dropIndex('subagent_content_sequence');
  try {
    expect((await read(2, 2)).map((batch) => batch.revision)).toEqual([2]);
    expect(await read(2, 5)).toEqual([]);
    expect(await read(1, 2)).toEqual([]);
  } finally {
    await Content.createIndexes();
  }
});
