import { Constants } from '@librechat/agents';
import { EToolResources, FileContext } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { ProvisionState } from '~/agents/resources';
import type { ProvisionToolContext } from './callback';
import type { ServerRequest } from '~/types';
import { createProvisionFilesCallback } from './callback';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

const req = { user: { id: 'user-1' } } as ServerRequest;

function makeFile(overrides: Partial<TFile> = {}): TFile {
  return {
    file_id: 'file-1',
    filename: 'data.csv',
    filepath: '/uploads/data.csv',
    type: 'text/csv',
    user: 'user-1',
    object: 'file',
    bytes: 10,
    embedded: false,
    usage: 0,
    context: FileContext.message_attachment,
    ...overrides,
  } as TFile;
}

function state(
  codeEnvFiles: TFile[],
  vectorDBFiles: TFile[],
  agentScopedFileIds: string[] = [],
): ProvisionState {
  return {
    codeEnvFiles,
    vectorDBFiles,
    aliveFileIds: new Set<string>(),
    agentScopedFileIds: new Set(agentScopedFileIds),
  };
}

function buildHarness({
  contexts,
  codeImpl,
  vectorImpl,
}: {
  contexts: Array<[string, ProvisionToolContext]>;
  codeImpl?: jest.Mock;
  vectorImpl?: jest.Mock;
}) {
  const provisionToCodeEnv =
    codeImpl ??
    jest.fn(async ({ file, sandboxFilename }: { file: TFile; sandboxFilename: string }) => ({
      referenceSet: {
        codeEnvRefs: {
          default: {
            kind: 'user',
            id: 'u1',
            storage_session_id: 'sess-1',
            file_id: 'remote-1',
          },
        },
      },
      refUpdate: {
        file_id: file.file_id,
        routeKey: 'default',
        ref: { kind: 'user', id: 'u1', storage_session_id: 'sess-1', file_id: 'remote-1' },
      },
      /* Mirrors the service: the sandbox stores a converted image under a corrected
       * extension, so the name the model is told is not always the record's. */
      sandboxFilename,
    }));
  const provisionToVectorDB =
    vectorImpl ??
    jest.fn(async ({ file }: { file: TFile }) => ({
      embedded: true,
      fileUpdate: { file_id: file.file_id, embedded: true },
    }));
  const updateFile = jest.fn(async () => ({}));
  const updateCodeEnvRef = jest.fn(async () => ({}));
  const addEmbeddedEntity = jest.fn(async () => ({}));
  const agentToolContexts = new Map<string, ProvisionToolContext>(contexts);

  return {
    provisionToCodeEnv,
    provisionToVectorDB,
    updateFile,
    updateCodeEnvRef,
    addEmbeddedEntity,
    agentToolContexts,
    provisionFiles: createProvisionFilesCallback({
      req,
      agentToolContexts,
      provisionToCodeEnv: provisionToCodeEnv as never,
      provisionToVectorDB: provisionToVectorDB as never,
      updateFile,
      updateCodeEnvRef,
      addEmbeddedEntity,
    }),
  };
}

describe('createProvisionFilesCallback', () => {
  it('scopes only the agent own resource files to its identity', async () => {
    /* A user can attach another agent's setup file to this conversation. Uploading it under
     * this agent would place it in a namespace this agent's other users share, so the
     * upload identity comes from membership in this agent's resources. */
    const own = makeFile({ file_id: 'own-file', context: FileContext.agents });
    const foreign = makeFile({ file_id: 'foreign-file', context: FileContext.agents });
    const { provisionFiles, provisionToCodeEnv } = buildHarness({
      contexts: [['agent-a', { provisionState: state([own, foreign], [], ['own-file']) }]],
    });

    await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');

    const byFile = new Map(
      provisionToCodeEnv.mock.calls.map(([args]) => [
        (args as { file: TFile }).file.file_id,
        (args as { entity_id?: string }).entity_id,
      ]),
    );
    expect(byFile.get('own-file')).toBe('agent-a');
    expect(byFile.get('foreign-file')).toBeUndefined();
  });

  it('provisions once for the request when two agents queue the same file', async () => {
    const shared = makeFile();
    const contexts: Array<[string, ProvisionToolContext]> = [
      ['agent-a', { provisionState: state([{ ...shared }], []) }],
      ['agent-b', { provisionState: state([{ ...shared }], []) }],
    ];
    const { provisionFiles, provisionToCodeEnv, agentToolContexts } = buildHarness({ contexts });

    await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');
    await provisionFiles([Constants.EXECUTE_CODE], 'agent-b');

    expect(provisionToCodeEnv).toHaveBeenCalledTimes(1);
    for (const agentId of ['agent-a', 'agent-b']) {
      const ctx = agentToolContexts.get(agentId);
      const files = (ctx?.tool_resources as Record<string, { files?: TFile[] }>)[
        EToolResources.execute_code
      ]?.files;
      expect(files?.[0]?.metadata).toMatchObject({
        codeEnvRefs: { default: { file_id: 'remote-1' } },
      });
      expect(ctx?.provisionState?.codeEnvFiles).toHaveLength(0);
    }
  });

  it('gives shared files consistent names across agents with private collisions', async () => {
    const shared = makeFile({ file_id: 'shared' });
    const own = makeFile({ file_id: 'own' });
    const { provisionFiles, provisionToCodeEnv } = buildHarness({
      contexts: [
        ['agent-a', { provisionState: state([own, { ...shared }], [], ['own']) }],
        ['agent-b', { provisionState: state([{ ...shared }], []) }],
      ],
    });

    await Promise.all([
      provisionFiles([Constants.EXECUTE_CODE], 'agent-a'),
      provisionFiles([Constants.EXECUTE_CODE], 'agent-b'),
    ]);

    const calls = provisionToCodeEnv.mock.calls.map(([args]) => args);
    expect(calls.filter(({ file }) => file.file_id === 'shared')).toHaveLength(1);
    expect(calls.find(({ file }) => file.file_id === 'shared').sandboxFilename).toBe('data.csv');
    expect(calls.find(({ file }) => file.file_id === 'own').sandboxFilename).not.toBe('data.csv');
  });

  it('recovers a cleared reference under its saved route name', async () => {
    const pending = state([makeFile()], []);
    pending.codeEnvRecoveryNames = new Map([
      ['file-1', { name: 'saved-alias.csv', isTargetScope: true }],
    ]);
    const { provisionFiles, provisionToCodeEnv } = buildHarness({
      contexts: [['agent-a', { provisionState: pending }]],
    });

    const files = await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');

    expect(provisionToCodeEnv).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxFilename: 'saved-alias.csv' }),
    );
    expect(files?.[0].name).toBe('saved-alias.csv');
  });

  it.each(['agent-a', 'agent-b'])(
    'shares recovery around live private paths when %s runs first',
    async (first) => {
      const shared = makeFile({ file_id: 'shared' });
      const own = makeFile({
        file_id: 'own',
        metadata: {
          codeEnvRef: {
            kind: 'agent',
            id: 'agent-a',
            storage_session_id: 'live',
            file_id: 'own-remote',
            sandboxFilename: 'data.csv',
          },
        },
      });
      const { provisionFiles, provisionToCodeEnv } = buildHarness({
        contexts: [
          [
            'agent-a',
            {
              provisionState: state([{ ...shared }], [], ['own']),
              tool_resources: { execute_code: { files: [own] } },
            },
          ],
          ['agent-b', { provisionState: state([{ ...shared }], []) }],
        ],
      });
      const a = await provisionFiles([Constants.EXECUTE_CODE], first);
      const b = await provisionFiles(
        [Constants.EXECUTE_CODE],
        first === 'agent-a' ? 'agent-b' : 'agent-a',
      );
      expect(provisionToCodeEnv).toHaveBeenCalledTimes(1);
      expect(a[0].name).toBe(b[0].name);
      expect(a[0].name).not.toBe('data.csv');
    },
  );

  it('drops superseded saved paths before assigning recovery aliases', async () => {
    const older = makeFile({ file_id: 'older', createdAt: '2026-01-01' });
    const newer = makeFile({ file_id: 'newer', createdAt: '2026-02-01' });
    const pending = state([older, newer], []);
    pending.codeEnvRecoveryNames = new Map([
      ['older', { name: 'data.csv', isTargetScope: true }],
      ['newer', { name: 'data.csv', isTargetScope: true }],
    ]);
    const { provisionFiles, provisionToCodeEnv } = buildHarness({
      contexts: [['agent-a', { provisionState: pending }]],
    });
    const files = await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');
    expect(provisionToCodeEnv).toHaveBeenCalledTimes(1);
    expect(provisionToCodeEnv).toHaveBeenCalledWith(
      expect.objectContaining({ file: newer, sandboxFilename: 'data.csv' }),
    );
    expect(files).toHaveLength(1);
    expect(pending.codeEnvFiles).toHaveLength(0);
  });

  it('does not recover old content already superseded by a live saved path', async () => {
    const older = makeFile({ file_id: 'older', createdAt: '2026-01-01' });
    const newer = makeFile({
      file_id: 'newer',
      createdAt: '2026-02-01',
      metadata: {
        codeEnvRef: {
          kind: 'user',
          id: 'user-1',
          storage_session_id: 'live',
          file_id: 'new-remote',
          sandboxFilename: 'data.csv',
        },
      },
    });
    const pending = state([older], []);
    pending.codeEnvRecoveryNames = new Map([['older', { name: 'data.csv', isTargetScope: true }]]);
    const { provisionFiles, provisionToCodeEnv } = buildHarness({
      contexts: [
        [
          'agent-a',
          { provisionState: pending, tool_resources: { execute_code: { files: [newer] } } },
        ],
      ],
    });
    await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');
    expect(provisionToCodeEnv).not.toHaveBeenCalled();
    expect(pending.codeEnvFiles).toHaveLength(0);
  });

  it('keeps recoverable prefix conflicts as separate inputs', async () => {
    const pending = state([makeFile({ file_id: 'parent' }), makeFile({ file_id: 'child' })], []);
    pending.codeEnvRecoveryNames = new Map([
      ['parent', { name: 'reports', isTargetScope: true }],
      ['child', { name: 'reports/data.csv', isTargetScope: true }],
    ]);
    const { provisionFiles, provisionToCodeEnv } = buildHarness({
      contexts: [['agent-a', { provisionState: pending }]],
    });
    const result = await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');
    expect(provisionToCodeEnv).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((f) => f.name)).size).toBe(2);
  });

  it.each([false, true])(
    'aliases foreign-scope names instead of suppressing inputs (cleared=%s)',
    async (cleared) => {
      const foreign = makeFile({
        file_id: 'foreign',
        metadata: {
          codeEnvRef: {
            kind: 'agent',
            id: 'another-agent',
            storage_session_id: 'foreign-session',
            file_id: 'foreign-remote',
            sandboxFilename: 'data.csv',
          },
        },
      });
      const own = makeFile({ file_id: 'own' });
      const pending = state([foreign, own], []);
      pending.codeEnvRecoveryNames = new Map([['own', { name: 'data.csv', isTargetScope: true }]]);
      if (cleared) {
        foreign.metadata = {};
        pending.codeEnvRecoveryNames.set('foreign', { name: 'data.csv', isTargetScope: false });
      }
      const { provisionFiles, provisionToCodeEnv } = buildHarness({
        contexts: [['agent-a', { provisionState: pending }]],
      });
      const result = await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');
      expect(provisionToCodeEnv).toHaveBeenCalledTimes(2);
      expect(new Set(result.map((f) => f.name)).size).toBe(2);
    },
  );

  it('uses route-wide ownership priority for confirmed recovery duplicates', async () => {
    const privateFile = makeFile({ file_id: 'private', createdAt: '2026-02-01' });
    const shared = makeFile({ file_id: 'shared', createdAt: '2026-01-01' });
    const a = state([{ ...privateFile }, { ...shared }], [], ['private']);
    const b = state([{ ...privateFile }, { ...shared }], []);
    for (const pending of [a, b])
      pending.codeEnvRecoveryNames = new Map([
        ['private', { name: 'data.csv', isTargetScope: true }],
        ['shared', { name: 'data.csv', isTargetScope: true }],
      ]);
    const { provisionFiles, provisionToCodeEnv } = buildHarness({
      contexts: [
        ['agent-a', { provisionState: a }],
        ['agent-b', { provisionState: b }],
      ],
    });
    await Promise.all([
      provisionFiles([Constants.EXECUTE_CODE], 'agent-a'),
      provisionFiles([Constants.EXECUTE_CODE], 'agent-b'),
    ]);
    expect(provisionToCodeEnv).toHaveBeenCalledTimes(1);
    expect(provisionToCodeEnv).toHaveBeenCalledWith(
      expect.objectContaining({ file: expect.objectContaining({ file_id: 'shared' }) }),
    );
  });

  it('returns the provisioned refs so the batch can inject them', async () => {
    const { provisionFiles } = buildHarness({
      contexts: [['agent-a', { provisionState: state([makeFile()], []) }]],
    });

    const provisioned = await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');

    expect(provisioned).toEqual([
      {
        id: 'remote-1',
        resource_id: 'u1',
        storage_session_id: 'sess-1',
        name: 'data.csv',
        kind: 'user',
      },
    ]);
  });

  it('reports the name the sandbox stored, not the record name', async () => {
    /* A converted image is uploaded under a corrected extension, so telling the model the
     * record's name points it at a path the sandbox does not have. */
    const converted = makeFile({ file_id: 'converted', filename: 'photo.png', type: 'image/webp' });
    const { provisionFiles } = buildHarness({
      contexts: [['agent-a', { provisionState: state([converted], []) }]],
      codeImpl: jest.fn(async ({ file }: { file: TFile }) => ({
        referenceSet: {
          codeEnvRef: { kind: 'user', id: 'u1', storage_session_id: 'sess-1', file_id: 'remote-1' },
          codeEnvRefs: {
            default: {
              kind: 'user',
              id: 'u1',
              storage_session_id: 'sess-1',
              file_id: 'remote-1',
            },
          },
        },
        refUpdate: {
          file_id: file.file_id,
          routeKey: 'default',
          ref: { kind: 'user', id: 'u1', storage_session_id: 'sess-1', file_id: 'remote-1' },
        },
        sandboxFilename: 'photo.webp',
      })),
    });

    const provisioned = await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');

    expect(provisioned.map((entry) => entry.name)).toEqual(['photo.webp']);
  });

  it('assigns deterministic unique names before lazy uploads', async () => {
    const first = makeFile({ file_id: 'first', filename: 'data.csv' });
    const second = makeFile({ file_id: 'second', filename: 'data.csv', bytes: 20 });
    const { provisionFiles, provisionToCodeEnv } = buildHarness({
      contexts: [['agent-a', { provisionState: state([first, second], []) }]],
    });

    const provisioned = await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');
    const uploadedNames = provisionToCodeEnv.mock.calls.map(
      ([args]) => (args as { sandboxFilename: string }).sandboxFilename,
    );

    expect(new Set(uploadedNames).size).toBe(2);
    expect(new Set(provisioned.map((file) => file.name))).toEqual(new Set(uploadedNames));
  });

  it('reserves names already present in the code session', async () => {
    const existing = makeFile({ file_id: 'existing', filename: 'data.csv' });
    const queued = makeFile({ file_id: 'queued', filename: 'data.csv' });
    const { provisionFiles, provisionToCodeEnv } = buildHarness({
      contexts: [
        [
          'agent-a',
          {
            provisionState: state([queued], []),
            tool_resources: { execute_code: { files: [existing] } },
          },
        ],
      ],
    });

    await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');

    expect(provisionToCodeEnv).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxFilename: expect.not.stringMatching(/^data\.csv$/) }),
    );
  });

  it('reserves a stored alias when adding a file on a later turn', async () => {
    const existing = makeFile({
      file_id: 'existing',
      filename: 'data.csv',
      metadata: {
        codeEnvRef: {
          kind: 'user',
          id: 'u1',
          storage_session_id: 's1',
          file_id: 'r1',
          sandboxFilename: 'data-alias.csv',
        },
      },
    });
    const queued = makeFile({ file_id: 'queued', filename: 'data-alias.csv' });
    const { provisionFiles, provisionToCodeEnv } = buildHarness({
      contexts: [
        [
          'agent-a',
          {
            provisionState: state([queued], []),
            tool_resources: { execute_code: { files: [existing] } },
          },
        ],
      ],
    });
    await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');
    expect(provisionToCodeEnv).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxFilename: expect.not.stringMatching(/^data-alias\.csv$/) }),
    );
  });

  it('arbitrates upload names after multipart path normalization', async () => {
    const first = makeFile({ file_id: 'first', filename: 'my dir/data.csv' });
    const second = makeFile({ file_id: 'second', filename: 'data.csv' });
    const { provisionFiles, provisionToCodeEnv } = buildHarness({
      contexts: [['agent-a', { provisionState: state([first, second], []) }]],
    });
    await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');
    const names = provisionToCodeEnv.mock.calls.map(
      ([args]) => (args as { sandboxFilename: string }).sandboxFilename,
    );
    expect(names[0]).toBe('data.csv');
    expect(names[1]).not.toBe('data.csv');
  });

  it('returns the refs to every agent sharing one upload', async () => {
    const shared = makeFile();
    const { provisionFiles } = buildHarness({
      contexts: [
        ['agent-a', { provisionState: state([{ ...shared }], []) }],
        ['agent-b', { provisionState: state([{ ...shared }], []) }],
      ],
    });

    const first = await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');
    const second = await provisionFiles([Constants.EXECUTE_CODE], 'agent-b');

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('persists the shared provisioning result once', async () => {
    const shared = makeFile();
    const { provisionFiles, updateCodeEnvRef } = buildHarness({
      contexts: [
        ['agent-a', { provisionState: state([{ ...shared }], []) }],
        ['agent-b', { provisionState: state([{ ...shared }], []) }],
      ],
    });

    await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');
    await provisionFiles([Constants.EXECUTE_CODE], 'agent-b');

    expect(updateCodeEnvRef).toHaveBeenCalledTimes(1);
  });

  it('holds every waiter until the shared reference is persisted', async () => {
    let releaseWrite: () => void = () => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const shared = makeFile();
    const harness = buildHarness({
      contexts: [
        ['agent-a', { provisionState: state([{ ...shared }], []) }],
        ['agent-b', { provisionState: state([{ ...shared }], []) }],
      ],
    });
    const events: string[] = [];
    harness.updateCodeEnvRef.mockImplementation(async () => {
      await writeGate;
      events.push('write');
      return {};
    });

    const waiterA = harness
      .provisionFiles([Constants.EXECUTE_CODE], 'agent-a')
      .then(() => events.push('a'));
    const waiterB = harness
      .provisionFiles([Constants.EXECUTE_CODE], 'agent-b')
      .then(() => events.push('b'));

    /* Drains every pending microtask, so anything that could return without the write
     * already has by the time this resolves. */
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([]);

    releaseWrite();
    await Promise.all([waiterA, waiterB]);

    expect(events[0]).toBe('write');
    expect(events).toHaveLength(3);
    expect(harness.updateCodeEnvRef).toHaveBeenCalledTimes(1);
  });

  it('aborts the turn when the reference cannot be persisted', async () => {
    const harness = buildHarness({
      contexts: [['agent-a', { provisionState: state([makeFile()], []) }]],
    });
    harness.updateCodeEnvRef.mockRejectedValue(new Error('mongo down'));

    await expect(harness.provisionFiles([Constants.EXECUTE_CODE], 'agent-a')).rejects.toThrow(
      /aborting tool execution rather than running without them/,
    );
    expect(harness.updateCodeEnvRef).toHaveBeenCalledTimes(2);
  });

  it('uploads separately when the agents resolve different code deployments', async () => {
    const shared = makeFile();
    const { provisionFiles, provisionToCodeEnv } = buildHarness({
      contexts: [
        ['agent-a', { provisionState: state([{ ...shared }], []) }],
        [
          'agent-b',
          {
            provisionState: state([{ ...shared }], []),
            codeExecutionContext: { executionProfile: 'stateful', executionRouteKey: 'stateful:x' },
          },
        ],
      ],
    });

    await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');
    await provisionFiles([Constants.EXECUTE_CODE], 'agent-b');

    expect(provisionToCodeEnv).toHaveBeenCalledTimes(2);
  });

  it('does not start provisioning after the run is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { provisionFiles, provisionToCodeEnv } = buildHarness({
      contexts: [['agent-a', { provisionState: state([makeFile()], []) }]],
    });

    await expect(
      provisionFiles([Constants.EXECUTE_CODE], 'agent-a', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(provisionToCodeEnv).not.toHaveBeenCalled();
  });

  it('preserves cancellation raised during code provisioning and skips search work', async () => {
    const controller = new AbortController();
    const codeImpl = jest.fn(async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    });
    const vectorImpl = jest.fn();
    const { provisionFiles } = buildHarness({
      contexts: [
        ['agent-a', { provisionState: state([makeFile()], [makeFile({ file_id: 'search-1' })]) }],
      ],
      codeImpl,
      vectorImpl,
    });

    await expect(
      provisionFiles([Constants.EXECUTE_CODE, 'file_search'], 'agent-a', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(vectorImpl).not.toHaveBeenCalled();
  });

  it('preserves cancellation raised during vector provisioning', async () => {
    const controller = new AbortController();
    const vectorImpl = jest.fn(async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    });
    const { provisionFiles } = buildHarness({
      contexts: [['agent-a', { provisionState: state([], [makeFile()]) }]],
      vectorImpl,
    });

    await expect(
      provisionFiles(['file_search'], 'agent-a', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('preserves a homogeneous Code API rate-limit failure from lazy provisioning', async () => {
    const rateLimit = Object.assign(new Error('rate limited'), {
      name: 'CodeApiRateLimitError',
      code: 'CODE_API_RATE_LIMITED',
      status: 429,
      statusCode: 429,
      retryAfterMs: 30_000,
    });
    const { provisionFiles } = buildHarness({
      contexts: [['agent-a', { provisionState: state([makeFile()], []) }]],
      codeImpl: jest.fn().mockRejectedValue(rateLimit),
    });

    await expect(provisionFiles([Constants.EXECUTE_CODE], 'agent-a')).rejects.toBe(rateLimit);
  });

  it('retains every failure when lazy code provisioning has mixed causes', async () => {
    const first = new Error('storage unavailable');
    const second = new Error('code api unavailable');
    const { provisionFiles } = buildHarness({
      contexts: [
        [
          'agent-a',
          {
            provisionState: state(
              [makeFile({ file_id: 'first' }), makeFile({ file_id: 'second' })],
              [],
            ),
          },
        ],
      ],
      codeImpl: jest.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second),
    });

    await expect(provisionFiles([Constants.EXECUTE_CODE], 'agent-a')).rejects.toMatchObject({
      cause: first,
      errors: [first, second],
    });
  });

  it('shares embedding work across agents queueing the same search file', async () => {
    const shared = makeFile();
    const { provisionFiles, provisionToVectorDB, addEmbeddedEntity } = buildHarness({
      contexts: [
        ['agent-a', { provisionState: state([], [{ ...shared }]) }],
        ['agent-b', { provisionState: state([], [{ ...shared }]) }],
      ],
    });

    await Promise.all([
      provisionFiles(['file_search'], 'agent-a'),
      provisionFiles(['file_search'], 'agent-b'),
    ]);

    expect(provisionToVectorDB).toHaveBeenCalledTimes(1);
    /* Unscoped vectors land in the requesting user's namespace, so that is what gets
     * recorded. Without it the file reads as unembedded and re-embeds every turn. */
    expect(addEmbeddedEntity).toHaveBeenCalledTimes(1);
    expect(addEmbeddedEntity).toHaveBeenCalledWith({
      file_id: shared.file_id,
      entityId: 'user-1',
    });
  });

  it('retries a failed upload on a later tool call instead of replaying the rejection', async () => {
    let attempts = 0;
    const codeImpl = jest.fn(async ({ file }: { file: TFile }) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('code api unreachable');
      }
      return {
        referenceSet: {
          codeEnvRefs: {
            default: {
              kind: 'user',
              id: 'u1',
              storage_session_id: 'sess-1',
              file_id: 'remote-1',
            },
          },
        },
        refUpdate: {
          file_id: file.file_id,
          routeKey: 'default',
          ref: { kind: 'user', id: 'u1', storage_session_id: 'sess-1', file_id: 'remote-1' },
        },
      };
    });
    const { provisionFiles, agentToolContexts } = buildHarness({
      contexts: [['agent-a', { provisionState: state([makeFile()], []) }]],
      codeImpl,
    });

    await expect(provisionFiles([Constants.EXECUTE_CODE], 'agent-a')).rejects.toThrow(
      /Failed to provision/,
    );
    expect(agentToolContexts.get('agent-a')?.provisionState?.codeEnvFiles).toHaveLength(1);

    await expect(provisionFiles([Constants.EXECUTE_CODE], 'agent-a')).resolves.toHaveLength(1);
    expect(codeImpl).toHaveBeenCalledTimes(2);
  });

  it('returns earlier successes when the rest of a batch succeeds on retry', async () => {
    const first = makeFile({ file_id: 'first', filename: 'first.csv' });
    const second = makeFile({ file_id: 'second', filename: 'second.csv' });
    let secondAttempts = 0;
    const codeImpl = jest.fn(
      async ({ file, sandboxFilename }: { file: TFile; sandboxFilename: string }) => {
        if (file.file_id === 'second' && secondAttempts++ === 0) {
          throw new Error('temporary failure');
        }
        const remoteId = `remote-${file.file_id}`;
        return {
          referenceSet: {
            codeEnvRefs: {
              default: {
                kind: 'user',
                id: 'u1',
                storage_session_id: 'sess-1',
                file_id: remoteId,
              },
            },
          },
          refUpdate: {
            file_id: file.file_id,
            routeKey: 'default',
            ref: {
              kind: 'user',
              id: 'u1',
              storage_session_id: 'sess-1',
              file_id: remoteId,
            },
          },
          sandboxFilename,
        };
      },
    );
    const { provisionFiles } = buildHarness({
      contexts: [['agent-a', { provisionState: state([first, second], []) }]],
      codeImpl,
    });

    await expect(provisionFiles([Constants.EXECUTE_CODE], 'agent-a')).rejects.toThrow(
      /Failed to provision/,
    );
    const retried = await provisionFiles([Constants.EXECUTE_CODE], 'agent-a');

    expect(retried.map((file) => file.id).sort()).toEqual(['remote-first', 'remote-second']);
    expect(codeImpl.mock.calls.filter(([args]) => args.file.file_id === 'first')).toHaveLength(1);
  });

  it('treats a declined embedding as a failure rather than a result', async () => {
    /* The service resolves with embedded false when the vector store declines the file.
     * That means the vectors are absent just as a throw does, so the file has to stay
     * queued instead of search proceeding without it. */
    const vectorImpl = jest.fn(async () => ({ embedded: false, fileUpdate: null }));
    const { provisionFiles, agentToolContexts } = buildHarness({
      contexts: [['agent-a', { provisionState: state([], [makeFile()]) }]],
      vectorImpl,
    });

    await expect(provisionFiles(['file_search'], 'agent-a')).rejects.toThrow(
      /aborting tool execution rather than searching without them/,
    );
    expect(agentToolContexts.get('agent-a')?.provisionState?.vectorDBFiles).toHaveLength(1);
  });

  it('aborts the turn when search provisioning fails', async () => {
    const vectorImpl = jest.fn(async () => {
      throw new Error('rag unreachable');
    });
    const { provisionFiles, agentToolContexts } = buildHarness({
      contexts: [['agent-a', { provisionState: state([], [makeFile()]) }]],
      vectorImpl,
    });

    await expect(provisionFiles(['file_search'], 'agent-a')).rejects.toThrow(
      /aborting tool execution rather than searching without them/,
    );
    expect(agentToolContexts.get('agent-a')?.provisionState?.vectorDBFiles).toHaveLength(1);
  });

  it('ignores tool batches that need neither code nor search', async () => {
    const { provisionFiles, provisionToCodeEnv, provisionToVectorDB } = buildHarness({
      contexts: [['agent-a', { provisionState: state([makeFile()], [makeFile()]) }]],
    });

    await provisionFiles(['web_search'], 'agent-a');

    expect(provisionToCodeEnv).not.toHaveBeenCalled();
    expect(provisionToVectorDB).not.toHaveBeenCalled();
  });
});
