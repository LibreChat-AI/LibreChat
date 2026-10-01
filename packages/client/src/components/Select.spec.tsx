import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { Select, SelectTrigger, SelectValue } from './Select';

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
