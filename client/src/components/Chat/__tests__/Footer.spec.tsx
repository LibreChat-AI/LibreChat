import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import Footer from '../Footer';

jest.mock('react-gtm-module', () => ({
  __esModule: true,
  default: { initialize: jest.fn() },
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(() => ({ data: undefined, isFetching: false, error: null })),
}));

const mockTranslations: Record<string, string> = {
  com_ui_latest_footer: 'Every AI for Everyone.',
  com_ui_privacy_policy: 'Privacy policy',
  com_ui_terms_of_service: 'Terms of service',
};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => mockTranslations[key] ?? key,
}));

describe('Footer', () => {
  test('opens the default LibreChat site link in a new tab', () => {
    render(<Footer startupConfig={null} />);
    const link = screen.getByRole('link', { name: /LibreChat/ });
    expect(link).toHaveAttribute('href', 'https://librechat.ai');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('opens custom footer markdown links in a new tab', () => {
    render(<Footer startupConfig={{ customFooter: '[Docs](https://example.com/docs)' }} />);
    const link = screen.getByRole('link', { name: 'Docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('keeps privacy policy and terms of service links in the same tab', () => {
    render(
      <Footer
        startupConfig={{
          interface: {
            privacyPolicy: { externalUrl: 'https://example.com/privacy' },
            termsOfService: { externalUrl: 'https://example.com/terms' },
          },
        }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Privacy policy' })).not.toHaveAttribute('target');
    expect(screen.getByRole('link', { name: 'Terms of service' })).not.toHaveAttribute('target');
  });

  test('leaves the policy links behind once a conversation starts', () => {
    render(
      <Footer
        configuredOnly
        startupConfig={{
          customFooter: 'Operator policy',
          interface: {
            privacyPolicy: { externalUrl: 'https://example.com/privacy' },
            termsOfService: { externalUrl: 'https://example.com/terms' },
          },
        }}
      />,
    );

    expect(screen.getByText('Operator policy')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Privacy policy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Terms of service' })).not.toBeInTheDocument();
  });

  /** `externalUrl` is an optional string, so an operator can set it to nothing;
   *  a link to a blank url points back at the page the reader is on. */
  test('treats a blank policy url as a policy the deployment never published', () => {
    const { container } = render(
      <Footer
        startupConfig={{
          interface: {
            privacyPolicy: { externalUrl: '  ' },
            termsOfService: { externalUrl: '' },
          },
        }}
      />,
    );

    expect(screen.queryByRole('link', { name: 'Privacy policy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Terms of service' })).not.toBeInTheDocument();
    expect(container.querySelector('a[href=""]')).toBeNull();
  });

  test('places no bar in a conversation whose deployment configured only policies', () => {
    const { container } = render(
      <Footer
        configuredOnly
        startupConfig={{
          interface: {
            privacyPolicy: { externalUrl: 'https://example.com/privacy' },
            termsOfService: { externalUrl: 'https://example.com/terms' },
          },
        }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
