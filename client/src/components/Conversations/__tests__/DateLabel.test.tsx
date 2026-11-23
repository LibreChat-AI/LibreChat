import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import { DateLabel } from '../Conversations';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, params?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      com_a11y_chats_date_section: `Chats from ${params?.date ?? ''}`,
      com_a11y_chats_alpha_section: `Chats with titles starting with ${params?.letter ?? ''}`,
      com_a11y_chats_running_section: `${params?.count} running chats`,
      com_a11y_chats_finished_section: `${params?.count} finished chats with unread replies`,
      com_ui_running_chats: 'Running',
      com_ui_finished_chats: 'Finished',
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

  it('announces the running group with its count, not as a date', () => {
    render(<DateLabel groupName="com_ui_running_chats" count={4} />);
    expect(screen.getByRole('heading', { level: 2, name: '4 running chats' })).toHaveTextContent(
      'Running · 4',
    );
  });

  it('announces the finished group with its count', () => {
    render(<DateLabel groupName="com_ui_finished_chats" count={2} />);
    expect(
      screen.getByRole('heading', { level: 2, name: '2 finished chats with unread replies' }),
    ).toHaveTextContent('Finished · 2');
  });

  it('leaves the count off date groups', () => {
    render(<DateLabel groupName="com_ui_date_today" />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Today$/);
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

  /** The first heading opens the list and needs no gap above it; every later one
   *  separates two groups. The size of that gap is a design decision, so what is
   *  pinned here is that the two cases differ, not the value. */
  it('opens the list flush for the first date header', () => {
    const { container } = render(<DateLabel groupName="com_ui_date_today" isFirst={true} />);
    const heading = container.querySelector('h2');
    expect(heading).toHaveClass('mt-0');
    expect(heading).not.toHaveClass('mt-1.5');
  });

  it('separates a later date header from the group above it', () => {
    const { container } = render(<DateLabel groupName="com_ui_date_today" isFirst={false} />);
    const heading = container.querySelector('h2');
    expect(heading).toHaveClass('mt-1.5');
    expect(heading).not.toHaveClass('mt-0');
  });
});
