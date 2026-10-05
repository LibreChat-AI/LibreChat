import { FileSources, resolveMediaConfig } from 'librechat-data-provider';
import type {
  MediaAsset,
  MediaJob,
  MediaToolArtifact,
  MediaSubmissionRequest,
} from 'librechat-data-provider';
import type { MediaContext, MediaServices } from '~/media/service';
import { collectMediaToolAttachments, createMediaTools, filterMediaToolPlugins } from './media';

const asset: MediaAsset = {
  file_id: 'owned-image',
  filename: 'image.png',
  type: 'image/png',
  bytes: 12,
  filepath: '/api/media/assets/owned-image/content',
};
function job(
  phase: MediaJob['phase'],
  operation: MediaJob['operation'] = 'image.generate',
): MediaJob {
  return {
    schemaVersion: 1,
    jobId: 'job',
    threadId: 'thread',
    turnId: 'turn',
    version: 1,
    phase,
    operation,
    executionOwner: 'media',
    selection: { connectionId: 'images', modelId: 'model', catalogVersion: 'current' },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    outputs:
      phase === 'succeeded'
        ? [{ outputId: 'out', ordinal: 0, kind: 'image', state: 'ready', asset }]
        : [],
    allowedActions: { cancel: phase === 'queued', retry: false },
  };
}
function fixture(
  options: {
    signal?: AbortSignal;
    phase?: MediaJob['phase'];
    operation?: MediaJob['operation'];
  } = {},
) {
  const config = resolveMediaConfig({
    surfaces: { tools: true },
    tools: { pollIntervalMs: 100, imageTimeoutMs: 200 },
  });
  config.enabled = true;
  const context: MediaContext = {
    config,
    canUse: true,
    canCreate: true,
    scope: { ownerId: 'owner', tenantId: 'tenant' },
    appConfig: {
      config: {},
      media: config,
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
    },
  };
  const admit = jest.fn(async () => undefined);
  const submit = jest.fn(async (_input: MediaSubmissionRequest, current: MediaContext) => {
    await current.admitGeneration?.();
    return {
      schemaVersion: 1,
      jobId: 'job',
      threadId: 'thread',
      turnId: 'turn',
      phase: 'accepted' as const,
    };
  });
  const cancel = jest.fn(async () => job('cancelled'));
  const catalog = jest.fn(async () => ({ version: 'current', offerings: [] }));
  const getMediaJobView = jest.fn(async () => job(options.phase ?? 'succeeded', options.operation));
  const services = {
    commands: { submit, cancel },
    queries: { catalog },
  } as unknown as MediaServices;
  const tools = createMediaTools({
    services,
    repository: { getMediaJobView },
    resolveContext: async () => context,
    admitGeneration: admit,
    signal: options.signal,
    now: Date.now,
  });
  const invoke = (id = 'call') =>
    tools[0].invoke(
      {
        type: 'tool_call',
        id,
        name: 'media_generate',
        args: {
          operation: options.operation ?? 'image.generate',
          prompt: 'Draw',
          connectionId: 'images',
          modelId: 'model',
        },
      },
      { metadata: { run_id: 'message', thread_id: 'conversation' } },
    );
  return { tools, invoke, context, submit, cancel, catalog, admit, getMediaJobView };
}

it('submits through shared admission and returns the existing owned File artifact', async () => {
  const f = fixture();
  const result = await f.invoke();
  expect(f.admit).toHaveBeenCalledTimes(1);
  expect(f.submit.mock.calls[0][0]).toMatchObject({
    selection: { catalogVersion: 'current' },
    inputs: [],
  });
  expect(f.submit.mock.calls[0][0]).not.toHaveProperty('connectionId');
  expect(result.artifact).toMatchObject({ media: { phase: 'succeeded' }, files: [asset] });
  expect(JSON.parse(String(result.content)).files).toEqual([
    { file_id: asset.file_id, filename: asset.filename, type: asset.type },
  ]);
  await f.invoke();
  expect(f.submit.mock.calls[0][0].clientRequestId).toBe(f.submit.mock.calls[1][0].clientRequestId);
  expect(f.getMediaJobView).toHaveBeenCalledWith(f.context.scope, 'job');
});

it('returns a durable video receipt immediately and checks it through media_status', async () => {
  const f = fixture({ operation: 'video.generate', phase: 'running' });
  const result = await f.invoke();
  expect(result.artifact).toMatchObject({
    media: { phase: 'running', operation: 'video.generate' },
    files: [],
  });
  expect(f.getMediaJobView).toHaveBeenCalledTimes(1);
  const status = await f.tools[1].invoke({
    type: 'tool_call',
    id: 'status',
    name: 'media_status',
    args: { jobId: 'job' },
  });
  expect(status.artifact).toMatchObject({ media: { jobId: 'job' } });
  expect(f.cancel).not.toHaveBeenCalled();
});

it('waits for an image while keeping provider bytes out of model output', async () => {
  const f = fixture({ phase: 'running' });
  f.getMediaJobView.mockResolvedValueOnce(job('running')).mockResolvedValue(job('succeeded'));
  const result = await f.invoke();
  expect(result.artifact).toMatchObject({ media: { phase: 'succeeded' }, files: [asset] });
  expect(f.getMediaJobView).toHaveBeenCalledTimes(2);
});

it('cancels the durable job when the owning tool invocation is aborted', async () => {
  const controller = new AbortController();
  const f = fixture({ phase: 'running', signal: controller.signal });
  const waiting = f.invoke();
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await expect(waiting).rejects.toThrow();
  } finally {
    clearTimeout(timer);
  }
  expect(f.cancel).toHaveBeenCalledWith('job', expect.objectContaining({ scope: f.context.scope }));
});

it('returns a still-running image receipt at the configured wait deadline', async () => {
  const f = fixture({ phase: 'running' });
  const result = await f.invoke();
  expect(result.artifact).toMatchObject({ media: { phase: 'running' }, files: [] });
  expect(f.cancel).not.toHaveBeenCalled();
});

it('denies generation before catalog or submission when the tools surface or grant is absent', async () => {
  const f = fixture();
  f.context.config.surfaces.tools = false;
  await expect(f.invoke()).rejects.toThrow('disabled');
  f.context.config.surfaces.tools = true;
  f.context.canCreate = false;
  await expect(f.invoke()).rejects.toThrow();
  expect(f.catalog).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
});

it('exposes only the scoped catalog when status has no job ID', async () => {
  const f = fixture();
  const result = await f.tools[1].invoke({
    type: 'tool_call',
    id: 'catalog',
    name: 'media_status',
    args: {},
  });
  expect(JSON.parse(String(result.content))).toEqual({
    catalog: { version: 'current', offerings: [] },
  });
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.getMediaJobView).not.toHaveBeenCalled();
});

it('emits authorized media Files without re-saving bytes and refuses foreign tool artifacts', async () => {
  const artifact: MediaToolArtifact = {
    media: { jobId: 'job', threadId: 'thread', operation: 'image.generate', phase: 'succeeded' },
    files: [asset],
  };
  const emit = jest.fn();
  const params = {
    output: { name: 'media_generate', tool_call_id: 'call', artifact },
    metadata: { run_id: 'message', thread_id: 'chat' },
    response: { headersSent: true, writableEnded: false },
    emit,
  };
  expect(await Promise.all(collectMediaToolAttachments(params))).toMatchObject([
    { file_id: 'owned-image', messageId: 'message', toolCallId: 'call' },
  ]);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(
    collectMediaToolAttachments({
      ...params,
      output: { ...params.output, name: 'remote_mcp_tool' },
    }),
  ).toEqual([]);
});

it('omits disabled media tools from the picker without a role query', async () => {
  const f = fixture();
  f.context.config.surfaces.tools = false;
  const getRoleByName = jest.fn();
  const plugins = [{ pluginKey: 'media_generate', name: 'Media', description: 'Media' }];
  const result = await filterMediaToolPlugins(plugins, {
    appConfig: f.context.appConfig,
    request: {} as Parameters<typeof filterMediaToolPlugins>[1]['request'],
    getRoleByName,
  });
  expect(result).toEqual([]);
  expect(getRoleByName).not.toHaveBeenCalled();
});
