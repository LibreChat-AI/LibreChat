import React from 'react';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  MediaCatalog,
  MediaUploadResponse,
  MediaURLUploadResponse,
  MediaThreadDetail,
} from 'librechat-data-provider';
import type { MediaHost } from '../host';
import { clearMediaSessionStorage, emptyDraft, mediaDraftFamily } from '../state';
import { MediaForm, MediaFormComposer, MediaFormSettings } from '../Form';
import { makeCatalog, createMediaTestEnvironment } from 'test/media';
import { useMediaDraftForm } from '../useMediaDraftForm';
import { MediaThreadView } from '../Thread';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string | number>) =>
    key === 'com_ui_provider_key_action' && values ? `${values.action} for ${values.name}` : key,
}));
jest.mock('~/components/Input/SetKeyDialog/SetKeyDialog', () => ({
  __esModule: true,
  default: ({
    keyConfiguration,
    label,
    endpoint,
    userProvideURL,
    onOpenChange,
  }: {
    keyConfiguration?: { keyName: string; label: string; userProvideURL: boolean };
    label?: string;
    endpoint: string;
    userProvideURL?: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div role="dialog" aria-label={label ?? keyConfiguration?.label}>
      <span>{keyConfiguration?.keyName ?? endpoint}</span>
      <span>
        {(keyConfiguration?.userProvideURL ?? userProvideURL) ? 'URL required' : 'Key only'}
      </span>
      <button onClick={() => onOpenChange(false)}>{'Close provider settings'}</button>
    </div>
  ),
}));
jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, uploadMedia: jest.fn(), uploadMediaURL: jest.fn() },
  };
});
const catalog = makeCatalog({
  offerings: [
    {
      connectionId: 'connection',
      connectionName: 'Connection',
      modelId: 'image-model',
      modelName: 'Image model',
      api: 'openai.images',
      available: true,
      capabilities: [
        {
          operation: 'image.generate',
          inputs: { roles: [], min: 0, max: 0 },
          execution: { kind: 'direct', previews: false },
          controls: {
            count: { min: 1, max: 2, default: 1 },
            quality: { values: ['low', 'high'], default: 'high' },
            resolution: { values: ['1K', '2K'], default: '2K' },
            format: { values: ['png', 'jpeg'] },
            background: { values: ['auto', 'opaque'] },
          },
        },
      ],
    },
  ],
});
function setup(canCreate = true, features?: MediaHost['features']) {
  const env = createMediaTestEnvironment({ canCreate, features });
  return { ...env, send: jest.fn().mockResolvedValue(undefined) };
}
test.each(['row', 'gear'] as const)(
  'configures a personal-key provider from its %s without replacing the active draft',
  async (target) => {
    const env = setup();
    const choices: MediaCatalog = {
      ...catalog,
      integrations: [
        {
          connectionId: 'connection',
          connectionName: 'Managed',
          api: 'openai.images',
          available: true,
        },
        {
          connectionId: 'native',
          connectionName: 'Native Images',
          api: 'google.generateContent',
          available: false,
          unavailableReason: 'credentials_required',
          userKey: { keyName: 'SharedNative', encoding: 'google', userProvideURL: false },
        },
        {
          connectionId: 'native-video',
          connectionName: 'Native Videos',
          api: 'google.vertex.videos',
          available: false,
          unavailableReason: 'credentials_required',
          userKey: { keyName: 'SharedNative', encoding: 'google', userProvideURL: true },
        },
      ],
    };
    const view = render(<MediaForm catalog={choices} send={env.send} busy={false} />, {
      wrapper: env.wrapper,
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
      target: { value: 'Keep my prompt' },
    });
    const draft = env.store.get(mediaDraftFamily('owner:new'));
    fireEvent.click(screen.getByRole('combobox', { name: 'com_media_connection' }));
    expect(
      screen.queryByRole('button', { name: 'com_endpoint_config_key for Managed' }),
    ).not.toBeInTheDocument();
    const provider = await screen.findByRole('option', { name: 'Native Images' });
    expect(provider).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(
      target === 'row'
        ? provider
        : await screen.findByRole('button', { name: 'com_endpoint_config_key for Native Images' }),
    );
    expect(await screen.findByRole('dialog', { name: 'Native Images' })).toHaveTextContent(
      'SharedNative',
    );
    expect(screen.getByText('URL required')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close provider settings' }));
    view.rerender(
      <MediaForm catalog={{ ...choices, version: 'refreshed' }} send={env.send} busy={false} />,
    );
    expect(env.store.get(mediaDraftFamily('owner:new'))).toEqual(draft);
    expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue('Keep my prompt');
    expect(env.send).not.toHaveBeenCalled();
  },
);
test('offers provider settings even when the catalog has no available models', async () => {
  const env = setup();
  render(
    <MediaForm
      catalog={{
        ...catalog,
        offerings: [],
        integrations: [
          {
            connectionId: 'native',
            connectionName: 'Native Images',
            api: 'google.generateContent',
            available: false,
            unavailableReason: 'credentials_required',
            userKey: { keyName: 'Native', encoding: 'google', userProvideURL: false },
          },
        ],
      }}
      send={env.send}
      busy={false}
    >
      <MediaFormSettings />
      <MediaFormComposer />
    </MediaForm>,
    { wrapper: env.wrapper },
  );
  expect(screen.getAllByRole('combobox', { name: 'com_media_connection' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('combobox', { name: 'com_media_connection' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'com_endpoint_config_key for Native Images' }),
  );
  expect(await screen.findByRole('dialog', { name: 'Native Images' })).toBeInTheDocument();
});
beforeEach(() => {
  clearMediaSessionStorage();
  jest.mocked(dataService.uploadMedia).mockReset();
  jest.mocked(dataService.uploadMediaURL).mockReset();
});

test('the sidebar observes draft normalization without racing the composer initial selection', () => {
  const env = setup();
  const choices = makeCatalog({
    offerings: [
      catalog.offerings[0],
      { ...catalog.offerings[0], modelId: 'restored', modelName: 'Restored' },
    ],
  });
  function Sidebar() {
    useMediaDraftForm({ catalog: choices, normalizeDraft: false });
    return null;
  }
  render(
    <>
      <Sidebar />
      <MediaForm
        catalog={choices}
        initialSelection={{
          connectionId: 'connection',
          modelId: 'restored',
          catalogVersion: 'catalog',
        }}
        send={env.send}
        busy={false}
      />
    </>,
    { wrapper: env.wrapper },
  );
  expect(env.store.get(mediaDraftFamily('owner:new'))).toMatchObject({
    offering: JSON.stringify(['connection', 'restored']),
    revision: 1,
  });
});

test.each(['paste', 'drop'] as const)(
  'uploads multiple files sequentially from %s and stops at the capability limit',
  async (source) => {
    const env = setup();
    const choices = makeCatalog({
      offerings: [
        {
          ...catalog.offerings[0],
          capabilities: [
            {
              operation: 'image.edit',
              inputs: { min: 1, max: 2, roles: ['reference'] },
              execution: { kind: 'direct', previews: false },
              controls: { count: { min: 1, max: 1, default: 1 } },
            },
          ],
        },
      ],
    });
    let complete!: (response: MediaUploadResponse) => void;
    const upload = jest
      .mocked(dataService.uploadMedia)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue({
        file: {
          file_id: 'second',
          filename: 'second.png',
          filepath: '/images/second.png',
          type: 'image/png',
          bytes: 10,
        },
      });
    render(<MediaForm catalog={choices} send={env.send} busy={false} />, { wrapper: env.wrapper });
    const prompt = screen.getByRole('textbox', { name: 'com_media_prompt' });
    const files = ['first', 'second', 'third'].map(
      (name) => new File(['image'], `${name}.png`, { type: 'image/png' }),
    );
    if (source === 'paste') fireEvent.paste(prompt, { clipboardData: { files } });
    else fireEvent.drop(prompt, { dataTransfer: { files, types: ['Files'] } });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await act(async () => {
      complete({
        file: {
          file_id: 'first',
          filename: 'first.png',
          filepath: '/images/first.png',
          type: 'image/png',
          bytes: 10,
        },
      });
    });
    await waitFor(() =>
      expect(
        env.store.get(mediaDraftFamily('owner:new')).inputs.map((input) => input.file_id),
      ).toEqual(['first', 'second']),
    );
    expect(upload).toHaveBeenCalledTimes(2);
  },
);

test('keeps an upload that switches the draft from generating to editing', async () => {
  const env = setup();
  const choices = makeCatalog({
    offerings: [
      {
        ...catalog.offerings[0],
        capabilities: [
          catalog.offerings[0].capabilities[0],
          {
            operation: 'image.edit',
            inputs: { min: 1, max: 2, roles: ['reference'] },
            execution: { kind: 'direct', previews: false },
            controls: { count: { min: 1, max: 1, default: 1 } },
          },
        ],
      },
    ],
  });
  const uploaded = (file_id: string) => ({
    file: {
      file_id,
      filename: `${file_id}.png`,
      filepath: `/images/${file_id}.png`,
      type: 'image/png',
      bytes: 10,
    },
  });
  const pending: Array<(response: MediaUploadResponse) => void> = [];
  const upload = jest.mocked(dataService.uploadMedia).mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  );
  render(<MediaForm catalog={choices} send={env.send} busy={false} />, { wrapper: env.wrapper });
  expect(env.store.get(mediaDraftFamily('owner:new')).operation).not.toBe('image.edit');
  const files = ['first', 'second'].map(
    (name) => new File(['image'], `${name}.png`, { type: 'image/png' }),
  );
  fireEvent.drop(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    dataTransfer: { files, types: ['Files'] },
  });
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  await act(async () => {
    pending[0](uploaded('first'));
  });
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  await act(async () => {
    pending[1](uploaded('second'));
  });
  await waitFor(() =>
    expect(
      env.store.get(mediaDraftFamily('owner:new')).inputs.map((input) => input.file_id),
    ).toEqual(['first', 'second']),
  );
  expect(env.store.get(mediaDraftFamily('owner:new')).operation).toBe('image.edit');
});

test('uses catalog controls and submits a typed immutable prompt snapshot', async () => {
  const env = setup();
  render(<MediaForm catalog={catalog} send={env.send} busy={false} />, { wrapper: env.wrapper });
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'A calm lake' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0]).toMatchObject({
    kind: 'submission',
    request: {
      operation: 'image.generate',
      prompt: 'A calm lake',
      inputs: [],
      parameters: {
        count: 1,
        quality: 'high',
        resolution: '2K',
        format: 'png',
        background: 'auto',
      },
      selection: { connectionId: 'connection', modelId: 'image-model', catalogVersion: 'catalog' },
    },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'A different lake' },
  });
  expect(env.send.mock.calls[0][0].request.prompt).toBe('A calm lake');
});

test.each([false, true])(
  'opens a saved provider without replacing an existing draft (%s)',
  async (hasDraft) => {
    const env = setup();
    const source = {
      connectionId: 'router',
      modelId: 'google/gemini-image',
      catalogVersion: 'catalog',
    };
    const choices: MediaCatalog = {
      ...catalog,
      offerings: [
        ...catalog.offerings,
        {
          ...catalog.offerings[0],
          ...source,
          connectionName: 'OpenRouter',
          modelName: 'Gemini Image',
        },
      ],
    };
    if (hasDraft)
      env.store.set(mediaDraftFamily('owner:saved'), {
        ...emptyDraft(),
        offering: '["connection","image-model"]',
        prompt: 'Keep this draft',
        revision: 3,
      });
    render(
      <MediaForm
        catalog={choices}
        threadId="saved"
        initialSelection={source}
        send={env.send}
        busy={false}
      />,
      { wrapper: env.wrapper },
    );
    if (!hasDraft)
      fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
        target: { value: 'A quiet lake' },
      });
    fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
    await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
    expect(env.send.mock.calls[0][0].request.selection).toEqual(
      hasDraft
        ? { connectionId: 'connection', modelId: 'image-model', catalogVersion: 'catalog' }
        : source,
    );
    if (hasDraft) expect(env.send.mock.calls[0][0].request.prompt).toBe('Keep this draft');
  },
);

test('replaces the old implicit empty default with the saved thread provider', () => {
  const env = setup();
  const selection = { connectionId: 'router', modelId: 'gemini', catalogVersion: 'catalog' };
  env.store.set(mediaDraftFamily('owner:saved'), {
    ...emptyDraft(),
    offering: '["connection","image-model"]',
    revision: 1,
  });
  const choices = {
    ...catalog,
    offerings: [...catalog.offerings, { ...catalog.offerings[0], ...selection }],
  };
  render(
    <MediaForm
      catalog={choices}
      threadId="saved"
      initialSelection={selection}
      send={env.send}
      busy={false}
    />,
    { wrapper: env.wrapper },
  );
  expect(env.store.get(mediaDraftFamily('owner:saved')).offering).toBe('["router","gemini"]');
  expect(env.send).not.toHaveBeenCalled();
});

test('retains a removed model draft and requires explicit model selection', () => {
  const env = setup();
  env.store.set(mediaDraftFamily('owner:new'), {
    ...emptyDraft(),
    prompt: 'Keep this draft',
    offering: '["old","removed"]',
    revision: 4,
  });
  render(<MediaForm catalog={catalog} send={env.send} busy={false} />, { wrapper: env.wrapper });
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  expect(env.store.get(mediaDraftFamily('owner:new')).prompt).toBe('Keep this draft');
  fireEvent.click(screen.getByRole('button', { name: 'com_media_choose_model' }));
  expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue('Keep this draft');
});

test('keeps an excluded provider draft visible and switches to an available provider without losing references', async () => {
  const env = setup();
  const asset = {
    file_id: 'reference-image',
    filepath: '/images/reference.png',
    filename: 'reference.png',
    type: 'image/png',
    bytes: 10,
  };
  const draft = {
    ...emptyDraft(),
    prompt: 'Keep my edit',
    offering: '["excluded","old-model"]',
    operation: 'image.edit' as const,
    parentTurnId: 'parent-turn',
    inputs: [{ file_id: asset.file_id, role: 'reference' as const }],
    assets: [asset],
    providerOptionsText: '{"preserve":"until changed"}',
    revision: 4,
  };
  env.store.set(mediaDraftFamily('owner:restored'), draft);
  const choices: MediaCatalog = {
    ...catalog,
    integrations: [
      {
        connectionId: 'connection',
        connectionName: 'Connection',
        api: 'openai.images',
        available: true,
      },
    ],
    offerings: [
      catalog.offerings[0],
      {
        ...catalog.offerings[0],
        modelId: 'edit-model',
        capabilities: [
          {
            ...catalog.offerings[0].capabilities[0],
            operation: 'image.edit',
            inputs: { min: 1, max: 4, roles: ['reference'] },
          },
        ],
      },
    ],
  };
  render(
    <MediaForm catalog={choices} threadId="restored" send={env.send} busy={false}>
      <aside>
        <MediaFormSettings />
      </aside>
      <main>
        <MediaFormComposer />
      </main>
    </MediaForm>,
    { wrapper: env.wrapper },
  );
  expect(screen.getByText('com_media_selection_unavailable')).toBeVisible();
  expect(screen.queryByText('com_media_no_models')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue('Keep my edit');
  expect(screen.getByRole('img', { name: 'com_media_image_preview' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  expect(env.store.get(mediaDraftFamily('owner:restored'))).toEqual(draft);
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'Updated edit' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_choose_model' }));
  const provider = await screen.findByRole('option', { name: 'Connection' });
  expect(screen.queryByRole('option', { name: 'excluded' })).not.toBeInTheDocument();
  fireEvent.click(provider);
  expect(env.store.get(mediaDraftFamily('owner:restored'))).toMatchObject({
    prompt: 'Updated edit',
    offering: '["connection","edit-model"]',
    operation: 'image.edit',
    inputs: draft.inputs,
    assets: draft.assets,
    parentTurnId: 'parent-turn',
  });
  expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue('Updated edit');
  expect(screen.getByRole('img', { name: 'com_media_image_preview' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeEnabled();
  expect(env.send).not.toHaveBeenCalled();
});

test('keeps a saved draft but blocks a resolution the refreshed catalog no longer supports', async () => {
  const env = setup();
  env.store.set(mediaDraftFamily('owner:new'), {
    ...emptyDraft(),
    offering: '["connection","image-model"]',
    prompt: 'Keep this draft',
    parameters: { count: 1, resolution: '1K' },
    revision: 3,
  });
  const view = render(<MediaForm catalog={catalog} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeEnabled();
  const refreshed = {
    ...catalog,
    version: 'refreshed',
    offerings: catalog.offerings.map((offering) => ({
      ...offering,
      capabilities: offering.capabilities.map((capability) => ({
        ...capability,
        controls: { ...capability.controls, resolution: { values: ['2K', '4K'] } },
      })),
    })),
  };
  view.rerender(<MediaForm catalog={refreshed} send={env.send} busy={false} />);
  const resolution = screen.getByRole('combobox', { name: 'com_media_resolution' });
  expect(resolution).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('com_media_unsupported_settings')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue('Keep this draft');
  expect(env.send).not.toHaveBeenCalled();
  fireEvent.click(resolution);
  fireEvent.click(await screen.findByRole('option', { name: '2K' }));
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request.parameters.resolution).toBe('2K');
});

test('read-only mode exposes the saved draft without a working generation control', () => {
  const env = setup(false);
  env.store.set(mediaDraftFamily('owner:new'), { ...emptyDraft(), prompt: 'A lake' });
  render(<MediaForm catalog={catalog} send={env.send} busy={false} />, { wrapper: env.wrapper });
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'com_media_upload' })).toBeDisabled();
  expect(env.send).not.toHaveBeenCalled();
});

test('leaving an editor aborts its upload and cannot append the late file to its draft', async () => {
  let finish: (value: MediaUploadResponse) => void = () => {};
  jest.mocked(dataService.uploadMedia).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const env = setup();
  const choices: MediaCatalog = {
    ...catalog,
    offerings: [
      {
        ...catalog.offerings[0],
        capabilities: [
          {
            ...catalog.offerings[0].capabilities[0],
            inputs: { roles: ['reference'], min: 0, max: 4 },
          },
        ],
      },
    ],
  };
  const view = render(<MediaForm catalog={choices} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  const input = view.container.querySelector<HTMLInputElement>('input[type=file]')!;
  fireEvent.change(input, {
    target: { files: [new File(['image'], 'lake.png', { type: 'image/png' })] },
  });
  await waitFor(() => expect(dataService.uploadMedia).toHaveBeenCalledTimes(1));
  const signal = jest.mocked(dataService.uploadMedia).mock.calls[0][1];
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    finish({
      file: {
        file_id: 'late',
        filename: 'lake.png',
        filepath: '/images/owner/lake.png',
        type: 'image/png',
        bytes: 5,
      },
    }),
  );
  expect(env.store.get(mediaDraftFamily('owner:new')).inputs).toEqual([]);
});

test('refining an existing result preserves its provider and parent instead of the default offering', async () => {
  const env = setup();
  const selection = {
    connectionId: 'source-connection',
    modelId: 'source-model',
    catalogVersion: catalog.version,
    providerTag: 'source-provider',
  };
  const asset = {
    file_id: 'source-file',
    filepath: '/images/owner/source.png',
    filename: 'source.png',
    type: 'image/png',
    bytes: 24,
  };
  const now = '2026-01-01T00:00:00.000Z';
  const detail: MediaThreadDetail = {
    thread: {
      schemaVersion: 1,
      threadId: 'thread',
      title: 'Earlier work',
      version: 1,
      createdAt: now,
      updatedAt: now,
      pendingJobCount: 0,
      turnCount: 1,
    },
    turns: {
      items: [
        {
          schemaVersion: 1,
          threadId: 'thread',
          turnId: 'parent',
          version: 1,
          kind: 'generation',
          createdAt: now,
          prompt: 'Original prompt',
          inputs: [],
          selection,
          operation: 'image.generate',
          assets: [],
          jobs: [
            {
              schemaVersion: 1,
              jobId: 'job',
              threadId: 'thread',
              turnId: 'parent',
              version: 1,
              phase: 'succeeded',
              executionOwner: 'media',
              operation: 'image.generate',
              selection,
              createdAt: now,
              updatedAt: now,
              allowedActions: { cancel: false, retry: false },
              outputs: [{ kind: 'image', outputId: 'output', ordinal: 0, state: 'ready', asset }],
            },
          ],
        },
      ],
    },
  };
  const choices: MediaCatalog = {
    ...catalog,
    offerings: [
      ...catalog.offerings,
      {
        ...catalog.offerings[0],
        ...selection,
        connectionName: 'Source connection',
        modelName: 'Source model',
        api: 'openrouter.images',
        routes: [
          {
            providerTag: 'source-provider',
            providerName: 'Source provider',
            capabilities: [
              {
                operation: 'image.edit',
                inputs: { min: 1, max: 1, roles: ['reference'] },
                execution: { kind: 'direct', previews: false },
                controls: { count: { min: 1, max: 1, default: 1 } },
              },
            ],
          },
        ],
        capabilities: [
          {
            operation: 'image.edit',
            inputs: { min: 1, max: 1, roles: ['reference'] },
            execution: { kind: 'direct', previews: false },
            controls: { count: { min: 1, max: 1, default: 1 } },
          },
        ],
      },
    ],
  };
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MediaForm
        catalog={choices}
        threadId="thread"
        imageContext={{ turnId: 'newer-turn', asset: { ...asset, file_id: 'newer-image' } }}
        send={env.send}
        busy={false}
      />
      <MediaThreadView detail={detail} send={env.send} onDeleted={() => {}} />
    </QueryClientProvider>,
    { wrapper: env.wrapper },
  );
  expect(env.store.get(mediaDraftFamily('owner:thread')).offering).toBe(
    '["connection","image-model"]',
  );
  fireEvent.click(screen.getByRole('button', { name: 'com_media_refine' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'Refine the source' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request).toMatchObject({
    threadId: 'thread',
    parentTurnId: 'parent',
    selection,
    operation: 'image.edit',
    inputs: [{ role: 'reference', file_id: 'source-file' }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_edit_request' }));
  expect(env.store.get(mediaDraftFamily('owner:thread')).providerTag).toBe('source-provider');
});

test('a completed image becomes the edit target without erasing a prompt typed while it was generating', async () => {
  const env = setup();
  const choices: MediaCatalog = {
    ...catalog,
    offerings: [
      {
        ...catalog.offerings[0],
        capabilities: [
          ...catalog.offerings[0].capabilities,
          {
            ...catalog.offerings[0].capabilities[0],
            operation: 'image.edit',
            inputs: { min: 1, max: 4, roles: ['reference'] },
          },
        ],
      },
    ],
  };
  const props = { catalog: choices, threadId: 'thread', send: env.send, busy: false };
  const view = render(<MediaForm {...props} />, { wrapper: env.wrapper });
  const prompt = screen.getByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.change(prompt, { target: { value: 'Make it red' } });
  const asset = {
    file_id: 'completed',
    filepath: '/images/completed.png',
    filename: 'completed.png',
    type: 'image/png',
    bytes: 10,
  };
  view.rerender(<MediaForm {...props} imageContext={{ turnId: 'parent', asset }} />);
  expect(prompt).toHaveValue('Make it red');
  expect(screen.getByText('com_media_editing_latest')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request).toMatchObject({
    operation: 'image.edit',
    parentTurnId: 'parent',
    prompt: 'Make it red',
    inputs: [{ role: 'reference', file_id: 'completed' }],
  });
});

test('video follow-ups use the latest result, preserve a typed prompt and allow starting fresh', async () => {
  const env = setup();
  const choices = makeCatalog({
    offerings: [
      catalog.offerings[0],
      {
        ...catalog.offerings[0],
        modelId: 'video-model',
        modelName: 'Video model',
        api: 'google.vertex.videos',
        capabilities: [
          {
            operation: 'video.generate',
            inputs: { roles: ['video'], min: 0, max: 1 },
            execution: { kind: 'remote-job', cancellation: 'unsupported' },
            controls: {
              count: { min: 1, max: 1 },
              durationSeconds: { min: 4, max: 7, values: [4, 7], default: 4 },
            },
            constraints: [
              {
                when: [{ kind: 'input', role: 'video', present: true }],
                anyOf: [{ kind: 'parameter', name: 'durationSeconds', values: [7] }],
              },
            ],
          },
        ],
      },
    ],
  });
  const props = {
    catalog: choices,
    threadId: 'thread',
    initialSelection: {
      connectionId: 'connection',
      modelId: 'video-model',
      catalogVersion: choices.version,
    },
    send: env.send,
    busy: false,
  };
  const view = render(<MediaForm {...props} />, { wrapper: env.wrapper });
  const prompt = screen.getByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.change(prompt, { target: { value: 'Follow the boat past the lighthouse' } });
  const asset = {
    file_id: 'latest-video',
    filename: 'video.mp4',
    filepath: '/api/media/assets/latest-video/content',
    type: 'video/mp4',
    bytes: 10,
  };
  view.rerender(<MediaForm {...props} videoContext={{ turnId: 'latest-turn', asset }} />);
  expect(prompt).toHaveValue('Follow the boat past the lighthouse');
  expect(screen.getByText('com_media_using_latest_video')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request).toMatchObject({
    operation: 'video.generate',
    threadId: 'thread',
    parentTurnId: 'latest-turn',
    prompt: 'Follow the boat past the lighthouse',
    inputs: [{ role: 'video', file_id: asset.file_id }],
    parameters: { durationSeconds: 7 },
  });
  fireEvent.click(screen.getByRole('radio', { name: 'com_media_image' }));
  expect(screen.queryByText('com_media_using_latest_video')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: 'com_media_video' }));
  expect(screen.getByText('com_media_using_latest_video')).toBeVisible();
  expect(prompt).toHaveValue('Follow the boat past the lighthouse');
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(2));
  expect(env.send.mock.calls[1][0].request).toMatchObject({
    parentTurnId: 'latest-turn',
    inputs: [{ role: 'video', file_id: asset.file_id }],
    parameters: { durationSeconds: 7 },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_remove_reference' }));
  fireEvent.click(screen.getByRole('radio', { name: 'com_media_image' }));
  fireEvent.click(screen.getByRole('radio', { name: 'com_media_video' }));
  view.rerender(
    <MediaForm
      {...props}
      videoContext={{ turnId: 'next-turn', asset: { ...asset, file_id: 'next-video' } }}
    />,
  );
  expect(screen.queryByText('com_media_using_latest_video')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(3));
  expect(env.send.mock.calls[2][0].request).toMatchObject({
    inputs: [],
    parameters: { durationSeconds: 4 },
  });
  expect(env.send.mock.calls[2][0].request.parentTurnId).toBeUndefined();
});

const contextualVideoCatalog = makeCatalog({
  offerings: [
    {
      ...catalog.offerings[0],
      modelId: 'contextual-video',
      modelName: 'Contextual video',
      api: 'google.vertex.videos',
      capabilities: [
        {
          operation: 'video.generate',
          inputs: { roles: ['video'], min: 0, max: 1 },
          execution: { kind: 'remote-job', cancellation: 'unsupported' },
          controls: {
            count: { min: 1, max: 1 },
            durationSeconds: { min: 4, max: 7, values: [4, 7], default: 4 },
            resolution: { values: ['720p', '1080p'], default: '720p' },
            seed: { min: 0, max: 1000 },
            audio: true,
          },
          constraints: [
            {
              when: [{ kind: 'input', role: 'video', present: true }],
              anyOf: [{ kind: 'parameter', name: 'durationSeconds', values: [7] }],
            },
            {
              when: [{ kind: 'input', role: 'video', present: true }],
              anyOf: [{ kind: 'parameter', name: 'resolution', values: ['720p'] }],
            },
            {
              when: [{ kind: 'input', role: 'video', present: false }],
              anyOf: [{ kind: 'parameter', name: 'durationSeconds', values: [4] }],
            },
          ],
        },
      ],
    },
  ],
});
const contextualVideo = {
  turnId: 'previous-turn',
  asset: {
    file_id: 'previous-video',
    filename: 'previous.mp4',
    filepath: '/api/media/assets/previous-video/content',
    type: 'video/mp4',
    bytes: 10,
  },
};

test('automatic video references adapt only incompatible inherited controls and restore fresh preferences when removed', async () => {
  const env = setup();
  const atom = mediaDraftFamily('owner:thread');
  const original = { count: 1, durationSeconds: 4, resolution: '1080p', seed: 17, audio: true };
  env.store.set(atom, {
    ...emptyDraft(),
    offering: '["connection","contextual-video"]',
    operation: 'video.generate',
    parameters: original,
    prompt: 'Continue the fox crossing the bridge',
    revision: 3,
  });
  const props = {
    catalog: contextualVideoCatalog,
    threadId: 'thread',
    send: env.send,
    busy: false,
  };
  const view = render(<MediaForm {...props} />, { wrapper: env.wrapper });
  expect(screen.getByRole('combobox', { name: 'com_media_duration_seconds' })).toHaveTextContent(
    '4',
  );
  view.rerender(<MediaForm {...props} videoContext={contextualVideo} />);
  expect(screen.getByRole('combobox', { name: 'com_media_duration_seconds' })).toHaveTextContent(
    '7',
  );
  expect(screen.getByRole('combobox', { name: 'com_media_resolution' })).toHaveTextContent('720p');
  expect(env.store.get(atom).parameters).toEqual(original);
  expect(env.store.get(atom).revision).toBe(3);
  expect(env.store.get(atom).inputs).toEqual([]);
  expect(env.store.get(atom).parentTurnId).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_advanced' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'com_media_seed' }), {
    target: { value: '99' },
  });
  expect(screen.getByRole('combobox', { name: 'com_media_duration_seconds' })).toHaveTextContent(
    '7',
  );
  expect(screen.getByRole('combobox', { name: 'com_media_resolution' })).toHaveTextContent('720p');
  const next = { turnId: 'next-turn', asset: { ...contextualVideo.asset, file_id: 'next-video' } };
  view.rerender(<MediaForm {...props} videoContext={next} />);
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request).toMatchObject({
    inputs: [{ role: 'video', file_id: 'next-video' }],
    parentTurnId: 'next-turn',
    parameters: { ...original, durationSeconds: 7, resolution: '720p', seed: 99 },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_remove_reference' }));
  expect(screen.getByRole('combobox', { name: 'com_media_duration_seconds' })).toHaveTextContent(
    '4',
  );
  expect(screen.getByRole('combobox', { name: 'com_media_resolution' })).toHaveTextContent('1080p');
  expect(env.store.get(atom).parameters).toEqual({ ...original, seed: 99 });
});

test('invalid controls deliberately chosen with an automatic video stay invalid after reload and newer results', async () => {
  const env = setup();
  const atom = mediaDraftFamily('owner:thread');
  env.store.set(atom, {
    ...emptyDraft(),
    offering: '["connection","contextual-video"]',
    operation: 'video.generate',
    parameters: { count: 1, durationSeconds: 4, resolution: '1080p' },
    prompt: 'Keep my settings',
    revision: 3,
  });
  const props = {
    catalog: contextualVideoCatalog,
    threadId: 'thread',
    videoContext: contextualVideo,
    busy: false,
  };
  const view = render(<MediaForm {...props} send={env.send} />, { wrapper: env.wrapper });
  fireEvent.click(screen.getByRole('combobox', { name: 'com_media_duration_seconds' }));
  fireEvent.click(await screen.findByRole('option', { name: '4' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'com_media_resolution' }));
  fireEvent.click(await screen.findByRole('option', { name: '1080p' }));
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'com_media_duration_seconds' })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(screen.getByRole('combobox', { name: 'com_media_resolution' })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  view.unmount();
  mediaDraftFamily.remove('owner:thread');
  const restored = setup();
  render(
    <MediaForm
      {...props}
      videoContext={{
        turnId: 'newer-turn',
        asset: { ...contextualVideo.asset, file_id: 'newer-video' },
      }}
      send={restored.send}
    />,
    { wrapper: restored.wrapper },
  );
  expect(screen.getByRole('combobox', { name: 'com_media_duration_seconds' })).toHaveTextContent(
    '4',
  );
  expect(screen.getByRole('combobox', { name: 'com_media_resolution' })).toHaveTextContent('1080p');
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  expect(screen.getByText('com_media_unsupported_settings')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue('Keep my settings');
  expect(restored.send).not.toHaveBeenCalled();
});

test('an explicitly pinned video keeps incompatible controls visible for correction', () => {
  const env = setup();
  env.store.set(mediaDraftFamily('owner:thread'), {
    ...emptyDraft(),
    offering: '["connection","contextual-video"]',
    operation: 'video.generate',
    inputs: [{ role: 'video', file_id: contextualVideo.asset.file_id }],
    assets: [contextualVideo.asset],
    parameters: { count: 1, durationSeconds: 4, resolution: '1080p' },
    parameterContexts: { durationSeconds: { operation: 'video.generate', roles: [] } },
    prompt: 'Keep this explicit reference',
    revision: 3,
  });
  render(
    <MediaForm
      catalog={contextualVideoCatalog}
      threadId="thread"
      videoContext={contextualVideo}
      send={env.send}
      busy={false}
    />,
    { wrapper: env.wrapper },
  );
  expect(screen.getByRole('combobox', { name: 'com_media_duration_seconds' })).toHaveTextContent(
    '4',
  );
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
});

test('automatic references do not repair controls that were already invalid before the context changed', () => {
  const env = setup();
  env.store.set(mediaDraftFamily('owner:thread'), {
    ...emptyDraft(),
    offering: '["connection","contextual-video"]',
    operation: 'video.generate',
    parameters: { count: 1, durationSeconds: 5 },
    prompt: 'Keep the invalid duration visible',
    revision: 3,
  });
  render(
    <MediaForm
      catalog={contextualVideoCatalog}
      threadId="thread"
      videoContext={contextualVideo}
      send={env.send}
      busy={false}
    />,
    { wrapper: env.wrapper },
  );
  expect(screen.getByRole('combobox', { name: 'com_media_duration_seconds' })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  expect(env.store.get(mediaDraftFamily('owner:thread')).parameters.durationSeconds).toBe(5);
});

test('automatic image edits retain valid controls and adapt an inherited resolution unavailable for editing', async () => {
  const env = setup();
  const choices = makeCatalog({
    offerings: [
      {
        ...catalog.offerings[0],
        capabilities: [
          catalog.offerings[0].capabilities[0],
          {
            ...catalog.offerings[0].capabilities[0],
            operation: 'image.edit',
            inputs: { roles: ['reference'], min: 1, max: 1 },
            controls: {
              ...catalog.offerings[0].capabilities[0].controls,
              resolution: { values: ['2K'], default: '2K' },
            },
          },
        ],
      },
    ],
  });
  env.store.set(mediaDraftFamily('owner:thread'), {
    ...emptyDraft(),
    offering: '["connection","image-model"]',
    parameters: { count: 1, resolution: '1K', quality: 'low', format: 'jpeg' },
    prompt: 'Make it red',
    revision: 3,
  });
  render(
    <MediaForm
      catalog={choices}
      threadId="thread"
      imageContext={{
        turnId: 'image-turn',
        asset: { ...contextualVideo.asset, file_id: 'image', type: 'image/png' },
      }}
      send={env.send}
      busy={false}
    />,
    { wrapper: env.wrapper },
  );
  expect(screen.getByRole('combobox', { name: 'com_media_resolution' })).toHaveTextContent('2K');
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request.parameters).toMatchObject({
    resolution: '2K',
    quality: 'low',
    format: 'jpeg',
  });
  expect(env.store.get(mediaDraftFamily('owner:thread')).parameters.resolution).toBe('1K');
});

test.each(['live', 'unavailable'] as const)(
  'preserves a fresh video choice with %s context after changing modes and restoring the session',
  async (context) => {
    const env = setup();
    const choices = makeCatalog({
      offerings: [
        catalog.offerings[0],
        {
          ...catalog.offerings[0],
          modelId: 'video-model',
          modelName: 'Video model',
          api: 'google.vertex.videos',
          capabilities: [
            {
              operation: 'video.generate',
              inputs: { roles: ['video'], min: 0, max: 1 },
              execution: { kind: 'remote-job', cancellation: 'unsupported' },
              controls: { count: { min: 1, max: 1 } },
            },
          ],
        },
      ],
    });
    const props = {
      catalog: choices,
      threadId: 'thread',
      initialSelection: {
        connectionId: 'connection',
        modelId: 'video-model',
        catalogVersion: choices.version,
      },
      videoContext:
        context === 'live'
          ? {
              turnId: 'latest-turn',
              asset: {
                file_id: 'latest-video',
                filename: 'video.mp4',
                filepath: '/video.mp4',
                type: 'video/mp4',
                bytes: 10,
              },
            }
          : undefined,
      videoContextUnavailable: context === 'unavailable',
      busy: false,
    };
    const view = render(<MediaForm {...props} send={env.send} />, { wrapper: env.wrapper });
    fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
      target: { value: 'A different video' },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: context === 'live' ? 'com_media_remove_reference' : 'com_media_start_new_video',
      }),
    );
    fireEvent.click(screen.getByRole('radio', { name: 'com_media_image' }));
    view.unmount();
    mediaDraftFamily.remove('owner:thread');
    const restored = setup();
    render(<MediaForm {...props} send={restored.send} />, { wrapper: restored.wrapper });
    fireEvent.click(screen.getByRole('radio', { name: 'com_media_video' }));
    expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue(
      'A different video',
    );
    expect(screen.queryByText('com_media_using_latest_video')).not.toBeInTheDocument();
    expect(screen.queryByText('com_media_video_reference_unavailable')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
    await waitFor(() => expect(restored.send).toHaveBeenCalledTimes(1));
    expect(restored.send.mock.calls[0][0].request).toMatchObject({
      operation: 'video.generate',
      inputs: [],
    });
    expect(restored.send.mock.calls[0][0].request.parentTurnId).toBeUndefined();
  },
);

test.each(['reference', 'parent'] as const)(
  'switching back to Video preserves an explicit %s instead of the automatic latest clip',
  async (pinned) => {
    const env = setup();
    const choices = makeCatalog({
      offerings: [
        {
          ...catalog.offerings[0],
          capabilities: [
            {
              operation: 'image.edit',
              inputs: { roles: ['reference'], min: 1, max: 1 },
              execution: { kind: 'direct', previews: false },
              controls: { count: { min: 1, max: 1 } },
            },
          ],
        },
        {
          ...catalog.offerings[0],
          modelId: 'video-model',
          modelName: 'Video model',
          api: 'google.vertex.videos',
          capabilities: [
            {
              operation: 'video.generate',
              inputs: { roles: ['video'], min: 0, max: 1 },
              execution: { kind: 'remote-job', cancellation: 'unsupported' },
              controls: { count: { min: 1, max: 1 } },
            },
          ],
        },
      ],
    });
    const asset = {
      file_id: 'chosen-video',
      filename: 'chosen.mp4',
      filepath: '/video/chosen.mp4',
      type: 'video/mp4',
      bytes: 10,
    };
    const inputs =
      pinned === 'reference' ? [{ role: 'video' as const, file_id: asset.file_id }] : [];
    env.store.set(mediaDraftFamily('owner:thread'), {
      ...emptyDraft(),
      operation: 'video.generate',
      offering: JSON.stringify(['connection', 'video-model']),
      prompt: 'Use my chosen reference',
      autoEdit: false,
      inputs,
      assets: pinned === 'reference' ? [asset] : [],
      parentTurnId: pinned === 'parent' ? 'chosen-parent' : undefined,
      revision: 3,
    });
    render(
      <MediaForm
        catalog={choices}
        threadId="thread"
        videoContext={{ turnId: 'latest-turn', asset: { ...asset, file_id: 'latest-video' } }}
        send={env.send}
        busy={false}
      />,
      { wrapper: env.wrapper },
    );
    fireEvent.click(screen.getByRole('radio', { name: 'com_ui_edit' }));
    fireEvent.click(screen.getByRole('radio', { name: 'com_media_video' }));
    expect(screen.queryByText('com_media_using_latest_video')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
    await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
    expect(env.send.mock.calls[0][0].request).toMatchObject({
      operation: 'video.generate',
      inputs,
    });
    expect(env.send.mock.calls[0][0].request.parentTurnId).toBe(
      pinned === 'parent' ? 'chosen-parent' : undefined,
    );
  },
);

test.each(['unsupported', 'hosted'] as const)(
  'a %s video model cannot silently omit the previous result',
  (mode) => {
    const env = setup();
    const choices = makeCatalog({
      offerings: [
        {
          ...catalog.offerings[0],
          capabilities: [
            {
              operation: 'video.generate',
              inputs:
                mode === 'hosted'
                  ? { roles: ['video'], hostedRoles: ['video'], min: 0, max: 1 }
                  : { roles: [], min: 0, max: 0 },
              execution: { kind: 'remote-job', cancellation: 'unsupported' },
              controls: { count: { min: 1, max: 1 } },
            },
          ],
        },
      ],
    });
    render(
      <MediaForm
        {...{ catalog: choices, threadId: 'thread', send: env.send, busy: false }}
        videoContext={{
          turnId: 'parent',
          asset: {
            file_id: 'video',
            filename: 'video.mp4',
            filepath: '/video.mp4',
            type: 'video/mp4',
            bytes: 10,
          },
        }}
      />,
      { wrapper: env.wrapper },
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
      target: { value: 'Continue the scene' },
    });
    expect(
      screen.getByText(
        mode === 'hosted' ? 'com_media_reference_needs_url' : 'com_media_video_model_required',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
    expect(env.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'com_media_remove_reference' }));
    expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeEnabled();
  },
);

test('an unavailable video reference remains blocked after a failed replacement upload', async () => {
  const env = setup();
  const choices = makeCatalog({
    offerings: [
      {
        ...catalog.offerings[0],
        api: 'google.vertex.videos',
        capabilities: [
          {
            operation: 'video.generate',
            inputs: { roles: ['video'], min: 0, max: 1 },
            execution: { kind: 'remote-job', cancellation: 'unsupported' },
            controls: { count: { min: 1, max: 1 } },
          },
        ],
      },
    ],
  });
  const view = render(
    <MediaForm
      catalog={choices}
      threadId="thread"
      videoContextUnavailable
      send={env.send}
      busy={false}
    />,
    { wrapper: env.wrapper },
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'Continue from my replacement clip' },
  });
  const generate = screen.getByRole('button', { name: 'com_media_queue' });
  expect(generate).toBeDisabled();
  const upload = view.container.querySelector<HTMLInputElement>('input[type=file]')!;
  jest.mocked(dataService.uploadMedia).mockRejectedValueOnce(new Error('Upload failed'));
  fireEvent.change(upload, {
    target: { files: [new File(['clip'], 'clip.mp4', { type: 'video/mp4' })] },
  });
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
  expect(screen.getByText('com_media_video_reference_unavailable')).toBeVisible();
  expect(generate).toBeDisabled();
  jest.mocked(dataService.uploadMedia).mockResolvedValueOnce({
    file: {
      file_id: 'replacement-video',
      filename: 'replacement.mp4',
      filepath: '/replacement.mp4',
      type: 'video/mp4',
      bytes: 10,
    },
  });
  fireEvent.change(upload, {
    target: { files: [new File(['clip'], 'replacement.mp4', { type: 'video/mp4' })] },
  });
  await waitFor(() => expect(generate).toBeEnabled());
  expect(screen.queryByText('com_media_video_reference_unavailable')).not.toBeInTheDocument();
  fireEvent.click(generate);
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request.inputs).toEqual([
    { role: 'video', file_id: 'replacement-video' },
  ]);
});

test('a model without editing support cannot silently send a follow-up without its image', () => {
  const env = setup();
  render(
    <MediaForm
      catalog={catalog}
      threadId="thread"
      send={env.send}
      busy={false}
      imageContext={{
        turnId: 'parent',
        asset: {
          file_id: 'image',
          filepath: '/images/image.png',
          filename: 'image.png',
          type: 'image/png',
          bytes: 10,
        },
      }}
    />,
    { wrapper: env.wrapper },
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'Make it red' },
  });
  expect(screen.getByText('com_media_edit_model_required')).toBeVisible();
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  expect(env.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_remove_reference' }));
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeEnabled();
});

test.each([
  ['credentials_required', 'com_media_error_credentials_required'],
  ['gemini_key_required', 'com_media_error_gemini_key_required'],
  ['not_ready', 'com_media_provider_configuration_required'],
] as const)(
  'keeps provider and model names clean with a separate %s description',
  async (reason, label) => {
    const env = setup();
    const choices: MediaCatalog = {
      ...catalog,
      integrations: [
        {
          connectionId: 'native-seed',
          connectionName: 'Seed native',
          api: 'seed.images',
          available: false,
          unavailableReason: reason,
        },
      ],
      offerings: [
        ...catalog.offerings,
        {
          ...catalog.offerings[0],
          modelId: 'unavailable-image',
          modelName: 'Unavailable image',
          available: false,
          capabilities: [],
          unavailableReason: 'unsupported',
        },
      ],
    };
    render(<MediaForm catalog={choices} send={env.send} busy={false} />, { wrapper: env.wrapper });
    fireEvent.click(screen.getByRole('combobox', { name: 'com_media_connection' }));
    const provider = await screen.findByRole('option', {
      name: 'Seed native',
    });
    expect(provider).toHaveAttribute('aria-disabled', 'true');
    expect(provider).toHaveAccessibleDescription(label);
    fireEvent.click(provider);
    expect(env.store.get(mediaDraftFamily('owner:new')).offering).toBe(
      '["connection","image-model"]',
    );
    fireEvent.keyDown(provider, { key: 'Escape' });
    fireEvent.click(screen.getByRole('combobox', { name: 'com_ui_model' }));
    const model = await screen.findByRole('option', { name: 'Unavailable image' });
    expect(model).toHaveAttribute('aria-disabled', 'true');
    expect(model).toHaveAccessibleDescription('com_media_error_unsupported');
  },
);

test('shows configured integrations even when no native model is currently available', async () => {
  const env = setup();
  render(
    <MediaForm
      catalog={{
        ...catalog,
        offerings: [],
        integrations: [
          {
            connectionId: 'minimax',
            connectionName: 'MiniMax',
            api: 'minimax.videos',
            available: false,
            unavailableReason: 'credentials_required',
          },
        ],
      }}
      send={env.send}
      busy={false}
    />,
    { wrapper: env.wrapper },
  );
  fireEvent.click(screen.getByRole('combobox', { name: 'com_media_connection' }));
  expect(await screen.findByRole('option', { name: 'MiniMax' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  expect(screen.queryByRole('button', { name: 'com_media_queue' })).not.toBeInTheDocument();
});

test('uses the chosen OpenRouter provider controls and blocks a stale route without changing the draft', async () => {
  const env = setup();
  const capability = catalog.offerings[0].capabilities[0];
  const choices: MediaCatalog = {
    ...catalog,
    offerings: [
      {
        ...catalog.offerings[0],
        api: 'openrouter.images',
        defaultProviderTag: 'provider-a',
        routes: [
          { providerTag: 'provider-a', providerName: 'Provider A', capabilities: [capability] },
          {
            providerTag: 'provider-b',
            providerName: 'Provider B',
            capabilities: [
              {
                ...capability,
                controls: {
                  count: { min: 1, max: 1, default: 1 },
                  resolution: { values: ['4K'], default: '4K' },
                },
              },
            ],
          },
        ],
      },
    ],
  };
  const view = render(<MediaForm catalog={choices} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'A small lake' },
  });
  fireEvent.click(screen.getByRole('combobox', { name: 'com_media_provider_route' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Provider B' }));
  expect(screen.getByRole('combobox', { name: 'com_media_resolution' })).toHaveTextContent('4K');
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request).toMatchObject({
    selection: { providerTag: 'provider-b' },
    parameters: { count: 1, resolution: '4K' },
  });
  const refreshed: MediaCatalog = {
    ...choices,
    version: 'new',
    offerings: [{ ...choices.offerings[0], routes: [choices.offerings[0].routes![0]] }],
  };
  view.rerender(<MediaForm catalog={refreshed} send={env.send} busy={false} />);
  expect(screen.getByText('com_media_stale_provider_route')).toBeVisible();
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  expect(env.store.get(mediaDraftFamily('owner:new')).providerTag).toBe('provider-b');
  expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue('A small lake');
  fireEvent.click(screen.getByRole('combobox', { name: 'com_media_provider_route' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Provider A' }));
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeEnabled();
});

test('keeps invalid provider JSON drafts and enforces allowed keys, bytes and nesting before submission', async () => {
  const env = setup();
  const base = catalog.offerings[0].capabilities[0];
  const choices: MediaCatalog = {
    ...catalog,
    limits: { ...catalog.limits, maxProviderOptionBytes: 48, maxProviderOptionDepth: 2 },
    offerings: [
      {
        ...catalog.offerings[0],
        capabilities: [
          { ...base, controls: { ...base.controls, providerOptions: ['watermark', 'style'] } },
        ],
      },
    ],
  };
  const view = render(<MediaForm catalog={choices} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'A small lake' },
  });
  fireEvent.click(screen.getByText('com_media_advanced'));
  const editor = screen.getByRole('textbox', { name: 'com_media_provider_options' });
  for (const value of [
    '{',
    '{"unknown":true}',
    '{"style":{"nested":{"deep":1}}}',
    JSON.stringify({ style: 'a'.repeat(50) }),
  ]) {
    fireEvent.change(editor, { target: { value } });
    expect(editor).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
    expect(env.store.get(mediaDraftFamily('owner:new')).providerOptionsText).toBe(value);
  }
  view.unmount();
  render(<MediaForm catalog={choices} send={env.send} busy={false} />, { wrapper: env.wrapper });
  fireEvent.click(screen.getByText('com_media_advanced'));
  const restored = screen.getByRole('textbox', { name: 'com_media_provider_options' });
  expect(restored).toHaveValue(JSON.stringify({ style: 'a'.repeat(50) }));
  fireEvent.change(restored, { target: { value: '{"watermark":false}' } });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request.parameters.providerOptions).toEqual({
    watermark: false,
  });
  fireEvent.change(restored, { target: { value: '{}' } });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(2));
  expect(env.send.mock.calls[1][0].request.parameters).not.toHaveProperty('providerOptions');
});

test('requires an explicit quality choice without inventing a paid tier', async () => {
  const env = setup();
  const base = catalog.offerings[0].capabilities[0];
  if (base.operation === 'video.generate') throw new Error('Expected an image capability');
  const choices: MediaCatalog = {
    ...catalog,
    offerings: [
      {
        ...catalog.offerings[0],
        capabilities: [
          {
            ...base,
            controls: {
              ...base.controls,
              quality: { values: ['standard', 'max'], required: true },
            },
          },
        ],
      },
    ],
  };
  render(<MediaForm catalog={choices} send={env.send} busy={false} />, { wrapper: env.wrapper });
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'A lake' },
  });
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  fireEvent.click(screen.getByRole('combobox', { name: 'com_media_quality' }));
  fireEvent.click(await screen.findByRole('option', { name: 'standard' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request.parameters.quality).toBe('standard');
});

test('submits image edit controls and clears provider-specific JSON when changing models', async () => {
  const env = setup();
  const base = catalog.offerings[0].capabilities[0];
  if (base.operation === 'video.generate') throw new Error('Expected an image capability');
  const choices: MediaCatalog = {
    ...catalog,
    offerings: [
      {
        ...catalog.offerings[0],
        capabilities: [
          {
            ...base,
            controls: {
              ...base.controls,
              outputCompression: { min: 0, max: 100 },
              strength: { min: 0, max: 1 },
              guidance: { min: 0, max: 10 },
              providerOptions: ['watermark'],
            },
          },
        ],
      },
      { ...catalog.offerings[0], modelId: 'second', modelName: 'Another model' },
    ],
  };
  render(<MediaForm catalog={choices} send={env.send} busy={false} />, { wrapper: env.wrapper });
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'A lake' },
  });
  fireEvent.click(screen.getByText('com_media_advanced'));
  for (const [name, value] of [
    ['com_media_output_compression', '80'],
    ['com_media_strength', '0.4'],
    ['com_media_guidance', '3.5'],
  ])
    fireEvent.change(screen.getByRole('spinbutton', { name }), { target: { value } });
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_provider_options' }), {
    target: { value: '{"watermark":false}' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request.parameters).toMatchObject({
    outputCompression: 80,
    strength: 0.4,
    guidance: 3.5,
    providerOptions: { watermark: false },
  });
  fireEvent.click(screen.getByRole('combobox', { name: 'com_ui_model' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Another model' }));
  expect(env.store.get(mediaDraftFamily('owner:new')).providerOptionsText).toBeUndefined();
  expect(env.store.get(mediaDraftFamily('owner:new')).parameters).toEqual({ count: 1 });
  expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue('A lake');
});

test('requires an avatar recording or an explicit voice before enabling generation', () => {
  const env = setup();
  const choices: MediaCatalog = {
    ...catalog,
    offerings: [
      {
        ...catalog.offerings[0],
        api: 'heygen.videos',
        capabilities: [
          {
            operation: 'video.generate',
            workflow: 'avatar',
            constraints: [
              {
                anyOf: [
                  { kind: 'input', role: 'audio', present: true },
                  { kind: 'parameter', name: 'providerOptions', option: 'voice_id', present: true },
                ],
              },
            ],
            inputs: { min: 1, max: 2, roles: ['reference', 'audio'], requiredRoles: ['reference'] },
            execution: { kind: 'remote-job', cancellation: 'unsupported' },
            controls: { count: { min: 1, max: 1, default: 1 }, providerOptions: ['voice_id'] },
          },
        ],
      },
    ],
  };
  env.store.set(mediaDraftFamily('owner:new'), {
    ...emptyDraft(),
    prompt: 'Hello',
    offering: '["connection","image-model"]',
    operation: 'video.generate',
    inputs: [{ role: 'reference', file_id: 'portrait' }],
    revision: 2,
  });
  render(<MediaForm catalog={choices} send={env.send} busy={false} />, { wrapper: env.wrapper });
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  expect(screen.getByText('com_media_unsupported_settings')).toBeVisible();
  fireEvent.click(screen.getByText('com_media_advanced'));
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_provider_options' }), {
    target: { value: '{"voice_id":"selected-voice"}' },
  });
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeEnabled();
});

test('sends one sizing method and clears conflicting defaults when dimensions change', async () => {
  const env = setup();
  const base = catalog.offerings[0].capabilities[0];
  const choices: MediaCatalog = {
    ...catalog,
    offerings: [
      {
        ...catalog.offerings[0],
        capabilities: [
          {
            ...base,
            controls: {
              ...base.controls,
              size: { values: ['1024x1024'], default: '1024x1024' },
              aspectRatio: { values: ['16:9'], default: '16:9' },
            },
          },
        ],
      },
    ],
  };
  render(<MediaForm catalog={choices} send={env.send} busy={false} />, { wrapper: env.wrapper });
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'A lake' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request.parameters).toMatchObject({ resolution: '2K' });
  expect(env.send.mock.calls[0][0].request.parameters).not.toHaveProperty('size');
  fireEvent.click(screen.getByRole('combobox', { name: 'com_media_size' }));
  fireEvent.click(await screen.findByRole('option', { name: '1024x1024' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(2));
  expect(env.send.mock.calls[1][0].request.parameters).toMatchObject({ size: '1024x1024' });
  expect(env.send.mock.calls[1][0].request.parameters).not.toHaveProperty('resolution');
  expect(env.send.mock.calls[1][0].request.parameters).not.toHaveProperty('aspectRatio');
  fireEvent.click(screen.getByRole('combobox', { name: 'com_media_resolution' }));
  fireEvent.click(await screen.findByRole('option', { name: '1K' }));
  expect(env.store.get(mediaDraftFamily('owner:new')).parameters.size).toBeUndefined();
});

test('supports fractional controls, automatic frame roles and required video references without a duplicate OpenRouter picker', async () => {
  const env = setup();
  const choices: MediaCatalog = {
    ...catalog,
    offerings: [
      {
        ...catalog.offerings[0],
        api: 'openrouter.videos',
        modelId: 'new/video-upscaler',
        capabilities: [
          {
            operation: 'video.generate',
            workflow: 'upscale',
            inputs: {
              min: 1,
              max: 3,
              roles: ['start_frame', 'video', 'audio'],
              requiredRoles: ['video'],
            },
            execution: { kind: 'remote-job', cancellation: 'unsupported' },
            controls: {
              count: { min: 1, max: 1, default: 1 },
              upscaleFactor: { min: 1, max: 4, default: 2 },
              creativity: { min: 0, max: 1 },
              negativePrompt: true,
            },
          },
        ],
      },
    ],
  };
  const view = render(<MediaForm catalog={choices} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'Make this clearer' },
  });
  expect(
    screen.queryByRole('combobox', { name: 'com_media_provider_route' }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('spinbutton', { name: 'com_media_upscale_factor' }), {
    target: { value: '1.5' },
  });
  expect(screen.getByRole('spinbutton', { name: 'com_media_upscale_factor' })).toHaveAttribute(
    'step',
    'any',
  );
  fireEvent.click(screen.getByText('com_media_advanced'));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'com_media_creativity' }), {
    target: { value: '0.3' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_negative_prompt' }), {
    target: { value: 'grain' },
  });
  const upload = view.container.querySelector<HTMLInputElement>('input[type=file]')!;
  for (const [file_id, type, expectedRole] of [
    ['frame', 'image/png', 'start_frame'],
    ['clip', 'video/mp4', 'video'],
  ] as const) {
    jest.mocked(dataService.uploadMedia).mockResolvedValueOnce({
      file: { file_id, filename: file_id, type, bytes: 10, filepath: `/media/${file_id}` },
    });
    fireEvent.change(upload, { target: { files: [new File(['original'], file_id, { type })] } });
    await waitFor(() =>
      expect(
        env.store
          .get(mediaDraftFamily('owner:new'))
          .inputs.some((input) => input.role === expectedRole),
      ).toBe(true),
    );
    if (expectedRole === 'start_frame')
      expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  }
  expect(screen.getByLabelText('com_media_video_preview')).toHaveAttribute('controls');
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request.parameters).toEqual({
    count: 1,
    upscaleFactor: 1.5,
    creativity: 0.3,
    negativePrompt: 'grain',
  });
});

const hostedCatalog: MediaCatalog = {
  ...catalog,
  offerings: [
    {
      ...catalog.offerings[0],
      api: 'openrouter.videos',
      capabilities: [
        {
          operation: 'video.generate',
          inputs: {
            min: 1,
            max: 3,
            roles: ['video', 'audio', 'start_frame'],
            hostedRoles: ['audio', 'video'],
            requiredRoles: ['video'],
          },
          execution: { kind: 'remote-job', cancellation: 'unsupported' },
          controls: { count: { min: 1, max: 1, default: 1 } },
        },
      ],
    },
  ],
};
const hostedReference: MediaURLUploadResponse = {
  sourceURL: 'https://media.example.com/reference.mp4',
  file: {
    file_id: 'hosted-clip',
    filename: 'reference.mp4',
    type: 'video/mp4',
    filepath: '/media/archived-reference.mp4',
    bytes: 12,
  },
};

test('a URL-only model opens its reference dialog without any local file input', () => {
  const env = setup();
  const choices: MediaCatalog = {
    ...hostedCatalog,
    offerings: [
      {
        ...hostedCatalog.offerings[0],
        capabilities: [
          {
            ...hostedCatalog.offerings[0].capabilities[0],
            inputs: {
              min: 1,
              max: 1,
              roles: ['video'],
              hostedRoles: ['video'],
              requiredRoles: ['video'],
            },
          },
        ],
      },
    ],
  };
  const view = render(<MediaForm catalog={choices} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  expect(view.container.querySelector('input[type=file]')).toBeNull();
  expect(
    screen.queryByRole('textbox', { name: 'com_media_reference_url' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  expect(screen.getByRole('dialog', { name: 'com_media_upload' })).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'com_media_local_reference' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('combobox', { name: 'com_media_reference_url_role' }),
  ).not.toBeInTheDocument();
});

test('a native model requiring hosted video still accepts local images and audio', async () => {
  const env = setup();
  const choices: MediaCatalog = {
    ...hostedCatalog,
    offerings: [
      {
        ...hostedCatalog.offerings[0],
        api: 'seed.videos',
        capabilities: [
          {
            ...hostedCatalog.offerings[0].capabilities[0],
            inputs: {
              min: 0,
              max: 3,
              roles: ['video', 'audio', 'start_frame'],
              hostedRoles: ['video'],
            },
          },
        ],
      },
    ],
  };
  const view = render(<MediaForm catalog={choices} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  const input = view.container.querySelector<HTMLInputElement>('input[type=file]')!;
  expect(input).toHaveAttribute('accept', 'image/*,audio/*');
  for (const [type, role] of [
    ['image/png', 'start_frame'],
    ['audio/mpeg', 'audio'],
  ] as const) {
    fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
    const choose = jest.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'com_media_local_reference' }));
    expect(choose).toHaveBeenCalled();
    const file = { ...hostedReference.file, file_id: role, type };
    jest.mocked(dataService.uploadMedia).mockResolvedValueOnce({ file });
    fireEvent.change(input, { target: { files: [new File(['reference'], role, { type })] } });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(env.store.get(mediaDraftFamily('owner:new')).inputs).toContainEqual({
      file_id: role,
      role,
    });
  }
  expect(dataService.uploadMediaURL).not.toHaveBeenCalled();
});

test('an image generation model retains the direct file chooser and switches to its edit capability', async () => {
  const env = setup();
  const choices: MediaCatalog = {
    ...catalog,
    offerings: [
      {
        ...catalog.offerings[0],
        capabilities: [
          catalog.offerings[0].capabilities[0],
          {
            ...catalog.offerings[0].capabilities[0],
            operation: 'image.edit',
            inputs: { min: 1, max: 2, roles: ['reference'] },
          },
        ],
      },
    ],
  };
  const view = render(<MediaForm catalog={choices} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  const input = view.container.querySelector<HTMLInputElement>('input[type=file]')!;
  expect(input).toHaveAttribute('accept', 'image/*');
  const choose = jest.spyOn(input, 'click');
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  expect(choose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  jest.mocked(dataService.uploadMedia).mockResolvedValueOnce({
    file: { ...hostedReference.file, type: 'image/png', file_id: 'local-image' },
  });
  fireEvent.change(input, {
    target: { files: [new File(['image'], 'image.png', { type: 'image/png' })] },
  });
  await waitFor(() =>
    expect(env.store.get(mediaDraftFamily('owner:new')).operation).toBe('image.edit'),
  );
  expect(env.store.get(mediaDraftFamily('owner:new')).inputs).toEqual([
    { file_id: 'local-image', role: 'reference' },
  ]);
});

test('switching editors closes and aborts a hosted import, preserves its draft, and ignores its late response', async () => {
  let finish!: (response: MediaURLUploadResponse) => void;
  jest.mocked(dataService.uploadMediaURL).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const env = setup();
  const view = render(<MediaForm catalog={hostedCatalog} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'Keep my prompt' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_reference_url' }), {
    target: { value: hostedReference.sourceURL },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_add_reference_url' }));
  await waitFor(() => expect(dataService.uploadMediaURL).toHaveBeenCalledTimes(1));
  const signal = jest.mocked(dataService.uploadMediaURL).mock.calls[0][1];
  view.rerender(
    <MediaForm catalog={hostedCatalog} threadId="second" send={env.send} busy={false} />,
  );
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await act(async () => finish(hostedReference));
  expect(env.store.get(mediaDraftFamily('owner:new')).inputs).toEqual([]);
  expect(env.store.get(mediaDraftFamily('owner:second')).inputs).toEqual([]);
  view.rerender(<MediaForm catalog={hostedCatalog} send={env.send} busy={false} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue('Keep my prompt');
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  expect(screen.getByRole('textbox', { name: 'com_media_reference_url' })).toHaveValue(
    hostedReference.sourceURL,
  );
});

test('validates hosted links and rejects local audio/video before making an upload request', () => {
  const env = setup();
  const view = render(<MediaForm catalog={hostedCatalog} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  expect(
    screen.queryByRole('textbox', { name: 'com_media_reference_url' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  const url = screen.getByRole('textbox', { name: 'com_media_reference_url' });
  expect(screen.getByRole('combobox', { name: 'com_media_reference_url_role' })).toHaveTextContent(
    'com_media_role_video',
  );
  const add = screen.getByRole('button', { name: 'com_media_add_reference_url' });
  for (const value of [
    'http://media.example.com/video.mp4',
    'https://user:password@media.example.com/video.mp4',
    'https://media.example.com/video.mp4#fragment',
  ]) {
    fireEvent.change(url, { target: { value } });
    expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(add).toBeDisabled();
  }
  const upload = view.container.querySelector<HTMLInputElement>('input[type=file]')!;
  expect(upload).toHaveAttribute('accept', 'image/*');
  for (const type of ['video/mp4', 'audio/mpeg'])
    fireEvent.change(upload, {
      target: { files: [new File(['original'], 'reference', { type })] },
    });
  expect(screen.getByRole('alert')).toHaveTextContent('com_media_reference_needs_url');
  expect(dataService.uploadMedia).not.toHaveBeenCalled();
  expect(dataService.uploadMediaURL).not.toHaveBeenCalled();
});

test('persists a URL draft, archives it, and submits the source URL with its owned reference', async () => {
  const env = setup();
  const view = render(<MediaForm catalog={hostedCatalog} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_reference_url' }), {
    target: { value: ` ${hostedReference.sourceURL} ` },
  });
  view.unmount();
  mediaDraftFamily.remove('owner:new');
  const restored = setup();
  render(<MediaForm catalog={hostedCatalog} send={restored.send} busy={false} />, {
    wrapper: restored.wrapper,
  });
  expect(
    screen.queryByRole('textbox', { name: 'com_media_reference_url' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  expect(screen.getByRole('textbox', { name: 'com_media_reference_url' })).toHaveValue(
    hostedReference.sourceURL,
  );
  jest.mocked(dataService.uploadMediaURL).mockResolvedValueOnce(hostedReference);
  fireEvent.click(screen.getByRole('button', { name: 'com_media_add_reference_url' }));
  await waitFor(() =>
    expect(restored.store.get(mediaDraftFamily('owner:new')).inputs).toEqual([
      { file_id: 'hosted-clip', role: 'video', sourceURL: hostedReference.sourceURL },
    ]),
  );
  expect(dataService.uploadMediaURL).toHaveBeenCalledWith(
    { url: hostedReference.sourceURL, role: 'video' },
    expect.any(AbortSignal),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(restored.store.get(mediaDraftFamily('owner:new')).referenceURL).toBe('');
  expect(screen.getByLabelText('com_media_video_preview')).toHaveAttribute('controls');
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'Upscale this video' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(restored.send).toHaveBeenCalledTimes(1));
  expect(restored.send.mock.calls[0][0].request.inputs).toEqual([
    { file_id: 'hosted-clip', role: 'video', sourceURL: hostedReference.sourceURL },
  ]);
});

test('cancels a URL import without accepting a late result and retains the draft for retry', async () => {
  let finish: (response: MediaURLUploadResponse) => void = () => {};
  jest.mocked(dataService.uploadMediaURL).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const env = setup();
  render(<MediaForm catalog={hostedCatalog} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_reference_url' }), {
    target: { value: hostedReference.sourceURL },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_add_reference_url' }));
  expect(screen.getByText('com_media_reference_loading')).toBeInTheDocument();
  await waitFor(() => expect(dataService.uploadMediaURL).toHaveBeenCalledTimes(1));
  const signal = jest.mocked(dataService.uploadMediaURL).mock.calls[0][1];
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  await act(async () => finish(hostedReference));
  expect(env.store.get(mediaDraftFamily('owner:new')).inputs).toEqual([]);
  expect(screen.getByRole('textbox', { name: 'com_media_reference_url' })).toHaveValue(
    hostedReference.sourceURL,
  );
  jest
    .mocked(dataService.uploadMediaURL)
    .mockRejectedValueOnce({ response: { data: { error: { code: 'transfer_failed' } } } });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_add_reference_url' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'com_media_add_reference_url' })).toBeEnabled();
  jest.mocked(dataService.uploadMediaURL).mockResolvedValueOnce(hostedReference);
  fireEvent.click(screen.getByRole('button', { name: 'com_media_add_reference_url' }));
  await waitFor(() => expect(env.store.get(mediaDraftFamily('owner:new')).inputs).toHaveLength(1));
});

test('a locally uploaded video stays blocked when a refreshed model requires a hosted reference', () => {
  const env = setup();
  env.store.set(mediaDraftFamily('owner:new'), {
    ...emptyDraft(),
    operation: 'video.generate',
    prompt: 'Edit this video',
    inputs: [{ file_id: 'local-clip', role: 'video' }],
    assets: [{ ...hostedReference.file, file_id: 'local-clip' }],
  });
  render(<MediaForm catalog={hostedCatalog} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  expect(screen.getByText('com_media_reference_needs_url')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
});

test.each(['reference_unavailable', 'reference_changed'] as const)(
  'explains the %s URL failure and keeps the reference draft for correction',
  async (code) => {
    const env = setup();
    render(<MediaForm catalog={hostedCatalog} send={env.send} busy={false} />, {
      wrapper: env.wrapper,
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
    jest
      .mocked(dataService.uploadMediaURL)
      .mockRejectedValueOnce({ response: { data: { error: { code } } } });
    fireEvent.change(screen.getByRole('textbox', { name: 'com_media_reference_url' }), {
      target: { value: hostedReference.sourceURL },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_media_add_reference_url' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(`com_media_error_${code}`),
    );
    expect(screen.getByRole('textbox', { name: 'com_media_reference_url' })).toHaveValue(
      hostedReference.sourceURL,
    );
    expect(screen.getByRole('button', { name: 'com_media_add_reference_url' })).toBeEnabled();
    expect(env.store.get(mediaDraftFamily('owner:new')).inputs).toHaveLength(0);
  },
);

test('imports an explicitly selected hosted audio role without satisfying a mandatory video input', async () => {
  const env = setup();
  render(<MediaForm catalog={hostedCatalog} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'com_media_reference_url_role' }));
  fireEvent.click(await screen.findByRole('option', { name: 'com_media_role_audio' }));
  const audio = {
    sourceURL: 'https://media.example.com/reference.mp3',
    file: { ...hostedReference.file, file_id: 'hosted-audio', type: 'audio/mpeg' },
  };
  jest.mocked(dataService.uploadMediaURL).mockResolvedValueOnce(audio);
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_reference_url' }), {
    target: { value: audio.sourceURL },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_add_reference_url' }));
  await waitFor(() =>
    expect(env.store.get(mediaDraftFamily('owner:new')).inputs).toEqual([
      { file_id: 'hosted-audio', role: 'audio', sourceURL: audio.sourceURL },
    ]),
  );
  expect(screen.getByLabelText('com_media_audio_preview')).toHaveAttribute('controls');
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
});

test('refining and editing a saved hosted input preserves its source URL', async () => {
  const env = setup();
  const now = '2026-01-01T00:00:00.000Z';
  const selection = {
    connectionId: 'connection',
    modelId: 'image-model',
    catalogVersion: 'catalog',
  };
  const input = {
    file_id: hostedReference.file.file_id,
    role: 'video' as const,
    sourceURL: hostedReference.sourceURL,
  };
  const detail: MediaThreadDetail = {
    thread: {
      schemaVersion: 1,
      threadId: 'thread',
      title: 'Video work',
      version: 1,
      createdAt: now,
      updatedAt: now,
      pendingJobCount: 0,
      turnCount: 1,
    },
    turns: {
      items: [
        {
          schemaVersion: 1,
          threadId: 'thread',
          turnId: 'parent',
          version: 1,
          kind: 'generation',
          createdAt: now,
          prompt: 'Original prompt',
          inputs: [input],
          selection,
          operation: 'video.generate',
          assets: [hostedReference.file],
          jobs: [
            {
              schemaVersion: 1,
              jobId: 'job',
              threadId: 'thread',
              turnId: 'parent',
              version: 1,
              phase: 'failed',
              executionOwner: 'media',
              operation: 'video.generate',
              selection,
              createdAt: now,
              updatedAt: now,
              allowedActions: { cancel: false, retry: false },
              outputs: [],
            },
          ],
        },
      ],
    },
  };
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MediaForm catalog={hostedCatalog} threadId="thread" send={env.send} busy={false} />
      <MediaThreadView
        detail={detail}
        catalog={hostedCatalog}
        send={env.send}
        onDeleted={() => {}}
      />
    </QueryClientProvider>,
    { wrapper: env.wrapper },
  );
  fireEvent.click(screen.getByRole('button', { name: 'com_media_refine' }));
  expect(env.store.get(mediaDraftFamily('owner:thread')).inputs).toEqual([input]);
  fireEvent.click(screen.getByRole('button', { name: 'com_media_edit_request' }));
  expect(env.store.get(mediaDraftFamily('owner:thread')).inputs).toEqual([input]);
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeEnabled();
});

const preset = {
  schemaVersion: 1 as const,
  presetId: 'preset-1',
  title: 'Quick draft',
  isDefault: false,
  settings: {
    operation: 'image.generate' as const,
    connectionId: 'connection',
    modelId: 'image-model',
    parameters: { count: 2, quality: 'low' },
  },
  assets: [],
  createdAt: '2026-09-17T12:00:00.000Z',
  updatedAt: '2026-09-17T12:00:00.000Z',
};

test('presets apply saved settings and capture the current ones', async () => {
  const env = setup(true, { presets: true });
  jest.spyOn(dataService, 'listMediaPresets').mockResolvedValue({ items: [preset] });
  const create = jest
    .spyOn(dataService, 'createMediaPreset')
    .mockResolvedValue({ ...preset, presetId: 'preset-2', title: 'Studio look' });
  render(<MediaForm catalog={catalog} send={env.send} busy={false} />, { wrapper: env.wrapper });
  fireEvent.click(await screen.findByRole('button', { name: 'com_ui_manage' }));
  const dialog = await screen.findByRole('dialog', { name: 'com_media_presets' });
  fireEvent.click(await within(dialog).findByRole('button', { name: 'com_media_preset_apply' }));
  await waitFor(() =>
    expect(env.store.get(mediaDraftFamily('owner:new')).parameters).toMatchObject({
      count: 2,
      quality: 'low',
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'com_media_presets' })).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_manage' }));
  const reopened = await screen.findByRole('dialog', { name: 'com_media_presets' });
  fireEvent.change(within(reopened).getByRole('textbox', { name: 'com_media_preset_name' }), {
    target: { value: 'Studio look' },
  });
  fireEvent.click(within(reopened).getByRole('button', { name: 'com_media_preset_save' }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      title: 'Studio look',
      isDefault: false,
      settings: expect.objectContaining({
        operation: 'image.generate',
        connectionId: 'connection',
        modelId: 'image-model',
        parameters: expect.objectContaining({ count: 2, quality: 'low' }),
      }),
    }),
  );
  expect(await within(reopened).findByText('com_media_preset_saved')).toBeVisible();
});

test('a default preset seeds an untouched draft', async () => {
  const env = setup(true, { presets: true });
  jest
    .spyOn(dataService, 'listMediaPresets')
    .mockResolvedValue({ items: [{ ...preset, isDefault: true }] });
  render(<MediaForm catalog={catalog} send={env.send} busy={false} />, { wrapper: env.wrapper });
  await waitFor(() =>
    expect(env.store.get(mediaDraftFamily('owner:new')).parameters.count).toBe(2),
  );
  expect(screen.getByRole('combobox', { name: 'com_media_presets' })).toHaveTextContent(
    'Quick draft',
  );
});

const presetReference = {
  file_id: 'saved-reference',
  filename: 'saved.png',
  type: 'image/png',
  bytes: 32,
  filepath: '/api/media/assets/saved-reference',
};
const referencePreset = {
  ...preset,
  settings: {
    ...preset.settings,
    operation: 'image.edit' as const,
    inputs: [{ file_id: presetReference.file_id, role: 'reference' as const }],
  },
  assets: [presetReference],
};
const presetCatalog = makeCatalog({
  offerings: [
    {
      ...catalog.offerings[0],
      capabilities: [
        {
          ...catalog.offerings[0].capabilities[0],
          operation: 'image.edit',
          inputs: { roles: ['reference'], min: 1, max: 2 },
        },
      ],
    },
  ],
});

test('reference presets restore complete assets without lineage and save only input identities', async () => {
  const env = setup(true, { presets: true });
  jest.spyOn(dataService, 'listMediaPresets').mockResolvedValue({ items: [referencePreset] });
  const create = jest.spyOn(dataService, 'createMediaPreset').mockResolvedValue(referencePreset);
  const atom = mediaDraftFamily('owner:new');
  env.store.set(atom, {
    ...emptyDraft(),
    offering: JSON.stringify(['connection', 'image-model']),
    prompt: 'Keep this prompt',
    parentTurnId: 'old-turn',
    autoEdit: true,
    revision: 2,
  });
  render(<MediaForm catalog={presetCatalog} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  fireEvent.click(await screen.findByRole('button', { name: 'com_ui_manage' }));
  const dialog = await screen.findByRole('dialog', { name: 'com_media_presets' });
  fireEvent.click(await within(dialog).findByRole('button', { name: 'com_media_preset_apply' }));
  await waitFor(() => expect(env.store.get(atom).inputs).toEqual(referencePreset.settings.inputs));
  expect(env.store.get(atom)).toMatchObject({
    prompt: 'Keep this prompt',
    parentTurnId: undefined,
    autoEdit: false,
    assets: [presetReference],
  });
  expect(screen.getByRole('combobox', { name: 'com_media_presets' })).toHaveTextContent(
    preset.title,
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_manage' }));
  const saveDialog = await screen.findByRole('dialog', { name: 'com_media_presets' });
  fireEvent.change(within(saveDialog).getByRole('textbox', { name: 'com_media_preset_name' }), {
    target: { value: 'Reference look' },
  });
  fireEvent.click(within(saveDialog).getByRole('button', { name: 'com_media_preset_save' }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0][0].settings.inputs).toEqual(referencePreset.settings.inputs);
  expect(create.mock.calls[0][0]).not.toHaveProperty('assets');
  fireEvent.keyDown(saveDialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  act(() => env.store.set(atom, { ...env.store.get(atom), inputs: [] }));
  expect(screen.getByRole('combobox', { name: 'com_media_presets' })).toHaveTextContent(
    'com_ui_custom',
  );
});

test.each(['missing reference', 'unsupported role'])(
  'a preset with a %s preserves the current draft',
  async (reason) => {
    const env = setup(true, { presets: true });
    const unavailable =
      reason === 'missing reference'
        ? { ...referencePreset, assets: [] }
        : {
            ...referencePreset,
            settings: {
              ...referencePreset.settings,
              inputs: [{ file_id: presetReference.file_id, role: 'start_frame' as const }],
            },
          };
    jest.spyOn(dataService, 'listMediaPresets').mockResolvedValue({ items: [unavailable] });
    const atom = mediaDraftFamily('owner:new');
    const draft = {
      ...emptyDraft(),
      offering: JSON.stringify(['connection', 'image-model']),
      operation: 'image.edit' as const,
      prompt: 'Keep every setting',
      parentTurnId: 'old-turn',
      inputs: [{ file_id: 'current-file', role: 'reference' as const }],
      assets: [{ ...presetReference, file_id: 'current-file' }],
      revision: 2,
    };
    env.store.set(atom, draft);
    render(<MediaForm catalog={presetCatalog} send={env.send} busy={false} />, {
      wrapper: env.wrapper,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_manage' }));
    const dialog = await screen.findByRole('dialog', { name: 'com_media_presets' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'com_media_preset_apply' }));
    expect(await within(dialog).findByText('com_media_preset_unavailable')).toBeVisible();
    expect(env.store.get(atom)).toEqual(draft);
  },
);

test.each([false, true])(
  'a default reference preset respects an explicitly seeded draft: %s',
  async (seeded) => {
    const env = setup(true, { presets: true });
    jest.spyOn(dataService, 'listMediaPresets').mockResolvedValue({
      items: [{ ...referencePreset, isDefault: true }],
    });
    const atom = mediaDraftFamily('owner:new');
    const seededInputs = [{ file_id: 'seeded-reference', role: 'reference' as const }];
    if (seeded) env.store.set(atom, { ...emptyDraft(), inputs: seededInputs });
    render(<MediaForm catalog={presetCatalog} send={env.send} busy={false} />, {
      wrapper: env.wrapper,
    });
    await waitFor(() => expect(env.store.get(atom).offering).toBeTruthy());
    expect(env.store.get(atom).inputs).toEqual(
      seeded ? seededInputs : referencePreset.settings.inputs,
    );
    expect(env.store.get(atom).parameters.count).toBe(seeded ? 1 : 2);
  },
);

test('presets explain why hosted references cannot be saved', async () => {
  const env = setup(true, { presets: true });
  jest.spyOn(dataService, 'listMediaPresets').mockResolvedValue({ items: [] });
  const create = jest.spyOn(dataService, 'createMediaPreset');
  env.store.set(mediaDraftFamily('owner:new'), {
    ...emptyDraft(),
    offering: JSON.stringify(['connection', 'image-model']),
    inputs: [{ file_id: 'hosted', role: 'video', sourceURL: 'https://example.com/reference.mp4' }],
    revision: 2,
  });
  render(<MediaForm catalog={presetCatalog} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  fireEvent.click(await screen.findByRole('button', { name: 'com_ui_manage' }));
  const dialog = await screen.findByRole('dialog', { name: 'com_media_presets' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'com_media_preset_name' }), {
    target: { value: 'Hosted reference' },
  });
  expect(within(dialog).getByText('com_media_preset_hosted_inputs')).toBeVisible();
  expect(within(dialog).getByRole('button', { name: 'com_media_preset_save' })).toBeDisabled();
  expect(create).not.toHaveBeenCalled();
});

test('comparing hands both validated model requests to the command owner before dispatch', async () => {
  const env = setup(true, { compare: true });
  const comparable: MediaCatalog = {
    ...catalog,
    offerings: [
      catalog.offerings[0],
      {
        ...catalog.offerings[0],
        modelId: 'other-model',
        modelName: 'Other model',
        capabilities: [
          {
            ...catalog.offerings[0].capabilities[0],
            controls: { count: { min: 1, max: 1, default: 1 } },
          },
        ],
      },
    ],
  };
  env.send.mockResolvedValueOnce({
    schemaVersion: 1,
    clientRequestId: 'first',
    threadId: 'thread-9',
    turnId: 'turn-9',
    jobId: 'job-9',
    phase: 'accepted',
  });
  render(<MediaForm catalog={comparable} send={env.send} busy={false} />, {
    wrapper: env.wrapper,
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_compare_add' }));
  expect(screen.getByRole('combobox', { name: 'com_media_compare_model' })).toHaveTextContent(
    'Other model',
  );
  expect(screen.getByText('com_media_compare_hint')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'A lighthouse at dusk' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  const { request: first, following: second } = env.send.mock.calls[0][0];
  expect(first.threadId).toBeUndefined();
  expect(first.comparisonId).toEqual(expect.any(String));
  expect(second).toMatchObject({
    comparisonId: first.comparisonId,
    prompt: 'A lighthouse at dusk',
    selection: expect.objectContaining({ modelId: 'other-model' }),
    parameters: { count: 1 },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_compare_remove' }));
  expect(
    screen.queryByRole('combobox', { name: 'com_media_compare_model' }),
  ).not.toBeInTheDocument();
});

test('a temporary draft flags only the submission that creates the thread', async () => {
  const env = setup();
  env.store.set(mediaDraftFamily('owner:new'), { ...emptyDraft(), temporary: true, revision: 1 });
  render(<MediaForm catalog={catalog} send={env.send} busy={false} />, { wrapper: env.wrapper });
  expect(screen.getByText('com_media_temporary_hint')).toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'Ephemeral sketch' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request).toMatchObject({ temporary: true });
  expect(env.send.mock.calls[0][0].request.comparisonId).toBeUndefined();
});

test('importing references from a temporary draft preserves its retention choice', async () => {
  const env = setup();
  env.store.set(mediaDraftFamily('owner:new'), {
    ...emptyDraft(),
    temporary: true,
    inputs: [{ role: 'reference', file_id: 'image' }],
    revision: 2,
  });
  render(<MediaForm catalog={catalog} send={env.send} busy={false} />, { wrapper: env.wrapper });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_import' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0]).toMatchObject({ kind: 'import', request: { temporary: true } });
});

test('conditional defaults adapt to references without overwriting an explicit invalid choice', async () => {
  const env = setup();
  const choices: MediaCatalog = {
    ...catalog,
    offerings: [
      {
        ...catalog.offerings[0],
        capabilities: [
          {
            operation: 'video.generate',
            inputs: { min: 0, max: 1, roles: ['reference'] },
            execution: { kind: 'remote-job', cancellation: 'unsupported' },
            controls: {
              count: { min: 1, max: 1, default: 1 },
              durationSeconds: { min: 4, max: 8, default: 4, values: [4, 6, 8] },
            },
            constraints: [
              {
                when: [{ kind: 'input', role: 'reference', present: true }],
                anyOf: [{ kind: 'parameter', name: 'durationSeconds', values: [8] }],
              },
            ],
          },
        ],
      },
    ],
  };
  env.store.set(mediaDraftFamily('owner:new'), {
    ...emptyDraft(),
    offering: '["connection","image-model"]',
    operation: 'video.generate',
    prompt: 'A lake',
    inputs: [{ role: 'reference', file_id: 'image' }],
    revision: 2,
  });
  render(<MediaForm catalog={choices} send={env.send} busy={false} />, { wrapper: env.wrapper });
  expect(screen.getByRole('combobox', { name: 'com_media_duration_seconds' })).toHaveTextContent(
    '8',
  );
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
  expect(env.send.mock.calls[0][0].request.parameters.durationSeconds).toBe(8);
  fireEvent.click(screen.getByRole('combobox', { name: 'com_media_duration_seconds' }));
  fireEvent.click(await screen.findByRole('option', { name: '4' }));
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  expect(screen.getByText('com_media_unsupported_settings')).toBeVisible();
});

test('failed preset mutations retain the preset and show a localized retryable error', async () => {
  const env = setup(true, { presets: true });
  jest.spyOn(dataService, 'listMediaPresets').mockResolvedValue({ items: [preset] });
  const update = jest
    .spyOn(dataService, 'updateMediaPreset')
    .mockRejectedValue(new Error('Disconnected'));
  const remove = jest
    .spyOn(dataService, 'deleteMediaPreset')
    .mockRejectedValue(new Error('Disconnected'));
  render(<MediaForm catalog={catalog} send={env.send} busy={false} />, { wrapper: env.wrapper });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_manage' }));
  const dialog = await screen.findByRole('dialog', { name: 'com_media_presets' });
  fireEvent.click(
    await within(dialog).findByRole('button', { name: 'com_media_preset_set_default' }),
  );
  expect(await within(dialog).findByText('com_media_preset_error')).toBeVisible();
  expect(update).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole('button', { name: 'com_media_preset_delete' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'com_ui_delete' }));
  await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
  expect(await within(dialog).findByText('com_media_preset_error')).toBeVisible();
  expect(within(dialog).getByText('Quick draft')).toBeVisible();
  expect(within(dialog).getByRole('button', { name: 'com_ui_delete' })).toBeEnabled();
});

test.each(['paste', 'drop'] as const)(
  'uploads an image from %s and selects image editing',
  async (source) => {
    const env = setup();
    const editing: MediaCatalog = {
      ...catalog,
      offerings: [
        {
          ...catalog.offerings[0],
          capabilities: [
            ...catalog.offerings[0].capabilities,
            {
              operation: 'image.edit',
              inputs: { min: 1, max: 1, roles: ['reference'] },
              execution: { kind: 'direct', previews: false },
              controls: { count: { min: 1, max: 1, default: 1 } },
            },
          ],
        },
      ],
    };
    const asset = {
      file_id: 'pasted',
      filename: 'input.png',
      filepath: '/images/input.png',
      type: 'image/png',
      bytes: 10,
    };
    jest.mocked(dataService.uploadMedia).mockResolvedValue({ file: asset });
    render(<MediaForm catalog={editing} send={env.send} busy={false} />, { wrapper: env.wrapper });
    const prompt = screen.getByRole('textbox', { name: 'com_media_prompt' });
    const file = new File(['image'], 'input.png', { type: 'image/png' });
    if (source === 'paste') fireEvent.paste(prompt, { clipboardData: { files: [file] } });
    else fireEvent.drop(prompt, { dataTransfer: { files: [file], types: ['Files'] } });
    await waitFor(() =>
      expect(env.store.get(mediaDraftFamily('owner:new'))).toMatchObject({
        operation: 'image.edit',
        inputs: [{ file_id: 'pasted', role: 'reference' }],
      }),
    );
    fireEvent.paste(prompt, { clipboardData: { files: [file] } });
    expect(dataService.uploadMedia).toHaveBeenCalledTimes(1);
    fireEvent.change(prompt, { target: { value: 'Paint the background blue' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
    await waitFor(() =>
      expect(env.send).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            operation: 'image.edit',
            inputs: [{ file_id: 'pasted', role: 'reference' }],
          }),
        }),
      ),
    );
  },
);

test.each([
  { type: 'video/webm', bytes: 100, allowed: false },
  { type: 'video/mp4', bytes: 501, allowed: false },
  { type: 'video/mp4', bytes: 500, allowed: true },
])(
  'validates restored input MIME and bytes before submission: $type, $bytes',
  async ({ type, bytes, allowed }) => {
    const env = setup();
    const choices: MediaCatalog = {
      ...catalog,
      offerings: [
        {
          ...catalog.offerings[0],
          capabilities: [
            {
              operation: 'video.generate',
              inputs: {
                min: 1,
                max: 1,
                roles: ['video'],
                mediaTypes: { video: ['video/mp4'] },
                maxBytes: { video: 500 },
              },
              execution: { kind: 'remote-job', cancellation: 'unsupported' },
              controls: { count: { min: 1, max: 1, default: 1 } },
            },
          ],
        },
      ],
    };
    const input = { file_id: 'clip', role: 'video' as const };
    env.store.set(mediaDraftFamily('owner:new'), {
      ...emptyDraft(),
      offering: '["connection","image-model"]',
      operation: 'video.generate',
      prompt: 'Continue the clip',
      inputs: [input],
      revision: 2,
      assets: [{ file_id: 'clip', filename: 'clip', filepath: '/clip', type, bytes }],
    });
    render(<MediaForm catalog={choices} send={env.send} busy={false} />, { wrapper: env.wrapper });
    const submit = screen.getByRole('button', { name: 'com_media_queue' });
    if (!allowed) {
      expect(submit).toBeDisabled();
      fireEvent.click(submit);
      expect(env.send).not.toHaveBeenCalled();
      return;
    }
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(env.send).toHaveBeenCalledTimes(1));
    expect(env.send.mock.calls[0][0].request.inputs).toEqual([input]);
  },
);

test('preserves an over-limit restored prompt and enables submission after shortening it', () => {
  const env = setup();
  const choices: MediaCatalog = {
    ...catalog,
    offerings: [
      {
        ...catalog.offerings[0],
        capabilities: [{ ...catalog.offerings[0].capabilities[0], maxPromptChars: 5 }],
      },
    ],
  };
  env.store.set(mediaDraftFamily('owner:new'), {
    ...emptyDraft(),
    offering: '["connection","image-model"]',
    prompt: 'Keep this long draft',
    revision: 2,
  });
  render(<MediaForm catalog={choices} send={env.send} busy={false} />, { wrapper: env.wrapper });
  const prompt = screen.getByRole('textbox', { name: 'com_media_prompt' });
  expect(prompt).toHaveValue('Keep this long draft');
  expect(prompt).toHaveAttribute('maxlength', '5');
  expect(screen.getByText('com_media_prompt_limit')).toBeVisible();
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeDisabled();
  fireEvent.change(prompt, { target: { value: 'Lake' } });
  expect(screen.queryByText('com_media_prompt_limit')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeEnabled();
});
