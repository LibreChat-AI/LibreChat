import { Constants } from '@librechat/agents';
import {
  AgentCapabilities,
  EToolResources,
  FileContext,
  FileSources,
  configSchema,
} from 'librechat-data-provider';
import type { Agent, CodeEnvRef, TFile } from 'librechat-data-provider';
import type { SubagentExecutionContext } from '@librechat/agents';
import type { ProvisionCallbackDeps } from '~/files/provision/callback';
import type { RunFileSessionDeps } from './session';
import type { RunFileToolContext } from './host';
import type { ServerRequest } from '~/types';
import { createRunFileHost, resolveRunFileCodeExecutionContext } from './host';
import * as sessionModule from './session';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

function file(id: string, overrides: Partial<TFile> = {}): TFile {
  return {
    file_id: id,
    filename: `${id}.csv`,
    filepath: `/uploads/${id}.csv`,
    user: 'user',
    tenantId: 'tenant',
    type: 'text/csv',
    bytes: 12,
    embedded: false,
    object: 'file',
    usage: 0,
    source: FileSources.local,
    context: FileContext.message_attachment,
    llmDeliveryPath: 'none',
    metadata: { destinationChosen: false },
    ...overrides,
  };
}

function identity(id = 'child'): SubagentExecutionContext {
  return {
    rootRunId: 'run',
    hookSessionId: 'run',
    depth: 1,
    ancestry: [
      {
        subagentRunId: id,
        subagentType: 'worker',
        subagentKind: 'agent',
        subagentAgentId: 'worker',
        parentRunId: 'run',
        parentAgentId: 'parent',
        parentToolCallId: `spawn-${id}`,
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness(options: { inputs?: TFile[]; setup?: TFile[] } = {}) {
  const input = options.inputs ?? [file('input')];
  const setup = options.setup ?? [file('worker-setup', { context: FileContext.agents })];
  const parsed = configSchema.parse({
    version: '1.3.9',
    endpoints: {
      agents: {
        capabilities: [AgentCapabilities.context],
        fileSharing: { enabled: true },
      },
    },
  });
  const req = {
    user: { id: 'user', tenantId: 'tenant', role: 'USER' },
    config: { endpoints: { agents: parsed.endpoints?.agents } },
  } as ServerRequest;
  const agent = (id: string): Agent =>
    ({
      id,
      name: id,
      provider: 'openAI',
      model: 'gpt-4o',
      tools: [Constants.EXECUTE_CODE, EToolResources.file_search, EToolResources.context],
      tool_resources:
        id === 'worker'
          ? {
              execute_code: { file_ids: setup.map((entry) => entry.file_id) },
              file_search: { file_ids: setup.map((entry) => entry.file_id) },
            }
          : undefined,
      subagents: { enabled: true, shareFiles: true, allowSelf: false, agent_ids: ['worker'] },
    }) as Agent;
  const contexts = new Map<string, RunFileToolContext>(
    ['parent', 'worker'].map((id) => [
      id,
      {
        agent: agent(id),
        codeEnvAvailable: true,
        // Base initialization may contain historical runtime resources. Only persisted
        // setup membership and this run's manifest may reach an execution host.
        tool_resources: { execute_code: { files: [file('historical')] } },
        codeExecutionContext: {
          baseUrl: 'https://code.example',
          executionProfile: 'stateful',
          executionRouteKey: 'managed-worker',
          environmentType: 'managed',
          codeSessionKey: 'base-agent-session',
          runtimeSessionHint: 'base-agent-session',
          statefulSessions: true,
        },
      },
    ]),
  );
  const loadFiles = jest.fn(async (_ids: string[]) => structuredClone(setup));
  const filterFiles = jest.fn(async ({ files }: { files: TFile[] }) => files);
  const saved: TFile[] = [];
  const listPublications = jest.fn(async () => structuredClone(saved));
  const publish = jest.fn<
    ReturnType<RunFileSessionDeps['publish']>,
    Parameters<RunFileSessionDeps['publish']>
  >(async ({ scope, artifact, provenance }) => {
    const published = file(`published-${provenance.sourceFileId}`, {
      filename: artifact.name,
      conversationId: scope.conversationId,
      context: FileContext.run_artifact,
      metadata: { destinationChosen: false, runFile: provenance },
    });
    saved.push(published);
    return structuredClone(published);
  });
  type CodeProvision = ProvisionCallbackDeps['provisionToCodeEnv'];
  const codeResult = ({
    file: candidate,
    entity_id,
    sandboxFilename,
    route,
  }: Parameters<CodeProvision>[0]): Awaited<ReturnType<CodeProvision>> => {
    const routeKey = route?.executionRouteKey ?? route?.executionProfile ?? 'default';
    const ref: CodeEnvRef = {
      kind: entity_id ? 'agent' : 'user',
      id: entity_id ?? 'user',
      file_id: `remote-${candidate.file_id}`,
      storage_session_id: `storage-${entity_id ?? 'user'}`,
      sandboxFilename,
    };
    return {
      referenceSet: { codeEnvRefs: { [routeKey]: ref } },
      refUpdate: { file_id: candidate.file_id, routeKey, ref },
      sandboxFilename: sandboxFilename ?? candidate.filename,
    };
  };
  const provisionToCodeEnv = jest.fn<ReturnType<CodeProvision>, Parameters<CodeProvision>>(
    async (params) => codeResult(params),
  );
  const provisionToVectorDB = jest.fn<
    ReturnType<ProvisionCallbackDeps['provisionToVectorDB']>,
    Parameters<ProvisionCallbackDeps['provisionToVectorDB']>
  >(async ({ file: candidate }) => ({
    embedded: true,
    fileUpdate: { file_id: candidate.file_id, embedded: true },
  }));
  const updateCodeEnvRef = jest.fn(async () => undefined);
  const addEmbeddedEntity = jest.fn(async () => undefined);
  const emit = jest.fn(async () => undefined);
  const encodeMessages = jest.fn(async () => []);
  const spy = jest.spyOn(sessionModule, 'createRunFileSession');
  const host = createRunFileHost({
    req,
    contexts,
    createdAt: Date.now(),
    inputFileIds: new Set(input.map((entry) => entry.file_id)),
    getInputs: () => [...input, file('foreign-history', { user: 'other' })],
    loadFiles,
    filterFiles,
    listPublications,
    snapshots: {
      capture: jest.fn(async () => ({ snapshotId: 'private-output', size: 12, sha256: 'hash' })),
      discard: jest.fn(async () => undefined),
      close: jest.fn(async () => undefined),
    },
    publish,
    emit,
    validateMessages: jest.fn(),
    encodeMessages,
    provisioning: {
      provisionToCodeEnv,
      provisionToVectorDB,
      updateCodeEnvRef,
      updateFile: jest.fn(async () => undefined),
      addEmbeddedEntity,
    },
  });
  const deps = spy.mock.calls[spy.mock.calls.length - 1][0];
  host.session.activate('run', 'conversation', ['parent']);
  const signal = new AbortController().signal;
  const prepare = (context = identity(), suppliedSignal = signal) =>
    host.session.prepare({
      executionContext: context,
      memberAgentIds: ['worker'],
      signal: suppliedSignal,
      resumed: false,
    });
  const publishOutput = async (context = identity(), id = 'output') => {
    await host.session.capture(
      'worker',
      context,
      `tool-${id}`,
      {
        session_id: `private-${context.ancestry[0].subagentRunId}`,
        files: [{ id, name: `${id}.csv` }],
      },
      host.getContext('worker', context)?.codeExecutionContext,
    );
    const artifact = (await host.session.list('worker', context)).artifacts.find(
      (entry) => entry.filename === `${id}.csv`,
    );
    if (!artifact) throw new Error('Expected staged artifact');
    return host.session.publish('worker', context, artifact.artifact_id, [], signal);
  };
  return {
    host,
    deps,
    req,
    contexts,
    input,
    setup,
    saved,
    signal,
    prepare,
    publishOutput,
    loadFiles,
    filterFiles,
    publish,
    emit,
    encodeMessages,
    listPublications,
    provisionToCodeEnv,
    provisionToVectorDB,
    updateCodeEnvRef,
    addEmbeddedEntity,
    codeResult,
  };
}

describe('run file execution host', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['file_search', { file_search: { citations: ['document'] } }],
    ['web_search', { web_search: { results: ['page'] } }],
    ['set_memory', { memory: { key: 'preference', value: 'saved' } }],
    ['interactive_tool', { ui_resources: { data: ['widget'] } }],
    [
      'generate_image',
      { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aQ==' } }] },
    ],
  ])('preserves ordinary %s artifact delivery from a shared-file child', async (name, artifact) => {
    const h = harness();
    await h.prepare();
    const callback = jest.fn(async () => undefined);
    const data = { output: { name, tool_call_id: 'other-output', content: '', artifact } };
    const metadata = { executingAgentId: 'worker', executionContext: identity() };

    await h.host.deliverToolEnd(callback, data, metadata);

    expect(callback).toHaveBeenCalledWith(data, metadata);
    expect(h.deps.snapshots.capture).not.toHaveBeenCalled();
    expect((await h.host.session.list('worker', identity())).artifacts).toEqual([]);
  });

  it.each(['execute_code', 'bash_tool', 'create_file'])(
    'keeps %s outputs private until publication',
    async (name) => {
      const h = harness();
      await h.prepare();
      const callback = jest.fn(async () => undefined);
      await h.host.deliverToolEnd(
        callback,
        {
          output: {
            name,
            tool_call_id: 'private-output',
            content: '',
            artifact: {
              session_id: 'sandbox',
              files: [{ id: 'chart', name: 'chart.png' }],
            },
          },
        },
        { executingAgentId: 'worker', executionContext: identity() },
      );

      expect(callback).not.toHaveBeenCalled();
      expect(h.emit).not.toHaveBeenCalled();
      expect((await h.host.session.list('worker', identity())).artifacts).toEqual([
        { artifact_id: expect.any(String), filename: 'chart.png' },
      ]);
      const [artifact] = (await h.host.session.list('worker', identity())).artifacts;
      await h.host.session.publish('worker', identity(), artifact.artifact_id, [], h.signal);
      expect(h.emit).toHaveBeenCalledTimes(1);
    },
  );

  it('does not publish a private sandbox image merely because the child reads it', async () => {
    const h = harness();
    await h.prepare();
    const callback = jest.fn(async () => undefined);
    const artifact = {
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aQ==' } }],
    };
    const data = {
      output: { name: 'read_file', tool_call_id: 'inspect-image', content: 'Image', artifact },
    };

    await h.host.deliverToolEnd(callback, data, {
      executingAgentId: 'worker',
      executionContext: identity(),
    });

    expect(callback).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.deps.snapshots.capture).not.toHaveBeenCalled();
    expect(data.output.artifact).toBe(artifact);
  });

  it('reuses the handler authorized batch without a second publication query', async () => {
    const h = harness();
    await expect(
      h.host.provisionPrepared([Constants.EXECUTE_CODE], 'parent', h.signal),
    ).rejects.toThrow('not been prepared');
    await h.prepare();
    await h.host.session.prepareTools('worker', identity(), h.signal);
    const reads = h.listPublications.mock.calls.length;
    await h.host.provisionPrepared([Constants.EXECUTE_CODE], 'worker', h.signal, identity());
    expect(h.listPublications).toHaveBeenCalledTimes(reads);
    expect(h.provisionToCodeEnv).toHaveBeenCalledTimes(2);
  });

  it('keeps current inputs user-scoped and each agent setup agent-scoped without historical files', async () => {
    const current = file('current', { context: FileContext.agents });
    const h = harness({ inputs: [current] });
    h.loadFiles.mockResolvedValue([...h.setup, file('unrequested-setup', { user: 'other' })]);
    await h.prepare();
    await h.host.provision([Constants.EXECUTE_CODE, 'file_search'], 'worker', h.signal, identity());
    expect(h.loadFiles).toHaveBeenCalledWith(['worker-setup']);
    expect(h.filterFiles).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'worker', userId: 'user' }),
    );
    const codeCalls = h.provisionToCodeEnv.mock.calls.map(([params]) => [
      params.file.file_id,
      params.entity_id,
    ]);
    expect(codeCalls).toEqual(
      expect.arrayContaining([
        ['current', undefined],
        ['worker-setup', 'worker'],
      ]),
    );
    expect(codeCalls).toHaveLength(2);
    expect(
      h.provisionToVectorDB.mock.calls.map(([params]) => [params.file.file_id, params.entity_id]),
    ).toEqual(
      expect.arrayContaining([
        ['current', undefined],
        ['worker-setup', 'worker'],
      ]),
    );
    const context = h.host.getContext('worker', identity());
    expect(
      context?.tool_resources?.execute_code?.files?.map((entry) => entry.file_id).sort(),
    ).toEqual(['current', 'worker-setup']);
    expect(context?.tool_resources?.file_search?.file_ids).toEqual(['worker-setup']);
    expect(context?.provisionState?.agentScopedFileIds).toEqual(new Set(['worker-setup']));
    expect(current.metadata?.codeEnvRefs).toBeUndefined();
    expect(
      h.contexts.get('worker')?.tool_resources?.execute_code?.files?.map((entry) => entry.file_id),
    ).toEqual(['historical']);
  });

  it('isolates concurrent executions of the same agent without broadening storage grants', async () => {
    const h = harness();
    const first = identity('first');
    const second = identity('second');
    const results = await Promise.all([h.prepare(first), h.prepare(second)]);
    const a = h.host.getContext('worker', first)!;
    const b = h.host.getContext('worker', second)!;
    expect(a).not.toBe(b);
    expect(a.provisionState?.codeEnvFiles[0]).not.toBe(b.provisionState?.codeEnvFiles[0]);
    expect(a.codeExecutionContext?.codeSessionKey).not.toBe(b.codeExecutionContext?.codeSessionKey);
    expect(a.codeExecutionContext?.runtimeSessionHint).toBe(a.codeExecutionContext?.codeSessionKey);
    expect(b.codeExecutionContext?.runtimeSessionHint).toBe(b.codeExecutionContext?.codeSessionKey);
    expect(results[0].agentSessions?.worker.codeSessionKey).toBe(
      a.codeExecutionContext?.codeSessionKey,
    );
    expect(results[1].agentSessions?.worker.codeSessionKey).toBe(
      b.codeExecutionContext?.codeSessionKey,
    );
    await Promise.all(
      [first, second].map((context) =>
        h.host.provision([Constants.EXECUTE_CODE], 'worker', h.signal, context),
      ),
    );
    expect(h.provisionToCodeEnv.mock.calls.map(([params]) => params.entity_id)).toEqual(
      expect.arrayContaining([undefined, 'worker']),
    );
    expect(
      h.provisionToCodeEnv.mock.calls.every(
        ([params]) => params.entity_id == null || params.entity_id === 'worker',
      ),
    ).toBe(true);
    expect(h.contexts.get('worker')?.codeExecutionContext?.codeSessionKey).toBe(
      'base-agent-session',
    );
  });

  it('refreshes after publication while retaining successful resources, context and setup hydration', async () => {
    const h = harness();
    await h.prepare();
    await h.host.provision([Constants.EXECUTE_CODE, 'file_search'], 'worker', h.signal, identity());
    const before = h.host.getContext('worker', identity());
    const published = await h.publishOutput();
    await h.host.provision([Constants.EXECUTE_CODE, 'file_search'], 'worker', h.signal, identity());
    expect(h.host.getContext('worker', identity())).toBe(before);
    expect(
      before?.tool_resources?.execute_code?.files?.map((entry) => entry.file_id).sort(),
    ).toEqual(['input', published.file_id, 'worker-setup'].sort());
    expect(h.provisionToCodeEnv).toHaveBeenCalledTimes(3);
    expect(h.provisionToVectorDB).toHaveBeenCalledTimes(3);
    expect(h.loadFiles).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: expect.objectContaining({ sessionId: 'private-child' }),
        provenance: expect.objectContaining({
          agentId: 'worker',
          executionId: 'child',
          parentExecutionId: 'run',
        }),
      }),
    );
  });

  it('does not provision private staged outputs before explicit publication', async () => {
    const h = harness({ setup: [] });
    await h.prepare();
    await h.host.session.capture('worker', identity(), 'private-call', {
      session_id: 'private-child',
      files: [{ id: 'private-file', name: 'private.csv' }],
    });
    await h.host.provision([Constants.EXECUTE_CODE], 'worker', h.signal, identity());
    expect(h.provisionToCodeEnv.mock.calls.map(([params]) => params.file.file_id)).toEqual([
      'input',
    ]);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('preserves the root historical resources and runtime while descendants receive current inputs', async () => {
    const h = harness();
    const root = h.contexts.get('parent')!;
    root.tool_resources!.file_search = { file_ids: ['parent-setup'] };
    root.provisionState = {
      codeEnvFiles: [file('historical-deferred')],
      vectorDBFiles: [],
      aliveFileIds: new Set(),
      agentScopedFileIds: new Set(['parent-setup']),
    };
    const originalCodeContext = root.codeExecutionContext;
    await h.prepare();
    await h.host.provision([Constants.EXECUTE_CODE], 'parent', h.signal);
    const published = await h.publishOutput();
    await h.host.provision([Constants.EXECUTE_CODE], 'parent', h.signal);
    expect(h.host.getContext('parent')).toBe(root);
    expect(root.codeExecutionContext).toBe(originalCodeContext);
    expect(root.codeExecutionContext?.codeSessionKey).toBe('base-agent-session');
    expect(root.tool_resources?.file_search?.file_ids).toEqual(['parent-setup']);
    expect(root.tool_resources?.execute_code?.files?.map((entry) => entry.file_id).sort()).toEqual(
      ['historical', 'historical-deferred', 'input', published.file_id].sort(),
    );
    expect(
      h.host
        .getContext('worker', identity())
        ?.provisionState?.codeEnvFiles.map((entry) => entry.file_id)
        .sort(),
    ).toEqual(['input', 'worker-setup']);
    expect(
      h.provisionToCodeEnv.mock.calls.filter(
        ([params]) => params.file.file_id === 'historical-deferred',
      ),
    ).toHaveLength(1);
    expect(h.loadFiles).toHaveBeenCalledTimes(1);
  });

  it('keeps successful refs across a partial failure, publication refresh and retry', async () => {
    const h = harness({ inputs: [file('good'), file('retry')], setup: [] });
    let fail = true;
    h.provisionToCodeEnv.mockImplementation(async (params) => {
      if (params.file.file_id === 'retry' && fail) throw new Error('Temporary Code API outage');
      return h.codeResult(params);
    });
    await h.prepare();
    await expect(
      h.host.provision([Constants.EXECUTE_CODE], 'worker', h.signal, identity()),
    ).rejects.toThrow('Failed to provision');
    const before = h.host.getContext('worker', identity());
    expect(before?.pendingProvisionedCodeFiles?.map((entry) => entry.id)).toEqual(['remote-good']);
    const published = await h.publishOutput();
    fail = false;
    const recovered = await h.host.provision(
      [Constants.EXECUTE_CODE],
      'worker',
      h.signal,
      identity(),
    );
    expect(h.host.getContext('worker', identity())).toBe(before);
    expect(recovered?.map((entry) => entry.id).sort()).toEqual(
      ['remote-good', 'remote-retry', `remote-${published.file_id}`].sort(),
    );
    expect(
      h.provisionToCodeEnv.mock.calls.filter(([params]) => params.file.file_id === 'good'),
    ).toHaveLength(1);
    expect(before?.provisionState?.codeEnvFiles).toEqual([]);
  });

  it('rejects an older snapshot arriving after a newer grant removal', async () => {
    const h = harness({ setup: [] });
    await h.prepare();
    const published = await h.publishOutput();
    const context = h.host.getContext('worker', identity());
    const actor = h.host.session.actorFor('worker', identity());
    const sessionKey = context!.codeExecutionContext!.codeSessionKey;
    await h.deps.prepareAgent({
      actor,
      files: [...h.input, published],
      sessionKey,
      revision: 5,
      signal: h.signal,
    });
    await h.deps.prepareAgent({ actor, files: h.input, sessionKey, revision: 6, signal: h.signal });
    await h.deps.prepareAgent({
      actor,
      files: [...h.input, published],
      sessionKey,
      revision: 4,
      signal: h.signal,
    });
    expect(h.host.getContext('worker', identity())).toBe(context);
    expect(context?.provisionState?.codeEnvFiles.map((entry) => entry.file_id)).toEqual(['input']);
  });

  it('joins an in-flight refresh before a later snapshot can retain a deleted publication', async () => {
    const h = harness({ setup: [] });
    const read = deferred<TFile[]>();
    try {
      await h.prepare();
      const published = await h.publishOutput();
      await h.host.session.prepareTools('worker', identity(), h.signal);
      const context = h.host.getContext('worker', identity());
      expect(context?.provisionState?.codeEnvFiles.map((entry) => entry.file_id)).toContain(
        published.file_id,
      );
      h.saved.splice(0);
      h.listPublications.mockImplementationOnce(() => read.promise);
      const reads = h.listPublications.mock.calls.length;
      const refreshed = h.host.session.prepareTools('worker', identity(), h.signal);
      let snapshotSettled = false;
      const snapshot = h.host.session
        .prepareTools('worker', identity(), h.signal, 'snapshot')
        .then(() => {
          snapshotSettled = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const settledBeforeRead = snapshotSettled;
      read.resolve([]);
      await Promise.all([refreshed, snapshot]);

      const provisioned = await h.host.provisionPrepared(
        [Constants.EXECUTE_CODE],
        'worker',
        h.signal,
        identity(),
      );
      expect(settledBeforeRead).toBe(false);
      expect(h.listPublications).toHaveBeenCalledTimes(reads + 1);
      expect(h.host.getContext('worker', identity())).toBe(context);
      expect(provisioned?.map((entry) => entry.id)).toEqual(['remote-input']);
      expect(context?.tool_resources?.execute_code?.files?.map((entry) => entry.file_id)).toEqual([
        'input',
      ]);
    } finally {
      read.resolve([]);
      await h.host.session.close();
    }
  });

  it('serializes preparation with provisioning without blocking another execution', async () => {
    const h = harness({ setup: [] });
    const first = identity('first');
    const second = identity('second');
    await Promise.all([h.prepare(first), h.prepare(second)]);
    const entered = deferred<void>();
    const finish = deferred<void>();
    h.provisionToCodeEnv.mockImplementationOnce(async (params) => {
      entered.resolve();
      await finish.promise;
      return h.codeResult(params);
    });
    const upload = h.host.provision([Constants.EXECUTE_CODE], 'worker', h.signal, first);
    await entered.promise;
    const before = h.host.getContext('worker', first)!;
    let refreshed = false;
    const refresh = h.deps
      .prepareAgent({
        actor: h.host.session.actorFor('worker', first),
        files: [...h.input, file('new')],
        sessionKey: before.codeExecutionContext!.codeSessionKey,
        revision: 100,
        signal: h.signal,
      })
      .then(() => {
        refreshed = true;
      });
    await h.host.provision([Constants.EXECUTE_CODE], 'worker', h.signal, second);
    expect(refreshed).toBe(false);
    finish.resolve();
    await Promise.all([upload, refresh]);
    expect(h.host.getContext('worker', first)).toBe(before);
    expect(before.tool_resources?.execute_code?.files?.map((entry) => entry.file_id)).toEqual([
      'input',
    ]);
    expect(before.provisionState?.codeEnvFiles.map((entry) => entry.file_id)).toEqual(['new']);
  });

  it('fails a setup load closed while another execution and a later retry succeed', async () => {
    const h = harness();
    h.loadFiles.mockRejectedValueOnce(new Error('Setup load failed'));
    const results = await Promise.allSettled([
      h.prepare(identity('first')),
      h.prepare(identity('second')),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(h.host.getContext('worker', identity('first'))).toBeUndefined();
    expect(h.host.getContext('worker', identity('second'))).toBeDefined();
    expect(h.provisionToCodeEnv).not.toHaveBeenCalled();
    await h.prepare(identity('first'));
    await h.host.provision([Constants.EXECUTE_CODE], 'worker', h.signal, identity('first'));
    expect(h.provisionToCodeEnv).toHaveBeenCalledTimes(2);
  });

  it('fails access errors closed and removes denied setup ids from runtime resources', async () => {
    const h = harness();
    h.filterFiles.mockRejectedValueOnce(new Error('ACL unavailable'));
    await expect(h.prepare()).rejects.toThrow('ACL unavailable');
    expect(h.host.getContext('worker', identity())).toBeUndefined();
    h.filterFiles.mockResolvedValue([]);
    await h.prepare();
    const context = h.host.getContext('worker', identity());
    expect(context?.tool_resources?.execute_code?.file_ids).toEqual([]);
    expect(context?.tool_resources?.file_search?.file_ids).toEqual([]);
    expect(context?.provisionState?.agentScopedFileIds).toEqual(new Set());
    await h.host.provision([Constants.EXECUTE_CODE], 'worker', h.signal, identity());
    expect(h.provisionToCodeEnv.mock.calls.map(([params]) => params.file.file_id)).toEqual([
      'input',
    ]);
  });

  it('applies one endpoint size budget to current inputs and setup files', async () => {
    const h = harness({
      inputs: [file('input', { bytes: 600_000 })],
      setup: [file('worker-setup', { bytes: 600_000, context: FileContext.agents })],
    });
    if (!h.req.config) throw new Error('Missing test configuration');
    h.req.config.fileConfig = { endpoints: { openAI: { totalSizeLimit: 1 } } };
    await expect(h.prepare()).rejects.toThrow('not supported by the receiving agent');
    expect(h.host.getContext('worker', identity())).toBeUndefined();
    expect(h.provisionToCodeEnv).not.toHaveBeenCalled();
  });

  it.each(['resource', 'code queue', 'search queue'] as const)(
    'includes retained root files from the %s in the shared-file budget',
    async (location) => {
      const h = harness({ inputs: [file('input', { bytes: 600_000 })], setup: [] });
      h.req.config!.fileConfig = { endpoints: { openAI: { totalSizeLimit: 1 } } };
      const retained = file('retained', { bytes: 600_000 });
      const root = h.contexts.get('parent')!;
      root.tool_resources = {
        execute_code: { files: location === 'resource' ? [retained] : [] },
      };
      root.provisionState = {
        codeEnvFiles: location === 'code queue' ? [retained] : [],
        vectorDBFiles: location === 'search queue' ? [retained] : [],
        aliveFileIds: new Set(),
        agentScopedFileIds: new Set(),
      };
      const resources = structuredClone(root.tool_resources);
      const queues = structuredClone({
        codeEnvFiles: root.provisionState.codeEnvFiles,
        vectorDBFiles: root.provisionState.vectorDBFiles,
      });
      try {
        await expect(h.host.session.prepareTools('parent', undefined, h.signal)).rejects.toThrow(
          'not supported by the receiving agent',
        );
        expect(root.tool_resources).toEqual(resources);
        expect(root.provisionState).toMatchObject(queues);
        expect(h.provisionToCodeEnv).not.toHaveBeenCalled();
        expect(h.loadFiles).not.toHaveBeenCalled();

        retained.bytes = 400_000;
        await h.host.session.prepareTools('parent', undefined, h.signal);
        expect(root.provisionState?.codeEnvFiles.map((entry) => entry.file_id)).toContain('input');
      } finally {
        await h.host.session.close();
      }
    },
  );

  it('counts retained root files once across resources, queues and the current manifest', async () => {
    const current = file('input', { bytes: 600_000 });
    const retained = file('retained', { bytes: 400_000 });
    const h = harness({ inputs: [current], setup: [] });
    h.req.config!.fileConfig = { endpoints: { openAI: { totalSizeLimit: 1 } } };
    const root = h.contexts.get('parent')!;
    root.tool_resources = {
      execute_code: { files: [retained, current] },
      file_search: { files: [retained] },
    };
    root.provisionState = {
      codeEnvFiles: [retained, current],
      vectorDBFiles: [retained],
      aliveFileIds: new Set(),
      agentScopedFileIds: new Set(),
    };
    try {
      await h.host.session.prepareTools('parent', undefined, h.signal);
      await h.host.session.prepareTools('parent', undefined, h.signal);
      expect(root.provisionState.codeEnvFiles.map((entry) => entry.file_id)).toEqual([
        'retained',
        'input',
      ]);

      root.provisionState.vectorDBFiles.push(file('later-setup', { bytes: 100_000 }));
      await expect(h.host.session.prepareTools('parent', undefined, h.signal)).rejects.toThrow(
        'not supported by the receiving agent',
      );
    } finally {
      await h.host.session.close();
    }
  });

  it('releases the root budget when a previous publication is removed', async () => {
    const h = harness({ inputs: [], setup: [] });
    h.req.config!.fileConfig = { endpoints: { openAI: { totalSizeLimit: 1 } } };
    const root = h.contexts.get('parent')!;
    root.tool_resources = { execute_code: { files: [file('retained', { bytes: 300_000 })] } };
    const preparation = {
      actor: h.host.session.actorFor('parent'),
      sessionKey: root.codeExecutionContext!.codeSessionKey,
      signal: h.signal,
    };
    try {
      await h.deps.prepareAgent({
        ...preparation,
        files: [file('old-publication', { bytes: 600_000 })],
        revision: 1,
      });
      await h.deps.prepareAgent({
        ...preparation,
        files: [file('new-publication', { bytes: 600_000 })],
        revision: 2,
      });
      expect(root.provisionState?.codeEnvFiles.map((entry) => entry.file_id)).toEqual([
        'new-publication',
      ]);
      expect(root.tool_resources.execute_code?.files?.map((entry) => entry.file_id)).toEqual([
        'retained',
      ]);
    } finally {
      await h.host.session.close();
    }
  });

  it('counts a current attachment also present in agent setup only once', async () => {
    const shared = file('same-file', { bytes: 600_000, context: FileContext.agents });
    const h = harness({ inputs: [shared], setup: [shared] });
    if (!h.req.config) throw new Error('Missing test configuration');
    h.req.config.fileConfig = { endpoints: { openAI: { totalSizeLimit: 1 } } };
    await h.prepare();
    await h.host.provision([Constants.EXECUTE_CODE], 'worker', h.signal, identity());
    expect(h.provisionToCodeEnv).toHaveBeenCalledTimes(1);
  });

  it('rechecks the managed deployment when an unchanged snapshot is reused', async () => {
    const h = harness();
    await h.prepare();
    h.contexts.get('worker')!.codeExecutionContext!.executionRouteKey = 'different-deployment';
    await expect(h.host.session.prepareTools('worker', identity(), h.signal)).rejects.toThrow(
      'environment changed',
    );
    expect(h.provisionToCodeEnv).not.toHaveBeenCalled();
  });

  it('does not commit cancelled preparation and permits a new attempt', async () => {
    const h = harness();
    const entered = deferred<void>();
    const loaded = deferred<TFile[]>();
    h.loadFiles.mockImplementationOnce(async () => {
      entered.resolve();
      return loaded.promise;
    });
    const controller = new AbortController();
    const preparing = h.prepare(identity(), controller.signal);
    await entered.promise;
    controller.abort(new Error('cancel preparation'));
    loaded.resolve(h.setup);
    await expect(preparing).rejects.toThrow('cancel preparation');
    expect(h.host.getContext('worker', identity())).toBeUndefined();
    await h.prepare();
    expect(h.host.getContext('worker', identity())).toBeDefined();
  });

  it('rejects attached environments and preserves host deployment identity', async () => {
    const h = harness();
    const context = h.contexts.get('worker')!.codeExecutionContext!;
    const shared = {
      ...context,
      codeSessionKey: 'execution-session',
      runtimeSessionHint: 'execution-session',
    };
    expect(resolveRunFileCodeExecutionContext(context, shared)).toEqual(shared);
    expect(() =>
      resolveRunFileCodeExecutionContext({ ...context, executionRouteKey: 'other' }, shared),
    ).toThrow('environment changed');
    context.environmentType = 'attached';
    await expect(h.prepare()).rejects.toThrow('isolated managed');
    expect(h.loadFiles).not.toHaveBeenCalled();
  });
});
