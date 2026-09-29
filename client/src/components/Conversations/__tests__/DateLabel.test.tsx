import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import { DateLabel } from '../Conversations';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, params?: Record<string, string>) => {
    const translations: Record<string, string> = {
      com_a11y_chats_date_section: `Chats from ${params?.date ?? ''}`,
      com_a11y_chats_alpha_section: `Chats with titles starting with ${params?.letter ?? ''}`,
      com_a11y_chats_running_section: 'Running chats',
      com_ui_running_chats: 'Running',
      com_ui_date_today: 'Today',
      com_ui_date_yesterday: 'Yesterday',
      com_ui_date_previous_7_days: 'Previous 7 days',
    };
    return translations[key] ?? key;
  },
}));

describe('DateLabel', () => {
  it('provides accessible heading name via aria-label', () => {
    render(<DateLabel groupName="com_ui_date_today" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Chats from Today' })).toBeInTheDocument();
  });

  it('announces the running group without describing it as a date', () => {
    render(<DateLabel groupName="com_ui_running_chats" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Running chats' })).toHaveTextContent(
      'Running',
    );
  });

  it('uses the alphabetical accessible name for title groups', () => {
    render(<DateLabel groupName="A" isAlphabetical />);
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Chats with titles starting with A',
      }),
    ).toBeInTheDocument();
  });

  it('renders visible text as the localized group name', () => {
    render(<DateLabel groupName="com_ui_date_today" />);
    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  it('sets aria-label with the full accessible phrase', () => {
    const { container } = render(<DateLabel groupName="com_ui_date_yesterday" />);
    const heading = container.querySelector('h2');
    expect(heading).toHaveAttribute('aria-label', 'Chats from Yesterday');
  });

  it('uses raw groupName for unrecognized translation keys', () => {
    render(<DateLabel groupName="Unknown Group" />);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Chats from Unknown Group' }),
    ).toBeInTheDocument();
  });

  it('applies mt-0 for the first date header', () => {
    const { container } = render(<DateLabel groupName="com_ui_date_today" isFirst={true} />);
    const heading = container.querySelector('h2');
    expect(heading).toHaveClass('mt-0');
    expect(heading).not.toHaveClass('mt-2');
  });

  it('applies mt-2 for non-first date headers', () => {
    const { container } = render(<DateLabel groupName="com_ui_date_today" isFirst={false} />);
    const heading = container.querySelector('h2');
    expect(heading).toHaveClass('mt-2');
    expect(heading).not.toHaveClass('mt-0');
  });
});
