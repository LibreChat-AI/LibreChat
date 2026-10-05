import { dataService, QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { MediaSubmissionReceipt, MediaSubmissionRequest } from 'librechat-data-provider';
import type { MediaDraft, PendingMedia } from '../state';
import {
  clearMediaSessionStorage,
  emptyDraft,
  mediaDraftFamily,
  mediaPendingFamily,
} from '../state';
import { receiptInterval, useMediaCommands } from '../commands';
import { createMediaTestEnvironment } from 'test/media';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, submitMedia: jest.fn(), getMediaSubmission: jest.fn() },
  };
});

const command: Extract<PendingMedia, { kind: 'submission' }> = {
  kind: 'submission',
  draftKey: 'owner:new',
  draftRevision: 3,
  request: {
    schemaVersion: 1,
    clientRequestId: 'request',
    operation: 'image.generate',
    prompt: 'A lake',
    inputs: [],
    parameters: { count: 1 },
    selection: { connectionId: 'connection', modelId: 'model', catalogVersion: 'catalog' },
  },
};
const preparing: MediaSubmissionReceipt = {
  schemaVersion: 1,
  clientRequestId: 'request',
  threadId: 'thread',
  turnId: 'turn',
  jobId: 'job',
  phase: 'preparing',
};

function configuredDraft(overrides: Partial<MediaDraft> = {}): MediaDraft {
  return {
    ...emptyDraft(),
    prompt: 'Make the lake glow at sunset',
    operation: 'image.edit',
    offering: '["connection","image-model"]',
    providerTag: 'provider-a',
    providerOptionsText: '{"watermark":false,"style":"photographic"}',
    parameters: {
      count: 1,
      resolution: '512',
      aspectRatio: '4:3',
      quality: 'low',
      providerOptions: { watermark: false, style: 'photographic' },
    },
    parameterContexts: {
      resolution: { operation: 'image.generate', roles: [] },
      quality: { operation: 'image.edit', roles: ['reference'] },
    },
    temporary: true,
    compare: { offering: '["connection","other-model"]', providerTag: 'provider-b' },
    inputs: [{ role: 'reference', file_id: 'lake-image' }],
    assets: [
      {
        file_id: 'lake-image',
        filename: 'lake.png',
        type: 'image/png',
        bytes: 1024,
        filepath: '/api/media/assets/lake-image/content',
        width: 512,
        height: 512,
      },
    ],
    parentTurnId: 'previous-turn',
    autoEdit: true,
    revision: 3,
    ...overrides,
  };
}

function draftCommand(
  draft: MediaDraft,
  draftKey = 'owner:thread',
): Extract<PendingMedia, { kind: 'submission' }> {
  return {
    ...command,
    draftKey,
    draftRevision: draft.revision,
    request: {
      ...command.request,
      ...(draftKey === 'owner:new' ? {} : { threadId: 'thread' }),
      operation: draft.operation,
      prompt: draft.prompt,
      inputs: draft.inputs,
      parentTurnId: draftKey === 'owner:new' ? undefined : draft.parentTurnId,
      parameters: draft.parameters,
      temporary: draft.temporary,
      selection: {
        connectionId: 'connection',
        modelId: 'image-model',
        catalogVersion: 'catalog',
        providerTag: draft.providerTag,
      },
    },
  };
}

function setup(intervals = { pollIntervalMs: 60000, catchUpIntervalMs: 60000 }) {
  const openThread = jest.fn();
  let active = true;
  const { store, client, wrapper } = createMediaTestEnvironment({
    ...intervals,
    openThread,
    isCurrentSession: () => active,
  });
  return {
    store,
    client,
    wrapper,
    openThread,
    endSession: () => {
      active = false;
    },
  };
}

beforeEach(() => {
  clearMediaSessionStorage();
  jest.resetAllMocks();
});

test.each(['initial', 'follow-up'])(
  'an accepted %s releases request content while preserving the saved generation settings',
  async (kind) => {
    const draft = configuredDraft(
      kind === 'initial'
        ? { operation: 'image.generate', parentTurnId: undefined, autoEdit: false }
        : {},
    );
    const submission = draftCommand(draft, kind === 'initial' ? 'owner:new' : 'owner:thread');
    const accepted = { ...preparing, phase: 'accepted' as const };
    jest.mocked(dataService.submitMedia).mockResolvedValue(accepted);
    jest.mocked(dataService.getMediaSubmission).mockResolvedValue(accepted);
    const env = setup();
    env.store.set(mediaDraftFamily(submission.draftKey), draft);
    const hook = renderHook(() => useMediaCommands(['thread']), { wrapper: env.wrapper });
    await act(async () => {
      await hook.result.current.send(submission);
    });
    await waitFor(() => {
      expect(env.store.get(mediaDraftFamily(submission.draftKey)).prompt).toBe('');
    });
    const saved = env.store.get(mediaDraftFamily(submission.draftKey));
    expect(saved).toMatchObject({
      operation: draft.operation,
      offering: draft.offering,
      providerTag: draft.providerTag,
      providerOptionsText: draft.providerOptionsText,
      parameters: draft.parameters,
      parameterContexts: draft.parameterContexts,
      compare: draft.compare,
      temporary: true,
      inputs: [],
      assets: [],
      revision: 4,
    });
    expect(saved.parentTurnId).toBeUndefined();
    expect(saved.autoEdit).toBeUndefined();
    expect(JSON.parse(sessionStorage.getItem(`librechat:media:${submission.draftKey}`)!)).toEqual(
      saved,
    );
    env.client.clear();
  },
);

test.each(['preparing', 'accepted'] as const)(
  'a direct %s receipt installs submitted settings before opening the new thread',
  async (phase) => {
    const receipt = { ...preparing, phase };
    jest.mocked(dataService.submitMedia).mockResolvedValue(receipt);
    jest.mocked(dataService.getMediaSubmission).mockResolvedValue(receipt);
    const env = setup();
    const draft = configuredDraft();
    const submission = draftCommand(draft, 'owner:new');
    env.store.set(mediaDraftFamily(submission.draftKey), draft);
    let atNavigation: MediaDraft | undefined;
    env.openThread.mockImplementation((threadId: string) => {
      atNavigation = env.store.get(mediaDraftFamily(`owner:${threadId}`));
    });
    const hook = renderHook(() => useMediaCommands([]), { wrapper: env.wrapper });
    await act(async () => {
      await hook.result.current.send(submission);
    });
    expect(env.openThread).toHaveBeenCalledWith('thread');
    expect(atNavigation).toMatchObject({
      offering: draft.offering,
      operation: draft.operation,
      providerTag: draft.providerTag,
      providerOptionsText: draft.providerOptionsText,
      parameters: draft.parameters,
      parameterContexts: draft.parameterContexts,
      compare: draft.compare,
      temporary: true,
      prompt: '',
      inputs: [],
      assets: [],
    });
    expect(atNavigation?.parentTurnId).toBeUndefined();
    expect(atNavigation?.autoEdit).toBeUndefined();
    env.client.clear();
  },
);

test('a recovered accepted receipt installs saved settings without resubmitting the request', async () => {
  jest.mocked(dataService.getMediaSubmission).mockResolvedValue({
    ...preparing,
    phase: 'accepted',
  });
  const env = setup();
  const draft = configuredDraft();
  const submission = draftCommand(draft, 'owner:new');
  env.store.set(mediaDraftFamily(submission.draftKey), draft);
  env.store.set(mediaPendingFamily('owner'), [submission]);
  renderHook(() => useMediaCommands(['thread']), { wrapper: env.wrapper });
  await waitFor(() => expect(env.store.get(mediaPendingFamily('owner'))).toEqual([]));
  expect(env.store.get(mediaDraftFamily('owner:thread'))).toMatchObject({
    offering: draft.offering,
    operation: draft.operation,
    parameters: draft.parameters,
    parameterContexts: draft.parameterContexts,
    providerTag: draft.providerTag,
    providerOptionsText: draft.providerOptionsText,
    compare: draft.compare,
    temporary: true,
    prompt: '',
    inputs: [],
    assets: [],
  });
  expect(dataService.submitMedia).not.toHaveBeenCalled();
  env.client.clear();
});

test.each([1, 2])(
  'receipt recovery replaces implicit defaults but protects an explicit destination at revision %s',
  async (revision) => {
    let recover: (value: MediaSubmissionReceipt) => void = () => {};
    jest.mocked(dataService.getMediaSubmission).mockImplementation(
      () =>
        new Promise((resolve) => {
          recover = resolve;
        }),
    );
    const env = setup();
    const draft = configuredDraft();
    const submission = draftCommand(draft, 'owner:new');
    const destination = {
      ...emptyDraft(),
      offering: '["connection","default-model"]',
      revision,
    };
    env.store.set(mediaDraftFamily(submission.draftKey), draft);
    env.store.set(mediaDraftFamily('owner:thread'), destination);
    env.store.set(mediaPendingFamily('owner'), [submission]);
    renderHook(() => useMediaCommands(['thread']), { wrapper: env.wrapper });
    await waitFor(() => expect(dataService.getMediaSubmission).toHaveBeenCalledTimes(1));
    expect(env.store.get(mediaDraftFamily('owner:thread'))).toEqual(destination);
    await act(async () => {
      recover({ ...preparing, phase: 'accepted' });
    });
    await waitFor(() => expect(env.store.get(mediaPendingFamily('owner'))).toEqual([]));
    const saved = env.store.get(mediaDraftFamily('owner:thread'));
    if (revision === 2) expect(saved).toEqual(destination);
    else {
      expect(saved).toMatchObject({
        offering: draft.offering,
        operation: draft.operation,
        parameters: draft.parameters,
        providerTag: draft.providerTag,
        compare: draft.compare,
      });
    }
    expect(dataService.submitMedia).not.toHaveBeenCalled();
    env.client.clear();
  },
);

test('a late acceptance preserves newer source edits and seeds the destination from the submitted request', async () => {
  let finish: (value: MediaSubmissionReceipt) => void = () => {};
  jest.mocked(dataService.submitMedia).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  jest.mocked(dataService.getMediaSubmission).mockRejectedValue(new Error('not projected yet'));
  const env = setup();
  const draft = configuredDraft();
  const submission = draftCommand(draft, 'owner:new');
  env.store.set(mediaDraftFamily(submission.draftKey), draft);
  const hook = renderHook(() => useMediaCommands(['thread']), { wrapper: env.wrapper });
  let sending: ReturnType<typeof hook.result.current.send>;
  act(() => {
    sending = hook.result.current.send(submission);
  });
  await waitFor(() => expect(dataService.submitMedia).toHaveBeenCalledTimes(1));
  const newer = configuredDraft({
    prompt: 'Keep the lake blue and add a sailboat',
    offering: '["connection","newer-model"]',
    providerTag: 'provider-c',
    providerOptionsText: '{"watermark":true}',
    parameters: { count: 2, resolution: '1K', aspectRatio: '16:9', quality: 'high' },
    compare: { offering: '["connection","newer-compare-model"]', providerTag: 'provider-c' },
    inputs: [{ role: 'reference', file_id: 'newer-image' }],
    assets: [
      {
        ...draft.assets[0],
        file_id: 'newer-image',
        filepath: '/api/media/assets/newer-image/content',
      },
    ],
    parentTurnId: 'newer-turn',
    autoEdit: false,
    revision: 4,
  });
  act(() => env.store.set(mediaDraftFamily(submission.draftKey), newer));
  await act(async () => {
    finish({ ...preparing, phase: 'accepted' });
    await sending;
  });
  await waitFor(() => expect(hook.result.current.pending).toHaveLength(0));
  expect(env.store.get(mediaDraftFamily(submission.draftKey))).toEqual(newer);
  expect(env.store.get(mediaDraftFamily('owner:thread'))).toMatchObject({
    offering: draft.offering,
    operation: submission.request.operation,
    providerTag: submission.request.selection.providerTag,
    parameters: submission.request.parameters,
    temporary: submission.request.temporary,
    prompt: '',
    inputs: [],
    assets: [],
  });
  expect(env.store.get(mediaDraftFamily('owner:thread')).providerOptionsText).toBeUndefined();
  expect(env.store.get(mediaDraftFamily('owner:thread')).compare).toBeUndefined();
  env.client.clear();
});

test.each(['direct', 'recovered'])(
  'a %s receipt cannot overwrite edits already saved in the destination thread',
  async (path) => {
    const accepted = { ...preparing, phase: 'accepted' as const };
    jest.mocked(dataService.submitMedia).mockResolvedValue(accepted);
    jest.mocked(dataService.getMediaSubmission).mockResolvedValue(accepted);
    const env = setup();
    const draft = configuredDraft();
    const submission = draftCommand(draft, 'owner:new');
    const destination = configuredDraft({
      prompt: 'Continue editing the existing thread',
      offering: '["connection","destination-model"]',
      providerTag: 'provider-destination',
      parameters: { count: 2, resolution: '2K', aspectRatio: '16:9' },
      revision: 5,
    });
    env.store.set(mediaDraftFamily(submission.draftKey), draft);
    env.store.set(mediaDraftFamily('owner:thread'), destination);
    if (path === 'recovered') env.store.set(mediaPendingFamily('owner'), [submission]);
    const hook = renderHook(() => useMediaCommands(['thread']), { wrapper: env.wrapper });
    if (path === 'direct') {
      await act(async () => {
        await hook.result.current.send(submission);
      });
    }
    await waitFor(() => expect(env.store.get(mediaPendingFamily('owner'))).toEqual([]));
    expect(env.store.get(mediaDraftFamily('owner:thread'))).toEqual(destination);
    env.client.clear();
  },
);

test('an accepted comparison keeps primary settings when the second model is submitted', async () => {
  jest.mocked(dataService.getMediaSubmission).mockRejectedValue(new Error('not projected yet'));
  const submit = jest.mocked(dataService.submitMedia).mockImplementation(async (request) => ({
    ...preparing,
    clientRequestId: request.clientRequestId,
    turnId: `${request.clientRequestId}-turn`,
    jobId: `${request.clientRequestId}-job`,
    phase: 'accepted',
  }));
  const env = setup();
  const draft = configuredDraft();
  const submission = draftCommand(draft, 'owner:new');
  const following: MediaSubmissionRequest = {
    ...submission.request,
    operation: 'image.edit',
    clientRequestId: 'second-request',
    selection: {
      ...submission.request.selection,
      modelId: 'other-model',
      providerTag: 'provider-b',
    },
    parameters: {
      count: 2,
      resolution: '4K',
      quality: 'high',
      providerOptions: { watermark: true },
    },
  };
  submission.following = following;
  env.store.set(mediaDraftFamily(submission.draftKey), draft);
  const hook = renderHook(() => useMediaCommands(['thread']), { wrapper: env.wrapper });
  await act(async () => {
    await hook.result.current.send(submission);
  });
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(hook.result.current.pending).toHaveLength(0));
  expect(submit.mock.calls.map(([request]) => request.selection.modelId)).toEqual([
    'image-model',
    'other-model',
  ]);
  expect(submit.mock.calls[1][0]).toMatchObject({
    threadId: 'thread',
    parameters: following.parameters,
  });
  expect(env.store.get(mediaDraftFamily('owner:thread'))).toMatchObject({
    offering: draft.offering,
    providerTag: draft.providerTag,
    providerOptionsText: draft.providerOptionsText,
    parameters: draft.parameters,
    compare: draft.compare,
  });
  env.client.clear();
});

test.each(['saved draft', 'newer source'])(
  'a recovered explicit video reference retains parameter provenance with a %s',
  async (source) => {
    const draft = configuredDraft({
      operation: 'video.generate',
      offering: '["connection","video-model"]',
      inputs: [{ role: 'video', file_id: 'previous-video' }],
      assets: [
        {
          file_id: 'previous-video',
          filename: 'previous.mp4',
          filepath: '/api/media/assets/previous-video/content',
          type: 'video/mp4',
          bytes: 2048,
        },
      ],
      parameters: { count: 1, durationSeconds: 7, resolution: '720p', aspectRatio: '16:9' },
      parameterContexts: undefined,
      providerOptionsText: undefined,
      compare: undefined,
    });
    const submission = draftCommand(draft, 'owner:new');
    submission.request.selection.modelId = 'video-model';
    const newer = configuredDraft({ revision: 4, prompt: 'A new image request' });
    const current = source === 'newer source' ? newer : draft;
    jest.mocked(dataService.getMediaSubmission).mockResolvedValue({
      ...preparing,
      phase: 'accepted',
    });
    const env = setup();
    env.store.set(mediaDraftFamily(submission.draftKey), current);
    env.store.set(mediaPendingFamily('owner'), [submission]);
    renderHook(() => useMediaCommands(['thread']), { wrapper: env.wrapper });
    await waitFor(() => expect(env.store.get(mediaPendingFamily('owner'))).toEqual([]));
    const destination = env.store.get(mediaDraftFamily('owner:thread'));
    expect(destination).toMatchObject({
      offering: draft.offering,
      operation: 'video.generate',
      parameters: draft.parameters,
      parameterContexts: {
        count: { operation: 'video.generate', roles: ['video'] },
        durationSeconds: { operation: 'video.generate', roles: ['video'] },
        resolution: { operation: 'video.generate', roles: ['video'] },
        aspectRatio: { operation: 'video.generate', roles: ['video'] },
      },
      inputs: [],
      assets: [],
      prompt: '',
    });
    expect(destination.parentTurnId).toBeUndefined();
    expect(destination.autoEdit).toBeUndefined();
    const saved = env.store.get(mediaDraftFamily(submission.draftKey));
    if (source === 'newer source') expect(saved).toEqual(newer);
    else {
      expect(saved.inputs).toEqual([]);
      expect(saved.parameterContexts?.durationSeconds).toEqual({
        operation: 'video.generate',
        roles: ['video'],
      });
    }
    expect(dataService.submitMedia).not.toHaveBeenCalled();
    env.client.clear();
  },
);

test('a preparing receipt keeps the draft until accepted and does not vanish during projection lag', async () => {
  jest.mocked(dataService.submitMedia).mockResolvedValue(preparing);
  jest.mocked(dataService.getMediaSubmission).mockResolvedValue(preparing);
  const env = setup();
  env.store.set(mediaDraftFamily(command.draftKey), {
    ...emptyDraft(),
    prompt: 'A lake',
    revision: 3,
  });
  const hook = renderHook(({ visible }) => useMediaCommands(visible), {
    wrapper: env.wrapper,
    initialProps: { visible: [] as string[] },
  });
  await act(async () => {
    await hook.result.current.send(command);
  });
  expect(env.store.get(mediaDraftFamily(command.draftKey)).prompt).toBe('A lake');
  expect(env.openThread).toHaveBeenCalledWith('thread');
  expect(hook.result.current.pending).toHaveLength(1);
  act(() =>
    env.client.setQueryData([QueryKeys.mediaSubmission, 'owner', 'request'], {
      ...preparing,
      phase: 'accepted',
    }),
  );
  await waitFor(() => expect(env.store.get(mediaDraftFamily(command.draftKey)).prompt).toBe(''));
  expect(hook.result.current.pending).toHaveLength(1);
  hook.rerender({ visible: ['thread'] });
  await waitFor(() => expect(hook.result.current.pending).toHaveLength(0));
  env.client.clear();
});

test('lost responses retain the same request identity and recovery cannot erase newer draft edits', async () => {
  const submit = jest
    .mocked(dataService.submitMedia)
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValueOnce({ ...preparing, phase: 'accepted' });
  jest.mocked(dataService.getMediaSubmission).mockRejectedValue(new Error('not projected yet'));
  const env = setup();
  const draft = configuredDraft();
  const submission = draftCommand(draft);
  env.store.set(mediaDraftFamily(submission.draftKey), draft);
  const hook = renderHook(() => useMediaCommands([]), { wrapper: env.wrapper });
  await act(async () => {
    await hook.result.current.send(submission);
  });
  expect(hook.result.current.pending[0].request.clientRequestId).toBe('request');
  const newer = configuredDraft({
    prompt: 'Newer lake',
    parameters: { ...draft.parameters, resolution: '1K', quality: 'high' },
    providerOptionsText: '{"watermark":true}',
    revision: 4,
  });
  act(() => env.store.set(mediaDraftFamily(submission.draftKey), newer));
  await act(async () => {
    await hook.result.current.send(hook.result.current.pending[0]);
  });
  expect(submit.mock.calls[0][0]).toEqual(submit.mock.calls[1][0]);
  expect(env.store.get(mediaDraftFamily(submission.draftKey))).toEqual(newer);
  env.client.clear();
});

test('an account change discards a late receipt and leaves the next session cache untouched', async () => {
  let finish: (value: MediaSubmissionReceipt) => void = () => {};
  jest.mocked(dataService.submitMedia).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  jest.mocked(dataService.getMediaSubmission).mockRejectedValue(new Error('pending'));
  const env = setup();
  const hook = renderHook(() => useMediaCommands([]), { wrapper: env.wrapper });
  let sending: ReturnType<typeof hook.result.current.send>;
  act(() => {
    sending = hook.result.current.send(command);
  });
  await waitFor(() => expect(dataService.submitMedia).toHaveBeenCalledTimes(1));
  env.endSession();
  await act(async () => {
    finish({ ...preparing, phase: 'accepted' });
    await sending;
  });
  expect(env.client.getQueryData([QueryKeys.mediaSubmission, 'owner', 'request'])).toBeUndefined();
  expect(env.openThread).not.toHaveBeenCalled();
  env.client.clear();
});

test('a definite validation rejection preserves the draft without an unrecoverable pending command', async () => {
  jest
    .mocked(dataService.submitMedia)
    .mockRejectedValue({ response: { status: 400, data: { error: { code: 'invalid_request' } } } });
  jest.mocked(dataService.getMediaSubmission).mockRejectedValue(new Error('absent'));
  const env = setup();
  const draft = configuredDraft();
  const submission = draftCommand(draft);
  env.store.set(mediaDraftFamily(submission.draftKey), draft);
  const hook = renderHook(() => useMediaCommands([]), { wrapper: env.wrapper });
  await act(async () => {
    await hook.result.current.send(submission);
  });
  expect(env.store.get(mediaPendingFamily('owner'))).toEqual([]);
  expect(env.store.get(mediaDraftFamily(submission.draftKey))).toEqual(draft);
  expect(hook.result.current.error).toBe('invalid_request');
  expect(env.openThread).not.toHaveBeenCalled();
  env.client.clear();
});

test('a rejected receipt preserves the complete editable draft and saved settings', async () => {
  const rejected: MediaSubmissionReceipt = {
    ...preparing,
    phase: 'rejected',
    error: { code: 'invalid_request' },
  };
  jest.mocked(dataService.submitMedia).mockResolvedValue(rejected);
  jest.mocked(dataService.getMediaSubmission).mockResolvedValue(rejected);
  const env = setup();
  const draft = configuredDraft();
  const submission = draftCommand(draft, 'owner:new');
  env.store.set(mediaDraftFamily(submission.draftKey), draft);
  const hook = renderHook(() => useMediaCommands([]), { wrapper: env.wrapper });
  await act(async () => {
    await hook.result.current.send(submission);
  });
  expect(env.store.get(mediaDraftFamily(submission.draftKey))).toEqual(draft);
  expect(hook.result.current.error).toBe('invalid_request');
  expect(env.openThread).not.toHaveBeenCalled();
  env.client.clear();
});

test('sending a rejected draft again makes a new request instead of replaying the rejection', async () => {
  const rejected: MediaSubmissionReceipt = {
    ...preparing,
    phase: 'rejected',
    error: { code: 'quota_exceeded' },
  };
  jest
    .mocked(dataService.submitMedia)
    .mockImplementation(
      async (request): Promise<MediaSubmissionReceipt> =>
        request.clientRequestId === 'request'
          ? rejected
          : { ...preparing, clientRequestId: request.clientRequestId, phase: 'accepted' },
    );
  jest.mocked(dataService.getMediaSubmission).mockResolvedValue(rejected);
  const env = setup();
  const draft = configuredDraft();
  const submission = draftCommand(draft, 'owner:new');
  env.store.set(mediaDraftFamily(submission.draftKey), draft);
  const hook = renderHook(() => useMediaCommands([]), { wrapper: env.wrapper });
  await act(async () => {
    await hook.result.current.send(submission);
  });
  expect(hook.result.current.error).toBe('quota_exceeded');
  const retried = {
    ...submission,
    request: { ...submission.request, clientRequestId: 'second-attempt' },
  };
  await act(async () => {
    await hook.result.current.send(retried);
  });
  expect(jest.mocked(dataService.submitMedia).mock.calls.at(-1)?.[0]).toMatchObject({
    clientRequestId: 'second-attempt',
  });
  expect(
    env.store.get(mediaPendingFamily('owner')).map((item) => item.request.clientRequestId),
  ).toEqual(['second-attempt']);
  env.client.clear();
});

const unknownReceipt = { response: { status: 404, data: { error: { code: 'not_found' } } } };
const intervals = { pollIntervalMs: 10, catchUpIntervalMs: 20 };

test.each([
  ['no receipt and no error', undefined, null, 10],
  ['a preparing receipt', preparing, null, 10],
  ['a settled receipt', { ...preparing, phase: 'accepted' as const }, null, false],
  ['a request the server does not know', undefined, unknownReceipt, false],
  ['an outage', undefined, new Error('offline'), 20],
])('receiptInterval with %s', (_label, data, error, expected) => {
  expect(receiptInterval(data, error, intervals)).toBe(expected);
});

test('a pending request the server does not know stops polling and can be dismissed', async () => {
  const load = jest.mocked(dataService.getMediaSubmission).mockRejectedValue(unknownReceipt);
  const env = setup(intervals);
  env.store.set(mediaPendingFamily('owner'), [command]);
  const hook = renderHook(() => useMediaCommands([]), { wrapper: env.wrapper });
  await waitFor(() => expect(hook.result.current.receipts[0]?.isError).toBe(true));
  jest.useFakeTimers();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(80);
  });
  jest.useRealTimers();
  expect(load).toHaveBeenCalledTimes(1);
  expect(hook.result.current.pending).toHaveLength(1);
  act(() => hook.result.current.dismiss('request'));
  expect(hook.result.current.pending).toEqual([]);
  expect(sessionStorage.getItem('librechat:media:owner:pending')).toBe('[]');
  env.client.clear();
});

test('an outage keeps a pending receipt polling at the catch-up cadence', async () => {
  const load = jest.mocked(dataService.getMediaSubmission).mockRejectedValue(new Error('offline'));
  const env = setup(intervals);
  env.store.set(mediaPendingFamily('owner'), [command]);
  jest.useFakeTimers();
  const hook = renderHook(() => useMediaCommands([]), { wrapper: env.wrapper });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(80);
  });
  expect(load.mock.calls.length).toBeGreaterThanOrEqual(3);
  hook.unmount();
  jest.useRealTimers();
  expect(hook.result.current.pending).toHaveLength(1);
  env.client.clear();
});
