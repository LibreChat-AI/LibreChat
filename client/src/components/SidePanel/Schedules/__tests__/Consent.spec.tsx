import { createRef } from 'react';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ScheduleMCPConsentView } from 'librechat-data-provider';
import Consent from '../Consent';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getScheduleMCPConsent: jest.fn(),
      confirmScheduleMCPConsent: jest.fn(),
      revokeScheduleMCPConsent: jest.fn(),
    },
  };
});
const view: ScheduleMCPConsentView = {
  state: 'missing',
  revision: null,
  expiresAtMs: null,
  targets: [
    {
      resource: {
        serverName: 'warehouse',
        url: 'https://warehouse.example/mcp',
        issuer: 'https://issuer.example/',
        audience: 'warehouse',
        scopes: ['read'],
        credentialMode: 'resource_bearer',
        configurationRevision: 'v1',
      },
      policyRevision: 'p1',
      permittedTools: [
        { agentId: 'root', tools: ['export', 'query'] },
        { agentId: 'child', tools: ['query'] },
      ],
    },
  ],
  allowed: {},
  changed: {},
  offer: { digest: 'a'.repeat(64), maxLifetimeHours: 24 },
};
function display() {
  const client = new QueryClient({
    logger: { log: console.log, warn: console.warn, error: jest.fn() },
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Consent id="schedule" name="Digest" onOpenChange={jest.fn()} triggerRef={createRef()} />
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(view);
});
it('renders loading, then the resource, each tool on offer unchecked, and a bounded lifetime', async () => {
  let resolve!: (value: ScheduleMCPConsentView) => void;
  jest.mocked(dataService.getScheduleMCPConsent).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  display();
  expect(screen.queryByText('warehouse')).not.toBeInTheDocument();
  resolve(view);
  expect(await screen.findByText('warehouse')).toBeVisible();
  expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  expect(screen.getByRole('checkbox', { name: 'query' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'export' })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' })).toBeDisabled();
  expect(screen.getByText('com_ui_schedule_consent_none_selected')).toBeVisible();
  expect(screen.getByRole('spinbutton')).toHaveAttribute('max', '24');
});
it('confirms the offer reference, lifetime and only the tools the owner ticked, then rereads persisted state', async () => {
  const active = {
    ...view,
    state: 'active' as const,
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
  };
  jest.mocked(dataService.confirmScheduleMCPConsent).mockImplementation(async () => {
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(active);
    return active;
  });
  display();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'query' }));
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith('schedule', {
      offerDigest: view.offer!.digest,
      expectedRevision: null,
      lifetimeHours: 1,
      allow: { warehouse: ['query'] },
    }),
  );
  expect(await screen.findByText('com_ui_schedule_consent_active')).toBeVisible();
});
it('allows or clears every tool on a server with one box', async () => {
  display();
  const server = await screen.findByRole('checkbox', {
    name: 'com_ui_schedule_consent_allow_server',
  });
  await userEvent.click(server);
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'export' })).toBeChecked();
  expect(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' })).toBeEnabled();

  await userEvent.click(screen.getByRole('checkbox', { name: 'export' }));
  expect(server).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();

  await userEvent.click(server);
  expect(screen.getByRole('checkbox', { name: 'export' })).toBeChecked();
  await userEvent.click(server);
  expect(screen.getByRole('checkbox', { name: 'query' })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' })).toBeDisabled();
});
it('starts from what the stored grant allows and is still on offer', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'active',
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
    allowed: { warehouse: ['query', 'retired'] },
  });
  display();
  expect(await screen.findByRole('checkbox', { name: 'query' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'export' })).not.toBeChecked();
  expect(screen.queryByRole('checkbox', { name: 'retired' })).not.toBeInTheDocument();
});
it('drops ticks for a server or tool that leaves the offer while the dialog is open', async () => {
  const archive = {
    ...view.targets[0],
    resource: { ...view.targets[0].resource, serverName: 'archive' },
    permittedTools: [{ agentId: 'root', tools: ['purge'] }],
  };
  jest
    .mocked(dataService.getScheduleMCPConsent)
    .mockResolvedValue({ ...view, targets: [archive, ...view.targets] });
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  const client = display();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'purge' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'export' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'query' }));
  // The agents drop the archive server and the export tool; the offer is read again.
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    targets: [{ ...view.targets[0], permittedTools: [{ agentId: 'root', tools: ['query'] }] }],
    offer: { digest: 'b'.repeat(64), maxLifetimeHours: 24 },
  });
  await client.invalidateQueries();
  await waitFor(() =>
    expect(screen.queryByRole('checkbox', { name: 'purge' })).not.toBeInTheDocument(),
  );
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({ offerDigest: 'b'.repeat(64), allow: { warehouse: ['query'] } }),
    ),
  );
});
it('leaves a tool the server changed unticked and says why, until the owner allows it again', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'changed',
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
    allowed: { warehouse: ['export', 'query'] },
    changed: { warehouse: ['query'] },
  });
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  display();
  const changed = await screen.findByRole('checkbox', { name: 'query' });
  expect(changed).not.toBeChecked();
  expect(changed).toHaveAccessibleDescription('com_ui_schedule_consent_tool_changed');
  const unchanged = screen.getByRole('checkbox', { name: 'export' });
  expect(unchanged).toBeChecked();
  expect(unchanged).not.toHaveAccessibleDescription();
  await userEvent.click(changed);
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({ allow: { warehouse: ['export', 'query'] } }),
    ),
  );
});
it('unticks a tool that is marked as changed while the owner is choosing, until they tick it again', async () => {
  const granted = {
    ...view,
    state: 'active' as const,
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
    allowed: { warehouse: ['query'] },
  };
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(granted);
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  const client = display();
  // The owner edits a tick, so the dialog now holds their choice and not the stored one.
  await userEvent.click(await screen.findByRole('checkbox', { name: 'export' }));
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();
  // A run then sees `query` with a different definition, and the offer is read again.
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...granted,
    state: 'changed',
    changed: { warehouse: ['query'] },
    offer: { digest: 'c'.repeat(64), maxLifetimeHours: 24 },
  });
  await client.invalidateQueries();
  const marked = await screen.findByRole('checkbox', {
    name: 'query',
    description: 'com_ui_schedule_consent_tool_changed',
  });
  expect(marked).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'export' })).toBeChecked();
  // Ticked again with the warning in view, it is sent, and stays ticked across later edits.
  await userEvent.click(marked);
  await userEvent.click(screen.getByRole('checkbox', { name: 'export' }));
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({ offerDigest: 'c'.repeat(64), allow: { warehouse: ['query'] } }),
    ),
  );
});
it('unticks a tool the owner accepted once it is marked again under a later grant', async () => {
  const marked = {
    ...view,
    state: 'changed' as const,
    revision: 'grant-1',
    expiresAtMs: Date.now() + 60_000,
    allowed: { warehouse: ['query'] },
    changed: { warehouse: ['query'] },
  };
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(marked);
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  const client = display();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'query' }));
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();
  // Confirmed elsewhere, then a run marks the tool again: the same name, another change.
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...marked,
    revision: 'grant-2',
    offer: { digest: 'd'.repeat(64), maxLifetimeHours: 24 },
  });
  await client.invalidateQueries();
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'query' })).not.toBeChecked());
  expect(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' })).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox', { name: 'query' }));
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({
        offerDigest: 'd'.repeat(64),
        expectedRevision: 'grant-2',
        allow: { warehouse: ['query'] },
      }),
    ),
  );
});
it('names the changed tools when there is nothing to confirm', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'changed',
    revision: 'grant',
    allowed: { warehouse: ['export', 'query'] },
    changed: { warehouse: ['query'] },
    offer: null,
  });
  display();
  expect(await screen.findByText('com_ui_schedule_consent_changed_tools')).toBeVisible();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});
it('lists the allowed tools without boxes when there is nothing to confirm', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'revoked',
    revision: 'revoked',
    allowed: { warehouse: ['query'] },
    offer: null,
  });
  display();
  expect(await screen.findByText('com_ui_schedule_consent_allowed')).toBeVisible();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});
it('reopens with persisted expiry and explicitly revokes without enabling a schedule', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'active',
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
  });
  jest.mocked(dataService.revokeScheduleMCPConsent).mockImplementation(async () => {
    jest
      .mocked(dataService.getScheduleMCPConsent)
      .mockResolvedValue({ ...view, state: 'revoked', revision: 'revoked', offer: null });
  });
  display();
  expect(await screen.findByText('com_ui_schedule_consent_deadline')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_revoke' }));
  await waitFor(() =>
    expect(dataService.revokeScheduleMCPConsent).toHaveBeenCalledWith('schedule', 'grant'),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'com_ui_schedule_consent_revoke' }),
    ).not.toBeInTheDocument(),
  );
});
it('has no confirmation action when no trusted target resolver is installed', async () => {
  jest
    .mocked(dataService.getScheduleMCPConsent)
    .mockResolvedValue({ ...view, state: 'unsupported', targets: [], offer: null });
  display();
  expect(await screen.findByText('com_ui_schedule_consent_unsupported')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'com_ui_schedule_consent_confirm' }),
  ).not.toBeInTheDocument();
});
it('shows API errors and retries without silently accepting a grant', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockRejectedValueOnce(new Error('offline'));
  display();
  expect(await screen.findByText('com_ui_schedule_consent_error')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  expect(await screen.findByText('warehouse')).toBeVisible();
});
it('reports a stale confirmation and reloads the current offer', async () => {
  jest.mocked(dataService.confirmScheduleMCPConsent).mockRejectedValueOnce(new Error('conflict'));
  display();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'query' }));
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  expect(await screen.findByText('com_ui_schedule_consent_error')).toBeVisible();
  await waitFor(() => expect(dataService.getScheduleMCPConsent).toHaveBeenCalledTimes(2));
});

it('keeps persisted inspection and revocation when CREATE is removed, without offering confirmation', async () => {
  const active = {
    ...view,
    state: 'active' as const,
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
  };
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(active);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Consent
        canConfirm={false}
        id="schedule"
        name="Digest"
        onOpenChange={jest.fn()}
        triggerRef={createRef()}
      />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole('button', { name: 'com_ui_schedule_consent_revoke' }),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'com_ui_schedule_consent_confirm' }),
  ).not.toBeInTheDocument();
});
