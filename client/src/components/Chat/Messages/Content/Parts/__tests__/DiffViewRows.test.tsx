import { render } from '@testing-library/react';
import DiffView, { parseUnifiedDiff } from '../DiffView';
import { cn } from '~/utils';

jest.mock('~/utils', () => {
  const actual = jest.requireActual('~/utils');
  return { ...actual, cn: jest.fn(actual.cn) };
});

const cnSpy = jest.mocked(cn);
const base = ['@@ -1,2 +1,2 @@', '-old one', '+new one', ' same'].join('\n');

/** Renders the base diff and returns how many `cn` calls one row costs, so the
 *  assertions below compare row renders instead of pinning the call count. */
function renderBase(diff: string) {
  cnSpy.mockClear();
  const utils = render(<DiffView parsed={parseUnifiedDiff(diff)} />);
  const rowCount = utils.getByTestId('diff-view').children.length;
  const callsPerRow = cnSpy.mock.calls.length / rowCount;
  cnSpy.mockClear();
  return { ...utils, callsPerRow };
}

describe('DiffView row memoization', () => {
  it('renders only the appended row when a line is added', () => {
    const { rerender, getByTestId, callsPerRow } = renderBase(base);
    expect(callsPerRow).toBeGreaterThan(0);

    rerender(<DiffView parsed={parseUnifiedDiff(`${base}\n+appended`)} />);

    expect(cnSpy).toHaveBeenCalledTimes(callsPerRow);
    const rows = [...getByTestId('diff-view').children];
    expect(rows.map((row) => row.textContent)).toEqual([
      '1-old one',
      '1+new one',
      '2same',
      '3+appended',
    ]);
    expect(rows[0]).toHaveClass('bg-status-error-subtle');
    expect(rows[3]).toHaveClass('flex', 'bg-status-success-subtle');
    expect(rows[3]).not.toHaveClass('bg-status-error-subtle');
  });

  it('re-renders only the growing trailing row while it streams', () => {
    const { rerender, getByTestId, callsPerRow } = renderBase(`${base}\n+par`);

    rerender(<DiffView parsed={parseUnifiedDiff(`${base}\n+partial`)} />);

    expect(cnSpy).toHaveBeenCalledTimes(callsPerRow);
    expect(getByTestId('diff-view').lastElementChild?.textContent).toBe('3+partial');
  });
});
