/**
 * @jest-environment @happy-dom/jest-environment
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { DisableTwoFactorToggle } from '../DisableTwoFactorToggle';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('DisableTwoFactorToggle', () => {
  it('shows a disabled control with the policy reason when 2FA is required', async () => {
    const onChange = jest.fn();
    render(<DisableTwoFactorToggle enabled={true} required={true} onChange={onChange} />);

    const button = screen.getByRole('button', {
      name: 'com_ui_2fa_disable: com_ui_2fa_required',
    });
    const tooltipTrigger = screen.getByTestId('required-2fa-disable-control');

    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveClass('cursor-not-allowed');
    expect(tooltipTrigger).toHaveClass('cursor-not-allowed');
    expect(tooltipTrigger).toBe(button);

    fireEvent.mouseEnter(tooltipTrigger);
    fireEvent.mouseMove(tooltipTrigger, { screenX: 1 });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('com_ui_2fa_required');
    fireEvent.click(button);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the disable control when the deployment policy is optional', () => {
    render(<DisableTwoFactorToggle enabled={true} required={false} onChange={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'com_ui_2fa_disable' })).toBeEnabled();
  });
});
