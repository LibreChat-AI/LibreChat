import React, { useState } from 'react';
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { render, screen, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import type { TPreset, TModelsConfig } from 'librechat-data-provider';
import { startupConfigKey } from '~/data-provider/Endpoints/queries';
import EditPresetDialog from '../EditPresetDialog';
import store from '~/store';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

let mockContext: {
  preset: TPreset | null;
  setPreset: React.Dispatch<React.SetStateAction<TPreset | null>>;
};

jest.mock('~/Providers', () => ({ useChatContext: () => mockContext }));
jest.mock('~/Providers/ChatContext', () => ({ useChatContext: () => mockContext }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useSetIndexOptions: jest.requireActual('~/hooks/Conversations/useSetIndexOptions').default,
  useDebouncedInput: () => [jest.fn(), mockContext.preset?.title],
}));
jest.mock('~/components/Chat/Input/PopoverButtons', () => () => null);
jest.mock('~/components/Endpoints', () => ({
  EndpointSettings: ({ conversation, setOption }) => (
    <input
      aria-label="Selected model"
      value={conversation.model ?? ''}
      onChange={(event) => setOption('model')(event.target.value)}
    />
  ),
}));

const preset = {
  presetId: 'preset',
  title: 'Selected preset',
  endpoint: EModelEndpoint.openAI,
  model: 'gpt-selected',
} as TPreset;

function setup(initial = preset) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: console.log, warn: console.warn, error: () => {} },
  });
  client.setQueryData([QueryKeys.endpoints], {
    openAI: { order: 0 },
    anthropic: { order: 1 },
  });
  client.setQueryData(startupConfigKey(false), { appTitle: 'Test' });
  const submit = jest.fn();
  const exportPreset = jest.fn();
  function Harness() {
    const [value, setValue] = useState<TPreset | null>(initial);
    mockContext = { preset: value, setPreset: setValue };
    return (
      <EditPresetDialog
        submitPreset={() => submit(value)}
        exportPreset={() => exportPreset(value)}
      />
    );
  }
  render(
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.queriesEnabled, true);
        set(store.presetModalVisible, true);
      }}
    >
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>
    </RecoilRoot>,
  );
  return { client, submit, exportPreset, user: userEvent.setup() };
}

async function switchEndpoint(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox', { name: 'com_endpoint' }));
  await user.click(await screen.findByRole('option', { name: 'Anthropic' }));
}

beforeEach(() => {
  jest
    .spyOn(dataService, 'getModels')
    .mockImplementation(
      async (endpoint): Promise<TModelsConfig> =>
        endpoint === EModelEndpoint.openAI
          ? { openAI: ['gpt-selected'] }
          : { anthropic: ['claude-first', 'claude-picked'] },
    );
});

it('observes scoped model arrivals and saves the destination model after switching endpoints', async () => {
  let resolve!: (data: { anthropic: string[] }) => void;
  jest.spyOn(dataService, 'getModels').mockImplementation((endpoint) =>
    endpoint === EModelEndpoint.openAI
      ? Promise.resolve({ openAI: ['gpt-selected'] })
      : new Promise((done) => {
          resolve = done;
        }),
  );
  const { user, client, submit } = setup();
  await switchEndpoint(user);
  expect(screen.getByLabelText('Selected model')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'com_endpoint_export' })).toBeDisabled();
  await act(async () => resolve({ anthropic: ['claude-first'] }));
  await waitFor(() => expect(screen.getByLabelText('Selected model')).toHaveValue('claude-first'));
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ endpoint: 'anthropic', model: 'claude-first' }),
  );
  expect(client.getQueryData([QueryKeys.models])).toBeUndefined();
});

it('does not overwrite an explicit destination model when its scoped catalog settles', async () => {
  let resolve!: (data: { anthropic: string[] }) => void;
  jest.spyOn(dataService, 'getModels').mockImplementation((endpoint) =>
    endpoint === EModelEndpoint.openAI
      ? Promise.resolve({ openAI: ['gpt-selected'] })
      : new Promise((done) => {
          resolve = done;
        }),
  );
  const { user } = setup();
  await switchEndpoint(user);
  await user.type(screen.getByLabelText('Selected model'), 'claude-picked');
  await act(async () => resolve({ anthropic: ['claude-first', 'claude-picked'] }));
  await waitFor(() => expect(screen.getByLabelText('Selected model')).toHaveValue('claude-picked'));
});

it('does not save an inherited model after destination discovery fails, and recovers on retry', async () => {
  jest.spyOn(dataService, 'getModels').mockImplementation(async (endpoint) => {
    if (endpoint === EModelEndpoint.openAI) return { openAI: ['gpt-selected'] };
    throw Object.assign(new Error('unavailable'), { status: 403 });
  });
  const { user, client, submit } = setup();
  await switchEndpoint(user);
  await waitFor(() =>
    expect(client.getQueryState([QueryKeys.models, 'anthropic'])?.status).toBe('error'),
  );
  expect(screen.getByLabelText('Selected model')).toHaveValue('');
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  expect(submit).not.toHaveBeenCalled();
  jest.spyOn(dataService, 'getModels').mockResolvedValue({ anthropic: ['claude-recovered'] });
  await act(async () => {
    await client.refetchQueries([QueryKeys.models, 'anthropic']);
  });
  await waitFor(() =>
    expect(screen.getByLabelText('Selected model')).toHaveValue('claude-recovered'),
  );
});

it('leaves an empty destination unresolved rather than preserving an inherited model', async () => {
  jest
    .spyOn(dataService, 'getModels')
    .mockImplementation(
      async (endpoint): Promise<TModelsConfig> =>
        endpoint === EModelEndpoint.openAI ? { openAI: ['gpt-selected'] } : { anthropic: [] },
    );
  const { user } = setup();
  await switchEndpoint(user);
  await waitFor(() => expect(dataService.getModels).toHaveBeenCalledWith('anthropic'));
  expect(screen.getByLabelText('Selected model')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeDisabled();
});
