import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { Checkbox, CheckboxGlyph } from './Checkbox';

describe('Checkbox', () => {
  it('reads its corner and unchecked fill from the checkbox roles', () => {
    render(<Checkbox aria-label="Probe" />);

    const box = screen.getByRole('checkbox', { name: 'Probe' });
    expect(box).toHaveClass(
      'rounded-theme-checkbox',
      'theme-checkbox-fill:bg-checkbox-fill',
      'data-[state=checked]:bg-surface-inverted',
    );
    expect(box).not.toHaveClass('rounded-sm');
  });

  it("lets a caller's corner replace the checkbox role", () => {
    render(<Checkbox aria-label="Probe" className="rounded-full" />);

    const box = screen.getByRole('checkbox', { name: 'Probe' });
    expect(box).toHaveClass('rounded-full');
    expect(box).not.toHaveClass('rounded-theme-checkbox');
  });
});

describe('CheckboxGlyph', () => {
  it('paints the unchecked fill role only while unchecked', () => {
    const { container, rerender } = render(<CheckboxGlyph checked={false} />);
    const glyph = container.firstElementChild;

    expect(glyph).toHaveClass('rounded-theme-checkbox', 'theme-checkbox-fill:bg-checkbox-fill');
    expect(glyph).not.toHaveClass('bg-surface-inverted');

    rerender(<CheckboxGlyph checked />);

    expect(glyph).toHaveClass('rounded-theme-checkbox', 'bg-surface-inverted');
    expect(glyph).not.toHaveClass('theme-checkbox-fill:bg-checkbox-fill');
  });
});
