import { z } from 'zod';
import mongoose from 'mongoose';
import { tool } from '@langchain/core/tools';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { AIMessageChunk } from '@librechat/agents/langchain/messages';
import { Annotation, Command, END, INTERRUPT, START, StateGraph } from '@langchain/langgraph';
import {
  FakeChatModel,
  HookRegistry,
  Providers,
  StandardGraph,
  SubagentExecutor,
} from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { Interrupt } from '@langchain/langgraph';
import {
  LazyMongoSaver,
  CheckpointTooLargeError,
  deleteAgentCheckpoint,
  deleteOwnedAgentCheckpoints,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  getAgentCheckpointer,
  __resetCheckpointerForTests,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
} from '../checkpointer';
import {
  createCheckpointNamespace,
  checkpointOwnerNamespacePrefix,
} from '../../stream/checkpoints';
import { openCheckpointDeletion } from './deletion';

let server: MongoMemoryServer;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  __resetCheckpointerForTests();
  await mongoose.connection.dropDatabase();
});

/** Choose the next call from persisted tool messages, never model-instance state. */
class ChildModel extends FakeChatModel {
  constructor() {
    super({ responses: ['done'] });
  }

  async *_streamResponseChunks(messages: BaseMessage[]): AsyncGenerator<ChatGenerationChunk> {
    const completed = messages.filter((message) => message.getType() === 'tool');
    const step = completed.length;
    const name = step === 0 ? 'read_page' : 'append_marker';
    yield new ChatGenerationChunk({
      text: step < 3 ? '' : 'done',
      message: new AIMessageChunk({
        content: step < 3 ? '' : 'done',
        ...(step < 3 && {
          tool_call_chunks: [
            { id: `call-${step}`, name, args: JSON.stringify({ marker: step }), index: 0 },
          ],
        }),
      }),
    });
  }
}

function freshSaver(conversationId?: string): LazyMongoSaver {
  return new LazyMongoSaver({
    conversationId,
    client: mongoose.connection.getClient() as unknown as ConstructorParameters<
      typeof LazyMongoSaver
    >[0]['client'],
    dbName: mongoose.connection.db!.databaseName,
    checkpointCollectionName: 'agent_checkpoints',
    checkpointWritesCollectionName: 'agent_checkpoint_writes',
    ttl: 3600,
  });
}

function buildParent(effects: { reads: number; writes: number[] }, runId = 'parent-run') {
  const saver = freshSaver('parent-thread');
  const hooks = new HookRegistry();
  hooks.register('PreToolUse', {
    hooks: [async (input) => ({ decision: input.toolName === 'append_marker' ? 'ask' : 'allow' })],
  });
  const tools = [
    tool(
      () => {
        effects.reads++;
        return 'synthetic page';
      },
      {
        name: 'read_page',
        description: 'Read the page',
        schema: z.object({ marker: z.number() }),
      },
    ),
    tool(
      ({ marker }) => {
        effects.writes.push(marker);
        return `written ${marker}`;
      },
      {
        name: 'append_marker',
        description: 'Append one marker',
        schema: z.object({ marker: z.number() }),
      },
    ),
  ];
  const executor = new SubagentExecutor({
    configs: new Map([
      [
        'writer',
        {
          type: 'writer',
          name: 'Writer',
          description: 'Read and append twice',
          configId: 'writer-v1',
          agentInputs: {
            agentId: 'writer',
            provider: Providers.OPENAI,
            clientOptions: { model: 'synthetic' },
            tools,
          },
        },
      ],
    ]),
    parentRunId: runId,
    parentAgentId: 'parent',
    checkpointer: saver,
    humanInTheLoop: { enabled: true },
    hookRegistry: hooks,
    createChildGraph: (input) => {
      const graph = new StandardGraph(input);
      graph.overrideModel = new ChildModel();
      graph.compileOptions = { checkpointer: saver as never };
      graph.hookRegistry = hooks;
      graph.humanInTheLoop = { enabled: true };
      return graph;
    },
  });
  const State = Annotation.Root({ result: Annotation<string>() });
  const graph = new StateGraph(State)
    .addNode('delegate', async (_state, config: RunnableConfig) => {
      const result = await executor.execute({
        description: 'Read the page, append marker 1, then append marker 2',
        subagentType: 'writer',
        threadId: config.configurable?.thread_id,
        parentToolCallId: 'delegate-writer',
        parentConfigurable: config.configurable,
      });
      return { result: result.content };
    })
    .addEdge(START, 'delegate')
    .addEdge('delegate', END)
    .compile({ checkpointer: saver as never });
  return { graph, saver, executor };
}

function pendingInterrupts(state: {
  tasks: readonly { interrupts?: readonly Interrupt[] }[];
}): Interrupt[] {
  return state.tasks.flatMap((task) => [...(task.interrupts ?? [])]);
}

it.each(['approve', 'reject'] as const)(
  'resumes SDK child approvals on rebuilt parent graphs and fresh Mongo savers (%s) without repeating completed work',
  async (decision) => {
    await getAgentCheckpointer({ type: 'mongo', ttl: 3600 });
    const effects = { reads: 0, writes: [] as number[] };
    const config = {
      configurable: {
        thread_id: 'parent-thread',
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: createCheckpointNamespace('owner', 'tenant'),
      },
      durability: 'exit' as const,
    };
    const first = buildParent(effects);
    await first.graph.invoke({ result: '' }, config);
    const pause = pendingInterrupts(await first.graph.getState(config));
    expect(pause).toHaveLength(1);
    expect(effects).toEqual({ reads: 1, writes: [] });

    const resumeConfig = {
      ...config,
      configurable: {
        ...config.configurable,
        __librechat_subagent_resume_manifest: await first.executor.getResumeManifest(),
        __librechat_subagent_resume_attempt: 'resume-1',
      },
    };
    const second = buildParent(effects, 'parent-resume-1');
    await second.graph.invoke(
      new Command({ resume: { [pause[0].id!]: [{ type: 'approve' }] } }),
      resumeConfig,
    );
    const next = pendingInterrupts(await second.graph.getState(resumeConfig));
    expect(effects).toEqual({ reads: 1, writes: [1] });
    expect(next).toHaveLength(1);
    expect(next[0].id).not.toBe(pause[0].id);

    const finalConfig = {
      ...config,
      configurable: {
        ...config.configurable,
        __librechat_subagent_resume_manifest: await second.executor.getResumeManifest(),
        __librechat_subagent_resume_attempt: 'resume-2',
      },
    };
    const third = buildParent(effects, 'parent-resume-2');
    const output = await third.graph.invoke(
      new Command({ resume: { [next[0].id!]: [{ type: decision }] } }),
      finalConfig,
    );
    expect(output.result).toContain('done');
    expect(output).not.toHaveProperty(INTERRUPT);
    expect(effects).toEqual({ reads: 1, writes: decision === 'approve' ? [1, 2] : [1] });

    // Recover the completed child head even if its parent must replay the delegation.
    const replay = buildParent(effects, 'parent-resume-2');
    expect((await replay.graph.invoke({ result: '' }, finalConfig)).result).toContain('done');
    expect(effects).toEqual({ reads: 1, writes: decision === 'approve' ? [1, 2] : [1] });
    replay.executor.clearHeavyState();
    expect(
      await mongoose.connection
        .db!.collection('agent_checkpoints')
        .countDocuments({ thread_id: /^subagent:/ }),
    ).toBeGreaterThan(0);
    const threads = new Set([
      ...first.executor.getChildCheckpointThreadIds(),
      ...second.executor.getChildCheckpointThreadIds(),
      ...third.executor.getChildCheckpointThreadIds(),
      ...replay.executor.getChildCheckpointThreadIds(),
    ]);
    expect(threads.size).toBeGreaterThan(1);
    const deletion = await openCheckpointDeletion('owner', 'tenant', 'parent-thread', {
      type: 'mongo',
    });
    await deletion.remember(['parent-thread']);
    expect(deletion.conversationIds()).toEqual(['parent-thread']);
    await deletion.cleanup();
    await deletion.acknowledge();
    for (const name of ['agent_checkpoints', 'agent_checkpoint_writes']) {
      expect(
        await mongoose.connection.db!.collection(name).countDocuments({ thread_id: /^subagent:/ }),
      ).toBe(0);
    }
    first.executor.clearHeavyState();
    second.executor.clearHeavyState();
    third.executor.clearHeavyState();
  },
);

it.each(['before', 'after'] as const)(
  'retains child checkpoints when pending writes arrive %s put',
  async (order) => {
    const saver = freshSaver();
    const config = {
      configurable: {
        thread_id: 'subagent:ordering',
        checkpoint_ns: 'child:task',
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: createCheckpointNamespace('owner', 'tenant'),
      },
    };
    const checkpoint = emptyCheckpoint();
    const writesConfig = { configurable: { ...config.configurable, checkpoint_id: checkpoint.id } };
    const write = () =>
      saver.putWrites(
        writesConfig,
        [
          [INTERRUPT, [{ id: 'approval', value: 'approve?' }]],
          ['__no_writes__', null],
        ],
        'task',
      );
    if (order === 'before') await write();
    await saver.put(config, checkpoint, { source: 'loop', step: 0, parents: {} });
    if (order === 'after') await write();
    const tuple = await freshSaver().getTuple(config);
    expect(tuple?.checkpoint.id).toBe(checkpoint.id);
    expect(tuple?.config.configurable?.checkpoint_ns).toBe('child:task');
    expect(tuple?.pendingWrites?.map((entry) => entry[1]).sort()).toEqual(
      [INTERRUPT, '__no_writes__'].sort(),
    );
    for (const name of ['agent_checkpoints', 'agent_checkpoint_writes']) {
      const rows = await mongoose.connection
        .db!.collection<{ thread_id: string; upserted_at: Date; checkpoint_ns: string }>(name)
        .find({ thread_id: 'subagent:ordering' })
        .toArray();
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.every(
          (row) =>
            row.upserted_at instanceof Date &&
            row.checkpoint_ns ===
              `${config.configurable[LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]}|child:task`,
        ),
      ).toBe(true);
    }
  },
);

it('keeps the size guard on unanchored child checkpoints', async () => {
  const saver = new LazyMongoSaver({
    client: mongoose.connection.getClient() as unknown as ConstructorParameters<
      typeof LazyMongoSaver
    >[0]['client'],
    dbName: mongoose.connection.db!.databaseName,
    hardLimitBytes: 512,
  });
  const checkpoint = emptyCheckpoint();
  checkpoint.channel_values.payload = 'x'.repeat(1024);
  await expect(
    saver.put({ configurable: { thread_id: 'subagent:oversize' } }, checkpoint, {
      source: 'loop',
      step: 0,
      parents: {},
    }),
  ).rejects.toBeInstanceOf(CheckpointTooLargeError);
  expect(
    await saver.getTuple({ configurable: { thread_id: 'subagent:oversize' } }),
  ).toBeUndefined();
});

it.each(['ordinary-thread', 'not-subagent:thread'])(
  'preserves the zero-write clean-exit fast path for %s',
  async (threadId) => {
    const saver = freshSaver();
    const checkpoint = emptyCheckpoint();
    const writes = jest.spyOn(mongoose.mongo.Collection.prototype, 'updateOne');
    await saver.put({ configurable: { thread_id: threadId } }, checkpoint, {
      source: 'loop',
      step: 0,
      parents: {},
    });
    expect(writes).not.toHaveBeenCalled();
    expect(await saver.getTuple({ configurable: { thread_id: threadId } })).toBeUndefined();
  },
);

it('isolates child owner, tenant, thread, and generation during reads and cleanup', async () => {
  await getAgentCheckpointer({ type: 'mongo', ttl: 3600 });
  const saver = freshSaver();
  const checkpoint = emptyCheckpoint();
  const owner = checkpointOwnerNamespacePrefix('owner', 'tenant');
  const identities = [
    { thread: 'subagent:owned', owner, generation: 'generation' },
    { thread: 'subagent:owned', owner, generation: 'replacement' },
    { thread: 'subagent:other', owner, generation: 'generation' },
    {
      thread: 'subagent:owned',
      owner: checkpointOwnerNamespacePrefix('other', 'tenant'),
      generation: 'generation',
    },
    {
      thread: 'subagent:owned',
      owner: checkpointOwnerNamespacePrefix('owner', 'other-tenant'),
      generation: 'generation',
    },
  ];
  const configs = identities.map((identity) => ({
    configurable: {
      thread_id: identity.thread,
      checkpoint_ns: 'child:task',
      [LIBRECHAT_CHECKPOINT_OWNER_KEY]: identity.owner,
      [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: identity.generation,
    },
  }));
  for (const config of configs) {
    await saver.put(config, checkpoint, { source: 'loop', step: 0, parents: {} });
    await saver.putWrites(
      { configurable: { ...config.configurable, checkpoint_id: checkpoint.id } },
      [[INTERRUPT, [{ id: 'approval', value: 'approve?' }]]],
      'task',
    );
  }
  expect((await freshSaver().getTuple(configs[0]))?.checkpoint.id).toBe(checkpoint.id);
  for (const configurable of [
    {
      ...configs[0].configurable,
      [LIBRECHAT_CHECKPOINT_OWNER_KEY]: checkpointOwnerNamespacePrefix('missing', 'tenant'),
    },
    { ...configs[0].configurable, [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'missing' },
    { ...configs[0].configurable, thread_id: 'subagent:missing' },
  ])
    expect(await freshSaver().getTuple({ configurable })).toBeUndefined();
  const listed = [];
  for await (const tuple of freshSaver().list(configs[0])) listed.push(tuple.checkpoint.id);
  expect(listed).toEqual([checkpoint.id]);

  await deleteAgentCheckpoint('subagent:owned', { type: 'mongo' });
  await deleteOwnedAgentCheckpoints('missing', 'tenant', ['subagent:owned']);
  expect((await freshSaver().getTuple(configs[0]))?.checkpoint.id).toBe(checkpoint.id);
  await deleteAgentCheckpoint('subagent:owned', { type: 'mongo' }, undefined, {
    checkpointNamespace: `${owner}generation`,
    throwOnError: true,
  });
  expect((await freshSaver().getTuple(configs[0]))?.checkpoint.id).toBe(checkpoint.id);

  await deleteOwnedAgentCheckpoints('owner', 'tenant', ['subagent:owned']);
  expect(await freshSaver().getTuple(configs[0])).toBeUndefined();
  expect(await freshSaver().getTuple(configs[1])).toBeUndefined();
  for (const config of configs.slice(2))
    expect((await freshSaver().getTuple(config))?.checkpoint.id).toBe(checkpoint.id);
  for (const name of ['agent_checkpoints', 'agent_checkpoint_writes']) {
    expect(await mongoose.connection.db!.collection(name).countDocuments()).toBe(3);
  }
});

it.each([false, true])(
  'deletes associated child payload using only the parent ID (owned=%s)',
  async (owned) => {
    const child = (parent: string) =>
      `subagent:${Buffer.from(JSON.stringify([parent, 'root', 'agent', 'tool', 'batch'])).toString('base64url')}`;
    const thread = child('parent');
    const nested = child(thread);
    const scopes = [
      { user: 'owner', tenant: 'tenant', thread, parent: 'parent' },
      { user: 'owner', tenant: 'tenant', thread: nested, parent: 'parent' },
      { user: 'owner', tenant: 'tenant', thread, parent: 'other-parent' },
      { user: 'owner', tenant: 'tenant', thread: child('other-parent'), parent: 'other-parent' },
      { user: 'foreign', tenant: 'tenant', thread, parent: 'parent' },
      { user: 'owner', tenant: 'foreign-tenant', thread, parent: 'parent' },
    ];
    const configs = scopes.map((scope) => ({
      configurable: {
        thread_id: scope.thread,
        checkpoint_ns: 'child:task',
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: createCheckpointNamespace(scope.user, scope.tenant),
        ...(owned
          ? {
              [LIBRECHAT_CHECKPOINT_OWNER_KEY]: checkpointOwnerNamespacePrefix(
                scope.user,
                scope.tenant,
              ),
            }
          : {}),
      },
    }));
    for (const [index, config] of configs.entries()) {
      const saver = freshSaver(scopes[index].parent);
      const checkpoint = emptyCheckpoint();
      await saver.put(config, checkpoint, { source: 'loop', step: 0, parents: {} });
      await saver.putWrites(
        { configurable: { ...config.configurable, checkpoint_id: checkpoint.id } },
        [[INTERRUPT, ['approval']]],
        'task',
      );
    }
    // An interrupted write can outlive a failed checkpoint insert.
    await freshSaver('parent').putWrites(
      { configurable: { ...configs[0].configurable, checkpoint_id: 'orphan' } },
      [[INTERRUPT, ['orphan']]],
      'task',
    );
    const deletion = await openCheckpointDeletion('owner', 'tenant', 'parent', { type: 'mongo' });
    await deletion.remember(['parent']);
    expect(deletion.conversationIds()).toEqual(['parent']);
    await deletion.cleanup();
    await deletion.acknowledge();
    for (const config of configs.slice(0, 2))
      expect(await freshSaver().getTuple(config)).toBeUndefined();
    for (const config of configs.slice(2))
      expect(await freshSaver().getTuple(config)).toBeDefined();
    for (const name of ['agent_checkpoints', 'agent_checkpoint_writes']) {
      expect(await mongoose.connection.db!.collection(name).countDocuments()).toBe(4);
    }
  },
);
