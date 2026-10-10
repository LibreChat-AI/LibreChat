import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, screen } from '@testing-library/react';
import MemoryUsageBadge from '../MemoryUsageBadge';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('MemoryUsageBadge', () => {
  test('keeps the usage in a polite status region that follows changes', () => {
    const { rerender } = render(<MemoryUsageBadge percentage={40} tokenLimit={1000} />);
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_usage: 40%');

    rerender(<MemoryUsageBadge percentage={55} tokenLimit={1000} />);
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_usage: 55%');
    expect(screen.getByRole('button', { name: /com_ui_usage/ })).toBeInTheDocument();
  });
});
