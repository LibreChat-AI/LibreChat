import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SecretInput } from './SecretInput';

jest.mock('./MorphIcon', () => {
  const { createMorphIconMock } = jest.requireActual('../test/mockMorphIcon');
  const { Eye, EyeOff, Copy, Check } = jest.requireActual('lucide');
  return {
    MorphIcon: createMorphIconMock([
      [Eye, 'eye'],
      [EyeOff, 'eye-off'],
      [Copy, 'copy'],
      [Check, 'check'],
    ]),
  };
});

describe('SecretInput', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('shows eye icon when hidden and eye-off when visible', () => {
    render(<SecretInput value="secret" readOnly aria-label="token" />);
    const toggle = screen.getByRole('button', { name: 'Show secret' });
    expect(toggle.querySelector('[data-icon="eye"]')).not.toBeNull();

    fireEvent.click(toggle);
    expect(
      screen.getByRole('button', { name: 'Hide secret' }).querySelector('[data-icon="eye-off"]'),
    ).not.toBeNull();
  });

  it('morphs copy to check after a successful copy', async () => {
    render(<SecretInput value="secret-value" showCopy readOnly aria-label="token" />);
    const copyButton = screen.getByRole('button', { name: 'Copy to clipboard' });
    expect(copyButton.querySelector('[data-icon="copy"]')).not.toBeNull();

    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Copied' }).querySelector('[data-icon="check"]'),
      ).not.toBeNull();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('secret-value');
  });

  /** A secret sits beside plain inputs in forms, so it composes the shared field and takes the
   *  theme's field height and focus treatment with them. */
  it('draws the shared field with its height and focus roles', () => {
    render(<SecretInput value="secret" showCopy readOnly aria-label="token" />);
    const field = screen.getByLabelText('token');

    expect(field).toHaveClass(
      'lc-field',
      'h-theme-field',
      'focus-visible:ring-focus-control',
      'theme-field-border:focus:border-border-field-focus',
      'pr-20',
    );
    expect(field).not.toHaveClass('h-10');
  });
});
