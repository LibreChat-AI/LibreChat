import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { emptyCheckpoint, INTERRUPT } from '@langchain/langgraph-checkpoint';
import { Annotation, Command, END, interrupt, START, StateGraph } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  getAgentCheckpointer,
  hasDurableAgentInterruptCheckpoint,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
  __resetCheckpointerForTests,
} from './checkpointer';
import { createCheckpointNamespace, checkpointOwnerNamespacePrefix } from '../stream/checkpoints';

const cfg = { type: 'mongo' as const };
const threadId = 'scheduled-approval';
const namespace = createCheckpointNamespace('owner', 'tenant');
const metadata = { source: 'loop' as const, step: 1, parents: {} };
let replica: MongoMemoryReplSet;
let secondary: mongoose.mongo.MongoClient;
let primaryAddress: string;
const reads: { collection: string; address: string }[] = [];

function config(checkpointId?: string, checkpointNs = ''): RunnableConfig {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: checkpointNs,
      checkpoint_id: checkpointId,
      [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: namespace,
    },
  };
}

async function withReplicationPaused(work: () => Promise<void>): Promise<void> {
  await mongoose.connection
    .db!.collection('replication_barrier')
    .insertOne({}, { writeConcern: { w: 'majority' } });
  const admin = secondary.db('admin');
  const configured = await admin.command({
    configureFailPoint: 'stopReplProducer',
    mode: 'alwaysOn',
  });
  try {
    await admin.command({
      waitForFailPoint: 'stopReplProducer',
      timesEntered: configured.count + 1,
      maxTimeMS: 10000,
    });
    await work();
  } finally {
    await admin.command({ configureFailPoint: 'stopReplProducer', mode: 'off' });
  }
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({
    replSet: { count: 2 },
    instanceOpts: [
      { args: ['--setParameter', 'enableTestCommands=1'] },
      {
        args: ['--setParameter', 'enableTestCommands=1'],
        replicaMemberConfig: { priority: 0 },
      },
    ],
  });
  await mongoose.connect(replica.getUri('uri_default'), {
    dbName: 'active_checkpoints',
    readPreference: 'secondaryPreferred',
    writeConcern: { w: 1 },
    monitorCommands: true,
    serverSelectionTimeoutMS: 1000,
    heartbeatFrequencyMS: 1000,
  });
  const hello = await mongoose.connection
    .db!.admin()
    .command({ hello: 1 }, { readPreference: 'primary' });
  primaryAddress = hello.primary;
  const address = [...hello.hosts, ...(hello.passives ?? [])].find(
    (host: string) => host !== primaryAddress,
  );
  if (!address) throw new Error('Missing secondary fixture');
  secondary = await new mongoose.mongo.MongoClient(`mongodb://${address}`, {
    directConnection: true,
    readPreference: 'secondary',
  }).connect();
  mongoose.connection.getClient().on('commandStarted', (event) => {
    if (event.commandName === 'find') {
      reads.push({ collection: event.command.find, address: event.address });
    }
  });
  await getAgentCheckpointer(cfg);
}, 60000);

afterAll(async () => {
  await secondary?.close();
  await mongoose.disconnect();
  await replica?.stop();
  __resetCheckpointerForTests();
});

beforeEach(async () => {
  for (const name of ['agent_checkpoints', 'agent_checkpoint_writes']) {
    await mongoose.connection.db!.collection(name).deleteMany({});
  }
  reads.length = 0;
});

it.each(['checkpoint and interrupt', 'interrupt only'])(
  'verifies %s before secondary replication',
  async (lag) => {
    const saver = (await getAgentCheckpointer(cfg))!;
    const checkpoint = emptyCheckpoint();
    const input = config(checkpoint.id, 'nested-agent');
    const identity = {
      checkpointNamespace: namespace,
      checkpointNs: 'nested-agent',
      checkpointId: checkpoint.id,
      interruptId: 'exact-interrupt',
    };
    if (lag === 'interrupt only') {
      await saver.putWrites(input, [[INTERRUPT, { id: 'previous-interrupt' }]], 'approval');
      await saver.put(config(undefined, 'nested-agent'), checkpoint, metadata);
    }
    await withReplicationPaused(async () => {
      await saver.putWrites(input, [[INTERRUPT, [{ id: identity.interruptId }]]], 'approval');
      if (lag === 'checkpoint and interrupt') {
        await saver.put(config(undefined, 'nested-agent'), checkpoint, metadata);
      }
      const stale = await secondary
        .db('active_checkpoints')
        .collection('agent_checkpoint_writes')
        .findOne({
          thread_id: threadId,
          checkpoint_id: checkpoint.id,
        });
      if (lag === 'checkpoint and interrupt') expect(stale).toBeNull();
      else expect(stale).not.toBeNull();

      reads.length = 0;
      await expect(hasDurableAgentInterruptCheckpoint(threadId, cfg, identity)).resolves.toBe(true);
      expect(reads).toEqual([
        { collection: 'agent_checkpoints', address: primaryAddress },
        { collection: 'agent_checkpoint_writes', address: primaryAddress },
      ]);
      await expect(
        hasDurableAgentInterruptCheckpoint(threadId, cfg, { ...identity, interruptId: 'wrong' }),
      ).resolves.toBe(false);
      await expect(
        hasDurableAgentInterruptCheckpoint(threadId, cfg, {
          ...identity,
          checkpointNamespace: createCheckpointNamespace('owner', 'other-tenant'),
        }),
      ).resolves.toBe(false);
      await expect(
        hasDurableAgentInterruptCheckpoint(threadId, cfg, {
          ...identity,
          checkpointNamespace: `${namespace}replacement`,
        }),
      ).resolves.toBe(false);
      await expect(hasDurableAgentInterruptCheckpoint('other-thread', cfg, identity)).resolves.toBe(
        false,
      );
      await expect(
        hasDurableAgentInterruptCheckpoint(threadId, cfg, {
          ...identity,
          checkpointNs: 'other-graph',
        }),
      ).resolves.toBe(false);

      await mongoose.connection.db!.collection('agent_checkpoint_writes').deleteMany({});
      await expect(hasDurableAgentInterruptCheckpoint(threadId, cfg, identity)).resolves.toBe(
        false,
      );
      await mongoose.connection.db!.collection('agent_checkpoints').deleteMany({});
      await expect(hasDurableAgentInterruptCheckpoint(threadId, cfg, identity)).resolves.toBe(
        false,
      );
    });
  },
);

it('parks and resumes a rebuilt approval graph while its secondary has no checkpoint', async () => {
  let effects = 0;
  const build = async () => {
    const State = Annotation.Root({ approved: Annotation<boolean>() });
    return new StateGraph(State)
      .addNode('approval', () => {
        const approved = interrupt({ type: 'tool_approval', tool: 'append_marker' });
        if (approved) effects++;
        return { approved: Boolean(approved) };
      })
      .addEdge(START, 'approval')
      .addEdge('approval', END)
      .compile({ checkpointer: (await getAgentCheckpointer(cfg))! });
  };
  await withReplicationPaused(async () => {
    const graph = await build();
    await graph.invoke({ approved: false }, { ...config(), durability: 'exit' });
    const state = await graph.getState(config());
    const pending = state.tasks.flatMap((task) => task.interrupts ?? []);
    expect(pending).toHaveLength(1);
    expect(effects).toBe(0);
    await expect(
      hasDurableAgentInterruptCheckpoint(threadId, cfg, {
        checkpointNamespace: namespace,
        checkpointId: state.config.configurable!.checkpoint_id,
        interruptId: pending[0].id!,
      }),
    ).resolves.toBe(true);
    expect(
      await secondary
        .db('active_checkpoints')
        .collection('agent_checkpoints')
        .findOne({ thread_id: threadId }),
    ).toBeNull();
    __resetCheckpointerForTests();
    const resumed = await build();
    const result = await resumed.invoke(new Command({ resume: true }), {
      ...config(),
      durability: 'exit',
    });
    expect(result.approved).toBe(true);
    expect(effects).toBe(1);
  });
});

it('preserves owner fencing and connection-preferred history listing', async () => {
  const saver = (await getAgentCheckpointer(cfg))!;
  const checkpoint = emptyCheckpoint();
  const owned = config(checkpoint.id);
  owned.configurable![LIBRECHAT_CHECKPOINT_OWNER_KEY] = checkpointOwnerNamespacePrefix(
    'owner',
    'tenant',
  );
  await saver.putWrites(owned, [[INTERRUPT, { id: 'owned' }]], 'task');
  await saver.put(owned, checkpoint, metadata);
  await withReplicationPaused(async () => {
    const foreign = {
      configurable: {
        ...owned.configurable,
        [LIBRECHAT_CHECKPOINT_OWNER_KEY]: checkpointOwnerNamespacePrefix('owner', 'other-tenant'),
      },
    };
    await expect(saver.getTuple(foreign)).resolves.toBeUndefined();
    await expect(saver.getTuple(owned)).resolves.toMatchObject({
      checkpoint: { id: checkpoint.id },
    });
    reads.length = 0;
    const listed = [];
    for await (const tuple of saver.list(owned)) listed.push(tuple);
    expect(listed).toHaveLength(1);
    expect(reads).toHaveLength(2);
    expect(reads.every((read) => read.address !== primaryAddress)).toBe(true);
  });
});

it('reads exact legacy proofs and their pending writes from the primary', async () => {
  const saver = (await getAgentCheckpointer(cfg))!;
  await withReplicationPaused(async () => {
    const checkpoint = emptyCheckpoint();
    const legacy = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: 'event-actor/legacy',
        checkpoint_id: checkpoint.id,
      },
    };
    await saver.putWrites(legacy, [[INTERRUPT, { id: 'legacy-approval' }]], 'task');
    await saver.put(legacy, checkpoint, metadata);
    const owned = {
      configurable: {
        ...legacy.configurable,
        [LIBRECHAT_CHECKPOINT_OWNER_KEY]: checkpointOwnerNamespacePrefix('owner', 'tenant'),
        [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: checkpoint.id,
      },
    };
    reads.length = 0;
    await expect(saver.getTuple(owned)).resolves.toMatchObject({
      checkpoint: { id: checkpoint.id },
      pendingWrites: [['task', INTERRUPT, { id: 'legacy-approval' }]],
    });
    expect(reads).toHaveLength(3);
    expect(reads.every((read) => read.address === primaryAddress)).toBe(true);
    await expect(
      saver.getTuple({
        configurable: {
          ...owned.configurable,
          [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: 'wrong-proof',
        },
      }),
    ).resolves.toBeUndefined();
  });
});

it.each([0, 1])(
  'propagates database failure after %i successful tuple reads',
  async (successfulReads) => {
    const saver = (await getAgentCheckpointer(cfg))!;
    const checkpoint = emptyCheckpoint();
    const input = config(checkpoint.id);
    await saver.putWrites(input, [[INTERRUPT, { id: 'outage' }]], 'task');
    await saver.put(config(), checkpoint, metadata);
    await mongoose.connection.db!.admin().command(
      {
        configureFailPoint: 'failCommand',
        mode: { skip: successfulReads },
        data: { failCommands: ['find'], errorCode: 2 },
      },
      { readPreference: 'primary' },
    );
    try {
      await expect(
        hasDurableAgentInterruptCheckpoint(threadId, cfg, {
          checkpointNamespace: namespace,
          checkpointId: checkpoint.id,
          interruptId: 'outage',
        }),
      ).rejects.toThrow();
    } finally {
      await mongoose.connection
        .db!.admin()
        .command({ configureFailPoint: 'failCommand', mode: 'off' }, { readPreference: 'primary' });
    }
  },
);

it('does not fall back to a readable secondary when no primary is available', async () => {
  const saver = (await getAgentCheckpointer(cfg))!;
  const checkpoint = emptyCheckpoint();
  await saver.putWrites(config(checkpoint.id), [[INTERRUPT, { id: 'outage' }]], 'task');
  await saver.put(config(), checkpoint, metadata);
  await mongoose.connection
    .db!.collection('replication_barrier')
    .insertOne({}, { writeConcern: { w: 'majority' } });
  await mongoose.connection
    .db!.admin()
    .command({ replSetStepDown: 60, force: true }, { readPreference: 'primary' });
  expect(
    await secondary
      .db('active_checkpoints')
      .collection('agent_checkpoints')
      .findOne({ thread_id: threadId }),
  ).not.toBeNull();
  await expect(saver.getTuple(config(checkpoint.id))).rejects.toThrow();
  await expect(
    hasDurableAgentInterruptCheckpoint(threadId, cfg, {
      checkpointNamespace: namespace,
      checkpointId: checkpoint.id,
      interruptId: 'outage',
    }),
  ).resolves.toBe(false);
});
