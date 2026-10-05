import { createHash } from 'node:crypto';
import { AgentCapabilities, FileContext, FileSources } from 'librechat-data-provider';
import type { AgentSubagentsConfig, TFile } from 'librechat-data-provider';
import type { SubagentExecutionContext } from '@librechat/agents';
import type { RunArtifactDescriptor } from '~/files/code/publication';
import type { RunFileSessionDeps } from './session';
import type { ServerRequest } from '~/types';
import { createRunFileSession, getAuthorizedRunFileSnapshot } from './session';
import { AgentAttachmentLimitError } from '../attachments';
import { resolveTurnDeliveryRouting } from './delivery';
import { createRunFileMessageEncoder } from './encode';

function setup(
  subagentsEnabled = true,
  options: {
    signal?: AbortSignal;
    ttlMs?: number;
    inputs?: TFile[];
    capabilities?: readonly string[];
    subagents?: AgentSubagentsConfig;
    agents?: Record<string, AgentSubagentsConfig>;
    maxFiles?: number;
    allowSiblingSharing?: boolean;
    deferActivation?: boolean;
    validateMessages?: RunFileSessionDeps['validateMessages'];
    encodeMessages?: RunFileSessionDeps['encodeMessages'];
  } = {},
) {
  const saved: TFile[] = [];
  const publishedSources: RunArtifactDescriptor[] = [];
  const publishedBytes: Buffer[] = [];
  const privateBytes = new Map<string, Buffer>();
  let workingBytes = Buffer.from('initial output');
  let nextSnapshot = 0;
  let publicationFailure: Error | undefined;
  const snapshots = {
    capture: jest.fn(async (_source?: RunArtifactDescriptor, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const snapshotId = `snapshot-${nextSnapshot++}`;
      privateBytes.set(snapshotId, Buffer.from(workingBytes));
      return {
        snapshotId,
        size: workingBytes.length,
        sha256: createHash('sha256').update(workingBytes).digest('hex'),
      };
    }),
    discard: jest.fn(async (snapshotId: string) => {
      privateBytes.delete(snapshotId);
    }),
    close: jest.fn(async () => {
      privateBytes.clear();
    }),
  };
  const read = jest.fn(async () => saved);
  const prepared = jest.fn(async () => undefined);
  const emit = jest.fn(async () => undefined);
  const getInputs = jest.fn(() => options.inputs ?? []);
  const session = createRunFileSession({
    capabilities: options.capabilities ?? [AgentCapabilities.subagents],
    userId: 'user',
    createdAt: Date.now(),
    policy: {
      enabled: true,
      allowSiblingSharing: options.allowSiblingSharing ?? false,
      maxFiles: options.maxFiles ?? 20,
      maxPrivateBytes: 268_435_456,
      ttlMs: options.ttlMs ?? 60_000,
    },
    snapshots,
    getInputs,
    inputFileIds: new Set(options.inputs?.map((file) => file.file_id)),
    getAgent: (id) => {
      if (options.agents?.[id]) return { id, subagents: options.agents[id] };
      if (id === 'writer') {
        return { id, subagents: { enabled: true, allowSelf: false, agent_ids: ['reader'] } };
      }
      return {
        id,
        subagents:
          id === 'parent'
            ? (options.subagents ?? {
                enabled: subagentsEnabled,
                allowSelf: false,
                shareFiles: true,
                graphs: [
                  {
                    type: 'team',
                    name: 'Team',
                    description: 'Analyze and write',
                    agent_ids: ['reader', 'writer'],
                    entry_agent_id: 'reader',
                    result_agent_id: 'writer',
                    edges: [{ from: 'reader', to: 'writer', edgeType: 'direct' }],
                  },
                ],
              })
            : undefined,
      };
    },
    listPublications: read,
    publish: async ({ scope, artifact, provenance }) => {
      if (publicationFailure) {
        const error = publicationFailure;
        publicationFailure = undefined;
        throw error;
      }
      publishedSources.push(artifact);
      publishedBytes.push(Buffer.from(privateBytes.get(artifact.snapshotId!)!));
      const file: TFile = {
        file_id: `durable-output-${saved.length}`,
        filename: artifact.name,
        type: 'text/csv',
        user: scope.userId,
        conversationId: scope.conversationId,
        bytes: 10,
        embedded: false,
        filepath: '/private/output.csv',
        object: 'file',
        usage: 0,
        source: FileSources.local,
        context: FileContext.run_artifact,
        metadata: { runFile: provenance },
      };
      saved.push(file);
      return file;
    },
    prepareAgent: prepared,
    validateMessages: options.validateMessages ?? jest.fn(),
    encodeMessages: options.encodeMessages ?? (async () => []),
    emit,
  });
  const context: SubagentExecutionContext = {
    rootRunId: 'run',
    hookSessionId: 'run',
    depth: 1,
    ancestry: [
      {
        subagentRunId: 'child-team',
        subagentType: 'team',
        subagentKind: 'graph',
        subagentAgentId: 'reader',
        parentRunId: 'run',
        parentAgentId: 'parent',
        parentToolCallId: 'spawn-call',
      },
    ],
  };
  const preparation = {
    executionContext: context,
    memberAgentIds: ['reader', 'writer'],
    signal: new AbortController().signal,
    resumed: false,
  };
  if (!options.deferActivation) session.activate('run', 'conversation', ['parent'], options.signal);
  return {
    session,
    getInputs,
    saved,
    context,
    preparation,
    read,
    prepared,
    publishedSources,
    publishedBytes,
    snapshots,
    emit,
    setWorkingBytes: (value: string) => {
      workingBytes = Buffer.from(value);
    },
    failNextPublication: (error: Error) => {
      publicationFailure = error;
    },
  };
}

it('returns publications from every graph member without granting sibling access', async () => {
  const { session, context, preparation } = setup();
  await session.prepare(preparation);
  await session.capture('writer', context, 'code-call', {
    session_id: 'writer-session',
    files: [{ id: 'output', name: 'results.csv' }],
  });
  const artifactId = (await session.list('writer', context)).artifacts[0].artifact_id;
  await session.publish('writer', context, artifactId);
  expect((await session.list('reader', context)).files).toHaveLength(0);
  expect((await session.list('parent')).files).toHaveLength(1);
  const result = await session.complete(preparation, { content: 'Analysis finished.' });
  expect(result.content).toContain('durable-output');
  expect(result.content).toContain('results.csv');
});

it('prepares every graph member from one read and reuses the snapshot for the catalog', async () => {
  const { session, preparation, read, prepared } = setup();
  const result = await session.prepare(preparation);
  expect(read).toHaveBeenCalledTimes(1);
  expect(prepared).toHaveBeenCalledTimes(2);
  expect(result.agentSessions?.reader.codeSessionKey).not.toBe(
    result.agentSessions?.writer.codeSessionKey,
  );
});

it.each([{ totalSizeLimit: 1 }, { fileLimit: 1 }])(
  'checks later team members before encoding shared files or provisioning resources (%j)',
  async (limits) => {
    const input: TFile = {
      file_id: 'shared-report',
      filename: 'report.pdf',
      type: 'application/pdf',
      bytes: 600_000,
      user: 'user',
      embedded: false,
      filepath: '/files/report.pdf',
      object: 'file',
      usage: 0,
      source: FileSources.local,
      llmDeliveryPath: 'provider',
      metadata: { destinationChosen: true },
    };
    const writerAttachments = [{ ...input, file_id: 'writer-setup', context: FileContext.agents }];
    const document = {
      type: 'file',
      file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,cGRm' },
    };
    const encodeDocuments = jest.fn(async () => ({ documents: [document] }));
    const fileConfig: NonNullable<ServerRequest['config']>['fileConfig'] = {
      endpoints: { openAI: limits },
    };
    const encoder = createRunFileMessageEncoder({
      req: { body: {}, config: { fileConfig } } as ServerRequest,
      getAgent: (id) => ({
        provider: 'openAI',
        agentContextAttachments: id === 'writer' ? writerAttachments : [],
        deliveryRouting: resolveTurnDeliveryRouting({
          agent: { provider: 'openAI' },
          config: { fileConfig },
        }),
      }),
      encodeDocuments,
      encodeImages: async () => ({ image_urls: [] }),
      encodeAudios: async () => ({ audios: [] }),
      encodeVideos: async () => ({ videos: [] }),
      extractText: async () => undefined,
      getStrategyFunctions: jest.fn(),
    });
    const validateMessages = jest.fn(encoder.validate);
    const { session, preparation, prepared, read } = setup(true, {
      inputs: [input],
      validateMessages,
      encodeMessages: encoder.encode,
    });
    try {
      await expect(session.prepare(preparation)).rejects.toThrow(AgentAttachmentLimitError);
      expect(prepared).not.toHaveBeenCalled();
      expect(encodeDocuments).not.toHaveBeenCalled();

      writerAttachments.splice(0);
      const result = await session.prepare(preparation);
      expect(prepared).toHaveBeenCalledTimes(2);
      expect(encodeDocuments).toHaveBeenCalledTimes(1);
      expect(result.messages?.[1].content).toEqual(expect.arrayContaining([document]));
      expect(read).toHaveBeenCalledTimes(2);

      validateMessages.mockClear();
      const resumed = await session.prepare({ ...preparation, resumed: true });
      expect(resumed.messages).toEqual([]);
      expect(validateMessages).not.toHaveBeenCalled();
      expect(encodeDocuments).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
    }
  },
);

it('reuses publications for unrelated batches while preparing and authorizing each execution', async () => {
  const { session, preparation, context, read, prepared } = setup();
  try {
    await session.prepareTools('parent', undefined, preparation.signal, 'snapshot');
    await session.prepareTools('parent', undefined, preparation.signal, 'snapshot');
    expect(read).toHaveBeenCalledTimes(1);
    expect(prepared).toHaveBeenCalledTimes(2);
    expect(prepared).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actor: { executionId: 'run', agentId: 'parent' }, revision: 1 }),
    );
    expect(prepared).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actor: { executionId: 'run', agentId: 'parent' }, revision: 2 }),
    );

    await expect(
      session.prepareTools('writer', context, preparation.signal, 'snapshot'),
    ).rejects.toThrow('not authorized');
    expect(read).toHaveBeenCalledTimes(1);
    expect(prepared).toHaveBeenCalledTimes(2);

    await session.prepare(preparation);
    expect(read).toHaveBeenCalledTimes(2);
    await session.prepareTools('writer', context, preparation.signal, 'snapshot');
    expect(read).toHaveBeenCalledTimes(2);
    expect(prepared).toHaveBeenLastCalledWith(
      expect.objectContaining({ actor: { executionId: 'child-team', agentId: 'writer' } }),
    );
    await session.prepareTools('writer', context, preparation.signal);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    await session.close();
  }
});

it('keeps a retained sharing preference inactive while the master subagent setting is disabled', () => {
  const { session, read } = setup(false);
  expect(session.isActive()).toBe(false);
  expect(read).not.toHaveBeenCalled();
  expect(
    getAuthorizedRunFileSnapshot({
      capabilities: [AgentCapabilities.subagents],
      policy: {
        enabled: true,
        allowSiblingSharing: false,
        maxFiles: 100,
        maxPrivateBytes: 268_435_456,
        ttlMs: 60_000,
      },
      agent: { subagents: { enabled: false, shareFiles: true } },
      files: [],
    }),
  ).toBeUndefined();
});

it('grants a nested publication to the dispatching parent and ancestors, not its graph peers', async () => {
  const { session, context, preparation } = setup();
  await session.prepare(preparation);
  const nested: SubagentExecutionContext = {
    ...context,
    depth: 2,
    ancestry: [
      ...context.ancestry,
      {
        subagentRunId: 'nested',
        subagentType: 'reader',
        subagentKind: 'agent',
        subagentAgentId: 'reader',
        parentRunId: 'child-team',
        parentAgentId: 'writer',
        parentToolCallId: 'nested-spawn',
      },
    ],
  };
  await session.prepare({ ...preparation, executionContext: nested, memberAgentIds: ['reader'] });
  await session.capture('reader', nested, 'nested-code', {
    session_id: 'nested-sandbox',
    files: [{ id: 'output', name: 'output.csv' }],
  });
  const artifactId = (await session.list('reader', nested)).artifacts[0].artifact_id;
  await session.publish('reader', nested, artifactId);
  expect((await session.list('writer', context)).files).toHaveLength(1);
  expect((await session.list('parent')).files).toHaveLength(1);
  expect((await session.list('reader', context)).files).toHaveLength(0);
});

it('rejects substituted ancestry and retains its own copy of the SDK lineage', async () => {
  const { session, context, preparation } = setup();
  await session.prepare(preparation);
  Object.assign(context.ancestry[0], { parentAgentId: 'stranger' });
  await expect(session.list('writer', context)).rejects.toThrow('not authorized');
  await expect(session.prepare(preparation)).rejects.toThrow('parent lineage');
});

it('does not republish inherited inputs and uses the storage identity for generated files', async () => {
  const { session, context, preparation, publishedSources } = setup();
  await session.prepare(preparation);
  await session.capture('writer', context, 'code-call', {
    session_id: 'execution-session',
    files: [
      { id: 'input', name: 'input.pdf', inherited: true, storage_session_id: 'input-storage' },
      { id: 'output', name: 'output.csv', storage_session_id: 'output-storage' },
    ],
  });
  const artifacts = (await session.list('writer', context)).artifacts;
  const artifactId = artifacts[0].artifact_id;
  expect(artifacts).toEqual([
    { artifact_id: expect.stringMatching(/:code-call:output$/), filename: 'output.csv' },
  ]);
  await expect(session.publish('writer', context, 'code-call:input')).rejects.toThrow(
    'Only artifacts',
  );
  const file = await session.publish('writer', context, artifactId);
  expect(file.metadata?.runFile?.sourceFileId).toBe(artifactId);
  expect(publishedSources[0].sessionId).toBe('output-storage');
  expect((await session.list('writer', context)).artifacts).toHaveLength(0);
  await expect(session.publish('writer', context, artifactId)).resolves.toEqual(file);
});

it('retains immutable versions across inspect and overwrite calls until the child publishes', async () => {
  const { session, context, preparation, setWorkingBytes, publishedBytes, snapshots } = setup();
  await session.prepare(preparation);
  const output = { session_id: 'sandbox', files: [{ id: 'output', name: 'output.csv' }] };
  setWorkingBytes('draft');
  await session.capture('writer', context, 'first', output);
  const firstId = (await session.list('writer', context)).artifacts[0].artifact_id;
  await session.withCodeExecution('writer', context, preparation.signal, async () => {
    await session.capture('writer', context, 'inspect', output);
  });
  expect((await session.list('writer', context)).artifacts).toEqual([
    { artifact_id: firstId, filename: 'output.csv' },
  ]);
  expect(snapshots.discard).toHaveBeenCalledWith('snapshot-1');
  await session.withCodeExecution('writer', context, preparation.signal, async () => {
    setWorkingBytes('revised');
    await session.capture('writer', context, 'revise', output);
  });
  const versions = (await session.list('writer', context)).artifacts;
  expect(versions).toHaveLength(2);
  expect(versions[0].artifact_id).toBe(firstId);
  expect((await session.list('parent')).files).toHaveLength(0);
  expect((await session.list('reader', context)).artifacts).toHaveLength(0);
  const first = await session.publish('writer', context, firstId);
  const second = await session.publish('writer', context, versions[1].artifact_id);
  expect(publishedBytes.map((buffer) => buffer.toString())).toEqual(['draft', 'revised']);
  expect(first.file_id).not.toBe(second.file_id);
  await expect(session.publish('writer', context, firstId)).resolves.toEqual(first);
  expect((await session.list('parent')).files).toHaveLength(2);
  expect((await session.list('writer', context)).artifacts).toHaveLength(0);
});

it('distinguishes new code generations even when a provider reuses both tool and output IDs', async () => {
  const { session, context, preparation, publishedSources } = setup();
  await session.prepare(preparation);
  const output = { session_id: 'sandbox', files: [{ id: 'reused-output', name: 'output.csv' }] };
  const generate = () =>
    session.withCodeExecution('writer', context, preparation.signal, async () => {
      await session.capture('writer', context, 'reused-call', output);
    });
  await generate();
  const firstId = (await session.list('writer', context)).artifacts[0].artifact_id;
  const first = await session.publish('writer', context, firstId);
  await generate();
  const secondId = (await session.list('writer', context)).artifacts[0].artifact_id;
  const second = await session.publish('writer', context, secondId);
  expect(secondId).not.toBe(firstId);
  expect(second.file_id).not.toBe(first.file_id);
  expect(publishedSources).toHaveLength(2);
  await expect(session.publish('writer', context, firstId)).resolves.toEqual(first);
});

it('keeps a reverted working version last without confusing it with an older matching draft', async () => {
  const { session, context, preparation, setWorkingBytes, publishedBytes } = setup();
  await session.prepare(preparation);
  for (const contents of ['draft', 'revised', 'draft']) {
    setWorkingBytes(contents);
    await session.capture('writer', context, 'reused-call', {
      session_id: 'sandbox',
      files: [{ id: 'output', name: 'analysis.csv' }],
    });
  }
  const versions = (await session.list('writer', context)).artifacts;
  expect(versions).toHaveLength(3);
  expect(new Set(versions.map((version) => version.artifact_id)).size).toBe(3);
  await session.publish('writer', context, versions[2].artifact_id);
  expect(publishedBytes[0].toString()).toBe('draft');
});

it('retains existing versions when another capture fails and permits publication retry', async () => {
  const { session, context, preparation, snapshots, failNextPublication } = setup();
  await session.prepare(preparation);
  const output = { session_id: 'sandbox', files: [{ id: 'output', name: 'analysis.csv' }] };
  await session.capture('writer', context, 'generate', output);
  const artifact = (await session.list('writer', context)).artifacts[0];
  snapshots.capture.mockRejectedValueOnce(new Error('Private artifact byte limit exceeded'));
  await expect(session.capture('writer', context, 'refine', output)).rejects.toThrow('byte limit');
  expect((await session.list('writer', context)).artifacts).toEqual([artifact]);
  failNextPublication(new Error('Storage temporarily unavailable'));
  await expect(session.publish('writer', context, artifact.artifact_id)).rejects.toThrow(
    'temporarily',
  );
  expect(snapshots.discard).not.toHaveBeenCalled();
  expect((await session.list('writer', context)).artifacts).toEqual([artifact]);
  await session.publish('writer', context, artifact.artifact_id);
  expect(snapshots.discard).toHaveBeenCalledWith('snapshot-0');
  await session.close();
  expect(snapshots.close).toHaveBeenCalledTimes(1);
});

it('closes private snapshots on run cancellation and prevents further sandbox work', async () => {
  const controller = new AbortController();
  const { session, context, preparation, snapshots } = setup(true, { signal: controller.signal });
  await session.prepare(preparation);
  await session.capture('writer', context, 'generate', {
    session_id: 'sandbox',
    files: [{ id: 'output', name: 'analysis.csv' }],
  });
  controller.abort();
  await session.close();
  expect(snapshots.close).toHaveBeenCalledTimes(1);
  await expect(session.list('writer', context)).rejects.toThrow('expired');
  const execute = jest.fn(async () => undefined);
  expect(() => session.withCodeExecution('writer', context, preparation.signal, execute)).toThrow(
    'expired',
  );
  expect(execute).not.toHaveBeenCalled();
});

it('cancels only the child snapshot download when that child execution is aborted', async () => {
  const { session, context, preparation, snapshots } = setup();
  await session.prepare(preparation);
  const controller = new AbortController();
  let opened!: () => void;
  const opening = new Promise<void>((resolve) => {
    opened = resolve;
  });
  snapshots.capture.mockImplementationOnce(async (_source, signal) => {
    opened();
    return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    });
  });
  const operation = session.withCodeExecution('writer', context, controller.signal, () =>
    session.capture('writer', context, 'generate', {
      session_id: 'sandbox',
      files: [{ id: 'output', name: 'analysis.csv' }],
    }),
  );
  const observed = operation.catch((error: unknown) => error);
  await opening;
  controller.abort(new Error('Child stopped'));
  expect(await observed).toEqual(new Error('Child stopped'));
  expect((await session.list('writer', context)).artifacts).toHaveLength(0);
  expect(snapshots.close).not.toHaveBeenCalled();
  await expect(
    session.withCodeExecution('reader', context, preparation.signal, async () => 'still active'),
  ).resolves.toBe('still active');
  await session.close();
});

it('emits a durable publication even when private snapshot cleanup fails', async () => {
  const { session, context, preparation, snapshots, emit } = setup();
  await session.prepare(preparation);
  await session.capture('writer', context, 'generate', {
    session_id: 'sandbox',
    files: [{ id: 'output', name: 'analysis.csv' }],
  });
  const artifactId = (await session.list('writer', context)).artifacts[0].artifact_id;
  snapshots.discard.mockRejectedValueOnce(new Error('Temporary filesystem error'));
  const published = await session.publish('writer', context, artifactId);
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ file_id: published.file_id }));
  await session.close();
  expect(snapshots.close).toHaveBeenCalledTimes(1);
});

it('does not emit if cancellation arrives during cleanup after durable publication', async () => {
  const { session, context, preparation, snapshots, emit, saved } = setup();
  await session.prepare(preparation);
  await session.capture('writer', context, 'generate', {
    session_id: 'sandbox',
    files: [{ id: 'output', name: 'analysis.csv' }],
  });
  const artifactId = (await session.list('writer', context)).artifacts[0].artifact_id;
  const controller = new AbortController();
  snapshots.discard.mockImplementationOnce(async () => {
    controller.abort(new Error('Publication stopped'));
  });
  await expect(
    session.publish('writer', context, artifactId, [], controller.signal),
  ).rejects.toThrow('Publication stopped');
  expect(saved).toHaveLength(1);
  expect(emit).not.toHaveBeenCalled();
  await expect(session.publish('writer', context, artifactId)).resolves.toEqual(saved[0]);
  expect(emit).toHaveBeenCalledTimes(1);
  await session.close();
});

it('cleans up expired snapshots without needing another tool call', async () => {
  jest.useFakeTimers();
  try {
    const { session, context, preparation, snapshots } = setup(true, { ttlMs: 100 });
    await session.prepare(preparation);
    await session.capture('writer', context, 'generate', {
      session_id: 'sandbox',
      files: [{ id: 'output', name: 'analysis.csv' }],
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(snapshots.close).toHaveBeenCalledTimes(1);
    await expect(session.list('parent')).rejects.toThrow('expired');
    await session.close();
  } finally {
    jest.useRealTimers();
  }
});

it('serializes code through capture within one actor while another actor progresses independently', async () => {
  const { session, context, preparation } = setup();
  await session.prepare(preparation);
  const events: string[] = [];
  let finishFirst!: () => void;
  const first = session.withCodeExecution('writer', context, preparation.signal, async () => {
    events.push('first-start');
    await new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    await session.capture('writer', context, 'first', {
      session_id: 'writer-sandbox',
      files: [{ id: 'one', name: 'one.csv' }],
    });
    events.push('first-captured');
  });
  const second = session.withCodeExecution('writer', context, preparation.signal, async () => {
    events.push('second-start');
    expect((await session.list('writer', context)).artifacts).toHaveLength(1);
  });
  await session.withCodeExecution('reader', context, preparation.signal, async () => {
    events.push('reader');
  });
  expect(events).toEqual(['first-start', 'reader']);
  finishFirst();
  await Promise.all([first, second]);
  expect(events).toEqual(['first-start', 'reader', 'first-captured', 'second-start']);
});

it('releases a failed code operation and never starts an aborted queued operation', async () => {
  const { session, context, preparation } = setup();
  await session.prepare(preparation);
  await expect(
    session.withCodeExecution('writer', context, preparation.signal, async () => {
      throw new Error('Code failed');
    }),
  ).rejects.toThrow('Code failed');
  const execute = jest.fn(async () => 'success');
  await expect(
    session.withCodeExecution('writer', context, AbortSignal.abort(), execute),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  await expect(
    session.withCodeExecution('writer', context, preparation.signal, execute),
  ).resolves.toBe('success');
});

it('restores published references without advertising stale private outputs on resume', async () => {
  const { session, context, preparation } = setup();
  const prepared = await session.prepare({ ...preparation, resumed: true });
  expect(prepared.messages).toEqual([]);
  expect((await session.list('writer', context)).private_artifact_recovery).toContain('Regenerate');
  await session.close();
  await expect(session.list('parent')).rejects.toThrow('expired');
});

const fileCapabilityMatrix = [
  { name: 'ordinary', value: [AgentCapabilities.subagents] },
  { name: 'graphs', value: [AgentCapabilities.subagent_graphs] },
  { name: 'both', value: [AgentCapabilities.subagents, AgentCapabilities.subagent_graphs] },
  { name: 'neither', value: [] },
].flatMap(({ name, value }) =>
  [false, true].flatMap((enabled) =>
    [undefined, false, true].map((graphsEnabled) => ({
      name,
      capabilities: value,
      enabled,
      graphsEnabled,
    })),
  ),
);

it.each(fileCapabilityMatrix)(
  'gates snapshots and activation with $name capabilities, ordinary=$enabled, graphs=$graphsEnabled',
  async ({ capabilities, enabled, graphsEnabled }) => {
    const subagents = {
      enabled,
      graphsEnabled,
      allowSelf: false,
      shareFiles: true,
      agent_ids: ['writer'],
      graphs: [
        {
          type: 'team',
          name: 'Team',
          description: 'Work',
          agent_ids: ['reader'],
          entry_agent_id: 'reader',
          result_agent_id: 'reader',
          edges: [],
        },
      ],
    };
    const expected =
      (enabled && capabilities.includes(AgentCapabilities.subagents)) ||
      ((graphsEnabled ?? enabled) &&
        capabilities.includes(
          graphsEnabled == null ? AgentCapabilities.subagents : AgentCapabilities.subagent_graphs,
        ));
    const { session, getInputs, prepared, read } = setup(enabled, { capabilities, subagents });
    try {
      expect(session.isActive()).toBe(expected);
      expect(getInputs).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(read).not.toHaveBeenCalled();
      expect(prepared).not.toHaveBeenCalled();
      expect(
        getAuthorizedRunFileSnapshot({
          capabilities,
          agent: { subagents },
          files: [],
          policy: {
            enabled: true,
            allowSiblingSharing: false,
            maxFiles: 1,
            maxPrivateBytes: 100,
            ttlMs: 60000,
          },
        }),
      ).toEqual(expected ? [] : undefined);
    } finally {
      await session.close();
    }
  },
);

it('disabled graph-only sharing cannot impose manifest limits on ordinary attachments', async () => {
  const inputs: TFile[] = ['first', 'second'].map((file_id) => ({
    file_id,
    filename: `${file_id}.txt`,
    type: 'text/plain',
    bytes: 1,
    user: 'user',
    embedded: false,
    filepath: `/files/${file_id}`,
    object: 'file',
    usage: 0,
    source: FileSources.local,
  }));
  const subagents = { enabled: false, graphsEnabled: true, shareFiles: true, allowSelf: false };
  const disabled = setup(false, {
    capabilities: [AgentCapabilities.subagents],
    subagents,
    inputs,
    maxFiles: 1,
    deferActivation: true,
  });
  const enabled = setup(false, {
    capabilities: [AgentCapabilities.subagent_graphs],
    subagents,
    inputs,
    maxFiles: 1,
    deferActivation: true,
  });
  try {
    expect(disabled.session.activate('run', 'conversation', ['parent'])).toBe(false);
    expect(disabled.getInputs).not.toHaveBeenCalled();
    expect(disabled.read).not.toHaveBeenCalled();
    expect(disabled.prepared).not.toHaveBeenCalled();
    expect(() => enabled.session.activate('run', 'conversation', ['parent'])).toThrow(
      'configured file limit',
    );
  } finally {
    await disabled.session.close();
    await enabled.session.close();
  }
});

it.each([false, true])(
  'nested stored graph recipients follow their own capability, enabled=%s',
  async (graphsAllowed) => {
    const capabilities = graphsAllowed
      ? [AgentCapabilities.subagents, AgentCapabilities.subagent_graphs]
      : [AgentCapabilities.subagents];
    const { session, context, preparation, prepared } = setup(true, {
      capabilities,
      subagents: { enabled: true, allowSelf: false, shareFiles: true, agent_ids: ['writer'] },
      agents: {
        writer: {
          enabled: false,
          graphsEnabled: true,
          allowSelf: false,
          agent_ids: ['forbidden-single'],
          graphs: [
            {
              type: 'nested',
              name: 'Nested',
              description: 'Work',
              agent_ids: ['reader'],
              entry_agent_id: 'reader',
              result_agent_id: 'reader',
              edges: [],
            },
          ],
        },
      },
    });
    try {
      await session.prepare({ ...preparation, memberAgentIds: ['writer'] });
      const nested: SubagentExecutionContext = {
        ...context,
        depth: 2,
        ancestry: [
          ...context.ancestry,
          {
            subagentRunId: 'nested-team',
            subagentType: 'nested',
            subagentKind: 'graph',
            subagentAgentId: 'reader',
            parentRunId: 'child-team',
            parentAgentId: 'writer',
            parentToolCallId: 'nested-spawn',
          },
        ],
      };
      const invocation = {
        ...preparation,
        executionContext: nested,
        memberAgentIds: ['reader'],
        resumed: true,
      };
      if (graphsAllowed)
        await expect(session.prepare(invocation)).resolves.toMatchObject({
          messages: [],
          agentSessions: { reader: expect.anything() },
        });
      else {
        await expect(session.prepare(invocation)).rejects.toThrow('not authorized this child');
        expect(prepared).toHaveBeenCalledTimes(1);
      }
      await expect(
        session.prepare({
          ...invocation,
          executionContext: {
            ...nested,
            ancestry: [
              ...context.ancestry,
              {
                ...nested.ancestry[1],
                subagentRunId: 'forbidden',
                subagentAgentId: 'forbidden-single',
              },
            ],
          },
          memberAgentIds: ['forbidden-single'],
        }),
      ).rejects.toThrow('not authorized this child');
    } finally {
      await session.close();
    }
  },
);

it('disabled graph targets are not granted publication recipient authority', async () => {
  const { session, context, preparation, saved, snapshots } = setup(true, {
    capabilities: [AgentCapabilities.subagents],
    allowSiblingSharing: true,
    subagents: {
      enabled: true,
      allowSelf: false,
      shareFiles: true,
      agent_ids: ['writer'],
      graphsEnabled: true,
      graphs: [
        {
          type: 'team',
          name: 'Team',
          description: 'Work',
          agent_ids: ['disabled-member'],
          entry_agent_id: 'disabled-member',
          result_agent_id: 'disabled-member',
          edges: [],
        },
      ],
    },
  });
  try {
    await session.prepare({ ...preparation, memberAgentIds: ['writer'] });
    await session.capture('writer', context, 'code-call', {
      session_id: 'writer-session',
      files: [{ id: 'output', name: 'results.csv' }],
    });
    const artifact = (await session.list('writer', context)).artifacts[0];
    await expect(
      session.publish('writer', context, artifact.artifact_id, ['disabled-member']),
    ).rejects.toThrow('does not authorize');
    expect(saved).toHaveLength(0);
    expect(snapshots.discard).not.toHaveBeenCalled();
    await expect(session.publish('writer', context, artifact.artifact_id)).resolves.toHaveProperty(
      'file_id',
    );
  } finally {
    await session.close();
  }
});
