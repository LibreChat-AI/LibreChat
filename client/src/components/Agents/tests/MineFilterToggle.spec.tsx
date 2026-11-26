import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import MineFilterToggle from '../MineFilterToggle';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('MineFilterToggle', () => {
  it.each([false, true])('uses theme-aware icon color when checked=%s', (checked) => {
    render(<MineFilterToggle iconOnly checked={checked} onCheckedChange={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'com_agents_my_agents' })).toHaveClass(
      'text-text-secondary',
    );
  });
});
