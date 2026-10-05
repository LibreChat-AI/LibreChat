import React from 'react';
import { Provider, createStore } from 'jotai';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MediaSubmissionReceipt } from 'librechat-data-provider';
import {
  clearMediaSessionStorage,
  mediaPendingFamily,
  mediaDraftFamily,
} from '~/components/Media/state';
import { useMediaSessionGuard } from '~/components/Media/session';
import { useMediaCommands } from '~/components/Media/commands';
import { MediaHostProvider } from '~/components/Media/host';
import { runSessionCleanups } from '~/store/session';
import { MediaForm } from '~/components/Media/Form';
import { makeCatalog } from 'test/media';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});
jest.mock('~/components/Input/SetKeyDialog/SetKeyDialog', () => ({
  __esModule: true,
  default: () => null,
}));

const capability = {
  operation: 'image.generate' as const,
  inputs: { min: 0, max: 0, roles: [] },
  execution: { kind: 'direct' as const, previews: false },
  controls: { count: { min: 1, max: 1, default: 1 } },
};
const catalog = makeCatalog({
  version: 'audit',
  offerings: ['model-a', 'model-b'].map((modelId) => ({
    connectionId: 'audit',
    connectionName: 'Audit connection',
    modelId,
    modelName: modelId,
    api: 'openai.images',
    available: true,
    capabilities: [capability],
  })),
});

const clients: QueryClient[] = [];
const recoveryLabel = 'Recover persisted request';
function mount(compare = false) {
  const store = createStore();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  clients.push(client);
  function Harness() {
    const commands = useMediaCommands([]);
    return (
      <>
        <MediaForm catalog={catalog} send={commands.send} busy={commands.sending.size > 0} />
        {commands.pending.length > 0 && (
          <button
            disabled={commands.sending.size > 0}
            onClick={() => void commands.send(commands.pending[0])}
          >
            {recoveryLabel}
          </button>
        )}
      </>
    );
  }
  function Host() {
    const isCurrentSession = useMediaSessionGuard('audit-owner', true);
    return (
      <MediaHostProvider
        value={{
          scope: 'audit-owner',
          canCreate: true,
          pollIntervalMs: 60_000,
          catchUpIntervalMs: 60_000,
          enterToSend: false,
          isCurrentSession,
          openThread: () => {},
          features: { compare },
        }}
      >
        <Harness />
      </MediaHostProvider>
    );
  }
  const view = render(
    <Provider store={store}>
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>
    </Provider>,
  );
  return { ...view, store, client };
}

function lostFirstResponse() {
  const accepted = new Map<string, MediaSubmissionReceipt>();
  const submit = jest.spyOn(dataService, 'submitMedia').mockImplementation(async (request) => {
    let receipt = accepted.get(request.clientRequestId);
    if (!receipt) {
      receipt = {
        schemaVersion: 1,
        phase: 'accepted',
        clientRequestId: request.clientRequestId,
        threadId: 'thread-' + accepted.size,
        turnId: 'turn-' + accepted.size,
        jobId: 'job-' + accepted.size,
      };
      accepted.set(request.clientRequestId, receipt);
      if (accepted.size === 1) throw new Error('Injected lost HTTP response after acceptance');
    }
    return receipt;
  });
  jest
    .spyOn(dataService, 'getMediaSubmission')
    .mockRejectedValue(new Error('Injected lookup outage'));
  return { accepted, submit };
}

beforeEach(() => clearMediaSessionStorage());
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  jest.restoreAllMocks();
});

test('Queue recovers the same accepted identity after a lost response for an unchanged draft', async () => {
  const backend = lostFirstResponse();
  mount();
  const prompt = await screen.findByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.change(prompt, { target: { value: 'Audit lake' } });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(backend.accepted.size).toBe(1));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeEnabled(),
  );
  expect(prompt).toHaveValue('Audit lake');
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(backend.submit).toHaveBeenCalledTimes(2));
  expect(backend.accepted.size).toBe(1);
  const [first, second] = backend.submit.mock.calls.map(([request]) => request);
  expect(first.clientRequestId).toBe(second.clientRequestId);
  expect({ ...first, clientRequestId: '' }).toEqual({ ...second, clientRequestId: '' });
});

test('recovering a comparison resumes its persisted second model after the first lost response', async () => {
  const backend = lostFirstResponse();
  mount(true);
  fireEvent.click(await screen.findByRole('button', { name: 'com_media_compare_add' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'Compare audit lake' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(backend.submit).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Recover persisted request' })).toBeEnabled(),
  );
  expect(backend.submit.mock.calls[0][0].comparisonId).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Recover persisted request' }));
  await waitFor(() => expect(backend.submit).toHaveBeenCalledTimes(3));
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'com_media_prompt' })).toHaveValue(''),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(backend.accepted.size).toBe(2);
  const requests = backend.submit.mock.calls.map(([request]) => request);
  expect(requests[1].clientRequestId).toBe(requests[0].clientRequestId);
  expect(requests.map((request) => request.selection.modelId)).toEqual([
    'model-a',
    'model-a',
    'model-b',
  ]);
  expect(requests[2].threadId).toBe('thread-0');
  expect(requests[2].comparisonId).toBe(requests[0].comparisonId);
});

test('changing an unresolved draft admits a distinct intentional request', async () => {
  const backend = lostFirstResponse();
  mount();
  const prompt = await screen.findByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.change(prompt, { target: { value: 'First lake' } });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(backend.submit).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_media_queue' })).toBeEnabled(),
  );
  fireEvent.change(prompt, { target: { value: 'Revised lake' } });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(backend.accepted.size).toBe(2));
  expect(backend.submit.mock.calls[0][0].clientRequestId).not.toBe(
    backend.submit.mock.calls[1][0].clientRequestId,
  );
});

test('both comparison IDs survive a reload before the first receipt is recovered', async () => {
  const backend = lostFirstResponse();
  const firstView = mount(true);
  fireEvent.click(await screen.findByRole('button', { name: 'com_media_compare_add' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'Persist this comparison' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(backend.submit).toHaveBeenCalledTimes(1));
  const commands = firstView.store.get(mediaPendingFamily('audit-owner'));
  expect(commands).toHaveLength(2);
  const ids = commands.map((command) => command.request.clientRequestId);
  firstView.unmount();
  firstView.client.clear();
  mediaPendingFamily.remove('audit-owner');
  mediaDraftFamily.remove('audit-owner:new');
  const restored = mount(true);
  expect(
    restored.store
      .get(mediaPendingFamily('audit-owner'))
      .map((command) => command.request.clientRequestId),
  ).toEqual(ids);
  fireEvent.click(await screen.findByRole('button', { name: 'Recover persisted request' }));
  await waitFor(() => expect(backend.submit).toHaveBeenCalledTimes(3));
  expect(backend.submit.mock.calls.map(([request]) => request.clientRequestId)).toEqual([
    ids[0],
    ids[0],
    ids[1],
  ]);
  expect(backend.accepted.size).toBe(2);
});

test('an interrupted second member recovers only that member and keeps the draft until both accept', async () => {
  const accepted = new Map<string, MediaSubmissionReceipt>();
  const submit = jest.spyOn(dataService, 'submitMedia').mockImplementation(async (request) => {
    let receipt = accepted.get(request.clientRequestId);
    if (!receipt) {
      receipt = {
        schemaVersion: 1,
        phase: 'accepted',
        clientRequestId: request.clientRequestId,
        threadId: 'comparison-thread',
        turnId: 'turn-' + accepted.size,
        jobId: 'job-' + accepted.size,
      };
      accepted.set(request.clientRequestId, receipt);
      if (request.selection.modelId === 'model-b') throw new Error('Lost second response');
    }
    return receipt;
  });
  jest.spyOn(dataService, 'getMediaSubmission').mockRejectedValue(new Error('Receipt outage'));
  mount(true);
  fireEvent.click(await screen.findByRole('button', { name: 'com_media_compare_add' }));
  const prompt = screen.getByRole('textbox', { name: 'com_media_prompt' });
  fireEvent.change(prompt, { target: { value: 'Keep partial comparison' } });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Recover persisted request' })).toBeEnabled(),
  );
  expect(prompt).toHaveValue('Keep partial comparison');
  fireEvent.click(screen.getByRole('button', { name: 'Recover persisted request' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
  expect(submit.mock.calls.map(([request]) => request.selection.modelId)).toEqual([
    'model-a',
    'model-b',
    'model-b',
  ]);
  expect(submit.mock.calls[2][0].clientRequestId).toBe(submit.mock.calls[1][0].clientRequestId);
  await waitFor(() => expect(prompt).toHaveValue(''));
  expect(accepted.size).toBe(2);
});

test('a first comparison receipt cannot dispatch the second member after synchronous logout cleanup', async () => {
  let accept!: (receipt: MediaSubmissionReceipt) => void;
  const submit = jest.spyOn(dataService, 'submitMedia').mockImplementation(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  jest.spyOn(dataService, 'getMediaSubmission').mockRejectedValue(new Error('Receipt outage'));
  mount(true);
  fireEvent.click(await screen.findByRole('button', { name: 'com_media_compare_add' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'com_media_prompt' }), {
    target: { value: 'Comparison at logout' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_media_queue' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  await act(async () => {
    runSessionCleanups();
    accept({
      schemaVersion: 1,
      phase: 'accepted',
      clientRequestId: submit.mock.calls[0][0].clientRequestId,
      threadId: 'comparison-thread',
      turnId: 'first-turn',
      jobId: 'first-job',
    });
  });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem('librechat:media:audit-owner:pending')).toBeNull();
});
