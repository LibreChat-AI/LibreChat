import { createRef } from 'react';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ScheduleMCPConsentView } from 'librechat-data-provider';
import KeyGrant from '../KeyGrant';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
const mockListAgents = jest.fn();
jest.mock('~/data-provider', () => ({
  useListAgentsQuery: () => mockListAgents(),
}));
const listed = {
  data: [
    { id: 'agent_a', name: 'Analyst' },
    { id: 'agent_b', name: 'Builder' },
  ],
  isLoading: false,
  isError: false,
  refetch: jest.fn(),
};
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getApiKeyMCPConsent: jest.fn(),
      confirmApiKeyMCPConsent: jest.fn(),
      revokeApiKeyMCPConsent: jest.fn(),
    },
  };
});

const view = (tools: string[]): ScheduleMCPConsentView => ({
  state: 'missing',
  revision: null,
  expiresAtMs: null,
  targets: [
    {
      resource: {
        serverName: 'warehouse',
        url: 'https://warehouse.example/mcp',
        issuer: null,
        audience: null,
        scopes: [],
        credentialMode: 'stored_oauth',
        configurationRevision: 'v1',
      },
      policyRevision: 'p1',
      permittedTools: [{ agentId: 'root', tools }],
    },
  ],
  allowed: {},
  changed: {},
  asking: {},
  approval: false,
  required: false,
  requireAfterMs: null,
  offer: { digest: 'a'.repeat(64), maxLifetimeHours: 24 },
});

function display() {
  const client = new QueryClient({
    logger: { log: console.log, warn: console.warn, error: jest.fn() },
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <KeyGrant id="key-1" name="CI Pipeline" onOpenChange={jest.fn()} triggerRef={createRef()} />
    </QueryClientProvider>,
  );
}
const pick = async (name: string) => {
  await userEvent.click(screen.getByRole('combobox', { name: 'com_ui_agent' }));
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
};

beforeEach(() => {
  mockListAgents.mockReturnValue(listed);
  jest
    .mocked(dataService.getApiKeyMCPConsent)
    .mockImplementation(async (_id, agentId) =>
      view(agentId === 'agent_a' ? ['query'] : ['deploy']),
    );
});
afterEach(() => jest.clearAllMocks());

it('asks for nothing until an agent is picked', async () => {
  display();
  expect(await screen.findByText('com_ui_api_key_grant_choose_agent')).toBeVisible();
  expect(screen.getByText('com_ui_api_key_grant_title')).toBeVisible();
  expect(screen.getByText('CI Pipeline')).toBeVisible();
  expect(dataService.getApiKeyMCPConsent).not.toHaveBeenCalled();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  // Nothing is loading either: a disabled query must not leave a spinner turning.
  expect(document.querySelector('svg.spinner')).toBeNull();
});

it('says the agents are loading, and offers no picker yet', () => {
  mockListAgents.mockReturnValue({ ...listed, data: undefined, isLoading: true });
  display();
  expect(document.querySelector('svg.spinner')).not.toBeNull();
  expect(screen.queryByRole('combobox', { name: 'com_ui_agent' })).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_api_key_grant_choose_agent')).not.toBeInTheDocument();
});

it('says the agents could not be loaded and lets the owner try again', async () => {
  const refetch = jest.fn();
  mockListAgents.mockReturnValue({ ...listed, data: undefined, isError: true, refetch });
  display();
  expect(screen.getByRole('alert')).toHaveTextContent('com_ui_api_key_grant_agents_error');
  // No empty picker and no instruction to choose from it.
  expect(screen.queryByRole('combobox', { name: 'com_ui_agent' })).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_api_key_grant_choose_agent')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  expect(refetch).toHaveBeenCalledTimes(1);
});

it('keeps a list it already has usable when a refresh fails', async () => {
  mockListAgents.mockReturnValue({ ...listed, isError: true });
  display();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await pick('Analyst');
  expect(await screen.findByRole('checkbox', { name: 'query' })).toBeVisible();
});

it('says so when the owner has no agent to pick', () => {
  mockListAgents.mockReturnValue({ ...listed, data: [] });
  display();
  expect(screen.getByText('com_ui_api_key_grant_no_agents')).toBeVisible();
  expect(screen.queryByRole('combobox', { name: 'com_ui_agent' })).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_api_key_grant_choose_agent')).not.toBeInTheDocument();
});

it('shows and confirms the grant of this key for the picked agent', async () => {
  jest.mocked(dataService.confirmApiKeyMCPConsent).mockResolvedValue(view(['query']));
  display();
  await pick('Analyst');
  await userEvent.click(await screen.findByRole('checkbox', { name: 'query' }));
  expect(dataService.getApiKeyMCPConsent).toHaveBeenCalledWith('key-1', 'agent_a');
  expect(screen.queryByText('com_ui_api_key_grant_choose_agent')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmApiKeyMCPConsent).toHaveBeenCalledWith(
      'key-1',
      'agent_a',
      expect.objectContaining({ allow: { warehouse: ['query'] }, expectedRevision: null }),
    ),
  );
  expect(await screen.findByText('com_ui_api_key_grant_confirmed')).toBeVisible();
});

it('starts over when another agent is picked', async () => {
  display();
  await pick('Analyst');
  await userEvent.click(await screen.findByRole('checkbox', { name: 'query' }));
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();
  await pick('Builder');
  const other = await screen.findByRole('checkbox', { name: 'deploy' });
  expect(other).not.toBeChecked();
  expect(screen.queryByRole('checkbox', { name: 'query' })).not.toBeInTheDocument();
  expect(dataService.getApiKeyMCPConsent).toHaveBeenLastCalledWith('key-1', 'agent_b');
  expect(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' })).toBeDisabled();
});

it('speaks of the key, not of schedules, when there is nothing to grant', async () => {
  jest.mocked(dataService.getApiKeyMCPConsent).mockResolvedValue({
    ...view([]),
    state: 'unsupported',
    targets: [],
    required: false,
    offer: null,
  });
  display();
  await pick('Analyst');
  expect(await screen.findByText('com_ui_api_key_grant_unsupported')).toBeVisible();
  expect(screen.queryByText('com_ui_schedule_consent_unsupported')).not.toBeInTheDocument();
});

it('revokes this key and agent only', async () => {
  jest.mocked(dataService.getApiKeyMCPConsent).mockResolvedValue({
    ...view(['query']),
    state: 'active',
    revision: 'grant-1',
    expiresAtMs: Date.now() + 60_000,
    allowed: { warehouse: ['query'] },
    required: false,
  });
  jest.mocked(dataService.revokeApiKeyMCPConsent).mockResolvedValue(undefined);
  display();
  await pick('Builder');
  await userEvent.click(
    await screen.findByRole('button', { name: 'com_ui_schedule_consent_revoke' }),
  );
  await waitFor(() =>
    expect(dataService.revokeApiKeyMCPConsent).toHaveBeenCalledWith('key-1', 'agent_b', 'grant-1'),
  );
});
