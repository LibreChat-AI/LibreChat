import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import CheckboxButton from './CheckboxButton';

describe('CheckboxButton', () => {
  it('uses theme-owned control geometry', () => {
    render(<CheckboxButton label="Tools" icon={<span>icon</span>} />);

    expect(screen.getByRole('checkbox', { name: 'Tools' })).toHaveClass(
      'h-theme-control',
      'w-theme-control',
      'rounded-theme-control-round',
      'gap-theme-compact',
      'p-theme-compact',
      'md:px-theme-normal',
    );
  });
});
