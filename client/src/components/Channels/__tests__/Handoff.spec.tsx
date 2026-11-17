import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import Handoff from '../Handoff';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useCopyToClipboard: () => jest.fn(),
}));

test.each([true, false])(
  'local handoff offers only a usable sign-in action (storage: %s)',
  async (canResume) => {
    expect(window.location.hostname).toBe('localhost');
    const onContinue = jest.fn();
    render(<Handoff ticket={'a'.repeat(43)} canResume={canResume} onContinue={onContinue} />);
    expect(
      screen.queryByRole('button', { name: 'com_ui_channel_handoff_phone' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    if (!canResume) expect(screen.getByText('com_ui_channel_handoff_storage')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_channel_handoff_continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  },
);
