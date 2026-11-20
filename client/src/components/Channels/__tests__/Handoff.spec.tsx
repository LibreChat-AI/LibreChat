import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import Handoff from '../Handoff';

jest.mock('copy-to-clipboard', () => ({ __esModule: true, default: jest.fn() }));

test.each([true, false])(
  'local handoff offers only a usable sign-in action (storage: %s)',
  async (canResume) => {
    expect(window.location.hostname).toBe('localhost');
    const onContinue = jest.fn();
    render(<Handoff ticket={'a'.repeat(43)} canResume={canResume} onContinue={onContinue} />);
    expect(screen.queryByRole('button', { name: 'Use my phone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    if (!canResume) {
      expect(
        screen.getByText('After signing in, reopen this link from Discord or Slack.'),
      ).toBeVisible();
      expect(screen.getByRole('button', { name: 'Continue here' })).toHaveAccessibleDescription(
        'After signing in, reopen this link from Discord or Slack.',
      );
    }
    await userEvent.click(screen.getByRole('button', { name: 'Continue here' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  },
);
