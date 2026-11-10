import React from 'react';
import userEvent from '@testing-library/user-event';
import { dataService, PrincipalType } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import BotManagers from './BotManagers';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getSlackBotManagers: jest.fn(),
      searchSlackBotManagers: jest.fn(),
      setSlackBotManagers: jest.fn(),
    },
  };
});

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
const workspace = {
  workspaceId: 'workspace-1',
  appId: 'A123',
  teamId: 'T123',
  teamName: 'Engineering',
  botUserId: 'U123',
  revision: 'r1',
  status: 'active' as const,
  scopes: [],
};
const manager = { id: '000000000000000000000001', name: 'Alice', email: 'alice@example.com' };
const bob = {
  id: '000000000000000000000002',
  idOnTheSource: 'directory-bob',
  source: 'local',
  type: PrincipalType.USER,
  name: 'Bob',
  email: 'bob@example.com',
};
let read: jest.SpyInstance;
let save: jest.SpyInstance;
function page() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log() {}, warn() {}, error() {} },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <BotManagers workspace={workspace} principalKey="org-a:admin" disabled={false} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}
beforeEach(() => {
  read = jest
    .spyOn(dataService, 'getSlackBotManagers')
    .mockResolvedValue({ revision: 'r1', managers: [manager], maxManagers: 50 });
  save = jest.spyOn(dataService, 'setSlackBotManagers').mockResolvedValue({ revision: 'r2' });
  jest.spyOn(dataService, 'searchSlackBotManagers').mockResolvedValue([bob]);
});
afterEach(() => jest.restoreAllMocks());
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'com_ui_slack_manage_access_named' }));
  return screen.findByRole('dialog', { name: 'com_ui_slack_bot_managers' });
}

test('loads managers, uses the bot-admin search and saves with the observed revision', async () => {
  const user = userEvent.setup();
  page();
  const dialog = await open(user);
  await within(dialog).findByText('Alice');
  expect(within(dialog).getByRole('button', { name: 'com_ui_save' })).toBeDisabled();
  await user.type(within(dialog).getByRole('combobox'), 'bo');
  await user.click(await screen.findByRole('option', { name: /Bob/ }));
  expect(dataService.searchSlackBotManagers).toHaveBeenCalledWith('workspace-1', 'bo');
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_save' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('workspace-1', 'r1', [manager.id, bob.id]));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('cancel discards edits and returns focus without mutating access', async () => {
  const user = userEvent.setup();
  page();
  const dialog = await open(user);
  await within(dialog).findByText('Alice');
  await user.click(
    within(dialog).getByRole('button', { name: 'com_ui_slack_bot_managers_remove' }),
  );
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_cancel' }));
  expect(save).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_slack_manage_access_named' })).toHaveFocus(),
  );
});

test('a stale save requires reloading instead of silently overwriting newer grants', async () => {
  const user = userEvent.setup();
  save.mockRejectedValue(new Error('private diagnostics'));
  page();
  const dialog = await open(user);
  await within(dialog).findByText('Alice');
  await user.click(
    within(dialog).getByRole('button', { name: 'com_ui_slack_bot_managers_remove' }),
  );
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_save' }));
  await within(dialog).findByText('com_ui_slack_bot_managers_error');
  expect(screen.queryByText('private diagnostics')).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'com_ui_save' })).toBeDisabled();
  read.mockResolvedValue({
    revision: 'r2',
    managers: [{ ...manager, name: 'New owner' }],
    maxManagers: 50,
  });
  await user.click(
    within(dialog).getByRole('button', { name: 'com_ui_slack_bot_managers_reload' }),
  );
  await within(dialog).findByText('New owner');
  expect(within(dialog).getByRole('button', { name: 'com_ui_save' })).toBeDisabled();
});

test('an unavailable read cannot expose the picker or save control', async () => {
  const user = userEvent.setup();
  read.mockRejectedValue(new Error('private query'));
  page();
  const dialog = await open(user);
  await within(dialog).findByText('com_ui_slack_bot_managers_error');
  expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'com_ui_save' })).toBeDisabled();
});

test('search failures are visible and retryable without closing the manager dialog', async () => {
  const user = userEvent.setup();
  jest
    .mocked(dataService.searchSlackBotManagers)
    .mockRejectedValueOnce(new Error('private directory diagnostic'));
  page();
  const dialog = await open(user);
  await within(dialog).findByText('Alice');
  await user.type(within(dialog).getByRole('combobox'), 'bo');
  await within(dialog).findByText('com_ui_slack_bot_managers_search_error');
  expect(screen.queryByText('private directory diagnostic')).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_retry' }));
  expect(within(dialog).getByRole('combobox')).toHaveFocus();
  await user.click(await screen.findByRole('option', { name: /Bob/ }));
  expect(within(dialog).getByRole('button', { name: 'com_ui_save' })).toBeEnabled();
});

test('keeps guidance in a keyboard-accessible title hint without opening it on entry', async () => {
  read.mockResolvedValue({ revision: 'r1', managers: [], maxManagers: 50 });
  const user = userEvent.setup();
  page();
  const dialog = await open(user);
  await within(dialog).findByRole('combobox');
  expect(dialog).toHaveAccessibleName('com_ui_slack_bot_managers');
  expect(dialog).toHaveAccessibleDescription('Engineering');
  expect(dialog).toHaveFocus();
  expect(screen.queryByText('com_ui_slack_bot_managers_hint')).not.toBeInTheDocument();
  expect(
    within(dialog).queryByText('com_ui_slack_bot_managers_description'),
  ).not.toBeInTheDocument();
  expect(within(dialog).queryByText('com_ui_slack_bot_managers_empty')).not.toBeInTheDocument();
  expect(
    within(dialog).queryByText('com_ui_slack_bot_managers_revocation'),
  ).not.toBeInTheDocument();
  await user.tab();
  expect(
    within(dialog).getByRole('button', { name: 'com_ui_slack_bot_managers_hint' }),
  ).toHaveFocus();
  expect(await screen.findByText('com_ui_slack_bot_managers_hint')).toBeVisible();
  await user.tab();
  await waitFor(() =>
    expect(screen.queryByText('com_ui_slack_bot_managers_hint')).not.toBeInTheDocument(),
  );
  expect(within(dialog).getByRole('combobox')).toHaveFocus();
});

test('prevents cancelling a pending save and closes after it succeeds', async () => {
  let complete!: () => void;
  save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const user = userEvent.setup();
  page();
  const dialog = await open(user);
  await within(dialog).findByText('Alice');
  await user.click(
    within(dialog).getByRole('button', { name: 'com_ui_slack_bot_managers_remove' }),
  );
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_save' }));
  expect(within(dialog).getByRole('button', { name: 'com_ui_cancel' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(dialog).toBeInTheDocument();
  complete();
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'com_ui_slack_manage_access_named' })).toHaveFocus();
});
