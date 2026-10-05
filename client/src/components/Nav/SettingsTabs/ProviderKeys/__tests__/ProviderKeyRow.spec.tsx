import userEvent from '@testing-library/user-event';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import { changeLanguageSafely, initializeI18n } from '~/locales/i18n';
import { render, screen } from 'test/layout-test-utils';
import ProviderKeyRow from '../ProviderKeyRow';

const mockExpiry = '2026-08-11T12:00:00.000Z';
let mockKeyStatus: { expiry?: string; valid: boolean; loading: boolean; error: boolean };
const mockRefetch = jest.fn();

jest.mock('~/hooks', () => ({
  useClockFormat: () => true,
  useLocalize: jest.requireActual('~/hooks/useLocalize').default,
  useUserKey: () => ({
    getExpiry: () => mockKeyStatus.expiry,
    checkExpiry: () => mockKeyStatus.valid,
    isLoading: mockKeyStatus.loading,
    isError: mockKeyStatus.error,
    refetch: mockRefetch,
  }),
}));

jest.mock('~/components/Input/SetKeyDialog', () => ({ SetKeyDialog: () => null }));

describe('ProviderKeyRow', () => {
  beforeAll(async () => {
    await initializeI18n();
  });

  beforeEach(() => {
    mockKeyStatus = { expiry: mockExpiry, valid: true, loading: false, error: false };
  });

  afterEach(async () => {
    await changeLanguageSafely('en');
  });

  it('interpolates a finite key expiry without leaving a placeholder', () => {
    render(<ProviderKeyRow endpoint="openAI" endpointsConfig={{} as TEndpointsConfig} />);

    const formattedExpiry = new Date(mockExpiry).toLocaleString();
    expect(
      screen.getByText(`Current key is encrypted and will be deleted at ${formattedExpiry}`),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\{\{0\}\}/)).not.toBeInTheDocument();
  });

  it('preserves the expiry for translations that predate interpolation', async () => {
    await changeLanguageSafely('fr');
    render(<ProviderKeyRow endpoint="openAI" endpointsConfig={{} as TEndpointsConfig} />);

    expect(screen.getByText(new RegExp(new Date(mockExpiry).toLocaleString()))).toBeInTheDocument();
  });

  it('renders a configured endpoint image instead of the generic mark', () => {
    const { container } = render(
      <ProviderKeyRow
        endpoint="Branded"
        endpointsConfig={
          {
            Branded: {
              type: EModelEndpoint.custom,
              iconURL: 'https://cdn.example.com/x.png',
              order: 0,
            },
          } as TEndpointsConfig
        }
      />,
    );

    expect(container.querySelector('img')).toHaveAttribute('src', 'https://cdn.example.com/x.png');
  });

  it('distinguishes an absent key from an indefinite saved key', () => {
    mockKeyStatus = { expiry: undefined, valid: false, loading: false, error: false };
    const { rerender } = render(<ProviderKeyRow endpoint="openAI" endpointsConfig={{}} />);
    expect(screen.getByText('No key set')).toBeVisible();
    expect(screen.queryByText('Update')).not.toBeInTheDocument();
    mockKeyStatus = { expiry: 'never', valid: true, loading: false, error: false };
    rerender(<ProviderKeyRow endpoint="openAI" endpointsConfig={{}} />);
    expect(screen.queryByText('No key set')).not.toBeInTheDocument();
    expect(screen.getByText('Update')).toBeVisible();
  });

  it('disables setup until key status loads and provides retry for a failed request', async () => {
    mockKeyStatus = { expiry: undefined, valid: false, loading: true, error: false };
    const { rerender } = render(<ProviderKeyRow endpoint="openAI" endpointsConfig={{}} />);
    expect(screen.getByText('Loading...')).toBeVisible();
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.queryByText('No key set')).not.toBeInTheDocument();

    mockKeyStatus = { expiry: undefined, valid: false, loading: false, error: true };
    rerender(<ProviderKeyRow endpoint="openAI" endpointsConfig={{}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load API keys');
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });
});
