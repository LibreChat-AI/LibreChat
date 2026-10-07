import React from 'react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import InputWithDropdown from './InputWithDropDown';
import { InputCombobox } from './InputCombobox';
import { SecretInput } from './SecretInput';
import MultiSearch from './MultiSearch';

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

/**
 * These controls drew keyboard focus in the decorative `ring-primary`, about 2.3:1 on the dark
 * default canvas. Each is reached by Tab, as a keyboard user reaches it, and must paint its ring in
 * the `focus-control` role that `semanticTokens.spec.ts` holds at 3:1 on every control canvas.
 */
describe('shared control keyboard focus', () => {
  it('rings the secret reveal and copy buttons in the focus role', async () => {
    const user = userEvent.setup();
    render(<SecretInput value="secret" showCopy readOnly aria-label="token" />);

    const reached: Element[] = [];
    for (let stop = 0; stop < 3; stop++) {
      await user.tab();
      if (document.activeElement) {
        reached.push(document.activeElement);
      }
    }

    const buttons = [
      screen.getByRole('button', { name: 'Show secret' }),
      screen.getByRole('button', { name: 'Copy to clipboard' }),
    ];
    buttons.forEach((button) => {
      expect(reached).toContain(button);
      expect(button).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-focus-control');
    });
  });

  it('rings the model search field in the focus role', async () => {
    const user = userEvent.setup();
    render(<MultiSearch value="" onChange={jest.fn()} />);

    await user.tab();
    const search = screen.getByRole('textbox', { name: 'Search Model' });
    expect(search).toHaveFocus();
    expect(search).toHaveClass('focus:ring-1', 'focus:ring-focus-control');
  });

  it('rings the dropdown toggle and its options in the focus role', async () => {
    const user = userEvent.setup();
    render(<InputWithDropdown aria-label="Stop word" options={['alpha', 'beta']} />);

    await user.tab();
    await user.tab();
    const toggle = screen.getByRole('button', { name: 'Open dropdown' });
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveClass('focus-visible:ring-1', 'focus-visible:ring-focus-control');

    await user.keyboard('{Enter}');
    expect(screen.getByRole('listbox')).toHaveClass('focus:ring-focus-control');

    await user.tab();
    const [first] = screen.getAllByRole('option');
    expect(first).toHaveFocus();
    expect(first).toHaveClass('focus:ring-1', 'focus:ring-focus-control');
  });

  it('rings the combobox only while it holds keyboard focus', async () => {
    const user = userEvent.setup();
    render(
      <>
        <InputCombobox
          label="Region"
          options={['eu', 'us']}
          value=""
          onChange={jest.fn()}
          onBlur={jest.fn()}
        />
        <button type="button">after</button>
      </>,
    );

    const combobox = screen.getByRole('combobox', { name: 'Region' });
    const ringHost = combobox.parentElement as HTMLElement;
    expect(ringHost).not.toHaveClass('ring-focus-control');

    await user.tab();
    expect(combobox).toHaveFocus();
    expect(ringHost).toHaveClass('ring-2', 'ring-focus-control');
    expect(ringHost).not.toHaveClass('ring-ring-primary');

    await user.tab();
    expect(ringHost).not.toHaveClass('ring-focus-control');
  });
});
