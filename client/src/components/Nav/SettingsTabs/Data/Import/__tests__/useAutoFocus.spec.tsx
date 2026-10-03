import { render } from '@testing-library/react';
import useAutoFocus from '../useAutoFocus';

function Panel({ focusKey }: { focusKey: string }) {
  const ref = useAutoFocus<HTMLDivElement, string>(focusKey);
  return (
    <div>
      <div ref={ref} tabIndex={-1} data-testid="target">
        {focusKey}
      </div>
    </div>
  );
}

describe('useAutoFocus', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('takes focus when nothing else holds it, so the flow is followable', () => {
    const { getByTestId } = render(<Panel focusKey="summary" />);

    expect(document.activeElement).toBe(getByTestId('target'));
  });

  /**
   * The settings search mounts every matching setting as the user types, so a
   * single keystroke matching "Import" used to rip the caret out of the search
   * box. Focus that belongs to someone else is never taken (WCAG 3.2.1).
   */
  it('leaves focus alone when it belongs to an element outside the panel', () => {
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();

    render(<Panel focusKey="loading" />);

    expect(document.activeElement).toBe(outside);
  });

  it('still moves focus on a state change once focus is inside the panel', () => {
    const { getByTestId, rerender } = render(<Panel focusKey="summary" />);
    expect(document.activeElement).toBe(getByTestId('target'));

    rerender(<Panel focusKey="conversations" />);

    expect(document.activeElement).toBe(getByTestId('target'));
    expect(getByTestId('target')).toHaveTextContent('conversations');
  });

  it('does not steal focus on a phase change while the user is elsewhere', () => {
    const { rerender } = render(<Panel focusKey="assets" />);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    rerender(<Panel focusKey="conversations" />);

    expect(document.activeElement).toBe(outside);
  });
});
