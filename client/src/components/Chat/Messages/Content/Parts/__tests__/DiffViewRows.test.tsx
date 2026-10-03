import { render } from '@testing-library/react';
import DiffView, { parseUnifiedDiff } from '../DiffView';

const mockCn = jest.fn((...args: unknown[]) => args.filter((a) => typeof a === 'string').join(' '));

jest.mock('~/utils', () => ({
  cn: (...args: unknown[]) => mockCn(...args),
}));

const base = ['@@ -1,2 +1,2 @@', '-old one', '+new one', ' same'].join('\n');

describe('DiffView row memoization', () => {
  beforeEach(() => mockCn.mockClear());

  it('renders only the appended row when a line is added', () => {
    const { rerender, getByTestId } = render(<DiffView parsed={parseUnifiedDiff(base)} />);
    // Each non-hunk row calls cn twice (row and marker); three such rows.
    expect(mockCn).toHaveBeenCalledTimes(6);
    mockCn.mockClear();

    rerender(<DiffView parsed={parseUnifiedDiff(`${base}\n+appended`)} />);

    expect(mockCn).toHaveBeenCalledTimes(2);
    const rows = getByTestId('diff-view').children;
    expect(rows).toHaveLength(4);
    expect([...rows].map((row) => row.textContent)).toEqual([
      '1-old one',
      '1+new one',
      '2same',
      '3+appended',
    ]);
  });

  it('re-renders only the growing trailing row while it streams', () => {
    const { rerender, getByTestId } = render(
      <DiffView parsed={parseUnifiedDiff(`${base}\n+par`)} />,
    );
    mockCn.mockClear();

    rerender(<DiffView parsed={parseUnifiedDiff(`${base}\n+partial`)} />);

    expect(mockCn).toHaveBeenCalledTimes(2);
    expect(getByTestId('diff-view').lastElementChild?.textContent).toBe('3+partial');
  });
});
