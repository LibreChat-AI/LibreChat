import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AgentContact from '../AgentContact';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_agents_contact: 'Contact',
      com_agents_no_contact_available: 'No contact available',
    };
    return translations[key] || key;
  },
}));

jest.mock('~/utils', () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
}));

describe('AgentContact', () => {
  it('uses support contact before owner contact', () => {
    render(
      <AgentContact
        agent={{
          support_contact: { name: 'Support Team', email: 'support@example.com' },
          owner_contact: { name: 'Owner User' },
        }}
      />,
    );

    expect(screen.getByText('Contact:')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Support Team' })).toHaveAttribute(
      'href',
      'mailto:support@example.com',
    );
    expect(screen.queryByText('Owner User')).not.toBeInTheDocument();
  });

  it('falls back to owner contact as a plain name without a mailto link', () => {
    const owner = { name: 'Owner User', email: 'owner@example.com' };
    render(<AgentContact agent={{ support_contact: undefined, owner_contact: owner }} />);

    expect(screen.getByText('Owner User')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders no-contact text when no contact is available', () => {
    render(<AgentContact agent={{ support_contact: {}, owner_contact: undefined }} />);

    expect(screen.getByText('No contact available')).toBeInTheDocument();
  });

  it('omits missing contact information in compact card footers', () => {
    render(<AgentContact compact agent={{ support_contact: { name: '  ', email: ' ' } }} />);
    expect(screen.queryByText('No contact available')).not.toBeInTheDocument();
    expect(screen.queryByText('Contact:')).not.toBeInTheDocument();
  });

  it('keeps an explicit support link available in compact mode', () => {
    render(
      <AgentContact
        compact
        agent={{ support_contact: { name: '  Support Team ', email: ' support@example.com ' } }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Support Team' })).toHaveAttribute(
      'href',
      'mailto:support@example.com',
    );
    expect(screen.queryByText('Contact:')).not.toBeInTheDocument();
  });
});
