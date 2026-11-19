import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import OfficialAgentIcon from '../OfficialAgentIcon';

let mockOfficialStatus = { enabled: true, description: 'Official agent', canManage: false };

jest.mock('~/hooks', () => ({
  useAgentOfficialStatus: () => mockOfficialStatus,
  useLocalize: () => (key: string) => (key === 'com_ui_official_agent' ? 'Official agent' : key),
}));

describe('OfficialAgentIcon', () => {
  beforeEach(() => {
    mockOfficialStatus = { enabled: true, description: 'Official agent', canManage: false };
  });

  it('shows its localized tooltip when focused by keyboard', async () => {
    const user = userEvent.setup();
    render(<OfficialAgentIcon />);

    const icon = screen.getByRole('img', { name: 'Official agent' });
    expect(icon).toHaveClass('text-status-info');
    expect(icon.querySelector('svg')).toHaveClass('lucide-badge-check', 'size-full');
    await user.tab();

    expect(icon).toHaveFocus();
    expect(await screen.findByRole('tooltip', undefined, { timeout: 3000 })).toHaveTextContent(
      'Official agent',
    );
  });

  it('renders nothing while official status is disabled', () => {
    mockOfficialStatus = { ...mockOfficialStatus, enabled: false };
    const { container } = render(<OfficialAgentIcon />);

    expect(container).toBeEmptyDOMElement();
  });

  it('keeps a short name and exposes the configured explanation as its description', async () => {
    const explanation = 'Reviewed by the AI governance board for security and data handling.';
    mockOfficialStatus = { ...mockOfficialStatus, description: explanation };
    const user = userEvent.setup();
    render(<OfficialAgentIcon />);

    const icon = screen.getByRole('img', { name: 'Official agent' });
    expect(icon).toHaveAccessibleDescription(explanation);
    await user.tab();

    expect(await screen.findByRole('tooltip', undefined, { timeout: 3000 })).toHaveTextContent(
      explanation,
    );
  });

  it('adds no tab stop when static inside another control', () => {
    render(<OfficialAgentIcon static />);

    const icon = screen.getByRole('img', { name: 'Official agent' });
    expect(icon).not.toHaveAttribute('tabindex');
    expect(icon).toHaveAttribute('title', 'Official agent');
  });
});
