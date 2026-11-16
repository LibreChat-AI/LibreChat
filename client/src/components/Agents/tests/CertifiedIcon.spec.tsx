import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import CertifiedIcon from '../CertifiedIcon';

let mockCertification = { enabled: true, description: 'Official agent', canManage: false };

jest.mock('~/hooks', () => ({
  useAgentCertification: () => mockCertification,
  useLocalize: () => (key: string) => (key === 'com_ui_certified_agent' ? 'Official agent' : key),
}));

describe('CertifiedIcon', () => {
  beforeEach(() => {
    mockCertification = { enabled: true, description: 'Official agent', canManage: false };
  });

  it('shows its localized tooltip when focused by keyboard', async () => {
    const user = userEvent.setup();
    render(<CertifiedIcon />);

    const icon = screen.getByRole('img', { name: 'Official agent' });
    expect(icon).toHaveClass('text-status-info');
    expect(icon.querySelector('svg')).toHaveClass('fill-current', 'stroke-surface-primary');
    await user.tab();

    expect(icon).toHaveFocus();
    expect(await screen.findByRole('tooltip', undefined, { timeout: 3000 })).toHaveTextContent(
      'Official agent',
    );
  });

  it('renders nothing while certification is disabled', () => {
    mockCertification = { ...mockCertification, enabled: false };
    const { container } = render(<CertifiedIcon />);

    expect(container).toBeEmptyDOMElement();
  });

  it('keeps a short name and exposes the configured explanation as its description', async () => {
    const explanation = 'Reviewed by the AI governance board for security and data handling.';
    mockCertification = { ...mockCertification, description: explanation };
    const user = userEvent.setup();
    render(<CertifiedIcon />);

    const icon = screen.getByRole('img', { name: 'Official agent' });
    expect(icon).toHaveAccessibleDescription(explanation);
    await user.tab();

    expect(await screen.findByRole('tooltip', undefined, { timeout: 3000 })).toHaveTextContent(
      explanation,
    );
  });

  it('adds no tab stop when static inside another control', () => {
    render(<CertifiedIcon static />);

    const icon = screen.getByRole('img', { name: 'Official agent' });
    expect(icon).not.toHaveAttribute('tabindex');
    expect(icon).toHaveAttribute('title', 'Official agent');
  });
});
