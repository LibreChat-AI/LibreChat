import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import { changeLanguageSafely, initializeI18n } from '~/locales/i18n';
import { render, screen } from 'test/layout-test-utils';
import ProviderKeyRow from '../ProviderKeyRow';

const mockExpiry = '2026-08-11T12:00:00.000Z';

jest.mock('~/hooks', () => ({
  useClockFormat: () => true,
  useLocalize: jest.requireActual('~/hooks/useLocalize').default,
  useUserKey: () => ({
    getExpiry: () => mockExpiry,
    checkExpiry: () => true,
  }),
}));

jest.mock('~/components/Input/SetKeyDialog', () => ({ SetKeyDialog: () => null }));

describe('ProviderKeyRow', () => {
  beforeAll(async () => {
    await initializeI18n();
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
});
