import React, { useState } from 'react';
import { Provider, createStore } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, mediaSubmissionRequestSchema, QueryKeys } from 'librechat-data-provider';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  MediaAsset,
  MediaCatalog,
  MediaThreadDetail,
  MediaTurn,
  MediaSubmissionReceipt,
} from 'librechat-data-provider';
import type { MediaHost } from '../host';
import { clearMediaSessionStorage, mediaDraftFamily, mediaLibraryFamily } from '../state';
import { MediaSettingsContent } from '../Panel';
import { MediaHostProvider } from '../host';
import MediaWorkspace from '../Workspace';
import { makeCatalog } from 'test/media';
import { useMediaHost } from '../host';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: { count?: number }) =>
    values?.count == null ? key : key + ':' + values.count,
}));
jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

const catalog = makeCatalog({
  offerings: [
    {
      connectionId: 'provider',
      connectionName: 'Image provider',
      modelId: 'image-model',
      modelName: 'Image model',
      api: 'openai.images',
      available: true,
      capabilities: [
        {
          operation: 'image.generate',
          inputs: { min: 0, max: 0, roles: [] },
          execution: { kind: 'direct', previews: false },
          controls: { count: { min: 1, max: 2, default: 1 } },
        },
      ],
    },
  ],
});
const selection = { connectionId: 'provider', modelId: 'image-model', catalogVersion: 'catalog' };
const createdAt = '2026-09-17T12:00:00.000Z';
const turn = (sequence: number): MediaTurn => ({
  schemaVersion: 1,
  threadId: 'thread',
  turnId: 'turn-' + sequence,
  version: 1,
  kind: 'generation',
  sequence,
  createdAt,
  prompt: 'Prompt ' + sequence,
  inputs: [],
  assets: [],
  operation: 'image.generate',
  selection,
  jobs: [
    {
      schemaVersion: 1,
      threadId: 'thread',
      turnId: 'turn-' + sequence,
      jobId: 'job-' + sequence,
      version: 1,
      phase: 'succeeded',
      executionOwner: 'media',
      operation: 'image.generate',
      selection,
      createdAt,
      updatedAt: createdAt,
      allowedActions: { cancel: false, retry: false },
      outputs: [
        { kind: 'text', ordinal: 0, outputId: 'output-' + sequence, text: 'Result ' + sequence },
      ],
    },
  ],
});
const detail: MediaThreadDetail = {
  thread: {
    schemaVersion: 1,
    threadId: 'thread',
    title: 'Paper boats',
    version: 1,
    createdAt,
    updatedAt: createdAt,
    pendingJobCount: 0,
    turnCount: 2,
  },
  turns: { items: [turn(2), turn(1)] },
};

const imageAsset = (sequence: number): MediaAsset => ({
  file_id: 'image-' + sequence,
  filename: 'image-' + sequence + '.png',
  filepath: '/images/image-' + sequence + '.png',
  type: 'image/png',
  bytes: 100,
});
const imageTurn = (sequence: number): MediaTurn => {
  const result = turn(sequence);
  return {
    ...result,
    jobs: [
      {
        ...result.jobs[0],
        outputs: [
          {
            kind: 'image',
            outputId: 'output-' + sequence,
            ordinal: 0,
            state: 'ready',
            asset: imageAsset(sequence),
          },
        ],
      },
    ],
  };
};
const imageCatalog = (): MediaCatalog => ({
  ...catalog,
  offerings: [
    {
      ...catalog.offerings[0],
      capabilities: [
        ...catalog.offerings[0].capabilities,
        {
          operation: 'image.edit',
          inputs: { min: 1, max: 4, roles: ['reference'] },
          execution: { kind: 'direct', previews: false },
          controls: { count: { min: 1, max: 2, default: 1 } },
        },
      ],
    },
  ],
});

const videoCatalog = (): MediaCatalog => ({
  ...catalog,
  offerings: [
    {
      ...catalog.offerings[0],
      api: 'google.vertex.videos',
      capabilities: [
        {
          operation: 'video.generate',
          inputs: { min: 0, max: 1, roles: ['video'] },
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
const videoTurn = (): MediaTurn => {
  const result = turn(1);
  return {
    ...result,
    operation: 'video.generate',
    jobs: [
      {
        ...result.jobs[0],
        operation: 'video.generate',
        outputs: [
          {
            kind: 'video',
            outputId: 'video-output',
            ordinal: 0,
            state: 'ready',
            asset: {
              file_id: 'video',
              filename: 'video.mp4',
              filepath: '/video.mp4',
              type: 'video/mp4',
              bytes: 100,
            },
          },
        ],
      },
    ],
  };
};

const header = () => within(screen.getByRole('banner'));
function Settings({ threadId }: { threadId?: string }) {
  const host = useMediaHost();
  return <MediaSettingsContent host={host} threadId={threadId} />;
}
function Harness({
  initialThread,
  embedded = false,
  features,
  navigate,
}: {
  initialThread?: string;
  embedded?: boolean;
  features?: MediaHost['features'];
  navigate?: (id: string, commit: () => void) => void;
}) {
  const [threadId, setThreadId] = useState(initialThread);
  return (
    <MediaHostProvider
      value={{
        scope: 'owner',
        canCreate: true,
        pollIntervalMs: 5000,
        catchUpIntervalMs: 60000,
        enterToSend: false,
        isCurrentSession: () => true,
        useInChat: async () => {},
        openThread: (id) => {
          const commit = () => setThreadId(id || undefined);
          if (navigate) navigate(id, commit);
          else commit();
        },
        features,
      }}
    >
      {!embedded && (
        <aside aria-label="Studio sidebar">
          <Settings threadId={threadId} />
        </aside>
      )}
      <MediaWorkspace threadId={threadId} settingsToggle={embedded ? undefined : <span />} />
    </MediaHostProvider>
  );
}
const clients: QueryClient[] = [];
function mount(
  props: {
    initialThread?: string;
    embedded?: boolean;
    features?: MediaHost['features'];
    navigate?: (id: string, commit: () => void) => void;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 } },
    logger: { log: console.log, warn: console.warn, error: jest.fn() },
  });
  clients.push(client);
  return render(
    <Provider store={createStore()}>
      <QueryClientProvider client={client}>
        <Harness {...props} />
      </QueryClientProvider>
    </Provider>,
  );
}
beforeEach(() => {
  clearMediaSessionStorage();
  jest.spyOn(dataService, 'getMediaCatalog').mockResolvedValue(catalog);
  jest.spyOn(dataService, 'listMediaThreads').mockResolvedValue({ items: [detail.thread] });
  jest.spyOn(dataService, 'getMediaThread').mockResolvedValue(detail);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

test('keeps parameters in the sidebar and restores the prompt and gallery density after browsing and reload', async () => {
  const view = mount();
  const prompt = await screen.findByRole('textbox', { name: 'com_media_prompt' });
  const sidebar = within(screen.getByRole('complementary', { name: 'Studio sidebar' }));
  expect(sidebar.getByRole('combobox', { name: 'com_media_connection' })).toHaveTextContent(
    'Image provider',
  );
  expect(sidebar.queryByRole('textbox', { name: 'com_media_prompt' })).not.toBeInTheDocument();
  fireEvent.change(prompt, { target: { value: 'A paper boat on a lake' } });
  fireEvent.click(header().getByRole('button', { name: 'com_media_open_gallery' }));
  await screen.findByRole('heading', { name: 'com_media_gallery' });
  expect(
    header().queryByRole('button', { name: 'com_media_open_gallery' }),
  ).not.toBeInTheDocument();
  expect(header().getAllByRole('button', { name: 'com_media_new_thread' })).toHaveLength(1);
  expect(prompt).not.toBeVisible();
  const density = within(screen.getByRole('radiogroup', { name: 'com_media_columns' }));
  for (const columns of [2, 3, 4]) {
    const option = density.getByRole('radio', { name: String(columns) });
    fireEvent.click(option);
    expect(option).toHaveAttribute('aria-checked', 'true');
    expect(document.querySelector('[data-testid="media-gallery"]')).toHaveAttribute(
      'data-columns',
      String(columns),
    );
  }
  fireEvent.click(header().getByRole('button', { name: 'com_media_new_thread' }));
  expect(prompt).toBeVisible();
  expect(prompt).toHaveValue('A paper boat on a lake');
  fireEvent.click(header().getByRole('button', { name: 'com_media_open_gallery' }));
  view.unmount();
  mediaLibraryFamily.remove('owner');
  mediaDraftFamily.remove('owner:new');
  mount();
  await screen.findByRole('heading', { name: 'com_media_gallery' });
  expect(screen.getByRole('radio', { name: '4' })).toHaveAttribute('aria-checked', 'true');
  await waitFor(() =>
    expect(
      within(screen.getByTestId('media-composer')).getByRole('textbox', { hidden: true }),
    ).toHaveValue('A paper boat on a lake'),
  );
  fireEvent.click(header().getByRole('button', { name: 'com_media_new_thread' }));
  expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue(
    'A paper boat on a lake',
  );
});

test('creates an independent draft from a result without carrying the source thread identity', async () => {
  jest.mocked(dataService.getMediaCatalog).mockResolvedValue(imageCatalog());
  jest
    .mocked(dataService.getMediaThread)
    .mockResolvedValue({ ...detail, turns: { items: [imageTurn(1)] } });
  mount({ initialThread: 'thread' });
  const action = await screen.findByRole('button', { name: 'com_media_create_from_result' });
  fireEvent.click(action);
  await waitFor(() =>
    expect(header().getByRole('button', { name: 'com_media_open_gallery' })).toBeVisible(),
  );
  const prompt = await screen.findByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.change(prompt, { target: { value: 'A different composition' } });
  const submit = jest.spyOn(dataService, 'submitMedia').mockResolvedValue({
    schemaVersion: 1,
    phase: 'accepted',
    clientRequestId: 'new',
    threadId: 'new-thread',
    turnId: 'new-turn',
    jobId: 'new-job',
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(submit).toHaveBeenCalled());
  expect(submit.mock.calls[0][0]).toMatchObject({
    operation: 'image.edit',
    prompt: 'A different composition',
    inputs: [{ file_id: 'image-1', role: 'reference' }],
  });
  expect(submit.mock.calls[0][0]).not.toHaveProperty('threadId', 'thread');
  expect(submit.mock.calls[0][0].parentTurnId).toBeUndefined();
});

test.each(['image', 'video'] as const)(
  'a long thread uses authoritative latest %s context beyond the current page',
  async (kind) => {
    const choices = imageCatalog();
    if (kind === 'video')
      choices.offerings[0].capabilities = [
        {
          operation: 'video.generate',
          inputs: { roles: ['video'], min: 0, max: 1 },
          execution: { kind: 'remote-job', cancellation: 'unsupported' },
          controls: { count: { min: 1, max: 1 } },
        },
      ];
    const context = {
      turnId: 'turn-2',
      asset: {
        ...imageAsset(2),
        file_id: `${kind}-2`,
        type: kind === 'image' ? 'image/png' : 'video/mp4',
      },
    };
    jest.mocked(dataService.getMediaCatalog).mockResolvedValue(choices);
    jest.mocked(dataService.getMediaThread).mockResolvedValue({
      ...detail,
      thread: { ...detail.thread, turnCount: 30 },
      turns: {
        items: Array.from({ length: 24 }, (_, index) => turn(30 - index)),
        nextCursor: 'older',
      },
      ...(kind === 'image' ? { latestImageContext: context } : { latestVideoContext: context }),
    });
    jest.spyOn(dataService, 'getMediaSubmission').mockRejectedValue(new Error('Not published'));
    const submit = jest.spyOn(dataService, 'submitMedia').mockResolvedValue({
      schemaVersion: 1,
      phase: 'accepted',
      clientRequestId: 'context-request',
      threadId: 'thread',
      turnId: 'turn-31',
      jobId: 'job-31',
    });
    mount({ initialThread: 'thread' });
    const prompt = await screen.findByRole('textbox', { name: 'com_media_prompt' });
    fireEvent.change(prompt, { target: { value: 'Use the latest completed image' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toMatchObject({
      operation: kind === 'image' ? 'image.edit' : 'video.generate',
      parentTurnId: 'turn-2',
      inputs: [{ role: kind === 'image' ? 'reference' : 'video', file_id: `${kind}-2` }],
    });
  },
);

test('expired video context blocks a fresh generation until the user explicitly starts one', async () => {
  const previous = videoTurn();
  const output = previous.jobs[0].outputs[0];
  if (output.kind !== 'video' || !output.asset) throw new Error('Expected a video fixture');
  const restored: MediaThreadDetail = {
    ...detail,
    turns: { items: [previous] },
    latestVideoContext: { turnId: previous.turnId, asset: output.asset },
  };
  jest.mocked(dataService.getMediaCatalog).mockResolvedValue(videoCatalog());
  jest.mocked(dataService.getMediaThread).mockResolvedValue(restored);
  const submit = jest.spyOn(dataService, 'submitMedia').mockResolvedValue({
    schemaVersion: 1,
    phase: 'accepted',
    clientRequestId: 'fresh-video',
    threadId: 'thread',
    turnId: 'fresh-turn',
    jobId: 'fresh-job',
  });
  mount({ initialThread: 'thread' });
  await screen.findByText('com_media_using_latest_video');
  const prompt = screen.getByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.change(prompt, { target: { value: 'Continue the scene' } });
  expect(screen.getByRole('combobox', { name: 'com_media_duration_seconds' })).toHaveTextContent(
    '7',
  );
  jest.mocked(dataService.getMediaThread).mockResolvedValue({
    ...restored,
    latestVideoContext: null,
  });
  await act(async () => {
    await clients[0].invalidateQueries([QueryKeys.mediaThread, 'owner', 'thread']);
  });
  expect(await screen.findByText('com_media_video_reference_unavailable')).toBeVisible();
  expect(screen.queryByText('com_media_using_latest_video')).not.toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'com_media_references' })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'com_media_duration_seconds' })).toHaveTextContent(
    '4',
  );
  expect(prompt).toHaveValue('Continue the scene');
  const generate = screen.getByRole('button', { name: 'com_media_queue' });
  expect(generate).toBeDisabled();
  fireEvent.click(generate);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_start_new_video' }));
  expect(generate).toBeEnabled();
  fireEvent.click(generate);
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0][0]).toMatchObject({
    operation: 'video.generate',
    inputs: [],
    parameters: { durationSeconds: 4 },
  });
  expect(submit.mock.calls[0][0].parentTurnId).toBeUndefined();
});

test.each(['legacy', 'empty'] as const)(
  'video context from a %s thread preserves the appropriate generation mode',
  async (mode) => {
    jest.mocked(dataService.getMediaCatalog).mockResolvedValue(videoCatalog());
    jest.mocked(dataService.getMediaThread).mockResolvedValue({
      ...detail,
      turns: { items: mode === 'legacy' ? [videoTurn()] : [] },
      ...(mode === 'empty' ? { latestVideoContext: null } : {}),
    });
    mount({ initialThread: 'thread' });
    const prompt = await screen.findByRole('textbox', { name: 'com_media_prompt' });
    fireEvent.change(prompt, { target: { value: 'A video request' } });
    expect(screen.queryByText('com_media_video_reference_unavailable')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'com_media_duration_seconds' })).toHaveTextContent(
      mode === 'legacy' ? '7' : '4',
    );
    if (mode === 'legacy') expect(screen.getByText('com_media_using_latest_video')).toBeVisible();
    else expect(screen.queryByText('com_media_using_latest_video')).not.toBeInTheDocument();
  },
);

test('focuses the destination composer after deferred navigation replaces the old thread', async () => {
  let commitNavigation: (() => void) | undefined;
  const frames: FrameRequestCallback[] = [];
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  mount({
    initialThread: 'thread',
    navigate: (_id, commit) => {
      commitNavigation = commit;
    },
  });
  await screen.findByText('Result 2');
  const originalPrompt = screen.getByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.click(header().getByRole('button', { name: 'com_media_open_gallery' }));
  const create = header().getByRole('button', { name: 'com_media_new_thread' });
  create.focus();
  fireEvent.click(create);
  act(() => frames.splice(0).forEach((callback) => callback(0)));
  expect(originalPrompt).not.toHaveFocus();
  act(() => commitNavigation?.());
  act(() => frames.splice(0).forEach((callback) => callback(0)));
  const nextPrompt = screen.getByRole('textbox', { name: 'com_media_prompt' });
  expect(nextPrompt).not.toBe(originalPrompt);
  expect(nextPrompt).toHaveFocus();
});

test('preserves older saved filters while applying the new gallery defaults', async () => {
  sessionStorage.setItem(
    'librechat:media:owner:library',
    JSON.stringify({ filter: 'pending', search: 'boats' }),
  );
  mount();
  await screen.findByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.click(header().getByRole('button', { name: 'com_media_open_gallery' }));
  expect(screen.getByRole('button', { name: 'com_media_filter_pending' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByRole('searchbox', { name: 'com_media_search' })).toHaveValue('boats');
  expect(screen.getByRole('radio', { name: '2' })).toHaveAttribute('aria-checked', 'true');
});

test('shows a saved thread chronologically and returns to that thread when its gallery card is selected', async () => {
  mount({ initialThread: 'thread' });
  await screen.findByText('Result 2');
  expect(dataService.listMediaThreads).not.toHaveBeenCalled();
  const requests = screen.getAllByRole('group', { name: 'com_media_request' });
  expect(requests.map((request) => within(request).getByText(/^Prompt/).textContent)).toEqual([
    'Prompt 1',
    'Prompt 2',
  ]);
  const prompt = screen.getByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.change(prompt, { target: { value: 'Make the boat blue' } });
  fireEvent.click(header().getByRole('button', { name: 'com_media_open_gallery' }));
  fireEvent.click(await screen.findByRole('button', { name: 'com_media_open_named' }));
  expect(dataService.listMediaThreads).toHaveBeenCalled();
  expect(screen.getByText('Result 2')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue(
    'Make the boat blue',
  );
});

test('gallery deletion confirms one creation and clears cancelled errors before another attempt', async () => {
  const other = { ...detail.thread, threadId: 'other', title: 'Other creation' };
  jest.mocked(dataService.listMediaThreads).mockResolvedValue({ items: [detail.thread, other] });
  const remove = jest
    .spyOn(dataService, 'deleteMediaThreads')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ retired: 1, failures: [] });
  mount();
  await screen.findByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.click(header().getByRole('button', { name: 'com_media_open_gallery' }));
  const gallery = within(await screen.findByTestId('media-gallery'));
  const [first, second] = await gallery.findAllByRole('listitem');
  const deleteSecond = within(second).getByRole('button', { name: 'com_media_delete_named' });
  deleteSecond.focus();
  fireEvent.click(deleteSecond);
  const dialog = await screen.findByRole('dialog', { name: 'com_media_delete_title' });
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByText('com_media_gallery')).toBeVisible();
  fireEvent.click(within(dialog).getByRole('button', { name: 'com_ui_delete' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'com_media_error_internal_error',
  );
  expect(remove).toHaveBeenLastCalledWith({ mode: 'selected', threadIds: ['other'] });
  fireEvent.click(within(dialog).getByRole('button', { name: 'com_ui_cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(deleteSecond).toHaveFocus();
  fireEvent.click(within(first).getByRole('button', { name: 'com_media_delete_named' }));
  const nextDialog = await screen.findByRole('dialog', { name: 'com_media_delete_title' });
  expect(within(nextDialog).queryByRole('alert')).not.toBeInTheDocument();
  expect(remove).toHaveBeenCalledTimes(1);
  fireEvent.click(within(nextDialog).getByRole('button', { name: 'com_ui_cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(within(second).getByRole('button', { name: 'com_media_delete_named' }));
  jest.mocked(dataService.listMediaThreads).mockResolvedValue({ items: [detail.thread] });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_delete' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(remove).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenLastCalledWith({ mode: 'selected', threadIds: ['other'] });
  await waitFor(() => expect(gallery.getAllByRole('listitem')).toHaveLength(1));
  expect(gallery.getByText(detail.thread.title)).toBeVisible();
});

test('keeps the composer usable around the embedded settings dialog', async () => {
  mount({ embedded: true });
  const prompt = await screen.findByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.change(prompt, { target: { value: 'A miniature landscape' } });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_settings' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('combobox', { name: 'com_media_connection' })).toBeVisible();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue(
    'A miniature landscape',
  );
});

test('recovers a catalog failure without leaving the workspace', async () => {
  jest.mocked(dataService.getMediaCatalog).mockRejectedValueOnce(new Error('Unavailable'));
  mount();
  const sidebar = within(screen.getByRole('complementary', { name: 'Studio sidebar' }));
  await sidebar.findByText('com_media_load_failed');
  fireEvent.click(sidebar.getByRole('button', { name: 'com_ui_retry' }));
  expect(await screen.findByRole('textbox', { name: 'com_media_prompt' })).toBeVisible();
});

test('continues a saved image through consecutive prompt-only edits', async () => {
  let current: MediaThreadDetail = {
    ...detail,
    turns: { items: [turn(2), imageTurn(1)] },
  };
  const receipts = new Map<string, MediaSubmissionReceipt>();
  jest.mocked(dataService.getMediaCatalog).mockResolvedValue(imageCatalog());
  jest.mocked(dataService.getMediaThread).mockImplementation(async () => current);
  jest.spyOn(dataService, 'getMediaSubmission').mockImplementation(async (id) => {
    const receipt = receipts.get(id);
    if (!receipt) throw new Error('Unexpected receipt');
    return receipt;
  });
  const submit = jest.spyOn(dataService, 'submitMedia').mockImplementation(async (body) => {
    const request = mediaSubmissionRequestSchema.parse(body);
    const sequence = current.thread.turnCount + 1;
    const next = imageTurn(sequence);
    next.prompt = request.prompt;
    next.operation = request.operation;
    next.selection = request.selection;
    next.parentTurnId = request.parentTurnId;
    next.inputs = request.inputs;
    next.assets = request.inputs.map((input) => imageAsset(Number(input.file_id.slice(6))));
    next.jobs[0] = {
      ...next.jobs[0],
      operation: request.operation,
      selection: request.selection,
    };
    current = {
      ...current,
      thread: { ...current.thread, version: current.thread.version + 1, turnCount: sequence },
      turns: { items: [next, ...current.turns.items] },
    };
    const receipt: MediaSubmissionReceipt = {
      schemaVersion: 1,
      phase: 'accepted',
      clientRequestId: request.clientRequestId,
      threadId: 'thread',
      turnId: next.turnId,
      jobId: next.jobs[0].jobId,
    };
    receipts.set(request.clientRequestId, receipt);
    return receipt;
  });
  mount({ initialThread: 'thread' });
  const prompt = await screen.findByRole('textbox', { name: 'com_media_prompt' });
  const composer = within(screen.getByRole('region', { name: 'com_media_create' }));
  expect(composer.getByText('com_media_editing_latest')).toBeVisible();
  expect(composer.getByRole('img')).toHaveAttribute('src', imageAsset(1).filepath);

  for (const [index, text] of ['Make the boat red', 'Now make the background gray'].entries()) {
    fireEvent.change(prompt, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(index + 1));
    const parent = index === 0 ? 1 : 3;
    expect(submit.mock.calls[index][0]).toMatchObject({
      threadId: 'thread',
      parentTurnId: 'turn-' + parent,
      operation: 'image.edit',
      prompt: text,
      selection,
      inputs: [{ role: 'reference', file_id: 'image-' + parent }],
    });
    await waitFor(() => expect(prompt).toHaveValue(''));
    await waitFor(() =>
      expect(composer.getByRole('img')).toHaveAttribute('src', imageAsset(index + 3).filepath),
    );
  }
  expect(submit.mock.calls[0][0].inputs).toEqual([{ role: 'reference', file_id: 'image-1' }]);
});

test('removing the automatic image starts fresh and preserves that choice and the prompt on reload', async () => {
  jest.mocked(dataService.getMediaCatalog).mockResolvedValue(imageCatalog());
  jest
    .mocked(dataService.getMediaThread)
    .mockResolvedValue({ ...detail, turns: { items: [imageTurn(1)] } });
  const view = mount({ initialThread: 'thread' });
  const prompt = await screen.findByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.change(prompt, { target: { value: 'A different subject' } });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_remove_reference' }));
  expect(screen.queryByText('com_media_editing_latest')).not.toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'com_media_image' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  view.unmount();
  mediaDraftFamily.remove('owner:thread');
  mount({ initialThread: 'thread' });
  expect(await screen.findByRole('textbox', { name: 'com_media_prompt' })).toHaveValue(
    'A different subject',
  );
  expect(screen.queryByText('com_media_editing_latest')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: 'com_ui_edit' }));
  expect(screen.getByText('com_media_editing_latest')).toBeVisible();
  fireEvent.click(screen.getByRole('radio', { name: 'com_media_image' }));
  expect(screen.queryByText('com_media_editing_latest')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue(
    'A different subject',
  );
});

test('the sidebar offers history while creating and a new creation while browsing', async () => {
  mount({ initialThread: 'thread' });
  await screen.findByText('Result 2');
  const sidebar = () => within(screen.getByRole('complementary', { name: 'Studio sidebar' }));
  expect(sidebar().queryByRole('button', { name: 'com_media_new_thread' })).not.toBeInTheDocument();
  fireEvent.click(sidebar().getByRole('button', { name: 'com_media_open_gallery' }));
  await screen.findByRole('heading', { name: 'com_media_gallery' });
  expect(
    sidebar().queryByRole('button', { name: 'com_media_open_gallery' }),
  ).not.toBeInTheDocument();
  fireEvent.click(sidebar().getByRole('button', { name: 'com_media_new_thread' }));
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: 'com_media_gallery' })).not.toBeInTheDocument(),
  );
  expect(screen.getByRole('heading', { name: 'com_media_welcome' })).toBeVisible();
  expect(sidebar().getByRole('button', { name: 'com_media_open_gallery' })).toBeInTheDocument();
});

test('a command error stays with the thread it came from', async () => {
  jest
    .spyOn(dataService, 'submitMedia')
    .mockRejectedValue({ response: { status: 400, data: { error: { code: 'invalid_request' } } } });
  mount({ initialThread: 'thread' });
  const prompt = await screen.findByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.change(prompt, { target: { value: 'A rejected prompt' } });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('com_media_error_invalid_request');
  const sidebar = within(screen.getByRole('complementary', { name: 'Studio sidebar' }));
  fireEvent.click(sidebar.getByRole('button', { name: 'com_media_open_gallery' }));
  await screen.findByRole('heading', { name: 'com_media_gallery' });
  fireEvent.click(sidebar.getByRole('button', { name: 'com_media_new_thread' }));
  expect(await screen.findByRole('heading', { name: 'com_media_welcome' })).toBeVisible();
  expect(screen.queryByText('com_media_error_invalid_request')).not.toBeInTheDocument();
});

test('temporary creations are a header toggle for new work only and mark the draft', async () => {
  mount({ features: { temporary: true } });
  await screen.findByRole('textbox', { name: 'com_media_prompt' });
  const toggle = header().getByRole('button', { name: 'com_media_temporary_creation' });
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(screen.queryByText('com_media_temporary_hint')).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('com_media_temporary_hint')).toBeVisible();
  fireEvent.click(header().getByRole('button', { name: 'com_media_open_gallery' }));
  await screen.findByRole('heading', { name: 'com_media_gallery' });
  expect(
    header().queryByRole('button', { name: 'com_media_temporary_creation' }),
  ).not.toBeInTheDocument();
});

test('a pending request the server does not know can be recovered or dismissed', async () => {
  sessionStorage.setItem(
    'librechat:media:owner:pending',
    JSON.stringify([
      {
        kind: 'submission',
        draftKey: 'owner:new',
        draftRevision: 1,
        request: {
          schemaVersion: 1,
          clientRequestId: 'lost',
          operation: 'image.generate',
          prompt: 'A lost boat',
          inputs: [],
          parameters: { count: 1 },
          selection,
        },
      },
    ]),
  );
  jest
    .spyOn(dataService, 'getMediaSubmission')
    .mockRejectedValue({ response: { status: 404, data: { error: { code: 'not_found' } } } });
  mount();
  await screen.findByRole('textbox', { name: 'com_media_prompt' });
  const recovery = () => within(screen.getByRole('region', { name: 'com_media_recovery' }));
  expect(await screen.findByText('com_media_uncertain')).toBeInTheDocument();
  expect(recovery().getByRole('button', { name: 'com_media_recover_request' })).toBeEnabled();
  fireEvent.click(recovery().getByRole('button', { name: 'com_ui_dismiss' }));
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'com_media_recovery' })).not.toBeInTheDocument(),
  );
  expect(sessionStorage.getItem('librechat:media:owner:pending')).toBe('[]');
});

test('an empty library offers a first creation and returns to its composer', async () => {
  jest.mocked(dataService.listMediaThreads).mockResolvedValue({ items: [] });
  mount();
  await screen.findByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.click(header().getByRole('button', { name: 'com_media_open_gallery' }));
  expect(await screen.findByText('com_media_empty_title')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_create' }));
  expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toBeVisible();
});

test('an unavailable thread offers retry and recovers its composer', async () => {
  jest.mocked(dataService.getMediaThread).mockRejectedValueOnce(new Error('Unavailable'));
  mount({ initialThread: 'thread' });
  const alert = await within(screen.getByTestId('media-workspace')).findByRole('alert');
  expect(alert).toHaveTextContent('com_media_thread_unavailable');
  fireEvent.click(within(alert).getByRole('button', { name: 'com_ui_retry' }));
  expect(await screen.findByRole('textbox', { name: 'com_media_prompt' })).toBeVisible();
});

test.each([403, 404])(
  'an unavailable thread (%s) stops polling and still permits a new creation',
  async (status) => {
    const load = jest
      .mocked(dataService.getMediaThread)
      .mockRejectedValue({ response: { status } });
    const view = mount({ initialThread: 'thread' });
    expect(
      await within(screen.getByTestId('media-workspace')).findByRole('alert'),
    ).toHaveTextContent('com_media_thread_unavailable');
    const calls = load.mock.calls.length;
    jest.useFakeTimers();
    try {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(120000);
      });
      expect(load).toHaveBeenCalledTimes(calls);
      fireEvent.click(header().getByRole('button', { name: 'com_media_new_thread' }));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toBeVisible();
    } finally {
      view.unmount();
      jest.useRealTimers();
    }
  },
);

test.each([false, true])(
  'expiry preserves explicit temporary=%s for labels and chat attachment',
  async (temporary) => {
    jest.mocked(dataService.getMediaThread).mockResolvedValue({
      ...detail,
      thread: { ...detail.thread, temporary, expiresAt: '2099-09-20T00:00:00.000Z' },
      turns: { items: [imageTurn(1)] },
    });
    mount({ initialThread: 'thread' });
    const attach = await screen.findByRole('button', { name: 'com_media_use_chat' });
    if (temporary) {
      expect(attach).toBeDisabled();
      expect(screen.getByText(/com_media_temporary_creation/)).toBeVisible();
    } else {
      expect(attach).toBeEnabled();
      expect(screen.queryByText(/com_media_temporary_creation/)).not.toBeInTheDocument();
    }
  },
);
