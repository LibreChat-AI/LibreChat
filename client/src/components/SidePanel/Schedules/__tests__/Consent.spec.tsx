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
      permittedTools: [{ agentId: 'root', tools: ['query'] }],
    },
  ],
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
it('renders loading, then the exact agent/resource and bounded lifetime', async () => {
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
  expect(screen.getByText('root: query')).toBeVisible();
  expect(screen.getByRole('spinbutton')).toHaveAttribute('max', '24');
});
it('confirms only an offer reference and lifetime, then rereads persisted state', async () => {
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
  await userEvent.click(
    await screen.findByRole('button', { name: 'com_ui_schedule_consent_confirm' }),
  );
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith('schedule', {
      offerDigest: view.offer!.digest,
      expectedRevision: null,
      lifetimeHours: 1,
    }),
  );
  expect(await screen.findByText('com_ui_schedule_consent_active')).toBeVisible();
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
  await userEvent.click(
    await screen.findByRole('button', { name: 'com_ui_schedule_consent_confirm' }),
  );
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
