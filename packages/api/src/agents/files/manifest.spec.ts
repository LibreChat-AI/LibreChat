import { FileContext, FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { RunArtifact, RunFileScope, RunFileStore } from './manifest';
import { createRunFileManifest } from './manifest';

const scope: RunFileScope = {
  userId: 'user',
  tenantId: 'tenant',
  conversationId: 'conversation',
  runId: 'run',
};
const parent = { executionId: 'parent', agentId: 'lead' };
const child = { executionId: 'child', agentId: 'worker' };
const sibling = { executionId: 'sibling', agentId: 'reviewer' };
const input: TFile = {
  file_id: 'input',
  filename: 'input.pdf',
  type: 'application/pdf',
  user: 'user',
  tenantId: 'tenant',
  bytes: 12,
  embedded: false,
  filepath: '/private/input.pdf',
  object: 'file',
  usage: 0,
  source: FileSources.local,
  llmDeliveryPath: 'none',
  metadata: { destinationChosen: false },
};

function setup(
  options: { allowSiblingSharing?: boolean; maxFiles?: number; files?: TFile[] } = {},
) {
  let time = 0;
  let fail = false;
  let writes = 0;
  const saved: TFile[] = [];
  const store: RunFileStore<RunArtifact> = {
    list: async () => structuredClone(saved),
    publish: async ({ artifact, provenance }) => {
      writes++;
      if (fail) throw new Error('Storage unavailable');
      const file: TFile = {
        ...input,
        file_id: `${provenance.executionId}-${artifact.id}`,
        filename: artifact.filename,
        conversationId: scope.conversationId,
        context: FileContext.run_artifact,
        metadata: { runFile: provenance },
      };
      saved.push(file);
      return structuredClone(file);
    },
  };
  const create = () =>
    createRunFileManifest({
      scope,
      policy: {
        allowSiblingSharing: options.allowSiblingSharing ?? false,
        maxFiles: options.maxFiles ?? 20,
        ttlMs: 1000,
      },
      root: {
        id: parent.executionId,
        agentIds: ['lead'],
        allowedAgentIds: ['worker', 'reviewer', 'lead'],
      },
      inputFiles: options.files ?? [input],
      inputFileIds: new Set(['input']),
      createdAt: 0,
      now: () => time,
      store,
    });
  const manifest = create();
  const register = (target: ReturnType<typeof create>) => {
    target.register({
      id: 'child',
      parentId: 'parent',
      parentAgentId: 'lead',
      agentIds: ['worker'],
      allowedAgentIds: ['nested'],
    });
    target.register({
      id: 'sibling',
      parentId: 'parent',
      parentAgentId: 'lead',
      agentIds: ['reviewer'],
      allowedAgentIds: [],
    });
  };
  register(manifest);
  return {
    manifest,
    saved,
    store,
    create,
    register,
    writes: () => writes,
    fail: (value: boolean) => {
      fail = value;
    },
    time: (value: number) => {
      time = value;
    },
  };
}

describe('run file manifest', () => {
  it('seeds only authorized current-turn inputs and returns copies without storage paths in the catalog', async () => {
    const { manifest } = setup({
      files: [
        input,
        { ...input, file_id: 'historical' },
        { ...input, file_id: 'setup', context: FileContext.agents },
        { ...input, tenantId: 'foreign', filename: 'foreign.pdf' },
      ],
    });
    const files = await manifest.getFiles(child);
    expect(files.map((file) => file.file_id)).toEqual(['input']);
    files[0].metadata = { destinationChosen: true };
    const catalog = await manifest.list(child);
    expect(catalog[0].paths).toEqual(['execute_code', 'file_search']);
    expect(catalog[0]).not.toHaveProperty('filepath');
    expect(catalog[0].provenance).toEqual({ kind: 'user_attachment', runId: 'run' });
  });

  it('rejects unregistered actors, unapproved descendants and identity reassignment', async () => {
    const { manifest } = setup();
    await expect(manifest.list({ ...child, agentId: 'lead' })).rejects.toThrow('cannot access');
    await manifest.getFiles(child, undefined, 'snapshot');
    await expect(
      manifest.getFiles({ ...child, agentId: 'lead' }, undefined, 'snapshot'),
    ).rejects.toThrow('cannot access');
    expect(() =>
      manifest.register({
        id: 'stranger',
        parentId: 'child',
        parentAgentId: 'worker',
        agentIds: ['reviewer'],
        allowedAgentIds: [],
      }),
    ).toThrow('not authorized');
    expect(() =>
      manifest.register({
        id: 'child',
        parentId: 'parent',
        parentAgentId: 'lead',
        agentIds: ['reviewer'],
        allowedAgentIds: [],
      }),
    ).toThrow('cannot be reassigned');
  });

  it('keeps generated outputs private until publication and permits only the producing execution to publish', async () => {
    const { manifest, writes } = setup();
    manifest.stage(child, { id: 'csv', filename: 'report.csv' });
    expect((await manifest.list(parent)).map((file) => file.file_id)).toEqual(['input']);
    expect(writes()).toBe(0);
    await expect(manifest.publish(sibling, 'csv')).rejects.toThrow('Only artifacts');
    const file = await manifest.publish(child, 'csv');
    expect((await manifest.list(parent)).map((entry) => entry.file_id)).toContain(file.file_id);
    expect((await manifest.list(sibling)).map((entry) => entry.file_id)).toEqual(['input']);
    expect(file.metadata?.runFile).toMatchObject({
      agentId: 'worker',
      executionId: 'child',
      parentExecutionId: 'parent',
      inputFileIds: ['input'],
    });
  });

  it('does not confuse concurrent self-spawns with the parent or each other', async () => {
    const { manifest } = setup();
    manifest.register({
      id: 'self-a',
      parentId: 'parent',
      parentAgentId: 'lead',
      agentIds: ['lead'],
      allowedAgentIds: [],
    });
    manifest.register({
      id: 'self-b',
      parentId: 'parent',
      parentAgentId: 'lead',
      agentIds: ['lead'],
      allowedAgentIds: [],
    });
    const a = { executionId: 'self-a', agentId: 'lead' };
    const b = { executionId: 'self-b', agentId: 'lead' };
    manifest.stage(a, { id: 'csv', filename: 'report.csv' });
    const file = await manifest.publish(a, 'csv');
    expect((await manifest.list(b)).map((entry) => entry.file_id)).not.toContain(file.file_id);
    await expect(manifest.publish(b, 'csv')).rejects.toThrow('Only artifacts');
  });

  it('requires both deployment permission and explicit recipients for sibling sharing', async () => {
    const disabled = setup().manifest;
    disabled.stage(child, { id: 'csv', filename: 'report.csv' });
    await expect(disabled.publish(child, 'csv', ['reviewer'])).rejects.toThrow('sharing policy');
    const { manifest } = setup({ allowSiblingSharing: true });
    manifest.stage(child, { id: 'csv', filename: 'report.csv' });
    await expect(manifest.publish(child, 'csv', ['unknown'])).rejects.toThrow('sharing policy');
    const file = await manifest.publish(child, 'csv', ['reviewer', 'nested']);
    expect((await manifest.list(sibling)).map((entry) => entry.file_id)).toContain(file.file_id);
    manifest.register({
      id: 'nested-execution',
      parentId: 'child',
      parentAgentId: 'worker',
      agentIds: ['nested'],
      allowedAgentIds: [],
    });
    expect(
      (await manifest.list({ executionId: 'nested-execution', agentId: 'nested' })).map(
        (entry) => entry.file_id,
      ),
    ).toContain(file.file_id);
  });

  it('deduplicates concurrent publication, retries storage errors, and preserves recipients', async () => {
    const { manifest, writes, fail } = setup({ allowSiblingSharing: true });
    manifest.stage(child, { id: 'csv', filename: 'report.csv' });
    fail(true);
    await expect(manifest.publish(child, 'csv')).rejects.toThrow('Storage unavailable');
    fail(false);
    const files = await Promise.all([
      manifest.publish(child, 'csv'),
      manifest.publish(child, 'csv'),
    ]);
    expect(files[0].file_id).toBe(files[1].file_id);
    expect(writes()).toBe(2);
    await expect(manifest.publish(child, 'csv', ['reviewer'])).rejects.toThrow(
      'different recipients',
    );
  });

  it('restores scoped publications without private outputs and keeps other runs out', async () => {
    const { manifest, saved, create, register, writes } = setup();
    manifest.stage(child, { id: 'csv', filename: 'report.csv' });
    const published = await manifest.publish(child, 'csv');
    saved.push({
      ...published,
      file_id: 'other-run',
      metadata: { runFile: { ...published.metadata!.runFile!, runId: 'different-run' } },
    });
    saved.push({ ...published, file_id: 'other-tenant', tenantId: 'other' });
    const resumed = create();
    register(resumed);
    expect((await resumed.list(parent)).map((file) => file.file_id)).toEqual([
      'input',
      published.file_id,
    ]);
    expect((await resumed.publish(child, 'csv')).file_id).toBe(published.file_id);
    expect(writes()).toBe(1);
  });

  it('loads a snapshot once and includes local publications without another storage read', async () => {
    const { manifest, create, register, store } = setup();
    manifest.stage(child, { id: 'saved', filename: 'saved.csv' });
    const saved = await manifest.publish(child, 'saved');
    const read = jest.spyOn(store, 'list');
    const resumed = create();
    register(resumed);

    const initial = await resumed.getFiles(parent, undefined, 'snapshot');
    expect(initial.map((file) => file.file_id)).toEqual(['input', saved.file_id]);
    initial[0].filename = 'changed.csv';
    expect((await resumed.getFiles(parent, undefined, 'snapshot'))[0].filename).toBe(
      input.filename,
    );
    expect(read).toHaveBeenCalledTimes(1);

    resumed.stage(child, { id: 'new', filename: 'new.csv' });
    const published = await resumed.publish(child, 'new');
    const reads = read.mock.calls.length;
    expect(
      (await resumed.getFiles(parent, undefined, 'snapshot')).map((file) => file.file_id),
    ).toEqual(['input', saved.file_id, published.file_id]);
    expect(
      (await resumed.getFiles(sibling, undefined, 'snapshot')).map((file) => file.file_id),
    ).toEqual(['input']);
    expect(read).toHaveBeenCalledTimes(reads);
  });

  it('retries snapshot reads after initial or later storage failures', async () => {
    const { manifest, store } = setup();
    const read = jest.spyOn(store, 'list').mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(manifest.getFiles(parent, undefined, 'snapshot')).rejects.toThrow(
      'Storage unavailable',
    );
    await expect(manifest.getFiles(parent, undefined, 'snapshot')).resolves.toEqual([input]);
    await expect(manifest.getFiles(parent, undefined, 'snapshot')).resolves.toEqual([input]);
    expect(read).toHaveBeenCalledTimes(2);

    read.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(manifest.getFiles(parent)).rejects.toThrow('Storage unavailable');
    await expect(manifest.getFiles(parent, undefined, 'snapshot')).resolves.toEqual([input]);
    await expect(manifest.getFiles(parent, undefined, 'snapshot')).resolves.toEqual([input]);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it.each(['refresh', 'snapshot'] as const)(
    'expires or cancels %s access without deleting durable user files',
    async (mode) => {
      const { manifest, saved, time } = setup();
      manifest.stage(child, { id: 'csv', filename: 'report.csv' });
      await manifest.publish(child, 'csv');
      await expect(manifest.getFiles(parent, AbortSignal.abort(), mode)).rejects.toThrow();
      time(1000);
      await expect(manifest.getFiles(parent, undefined, mode)).rejects.toThrow('expired');
      expect(saved).toHaveLength(1);
      expect(() => manifest.stage(child, { id: 'new', filename: 'new.csv' })).toThrow('expired');
    },
  );

  it.each(['refresh', 'snapshot'] as const)(
    'coalesces a simultaneous %s read without sharing cancellation between children',
    async (mode) => {
      const { manifest, store } = setup();
      await manifest.getFiles(parent);
      let finishRead!: (files: TFile[]) => void;
      const read = jest.spyOn(store, 'list').mockImplementation(
        () =>
          new Promise<TFile[]>((resolve) => {
            finishRead = resolve;
          }),
      );
      const abort = new AbortController();
      const cancelled = manifest.list(child, abort.signal);
      const other = manifest.getFiles(sibling, undefined, mode);
      expect(read).toHaveBeenCalledTimes(1);
      abort.abort();
      finishRead([]);
      await expect(cancelled).rejects.toThrow();
      await expect(other).resolves.toEqual([expect.objectContaining({ file_id: 'input' })]);
    },
  );

  it('does not discard a publication when an older in-flight read finishes after the commit', async () => {
    const { manifest, store } = setup();
    manifest.stage(child, { id: 'csv', filename: 'report.csv' });
    let finishWrite!: () => void;
    const persist = store.publish;
    const writeStarted = new Promise<void>((resolve) => {
      store.publish = async (params) => {
        resolve();
        await new Promise<void>((finish) => {
          finishWrite = finish;
        });
        return persist(params);
      };
    });
    const publication = manifest.publish(child, 'csv');
    await writeStarted;
    let finishRead!: (files: TFile[]) => void;
    jest.spyOn(store, 'list').mockImplementationOnce(
      () =>
        new Promise<TFile[]>((resolve) => {
          finishRead = resolve;
        }),
    );
    const reading = manifest.list(parent);
    finishWrite();
    const published = await publication;
    finishRead([]);
    await expect(reading).resolves.toContainEqual(
      expect.objectContaining({ file_id: published.file_id }),
    );
  });

  it('drops deleted publications on the next read and enforces configured capacity', async () => {
    const { manifest, saved } = setup({ maxFiles: 2 });
    manifest.stage(child, { id: 'csv', filename: 'report.csv' });
    const published = await manifest.publish(child, 'csv');
    expect(() => manifest.stage(child, { id: 'second', filename: 'second.csv' })).toThrow('limit');
    saved.splice(0);
    expect((await manifest.list(parent)).map((file) => file.file_id)).not.toContain(
      published.file_id,
    );
    await expect(manifest.publish(child, 'csv')).rejects.toThrow('Only artifacts');
  });
});
