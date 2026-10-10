import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './Select';

describe('SelectTrigger', () => {
  /** The trigger hid the outline on every focus and drew nothing in its place, so a keyboard
   *  user could not see which control held focus. */
  it('draws keyboard focus in the control focus role', () => {
    render(
      <Select>
        <SelectTrigger aria-label="Model">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>,
    );

    const trigger = screen.getByRole('combobox', { name: 'Model' });
    expect(trigger).toHaveClass(
      'focus-visible:outline-hidden',
      'focus-visible:ring-2',
      'focus-visible:ring-focus-control',
    );
    expect(trigger).not.toHaveClass('focus:outline-hidden');
  });
});

describe('SelectContent', () => {
  /** The list's width floor and scroll cap are theme roles, so a theme can retune both. */
  it('bounds the list with the list size roles', () => {
    render(
      <Select open value="one">
        <SelectTrigger aria-label="Model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">One</SelectItem>
        </SelectContent>
      </Select>,
    );

    expect(screen.getByRole('listbox')).toHaveClass('min-w-theme-list', 'max-h-theme-list');
  });
});
