import axios from 'axios';
import userEvent from '@testing-library/user-event';
import { dataService, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MediaStartupConfig, MediaUserKey, TEndpointsConfig } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { initializeI18n } from '~/locales/i18n';
import ProviderKeys from '../ProviderKeys';

let mockEndpoints: string[] = [];
let mockEndpointsConfig: TEndpointsConfig = {};
let mockMediaConfig: Pick<MediaStartupConfig, 'integrations'> | undefined;

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useGetEndpointsQuery: () => ({ data: mockEndpointsConfig }),
}));

jest.mock('../useProviderKeys', () => ({
  __esModule: true,
  default: () => mockEndpoints,
  useMediaProviderKeyConfig: () => mockMediaConfig,
}));

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getMediaCatalog: jest.fn() },
  };
});

jest.mock('~/components/Input/SetKeyDialog', () => ({
  SetKeyDialog: ({ keyConfiguration }: { keyConfiguration?: MediaUserKey & { label: string } }) => (
    <div role="dialog" aria-label="Configure credential">
      {keyConfiguration?.keyName} {keyConfiguration?.userProvideURL ? 'URL required' : 'Key only'}
    </div>
  ),
}));

const integration = (keyName: string, overrides: Partial<MediaUserKey> = {}) => ({
  connectionId: 'images',
  connectionName: 'Personal media',
  api: 'openrouter.images' as const,
  available: false,
  unavailableReason: 'credentials_required' as const,
  userKey: { keyName, encoding: 'apiKey' as const, userProvideURL: false, ...overrides },
});

let queryClient: QueryClient;
function setup() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<ProviderKeys />, { wrapper: Wrapper });
}

describe('ProviderKeys', () => {
  beforeAll(async () => {
    await initializeI18n();
  });
  beforeEach(() => {
    mockEndpoints = [];
    mockEndpointsConfig = {};
    mockMediaConfig = undefined;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      logger: { log: console.log, warn: console.warn, error: () => {} },
    });
    jest.mocked(dataService.getMediaCatalog).mockReset();
    jest.spyOn(axios, 'get').mockResolvedValue({ data: { expiresAt: '' } });
  });
  afterEach(() => queryClient.clear());

  const enableMedia = (integrations: MediaStartupConfig['integrations'] = []) => {
    mockMediaConfig = { integrations };
  };

  it('keeps help hidden until its trigger receives focus', async () => {
    setup();

    await userEvent.click(screen.getByRole('button', { name: 'Provider API keys' }));

    const dialog = screen.getByRole('dialog');
    const helpText = 'Manage API keys for endpoints configured to use a user-provided key.';
    const helpTrigger = screen.getByLabelText(helpText);

    await waitFor(() => expect(dialog).toHaveFocus());
    expect(screen.queryByText(helpText)).not.toBeInTheDocument();

    fireEvent.focus(helpTrigger);
    expect(await screen.findByText(helpText)).toBeVisible();
  });

  it('offers startup credential descriptors without requesting the catalog', async () => {
    enableMedia([
      integration('Personal / & ?'),
      { ...integration('Personal / & ?', { userProvideURL: true }), connectionId: 'videos' },
      { connectionId: 'managed', connectionName: 'Managed provider' },
    ]);
    setup();
    expect(dataService.getMediaCatalog).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Provider API keys' }));
    expect(await screen.findByText('Personal media')).toBeVisible();
    expect(screen.getAllByText('Personal media')).toHaveLength(1);
    expect(screen.queryByText('Managed provider')).not.toBeInTheDocument();
    expect(dataService.getMediaCatalog).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('name=Personal%20%2F%20%26%20%3F'),
        expect.anything(),
      ),
    );
    expect(await screen.findByText('No key set')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Personal media$/ }));
    expect(screen.getByRole('dialog', { name: 'Configure credential' })).toHaveTextContent(
      'Personal / & ? URL required',
    );
  });

  it('shows a useful empty state for managed-only Media connections', async () => {
    enableMedia();
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Provider API keys' }));
    expect(
      await screen.findByText('No providers currently require a personal API key.'),
    ).toBeVisible();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('retains chat keys without fetching Media when the scope is unavailable', async () => {
    mockEndpoints = ['Router'];
    mockEndpointsConfig = { Router: { order: 0, type: EModelEndpoint.custom, userProvide: true } };
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Provider API keys' }));
    expect(await screen.findByText('No key set')).toBeVisible();
    expect(screen.getByText('Router')).toBeVisible();
    expect(dataService.getMediaCatalog).not.toHaveBeenCalled();
  });

  it('blocks conflicting key formats and avoids querying or editing that credential', async () => {
    enableMedia([
      integration('Shared'),
      { ...integration('Shared', { encoding: 'google' }), connectionId: 'google' },
    ]);
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Provider API keys' }));
    expect(await screen.findByText(/These providers require different key formats/)).toBeVisible();
    expect(screen.getByRole('button', { name: /Personal media$/ })).toBeDisabled();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('merges a shared chat row into the required-URL credential editor', async () => {
    enableMedia([integration('openAI', { userProvideURL: true })]);
    mockEndpoints = ['openAI'];
    mockEndpointsConfig = {
      openAI: { order: 0, userProvide: true, userProvideURL: true, keyEncoding: 'apiKey' },
    };
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Provider API keys' }));
    expect(await screen.findByText('No key set')).toBeVisible();
    expect(screen.getAllByText('OpenAI')).toHaveLength(1);
    expect(screen.queryByText('Personal media')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /OpenAI$/ }));
    expect(screen.getByRole('dialog', { name: 'Configure credential' })).toHaveTextContent(
      'openAI URL required',
    );
  });
});
