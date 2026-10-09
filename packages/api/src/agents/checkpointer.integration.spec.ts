import mongoose from 'mongoose';
import { logger } from '@librechat/data-schemas';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import { emptyCheckpoint, ERROR, INTERRUPT } from '@langchain/langgraph-checkpoint';
import {
  getAgentCheckpointer,
  hasDurableAgentInterruptCheckpoint,
  captureAgentCheckpointGeneration,
  deleteAgentCheckpoint,
  deleteOwnedAgentCheckpoints,
  forkAgentEventCheckpoint,
  captureAgentEventCheckpoint,
  LazyMongoSaver,
  CheckpointTooLargeError,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY,
  setupCheckpointIndexes,
  __resetCheckpointerForTests,
} from './checkpointer';
import { createCheckpointNamespace } from '../stream/checkpoints';

/**
 * Integration tests for the durable Mongo checkpointer seam, against a real
 * (in-memory) MongoDB. The unit spec covers config/selection with no connection;
 * this proves the part that actually matters for correctness — that a checkpoint
 * written for a thread can be read back and that `deleteAgentCheckpoint` truly
 * prunes it (the cross-turn isolation guarantee), scoped to a single thread.
 */

const MONGO_CFG = { type: 'mongo' as const, ttl: 3600 };

/** Minimal LangGraph put() args for an empty checkpoint under a thread. */
function putArgs(threadId: string, checkpointNamespace = '') {
  const config = {
    configurable: { thread_id: threadId, checkpoint_ns: checkpointNamespace },
  };
  const metadata = { source: 'input' as const, step: -1, writes: null, parents: {} };
  return { config, checkpoint: emptyCheckpoint(), metadata };
}

const readConfig = (threadId: string, checkpointNamespace = '') => ({
  configurable: { thread_id: threadId, checkpoint_ns: checkpointNamespace },
});

/**
 * Persist a checkpoint the way LangGraph does on a PAUSE: an interrupt `putWrites` on the
 * `INTERRUPT` channel for the checkpoint id, then `put` of that checkpoint. The lazy saver
 * persists only checkpoints seeded this way (a bare `put` is a clean exit → discarded).
 */
async function seedInterruptCheckpoint(
  saver: MongoDBSaver,
  threadId: string,
  checkpointNamespace = '',
  interruptId = 'interrupt-current',
) {
  const { config, checkpoint, metadata } = putArgs(threadId, checkpointNamespace);
  await saver.putWrites(
    {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id,
      },
    },
    [[INTERRUPT, { id: interruptId, value: 'approve?' }]],
    'task-1',
  );
  await saver.put(config, checkpoint, metadata);
  return checkpoint;
}

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(() => {
  // Force a fresh saver build (+ setup) against the live connection each test.
  __resetCheckpointerForTests();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('checkpointer (mongodb-memory-server integration)', () => {
  it('builds a real MongoDBSaver when Mongo is connected', async () => {
    const saver = await getAgentCheckpointer(MONGO_CFG);
    expect(saver).toBeDefined();
    // setup() created the checkpoint collection with a TTL index on `upserted_at`.
    const indexes = await mongoose.connection.db!.collection('agent_checkpoints').indexes();
    const ttlIndex = indexes.find((idx) => idx.expireAfterSeconds != null);
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex?.expireAfterSeconds).toBe(3600);
  });

  it('verifies that an interrupt write has its matching durable checkpoint', async () => {
    const saver = await getAgentCheckpointer(MONGO_CFG);
    expect(saver).toBeDefined();
    const missingIdentity = {
      checkpointId: 'missing-checkpoint',
      interruptId: 'interrupt-current',
    };
    await expect(
      hasDurableAgentInterruptCheckpoint('verified-pause', MONGO_CFG, missingIdentity),
    ).resolves.toBe(false);

    const checkpoint = await seedInterruptCheckpoint(saver!, 'verified-pause');
    const identity = {
      checkpointId: checkpoint.id,
      interruptId: 'interrupt-current',
    };

    await expect(
      hasDurableAgentInterruptCheckpoint('verified-pause', MONGO_CFG, identity),
    ).resolves.toBe(true);
    await expect(
      hasDurableAgentInterruptCheckpoint('verified-pause', MONGO_CFG, missingIdentity),
    ).resolves.toBe(false);
    await expect(
      hasDurableAgentInterruptCheckpoint('verified-pause', MONGO_CFG, {
        ...identity,
        interruptId: 'interrupt-stale',
      }),
    ).resolves.toBe(false);
    await mongoose.connection.db!.collection('agent_checkpoints').deleteMany({
      thread_id: 'verified-pause',
    });
    await expect(
      hasDurableAgentInterruptCheckpoint('verified-pause', MONGO_CFG, identity),
    ).resolves.toBe(false);
  });

  it("uses Mongoose's selected database instead of the MongoClient URI default", async () => {
    await mongoose.disconnect();
    await mongoose.connect(mongoServer.getUri('driver_default'), { dbName: 'active_app' });
    __resetCheckpointerForTests();

    const saver = await getAgentCheckpointer(MONGO_CFG);
    expect(saver).toBeDefined();
    await seedInterruptCheckpoint(saver!, 'db-selection-pause');

    expect(
      await mongoose.connection.db!.collection('agent_checkpoints').countDocuments({
        thread_id: 'db-selection-pause',
      }),
    ).toBe(1);
    expect(
      await mongoose.connection
        .getClient()
        .db('driver_default')
        .collection('agent_checkpoints')
        .countDocuments({
          thread_id: 'db-selection-pause',
        }),
    ).toBe(0);
  });

  it('returns undefined for the memory type (SDK MemorySaver fallback) even when connected', async () => {
    expect(await getAgentCheckpointer({ type: 'memory' })).toBeUndefined();
  });

  it('memoizes one saver per resolved config', async () => {
    const a = await getAgentCheckpointer(MONGO_CFG);
    const b = await getAgentCheckpointer(MONGO_CFG);
    expect(a).toBe(b);
  });

  it('persists clean event-actor exits and forks only the committed checkpoint', async () => {
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `actor-${new mongoose.Types.ObjectId().toString()}`;
    const checkpoint = emptyCheckpoint();
    const config = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: '',
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'event-actor/base',
        [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: 'event-1',
      },
    };
    await saver!.put(config, checkpoint, {
      source: 'input',
      step: -1,
      parents: {},
    });

    await expect(
      captureAgentEventCheckpoint(threadId, 'event-actor/base', 'event-1', MONGO_CFG),
    ).resolves.toEqual({
      threadId,
      checkpointId: checkpoint.id,
      checkpointNs: 'event-actor/base',
    });
    await expect(
      forkAgentEventCheckpoint(
        { threadId, checkpointId: checkpoint.id, checkpointNs: 'event-actor/base' },
        'event-actor/fork',
        'event-2',
        MONGO_CFG,
      ),
    ).resolves.toEqual({
      threadId,
      checkpointId: checkpoint.id,
      checkpointNs: 'event-actor/fork',
    });
    expect(
      await mongoose.connection
        .db!.collection('agent_checkpoints')
        .countDocuments({ thread_id: threadId }),
    ).toBe(2);
  });

  it('replaces checkpoint-carried Skill context while preserving the committed base', async () => {
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `actor-${new mongoose.Types.ObjectId().toString()}`;
    const checkpoint = emptyCheckpoint();
    checkpoint.channel_values.messages = [
      new HumanMessage({ content: 'ordinary history' }),
      new HumanMessage({
        content: 'old skill body',
        additional_kwargs: { isMeta: true, source: 'skill', skillName: 'analysis' },
      }),
    ];
    checkpoint.channel_versions.messages = 1;
    const sourceConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: '',
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'event-actor/base',
        [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: 'event-1',
      },
    };
    await saver!.put(sourceConfig, checkpoint, {
      source: 'input',
      step: -1,
      parents: {},
    });

    await forkAgentEventCheckpoint(
      { threadId, checkpointId: checkpoint.id, checkpointNs: 'event-actor/base' },
      'event-actor/fork',
      'event-2',
      MONGO_CFG,
      {
        source: 'skill',
        messages: [
          new HumanMessage({
            content: 'current skill body',
            additional_kwargs: { isMeta: true, source: 'skill', skillName: 'analysis' },
          }),
        ],
      },
    );

    const source = await saver!.getTuple(sourceConfig);
    const fork = await saver!.getTuple({
      configurable: {
        thread_id: threadId,
        checkpoint_ns: '',
        checkpoint_id: checkpoint.id,
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'event-actor/fork',
        [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: 'event-2',
      },
    });
    expect(
      (source?.checkpoint.channel_values.messages as HumanMessage[]).map(
        (message) => message.content,
      ),
    ).toEqual(['ordinary history', 'old skill body']);
    expect(
      (fork?.checkpoint.channel_values.messages as HumanMessage[]).map(
        (message) => message.content,
      ),
    ).toEqual(['ordinary history', 'current skill body']);
  });

  it('warm-continues from a copied actor head without mutating the committed base', async () => {
    const { StateGraph, START, END, Annotation } = await import('@langchain/langgraph');
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `actor-${new mongoose.Types.ObjectId().toString()}`;
    const State = Annotation.Root({
      events: Annotation<string[]>({
        reducer: (left, right) => [...left, ...right],
        default: () => [],
      }),
    });
    const graph = new StateGraph(State)
      .addNode('observe', (state: { events: string[] }) => ({
        events: [`seen:${state.events[state.events.length - 1]}`],
      }))
      .addEdge(START, 'observe')
      .addEdge('observe', END)
      .compile({ checkpointer: saver as never });
    const config = (checkpointNamespace: string, invocationId: string, checkpointId?: string) => ({
      configurable: {
        thread_id: threadId,
        checkpoint_ns: '',
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: checkpointNamespace,
        [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: invocationId,
        ...(checkpointId == null ? {} : { checkpoint_id: checkpointId }),
      },
      durability: 'exit' as const,
    });

    await graph.invoke({ events: ['event-1'] }, config('event-actor/base', 'event-1'));
    const base = await captureAgentEventCheckpoint(
      threadId,
      'event-actor/base',
      'event-1',
      MONGO_CFG,
    );
    expect(base).not.toBeNull();
    const fork = await forkAgentEventCheckpoint(base!, 'event-actor/fork', 'event-2', MONGO_CFG);
    expect(fork).not.toBeNull();

    const warm = await graph.invoke(
      { events: ['event-2'] },
      config('event-actor/fork', 'event-2', fork!.checkpointId),
    );
    expect(warm.events).toEqual(['event-1', 'seen:event-1', 'event-2', 'seen:event-2']);
    const committedBase = await saver!.getTuple({
      configurable: {
        thread_id: threadId,
        checkpoint_ns: '',
        checkpoint_id: base!.checkpointId,
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'event-actor/base',
      },
    });
    expect(committedBase?.checkpoint.channel_values.events).toEqual(['event-1', 'seen:event-1']);
  });

  it('cold-rebuilds in a fresh namespace when an invalidated head id is not copied', async () => {
    const { StateGraph, START, END, Annotation } = await import('@langchain/langgraph');
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `actor-${new mongoose.Types.ObjectId().toString()}`;
    const State = Annotation.Root({
      events: Annotation<string[]>({
        reducer: (left, right) => [...left, ...right],
        default: () => [],
      }),
    });
    const graph = new StateGraph(State)
      .addNode('observe', (state: { events: string[] }) => ({
        events: [`seen:${state.events[state.events.length - 1]}`],
      }))
      .addEdge(START, 'observe')
      .addEdge('observe', END)
      .compile({ checkpointer: saver as never });
    const config = (checkpointNamespace: string, invocationId: string, checkpointId?: string) => ({
      configurable: {
        thread_id: threadId,
        checkpoint_ns: '',
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: checkpointNamespace,
        [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: invocationId,
        ...(checkpointId == null ? {} : { checkpoint_id: checkpointId }),
      },
      durability: 'exit' as const,
    });

    await graph.invoke({ events: ['legacy-before'] }, config('event-actor/base', 'event-1'));
    const base = await captureAgentEventCheckpoint(
      threadId,
      'event-actor/base',
      'event-1',
      MONGO_CFG,
    );
    expect(base).not.toBeNull();

    const rebuilt = await graph.invoke(
      { events: ['event-after-legacy'] },
      config('event-actor/cold', 'event-2', base!.checkpointId),
    );
    expect(rebuilt.events).toEqual(['event-after-legacy', 'seen:event-after-legacy']);
  });

  it('deleteAgentCheckpoint prunes a thread’s persisted checkpoint', async () => {
    const saver = await getAgentCheckpointer(MONGO_CFG);
    expect(saver).toBeDefined();

    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;
    await seedInterruptCheckpoint(saver!, threadId);

    // The checkpoint is durably readable before pruning…
    expect(await saver!.getTuple(readConfig(threadId))).toBeDefined();

    await deleteAgentCheckpoint(threadId, MONGO_CFG);

    // …and gone after (so turn N+1 on the same conversationId can't rehydrate it).
    expect(await saver!.getTuple(readConfig(threadId))).toBeUndefined();
  });

  it('captured legacy cleanup prunes nested graph checkpoints and writes without a thread-wide delete', async () => {
    const { StateGraph, START, END, interrupt, Annotation } = await import('@langchain/langgraph');
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;

    const State = Annotation.Root({
      origin: Annotation,
      approved: Annotation,
    });
    const child = new StateGraph(State)
      .addNode('child-gate', (state: { origin?: string }) => ({
        approved: interrupt(`approve-${state.origin}`),
      }))
      .addEdge(START, 'child-gate')
      .addEdge('child-gate', END)
      .compile();
    const graph = new StateGraph(State)
      .addNode('child', child)
      .addEdge(START, 'child')
      .addEdge('child', END)
      .compile({ checkpointer: saver as never });
    const config = {
      configurable: { thread_id: threadId, checkpoint_ns: '' },
      durability: 'exit' as const,
    };

    await graph.invoke({ origin: 'legacy', approved: null }, config);

    const db = mongoose.connection.db!;
    const storedNamespaces = await db
      .collection('agent_checkpoints')
      .distinct('checkpoint_ns', { thread_id: threadId });
    expect(storedNamespaces).toContain('');
    expect(storedNamespaces.some((namespace) => namespace.startsWith('child:'))).toBe(true);
    expect(
      await db.collection('agent_checkpoint_writes').countDocuments({ thread_id: threadId }),
    ).toBeGreaterThan(0);

    const generation = await captureAgentCheckpointGeneration(threadId, MONGO_CFG, {
      throwOnError: true,
    });
    const replacement = await seedInterruptCheckpoint(saver!, threadId, '2000');
    await expect(
      deleteAgentCheckpoint(threadId, MONGO_CFG, undefined, {
        throwOnError: true,
        checkpointNamespace: '',
      }),
    ).rejects.toThrow('requires a captured checkpoint generation');
    await deleteAgentCheckpoint(threadId, MONGO_CFG, generation, { throwOnError: true });

    expect(await db.collection('agent_checkpoints').countDocuments({ thread_id: threadId })).toBe(
      1,
    );
    expect(
      await db
        .collection('agent_checkpoints')
        .countDocuments({ thread_id: threadId, checkpoint_ns: { $ne: '2000' } }),
    ).toBe(0);
    expect(
      await db.collection('agent_checkpoint_writes').countDocuments({ thread_id: threadId }),
    ).toBe(1);
    expect(await saver!.getTuple(readConfig(threadId, '2000'))).toMatchObject({
      checkpoint: { id: replacement.id },
    });
  });

  it('prunes only the targeted thread, leaving other conversations intact', async () => {
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadA = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const threadB = `convo-${new mongoose.Types.ObjectId().toString()}`;

    await seedInterruptCheckpoint(saver!, threadA);
    await seedInterruptCheckpoint(saver!, threadB);

    await deleteAgentCheckpoint(threadA, MONGO_CFG);

    expect(await saver!.getTuple(readConfig(threadA))).toBeUndefined();
    expect(await saver!.getTuple(readConfig(threadB))).toBeDefined();
  });

  it('scheduled namespace capture prunes root and nested writes while preserving a replacement', async () => {
    const db = mongoose.connection.db!;
    const threadId = 'scheduled-owned-run';
    const namespace = createCheckpointNamespace('owner', 'tenant');
    const replacement = createCheckpointNamespace('owner', 'tenant');
    const rows = [namespace, `${namespace}|child`, replacement, ''].map((checkpoint_ns) => ({
      thread_id: threadId,
      checkpoint_ns,
      checkpoint_id: 'same-checkpoint-id',
    }));
    for (const name of ['agent_checkpoints', 'agent_checkpoint_writes']) {
      await db.collection(name).insertMany(rows.map((row) => ({ ...row })));
    }
    const capture = await captureAgentCheckpointGeneration(threadId, MONGO_CFG, {
      checkpointNamespace: namespace,
      throwOnError: true,
    });
    expect(capture?.checkpointIds).toContain('same-checkpoint-id');
    await deleteAgentCheckpoint(threadId, MONGO_CFG, capture, { throwOnError: true });
    for (const name of ['agent_checkpoints', 'agent_checkpoint_writes']) {
      expect(await db.collection(name).distinct('checkpoint_ns', { thread_id: threadId })).toEqual(
        expect.arrayContaining([replacement, '']),
      );
      expect(await db.collection(name).countDocuments({ thread_id: threadId })).toBe(2);
    }
  });

  it('generation-scoped cleanup preserves a replacement checkpoint on the same thread', async () => {
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const resumed = await seedInterruptCheckpoint(saver!, threadId);
    const generation = await captureAgentCheckpointGeneration(threadId, MONGO_CFG);

    const replacement = await seedInterruptCheckpoint(saver!, threadId);
    await deleteAgentCheckpoint(threadId, MONGO_CFG, generation);

    expect(await saver!.getTuple(readConfig(threadId))).toMatchObject({
      checkpoint: { id: replacement.id },
    });
    expect(
      await saver!.getTuple({
        configurable: {
          thread_id: threadId,
          checkpoint_ns: '',
          checkpoint_id: resumed.id,
        },
      }),
    ).toBeUndefined();
    expect(
      await mongoose.connection
        .db!.collection('agent_checkpoint_writes')
        .countDocuments({ thread_id: threadId, checkpoint_id: replacement.id }),
    ).toBe(1);
    expect(
      await mongoose.connection
        .db!.collection('agent_checkpoint_writes')
        .countDocuments({ thread_id: threadId, checkpoint_id: resumed.id }),
    ).toBe(0);
  });

  it('legacy capture and cleanup preserve ordinary owned payload even with matching checkpoint IDs', async () => {
    const saver = (await getAgentCheckpointer(MONGO_CFG))!;
    const threadId = 'legacy-owner-collision';
    const legacy = await seedInterruptCheckpoint(saver, threadId);
    const ownedNamespace = createCheckpointNamespace('other-owner', 'tenant');
    const db = mongoose.connection.db!;
    for (const name of ['agent_checkpoints', 'agent_checkpoint_writes']) {
      const row = await db.collection(name).findOne({ thread_id: threadId });
      const { _id, ...payload } = row!;
      await db.collection(name).insertOne({ ...payload, checkpoint_ns: ownedNamespace });
      await db
        .collection(name)
        .insertOne({ ...payload, checkpoint_id: 'only-owned', checkpoint_ns: ownedNamespace });
    }
    const captured = await captureAgentCheckpointGeneration(threadId, MONGO_CFG);
    expect(captured.checkpointIds).toEqual([legacy.id]);
    await deleteAgentCheckpoint(threadId, MONGO_CFG, captured, { throwOnError: true });
    await deleteAgentCheckpoint(threadId, MONGO_CFG, undefined, { throwOnError: true });
    for (const name of ['agent_checkpoints', 'agent_checkpoint_writes']) {
      const rows = await db.collection(name).find({ thread_id: threadId }).toArray();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.checkpoint_ns === ownedNamespace)).toBe(true);
    }
    await deleteAgentCheckpoint(threadId, MONGO_CFG, undefined, {
      checkpointNamespace: ownedNamespace,
      throwOnError: true,
    });
    expect(await db.collection('agent_checkpoints').countDocuments({ thread_id: threadId })).toBe(
      0,
    );
    expect(
      await db.collection('agent_checkpoint_writes').countDocuments({ thread_id: threadId }),
    ).toBe(0);
  });

  it('isolates a fresh generation from a predecessor checkpoint written after replacement', async () => {
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const predecessorNamespace = '1000';
    const replacementNamespace = '2000';

    await seedInterruptCheckpoint(saver!, threadId, predecessorNamespace);
    // Fresh B prunes only its own namespace before graph construction. A is
    // still running remotely and writes another interrupt after that barrier.
    await deleteAgentCheckpoint(threadId, MONGO_CFG, undefined, {
      checkpointNamespace: replacementNamespace,
    });
    const latePredecessor = await seedInterruptCheckpoint(saver!, threadId, predecessorNamespace);

    expect(await saver!.getTuple(readConfig(threadId, replacementNamespace))).toBeUndefined();
    const replacement = await seedInterruptCheckpoint(saver!, threadId, replacementNamespace);
    expect(await saver!.getTuple(readConfig(threadId, replacementNamespace))).toMatchObject({
      checkpoint: { id: replacement.id },
    });
    expect(await saver!.getTuple(readConfig(threadId, predecessorNamespace))).toMatchObject({
      checkpoint: { id: latePredecessor.id },
    });
  });

  it('adapts LangGraph root namespaces and prevents a late predecessor pause from hydrating into its replacement', async () => {
    const { StateGraph, START, END, interrupt, Annotation, Command } = await import(
      '@langchain/langgraph'
    );
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;

    const State = Annotation.Root({
      origin: Annotation,
      approved: Annotation,
    });
    const graph = new StateGraph(State)
      .addNode('gate', (state: { origin?: string }) => ({
        approved: interrupt(`approve-${state.origin}`),
      }))
      .addEdge(START, 'gate')
      .addEdge('gate', END)
      .compile({ checkpointer: saver as never });

    const scopedConfig = (generation: string, graphNamespace = '') => ({
      configurable: {
        thread_id: threadId,
        checkpoint_ns: graphNamespace,
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: generation,
      },
      durability: 'exit' as const,
    });
    // Deliberately nonempty on the initial root calls: PregelLoop.initialize
    // resets these to ''. The ordinary client wiring uses the normalized
    // configs below on both fresh and resume calls.
    const replacementStartConfig = scopedConfig('generation-b', 'caller-root-generation-b');
    const predecessorStartConfig = scopedConfig('generation-a', 'caller-root-generation-a');
    const replacementConfig = scopedConfig('generation-b');
    const predecessorConfig = scopedConfig('generation-a');

    // B has started and paused. A's remote owner then lands a late pause on
    // the same conversation thread; physical namespaces must keep it out of B.
    await graph.invoke({ origin: 'B', approved: null }, replacementStartConfig);
    await graph.invoke({ origin: 'A', approved: null }, predecessorStartConfig);

    const storedNamespaces = await mongoose.connection
      .db!.collection('agent_checkpoints')
      .distinct('checkpoint_ns', { thread_id: threadId });
    expect(new Set(storedNamespaces)).toEqual(new Set(['generation-a', 'generation-b']));
    expect(storedNamespaces).not.toContain('');
    expect(storedNamespaces).not.toContain('caller-root-generation-a');
    expect(storedNamespaces).not.toContain('caller-root-generation-b');

    const replacementState = await graph.getState(replacementConfig);
    expect(replacementState.values).toMatchObject({ origin: 'B' });
    const listedReplacementCheckpoints = [];
    for await (const tuple of saver!.list(replacementConfig)) {
      listedReplacementCheckpoints.push(tuple);
    }
    expect(listedReplacementCheckpoints.length).toBeGreaterThan(0);
    expect(
      listedReplacementCheckpoints.every(
        (tuple) =>
          tuple.config.configurable?.checkpoint_ns === '' &&
          tuple.config.configurable?.[LIBRECHAT_CHECKPOINT_NAMESPACE_KEY] === 'generation-b',
      ),
    ).toBe(true);
    const replacementResult = await graph.invoke(
      new Command({ resume: 'YES-B' }),
      replacementConfig,
    );
    expect(replacementResult).toMatchObject({ origin: 'B', approved: 'YES-B' });

    // Terminal B cleanup removes its whole namespace, including any write
    // committed after an earlier snapshot, while late A remains resumable.
    await deleteAgentCheckpoint(threadId, MONGO_CFG, undefined, {
      checkpointNamespace: 'generation-b',
    });
    expect(await graph.getState(replacementConfig)).toMatchObject({ next: [] });
    expect(await graph.getState(predecessorConfig)).toMatchObject({
      values: expect.objectContaining({ origin: 'A' }),
      next: expect.arrayContaining(['gate']),
    });
  });

  it('deleteAgentCheckpoint is a no-op for an undefined threadId', async () => {
    await expect(deleteAgentCheckpoint(undefined, MONGO_CFG)).resolves.toBeUndefined();
  });

  it('bulk-deletes only an owned generation scope when thread IDs collide', async () => {
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `collision-${new mongoose.Types.ObjectId().toString()}`;
    const ownedNamespace = createCheckpointNamespace('owner', 'tenant');
    await seedInterruptCheckpoint(saver!, threadId, ownedNamespace);
    await seedInterruptCheckpoint(saver!, threadId, `${ownedNamespace}|subgraph`);
    await seedInterruptCheckpoint(saver!, threadId, 'foreign-generation');
    await seedInterruptCheckpoint(saver!, threadId, '');

    await deleteOwnedAgentCheckpoints('owner', 'tenant', [threadId, threadId], MONGO_CFG);

    expect(await saver!.getTuple(readConfig(threadId, ownedNamespace))).toBeUndefined();
    expect(
      await saver!.getTuple(readConfig(threadId, `${ownedNamespace}|subgraph`)),
    ).toBeUndefined();
    expect(await saver!.getTuple(readConfig(threadId, 'foreign-generation'))).toBeDefined();
    expect(await saver!.getTuple(readConfig(threadId, ''))).toBeDefined();
    const db = mongoose.connection.db!;
    expect(
      await db.collection('agent_checkpoint_writes').countDocuments({
        thread_id: threadId,
        checkpoint_ns: { $in: [ownedNamespace, `${ownedNamespace}|subgraph`] },
      }),
    ).toBe(0);
    expect(
      await db.collection('agent_checkpoint_writes').countDocuments({ thread_id: threadId }),
    ).toBe(2);
  });

  it('propagates a bulk checkpoint deletion failure for retry', async () => {
    const deletion = jest
      .spyOn(mongoose.mongo.Collection.prototype, 'deleteMany')
      .mockRejectedValueOnce(new Error('checkpoint deletion unavailable'));
    try {
      await expect(
        deleteOwnedAgentCheckpoints('owner', 'tenant', ['conversation-1'], MONGO_CFG),
      ).rejects.toThrow('checkpoint deletion unavailable');
    } finally {
      deletion.mockRestore();
    }
  });
});

describe('LazyMongoSaver (lazy persistence — mongodb-memory-server)', () => {
  it('does NOT persist a clean-exit checkpoint (a bare put with no pending writes)', async () => {
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const { config, checkpoint, metadata } = putArgs(threadId);

    // A non-paused run's exit put — no preceding putWrites.
    await saver!.put(config, checkpoint, metadata);

    expect(await saver!.getTuple(readConfig(threadId))).toBeUndefined();
    const count = await mongoose.connection
      .db!.collection('agent_checkpoints')
      .countDocuments({ thread_id: threadId });
    expect(count).toBe(0);
  });

  it('persists a checkpoint anchored by a NON-interrupt write (delta-channel safety)', async () => {
    // K1/K3: a delta-channel graph can putWrites on a checkpoint that an interrupt
    // checkpoint then depends on — even without the __interrupt__ marker. A write on a
    // real (non-`__`-prefixed) channel must anchor its checkpoint so resume can walk the chain.
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const { config, checkpoint, metadata } = putArgs(threadId);
    await saver!.putWrites(
      { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpoint.id } },
      [['some_delta_channel', { msgs: ['delta'] }]],
      'task-1',
    );
    await saver!.put(config, checkpoint, metadata);

    expect(await saver!.getTuple(readConfig(threadId))).toBeDefined();
  });

  it('does NOT persist an error-only checkpoint OR its write row (failed non-paused turn — no leak)', async () => {
    // A turn that throws before any pause records a pending write on the `__error__`
    // bookkeeping channel, then a `put` (probe-confirmed against @langchain/langgraph). That
    // checkpoint is never HITL-resumable, so the lazy saver must leave NOTHING durable: the
    // bookkeeping batch is PARKED (not forwarded) until the checkpoint's fate is known, and the
    // discarding `put` drops both — no dead checkpoint, no orphan row in the writes collection.
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const { config, checkpoint, metadata } = putArgs(threadId);
    await saver!.putWrites(
      { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpoint.id } },
      [[ERROR, 'boom']], // '__error__' — bookkeeping channel, not resumable
      'task-1',
    );
    await saver!.put(config, checkpoint, metadata);

    expect(await saver!.getTuple(readConfig(threadId))).toBeUndefined();
    const db = mongoose.connection.db!;
    expect(await db.collection('agent_checkpoints').countDocuments({ thread_id: threadId })).toBe(
      0,
    );
    expect(
      await db.collection('agent_checkpoint_writes').countDocuments({ thread_id: threadId }),
    ).toBe(0);
  });

  it('preserves bookkeeping writes on a RETAINED checkpoint, in either arrival order', async () => {
    // Codex M2 (probe-confirmed): when one Send-sibling interrupts, siblings that completed
    // without state updates are recorded as `__no_writes__` pending writes on the SAME retained
    // checkpoint. Those markers must persist — dropping them makes LangGraph re-execute the
    // completed siblings on resume (duplicated side effects). The saver parks bookkeeping
    // batches until the checkpoint is anchored, so both orders must end durable.
    const NO_WRITES = '__no_writes__'; // langgraph constants.NO_WRITES (runner marker)
    const saver = await getAgentCheckpointer(MONGO_CFG);

    const runOrder = async (bookkeepingFirst: boolean) => {
      const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;
      const { config, checkpoint, metadata } = putArgs(threadId);
      const writeCfg = {
        configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpoint.id },
      };
      const bookkeeping = () => saver!.putWrites(writeCfg, [[NO_WRITES, null]], 'task-sibling');
      const anchor = () => saver!.putWrites(writeCfg, [[INTERRUPT, 'approve?']], 'task-gate');
      if (bookkeepingFirst) {
        await bookkeeping();
        await anchor();
      } else {
        await anchor();
        await bookkeeping();
      }
      await saver!.put(config, checkpoint, metadata);

      const tuple = await saver!.getTuple(readConfig(threadId));
      expect(tuple).toBeDefined();
      const channels = (tuple?.pendingWrites ?? []).map((w) => w[1]);
      expect(channels).toContain(INTERRUPT);
      expect(channels).toContain(NO_WRITES);
    };

    await runOrder(true); // parked, then flushed by the anchoring batch
    await runOrder(false); // forwarded directly (checkpoint already anchored)
  });

  it('un-anchors a checkpoint whose putWrites failed (no phantom pause persisted)', async () => {
    // A transient Mongo failure while writing the interrupt batch must not leave a persisted
    // checkpoint with MISSING pending writes: LangGraph dispatches the matching `put`
    // concurrently with `putWrites` (probe-confirmed), so the failed batch's anchor is removed
    // on rejection and that `put` discards the checkpoint instead of saving a phantom pause.
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const { config, checkpoint, metadata } = putArgs(threadId);

    const spy = jest
      .spyOn(MongoDBSaver.prototype, 'putWrites')
      .mockRejectedValueOnce(new Error('transient mongo failure'));
    try {
      await expect(
        saver!.putWrites(
          {
            configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpoint.id },
          },
          [[INTERRUPT, 'approve?']],
          'task-1',
        ),
      ).rejects.toThrow('transient mongo failure');
    } finally {
      spy.mockRestore();
    }

    // The `put` LangGraph issues for that checkpoint finds no anchor → discarded.
    await saver!.put(config, checkpoint, metadata);

    expect(await saver!.getTuple(readConfig(threadId))).toBeUndefined();
    const count = await mongoose.connection
      .db!.collection('agent_checkpoints')
      .countDocuments({ thread_id: threadId });
    expect(count).toBe(0);
  });

  it('persists an interrupt checkpoint and carries its __interrupt__ pending write', async () => {
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;
    await seedInterruptCheckpoint(saver!, threadId);

    const tuple = await saver!.getTuple(readConfig(threadId));
    expect(tuple).toBeDefined();
    // pendingWrites entries are [taskId, channel, value]; the interrupt is on INTERRUPT.
    expect((tuple?.pendingWrites ?? []).some((w) => w[1] === INTERRUPT)).toBe(true);
  });

  it('end-to-end: a real graph writes nothing on a clean run, a checkpoint on interrupt', async () => {
    const { StateGraph, START, END, interrupt, Annotation } = await import('@langchain/langgraph');
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const coll = mongoose.connection.db!.collection('agent_checkpoints');

    const State = Annotation.Root({ x: Annotation });
    const build = (withInterrupt: boolean) =>
      new StateGraph(State)
        .addNode('a', () => {
          if (withInterrupt) {
            interrupt('approve?');
          }
          return { x: 'done' };
        })
        .addEdge(START, 'a')
        .addEdge('a', END)
        // version skew between checkpoint-mongodb's BaseCheckpointSaver and langgraph's.
        .compile({ checkpointer: saver as never });

    // Clean run → nothing persisted.
    const tClean = `convo-${new mongoose.Types.ObjectId().toString()}`;
    await build(false).invoke(
      { x: 'start' },
      { configurable: { thread_id: tClean }, durability: 'exit' },
    );
    expect(await coll.countDocuments({ thread_id: tClean })).toBe(0);

    // Interrupt run → a checkpoint is persisted and the graph reports a pending pause.
    const tPause = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const pauseGraph = build(true);
    await pauseGraph.invoke(
      { x: 'start' },
      { configurable: { thread_id: tPause }, durability: 'exit' },
    );
    expect(await coll.countDocuments({ thread_id: tPause })).toBeGreaterThan(0);
    const state = await pauseGraph.getState({ configurable: { thread_id: tPause } });
    expect(state.next.length).toBeGreaterThan(0); // the interrupted node is still pending → resumable
  });

  it('end-to-end: a real graph that THROWS before pausing persists no checkpoint', async () => {
    // F2: a failed non-paused turn records an `__error__` pending write + a put. The lazy
    // saver must discard it so a conversation that errors (and is never retried) leaves nothing
    // durable behind — the clean-path prune that used to catch this was removed.
    const { StateGraph, START, END, Annotation } = await import('@langchain/langgraph');
    const saver = await getAgentCheckpointer(MONGO_CFG);
    const coll = mongoose.connection.db!.collection('agent_checkpoints');

    const State = Annotation.Root({ x: Annotation });
    const boomGraph = new StateGraph(State)
      .addNode('a', () => {
        throw new Error('boom');
      })
      .addEdge(START, 'a')
      .addEdge('a', END)
      .compile({ checkpointer: saver as never });

    const tErr = `convo-${new mongoose.Types.ObjectId().toString()}`;
    await expect(
      boomGraph.invoke({ x: 'start' }, { configurable: { thread_id: tErr }, durability: 'exit' }),
    ).rejects.toThrow('boom');

    // Nothing durable: neither the checkpoint nor an orphan row in the writes collection.
    expect(await coll.countDocuments({ thread_id: tErr })).toBe(0);
    const writesColl = mongoose.connection.db!.collection('agent_checkpoint_writes');
    expect(await writesColl.countDocuments({ thread_id: tErr })).toBe(0);
  });

  it('end-to-end: an interrupt persists, then resumes to completion with the approval value', async () => {
    // Guards the `putWrites` change: the `__interrupt__` write must still be forwarded (it is
    // resumable) so a paused run rehydrates and the resume value flows in. Mirrors the real HITL
    // round-trip across a fresh `invoke` on the same thread_id.
    const { StateGraph, START, END, interrupt, Annotation, Command } = await import(
      '@langchain/langgraph'
    );
    const saver = await getAgentCheckpointer(MONGO_CFG);

    const State = Annotation.Root({ approved: Annotation });
    const graph = new StateGraph(State)
      .addNode('gate', () => ({ approved: interrupt('approve?') }))
      .addNode('done', () => ({}))
      .addEdge(START, 'gate')
      .addEdge('gate', 'done')
      .addEdge('done', END)
      .compile({ checkpointer: saver as never });

    const thread = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const cfg = { configurable: { thread_id: thread }, durability: 'exit' as const };

    // Pause at the interrupt.
    await graph.invoke({ approved: null }, cfg);
    const paused = await graph.getState(cfg);
    expect(paused.next.length).toBeGreaterThan(0);

    // Resume with the approval — the paused run rehydrates from the durable interrupt checkpoint.
    const out = await graph.invoke(new Command({ resume: 'YES' }), cfg);
    expect(out.approved).toBe('YES');
  });

  it('end-to-end: completed Send-siblings are NOT re-executed after a pause (no duplicate side effects)', async () => {
    // Codex M2 end-to-end: a Send fan-out where 'b' pauses for approval while 'a'/'c' complete
    // with side effects but NO state writes (→ `__no_writes__` markers on the retained
    // checkpoint). On resume — through a REBUILT graph, as resume.js rebuilds the Run — the
    // completed siblings must not run again. Before the buffering fix this probe measured
    // effects {a:2, c:2}: the dropped markers made LangGraph re-execute both siblings.
    const { StateGraph, START, END, interrupt, Annotation, Send, Command } = await import(
      '@langchain/langgraph'
    );
    const saver = await getAgentCheckpointer(MONGO_CFG);

    const effects: Record<string, number> = {};
    const State = Annotation.Root({
      items: Annotation({ reducer: (a: string[], b: string[]) => (a ?? []).concat(b ?? []) }),
      results: Annotation({ reducer: (a: string[], b: string[]) => (a ?? []).concat(b ?? []) }),
    });
    const build = () =>
      new StateGraph(State)
        .addNode('fan', () => ({}))
        .addNode('work', (s: { item?: string }) => {
          if (s.item === 'b') {
            return { results: [`b:${interrupt('approve b?')}`] };
          }
          effects[s.item!] = (effects[s.item!] ?? 0) + 1; // side effect, no state update
          return {}; // no channel writes → langgraph records a `__no_writes__` marker
        })
        .addConditionalEdges(
          'fan',
          (s) => s.items.map((i: string) => new Send('work', { item: i })),
          ['work'],
        )
        .addEdge(START, 'fan')
        .addEdge('work', END)
        .compile({ checkpointer: saver as never });

    const thread = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const cfg = { configurable: { thread_id: thread }, durability: 'exit' as const };

    await build().invoke({ items: ['a', 'b', 'c'], results: [] }, cfg); // pauses on 'b'
    expect(effects).toEqual({ a: 1, c: 1 });

    // Resume on a REBUILT graph sharing the durable saver (mirrors resume.js).
    const out = await build().invoke(new Command({ resume: 'YES' }), cfg);
    expect(out.results).toEqual(['b:YES']);
    expect(effects).toEqual({ a: 1, c: 1 }); // siblings did NOT re-execute
  });
});

describe('LazyMongoSaver checkpoint size guard (mongodb-memory-server integration)', () => {
  // Guards the single-document ceiling: a checkpoint embeds the whole message history, so a
  // large conversation can serialize past MongoDB's 16 MB limit. The guard measures the
  // serialized state on the persist path, WARNS past a soft threshold, and REJECTS past a hard
  // limit BEFORE the write — a typed CheckpointTooLargeError instead of a raw BSONObjectTooLarge.
  // Thresholds are shrunk here so payloads stay tiny while exercising the real serde + Mongo.
  const clientForSaver = () =>
    // mongoose vends the live MongoClient; the driver type resolves to a different `mongodb` copy
    // than checkpoint-mongodb's, so the cast mirrors buildMongoSaver in checkpointer.ts.
    mongoose.connection.getClient() as unknown as ConstructorParameters<
      typeof MongoDBSaver
    >[0]['client'];

  const makeSaver = (overrides?: { warnBytes?: number; hardLimitBytes?: number }) =>
    new LazyMongoSaver({
      client: clientForSaver(),
      checkpointCollectionName: 'agent_checkpoints',
      checkpointWritesCollectionName: 'agent_checkpoint_writes',
      ttl: 3600,
      ...overrides,
    });

  /** Seed an interrupt anchor for a checkpoint whose serialized state is inflated to ~`payloadBytes`. */
  async function seedSizedInterrupt(saver: LazyMongoSaver, threadId: string, payloadBytes: number) {
    const checkpoint = emptyCheckpoint();
    checkpoint.channel_values = { messages: 'x'.repeat(payloadBytes) };
    await saver.putWrites(
      { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpoint.id } },
      [[INTERRUPT, 'approve?']],
      'task-1',
    );
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '' } };
    const metadata = { source: 'input' as const, step: -1, writes: null, parents: {} };
    return { checkpoint, config, metadata };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists a checkpoint under the soft threshold', async () => {
    const saver = makeSaver({ warnBytes: 5_000, hardLimitBytes: 50_000 });
    await saver.setup();
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const { checkpoint, config, metadata } = await seedSizedInterrupt(saver, threadId, 100);

    await saver.put(config, checkpoint, metadata);

    expect(await saver.getTuple(readConfig(threadId))).toBeDefined();
  });

  it('persists but WARNS when a checkpoint crosses the soft threshold', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const saver = makeSaver({ warnBytes: 500, hardLimitBytes: 50_000 });
    await saver.setup();
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const { checkpoint, config, metadata } = await seedSizedInterrupt(saver, threadId, 2_000);

    await saver.put(config, checkpoint, metadata);

    expect(await saver.getTuple(readConfig(threadId))).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('soft threshold'));
  });

  it('REFUSES to persist and throws CheckpointTooLargeError over the hard limit', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const saver = makeSaver({ warnBytes: 500, hardLimitBytes: 2_000 });
    await saver.setup();
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const { checkpoint, config, metadata } = await seedSizedInterrupt(saver, threadId, 10_000);

    await expect(saver.put(config, checkpoint, metadata)).rejects.toBeInstanceOf(
      CheckpointTooLargeError,
    );

    // Nothing durable was written for that thread — getTuple reads the checkpoint document.
    expect(await saver.getTuple(readConfig(threadId))).toBeUndefined();
    expect(
      await mongoose.connection.db!.collection('agent_checkpoints').countDocuments({
        thread_id: threadId,
      }),
    ).toBe(0);
  });

  it('counts metadata toward the ceiling — refuses when the checkpoint is under but metadata pushes over', async () => {
    // MongoDBSaver stores the serialized checkpoint AND metadata in one document, so a
    // just-under-limit checkpoint with large metadata still overflows. The guard must catch it
    // as a typed CheckpointTooLargeError, not let it fall through to a raw BSONObjectTooLarge.
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const saver = makeSaver({ warnBytes: 500, hardLimitBytes: 2_000 });
    await saver.setup();
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;

    const checkpoint = emptyCheckpoint();
    checkpoint.channel_values = { messages: 'x'.repeat(400) }; // checkpoint alone well UNDER 2 KB
    await saver.putWrites(
      { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpoint.id } },
      [[INTERRUPT, 'approve?']],
      'task-1',
    );
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '' } };
    // Metadata alone pushes checkpoint + metadata over the 2 KB hard limit.
    const metadata = {
      source: 'input' as const,
      step: -1,
      writes: { payload: 'y'.repeat(4_000) },
      parents: {},
    };

    await expect(saver.put(config, checkpoint, metadata)).rejects.toBeInstanceOf(
      CheckpointTooLargeError,
    );
    expect(await saver.getTuple(readConfig(threadId))).toBeUndefined();
  });

  it('counts metadata_search (the raw metadata copy) — refuses when serialized-only would pass', async () => {
    // MongoDBSaver stores `metadata_search: metadata` — the WHOLE raw metadata a
    // SECOND time in the same document. Sized so checkpoint + serialized metadata is
    // UNDER the limit but adding the raw metadata_search copy pushes it over: the guard
    // must count that copy, else the doc slips the preflight and overflows on the wire.
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const saver = makeSaver({ warnBytes: 500, hardLimitBytes: 6_000 });
    await saver.setup();
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;

    const checkpoint = emptyCheckpoint();
    checkpoint.channel_values = { messages: 'x'.repeat(200) };
    await saver.putWrites(
      { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpoint.id } },
      [[INTERRUPT, 'approve?']],
      'task-1',
    );
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '' } };
    // ~3 KB metadata: checkpoint + serialized metadata (~3.2 KB) is under 6 KB, but the
    // raw metadata_search copy (~another 3 KB) pushes checkpoint+metadata+metadata_search
    // over 6 KB. The pre-fix guard (checkpoint + serialized metadata only) would pass here.
    const metadata = {
      source: 'loop' as const,
      step: 1,
      writes: { payload: 'y'.repeat(3_000) },
      parents: {},
    };

    await expect(saver.put(config, checkpoint, metadata)).rejects.toBeInstanceOf(
      CheckpointTooLargeError,
    );
    expect(await saver.getTuple(readConfig(threadId))).toBeUndefined();
  });

  it('flushes bookkeeping parked during the size-serialization window (not dropped on resume)', async () => {
    // `put` consumes the write anchor, then AWAITS `assertCheckpointFitsDocument` (serialization).
    // A bookkeeping-only putWrites dispatched in that window sees no anchor and no persisted
    // marker, so it parks — and must be flushed once the checkpoint persists, or a resume
    // re-executes the completed sibling.
    const NO_WRITES = '__no_writes__';
    const saver = makeSaver({ warnBytes: 5_000, hardLimitBytes: 50_000 });
    await saver.setup();
    const threadId = `convo-${new mongoose.Types.ObjectId().toString()}`;
    const checkpoint = emptyCheckpoint();
    const writeCfg = {
      configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpoint.id },
    };
    await saver.putWrites(writeCfg, [[INTERRUPT, 'approve?']], 'task-gate');

    // Pause the checkpoint serialization inside `put` so the bookkeeping batch lands mid-window.
    const serde = (saver as unknown as { serde: { dumpsTyped: (v: unknown) => unknown } }).serde;
    const realDumps = serde.dumpsTyped.bind(serde);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let paused = false;
    jest.spyOn(serde, 'dumpsTyped').mockImplementation(async (value: unknown) => {
      if (!paused) {
        paused = true;
        await gate; // hold inside assertCheckpointFitsDocument (anchor consumed, not yet persisted)
      }
      return realDumps(value);
    });

    const config = { configurable: { thread_id: threadId, checkpoint_ns: '' } };
    const metadata = { source: 'input' as const, step: -1, writes: null, parents: {} };
    const putPromise = saver.put(config, checkpoint, metadata); // suspends at the gate
    await saver.putWrites(writeCfg, [[NO_WRITES, null]], 'task-sibling'); // parks in the window
    releaseGate();
    await putPromise;

    const tuple = await saver.getTuple(readConfig(threadId));
    const channels = (tuple?.pendingWrites ?? []).map((w) => w[1]);
    expect(channels).toContain(INTERRUPT);
    expect(channels).toContain(NO_WRITES); // flushed, not dropped
  });
});

describe('setupCheckpointIndexes on a single-index-build engine (mongodb-memory-server)', () => {
  const CHECKPOINTS = 'single_build_checkpoints';
  const WRITES = 'single_build_checkpoint_writes';
  /** Amazon DocumentDB: "Existing index build in progress on the same collection." */
  const INDEX_BUILD_ALREADY_IN_PROGRESS = 40333;

  const clientForSaver = () =>
    mongoose.connection.getClient() as unknown as ConstructorParameters<
      typeof MongoDBSaver
    >[0]['client'];

  /** Bound to Mongoose's database the way `buildMongoSaver` binds it, so the
   * index assertions below read the collections the saver actually built. */
  const makeSaver = () =>
    new LazyMongoSaver({
      client: clientForSaver(),
      dbName: mongoose.connection.db?.databaseName,
      checkpointCollectionName: CHECKPOINTS,
      checkpointWritesCollectionName: WRITES,
      ttl: 3600,
    });

  function indexBuildInProgressError(): Error {
    return new mongoose.mongo.MongoServerError({
      ok: 0,
      code: INDEX_BUILD_ALREADY_IN_PROGRESS,
      errmsg:
        'Existing index build in progress on the same collection. Collection is limited to a single index build at a time.',
    });
  }

  interface IndexBuild {
    collectionName: string;
    indexName: string;
    build: () => Promise<string>;
  }

  /**
   * Routes every `createIndex` through `handler`, naming the index the way the
   * server would. Patched on the driver prototype because the saver fetches a
   * fresh `Collection` handle per call.
   */
  function patchCreateIndex(handler: (build: IndexBuild) => Promise<string>): () => void {
    const prototype = mongoose.mongo.Collection.prototype;
    const createIndex = prototype.createIndex;
    prototype.createIndex = function (this: mongoose.mongo.Collection, spec, options) {
      const indexName =
        options?.name ??
        Object.entries(spec)
          .map(([field, direction]) => `${field}_${direction}`)
          .join('_');
      return handler({
        collectionName: this.collectionName,
        indexName,
        build: () => createIndex.call(this, spec, options),
      });
    };
    return () => {
      prototype.createIndex = createIndex;
    };
  }

  /**
   * Turns the in-memory MongoDB into a single-index-build engine for the two
   * checkpoint collections: a build that arrives while another is in flight on
   * the same collection is rejected the way DocumentDB rejects it, instead of
   * being serialized the way MongoDB does. Re-creating an index that already
   * exists starts no build on either engine, so it always passes through.
   */
  function enforceSingleIndexBuild(): { rejected: () => number; restore: () => void } {
    const inFlight = new Set<string>();
    const built = new Set<string>();
    let rejected = 0;
    const restore = patchCreateIndex(async ({ collectionName, indexName, build }) => {
      const key = `${collectionName}:${indexName}`;
      if ((collectionName !== CHECKPOINTS && collectionName !== WRITES) || built.has(key)) {
        return build();
      }
      if (inFlight.has(collectionName)) {
        rejected += 1;
        throw indexBuildInProgressError();
      }
      inFlight.add(collectionName);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const name = await build();
        built.add(key);
        return name;
      } finally {
        inFlight.delete(collectionName);
      }
    });
    return { rejected: () => rejected, restore };
  }

  async function indexNames(collectionName: string): Promise<string[]> {
    const indexes = await mongoose.connection.db!.collection(collectionName).indexes();
    return indexes.map((index) => index.name ?? '');
  }

  it('models the engine: a raw setup() loses one build per collection', async () => {
    const engine = enforceSingleIndexBuild();
    try {
      const errors = await makeSaver().setup();

      expect(errors.map((error) => (error as { code?: number }).code)).toEqual([
        INDEX_BUILD_ALREADY_IN_PROGRESS,
        INDEX_BUILD_ALREADY_IN_PROGRESS,
      ]);
      expect(engine.rejected()).toBe(2);
    } finally {
      engine.restore();
    }
  });

  it('re-runs setup() until every checkpoint index exists', async () => {
    const engine = enforceSingleIndexBuild();
    try {
      await expect(
        setupCheckpointIndexes(makeSaver(), { peerBuildPollMs: 1, peerBuildDeadlineMs: 5_000 }),
      ).resolves.toEqual([]);

      expect(engine.rejected()).toBe(2);
      expect(await indexNames(CHECKPOINTS)).toEqual(
        expect.arrayContaining(['thread_ns_checkpoint_idx', 'upserted_at_1']),
      );
      expect(await indexNames(WRITES)).toEqual(
        expect.arrayContaining(['thread_ns_checkpoint_task_idx', 'upserted_at_1']),
      );
    } finally {
      engine.restore();
    }
  });

  it('returns errors that are not a concurrent build without re-running setup()', async () => {
    const restore = patchCreateIndex(async ({ collectionName, build }) => {
      if (collectionName !== WRITES) {
        return build();
      }
      throw new mongoose.mongo.MongoServerError({
        ok: 0,
        code: 67,
        errmsg: 'CannotCreateIndex: bad index spec',
      });
    });
    try {
      const saver = makeSaver();
      const setup = jest.spyOn(saver, 'setup');

      const errors = await setupCheckpointIndexes(saver, {
        peerBuildPollMs: 1,
        peerBuildDeadlineMs: 5_000,
      });

      expect(errors.map((error) => error.message)).toEqual([
        'CannotCreateIndex: bad index spec',
        'CannotCreateIndex: bad index spec',
      ]);
      expect(setup).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('proceeds with the conflict reported once the peer-build deadline passes', async () => {
    const restore = patchCreateIndex(async ({ collectionName, build }) => {
      if (collectionName !== CHECKPOINTS) {
        return build();
      }
      throw indexBuildInProgressError();
    });
    try {
      const errors = await setupCheckpointIndexes(makeSaver(), {
        peerBuildPollMs: 1,
        peerBuildDeadlineMs: 20,
      });

      expect(errors.map((error) => (error as { code?: number }).code)).toEqual([
        INDEX_BUILD_ALREADY_IN_PROGRESS,
      ]);
    } finally {
      restore();
    }
  });

  it('keeps the failures reported beside a conflict that outlasts the deadline', async () => {
    const restore = patchCreateIndex(async ({ collectionName }) => {
      if (collectionName === CHECKPOINTS) {
        throw indexBuildInProgressError();
      }
      throw new mongoose.mongo.MongoServerError({
        ok: 0,
        code: 67,
        errmsg: 'CannotCreateIndex: bad index spec',
      });
    });
    try {
      const errors = await setupCheckpointIndexes(makeSaver(), {
        peerBuildPollMs: 1,
        peerBuildDeadlineMs: 20,
      });

      expect(errors.map((error) => (error as { code?: number }).code).sort()).toEqual([
        INDEX_BUILD_ALREADY_IN_PROGRESS,
        67,
        67,
      ]);
    } finally {
      restore();
    }
  });

  it('propagates a setup() rejection that is not a build conflict', async () => {
    /** The driver validates collection names server-side and `setup()` settles
     * every build with `Promise.allSettled`, so there is no rejection path to
     * trigger for real; a rejecting stand-in covers the contract that such a
     * rejection reaches the caller's in-process fallback instead of being
     * reported as an index error. */
    const saver = makeSaver();
    saver.setup = () => Promise.reject(new Error('client closed'));

    await expect(setupCheckpointIndexes(saver, { peerBuildPollMs: 1 })).rejects.toThrow(
      'client closed',
    );
  });
});
