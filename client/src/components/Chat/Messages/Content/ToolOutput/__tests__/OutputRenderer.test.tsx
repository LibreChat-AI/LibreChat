import React from 'react';
import copy from 'copy-to-clipboard';
import { fireEvent, render, screen } from '@testing-library/react';
import OutputRenderer, { isError } from '../OutputRenderer';

jest.mock('copy-to-clipboard', () => jest.fn());

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Messages/Content/CopyButton', () => ({
  __esModule: true,
  default: ({ onClick, className }: { onClick: () => void; className?: string }) => (
    <button type="button" data-testid="copy-output" className={className} onClick={onClick} />
  ),
}));

describe('OutputRenderer', () => {
  it('lays the copy control over the bottom right of the output without reserving width', () => {
    render(<OutputRenderer text={'First line\nSecond line'} />);

    const copyButton = screen.getByTestId('copy-output');
    expect(copyButton).toHaveClass('absolute', 'right-0', 'bottom-0');
    expect(copyButton).toHaveClass('[@media(hover:hover)]:group-hover/copy:opacity-100');
    expect(copyButton.parentElement).toHaveClass('group/copy', 'relative');
    expect(copyButton.parentElement).not.toHaveClass('pr-10');
  });

  it('copies original bytes when a code result has been formatted for display', () => {
    const raw = 'stdout:\n{"ok":true}';
    render(<OutputRenderer text={'stdout:\n{\n  "ok": true\n}'} copyText={raw} />);
    fireEvent.click(screen.getByTestId('copy-output'));
    expect(copy).toHaveBeenCalledWith(raw, { format: 'text/plain' });
  });

  it('renders long output in full with no show more toggle', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const { unmount } = render(<OutputRenderer text={text} />);
    expect(screen.getByText(/line 1/).textContent?.split('\n')).toHaveLength(30);
    expect(screen.queryByText('com_ui_show_more')).not.toBeInTheDocument();
    unmount();

    render(<OutputRenderer text={text} variant="terminal" />);
    const pre = screen.getByText(/line 30/);
    expect(pre.textContent).toBe(text);
    expect(pre).toHaveClass('max-h-[300px]', 'overflow-auto');
    expect(screen.queryByText('com_ui_show_more')).not.toBeInTheDocument();
  });

  it('opens terminal output on its last lines and default output on its first', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const scrollHeight = jest
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(900);
    try {
      const { unmount } = render(<OutputRenderer text={text} variant="terminal" />);
      expect(screen.getByText(/line 30/).scrollTop).toBe(900);
      unmount();

      render(<OutputRenderer text={text} />);
      expect(screen.getByText(/line 30/).scrollTop).toBe(0);
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('stops following streamed terminal output once the reader scrolls up', () => {
    const lines = (count: number) =>
      Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
    const scrollHeight = jest
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(900);
    const clientHeight = jest
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(300);
    try {
      const { rerender } = render(<OutputRenderer text={lines(30)} variant="terminal" />);
      const pre = screen.getByText(/line 30/);
      expect(pre.scrollTop).toBe(900);

      pre.scrollTop = 100;
      fireEvent.scroll(pre);
      rerender(<OutputRenderer text={lines(40)} variant="terminal" />);
      expect(pre.scrollTop).toBe(100);

      pre.scrollTop = 600;
      fireEvent.scroll(pre);
      rerender(<OutputRenderer text={lines(50)} variant="terminal" />);
      expect(pre.scrollTop).toBe(900);
    } finally {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    }
  });

  it('keeps whitespace-only terminal output', () => {
    const { container } = render(<OutputRenderer text={'\n\n'} variant="terminal" />);
    expect(container.querySelector('pre')?.textContent).toBe('\n\n');
  });

  it('keeps segment styling across the full terminal output', () => {
    const out = Array.from({ length: 25 }, (_, i) => `out ${i + 1}`).join('\n') + '\n';
    const err = 'stderr:\nboom\n';
    const trailer = '[exit code: 1]';
    render(
      <OutputRenderer
        text={out + err + trailer}
        variant="terminal"
        segments={[
          { text: out },
          { text: err, className: 'text-status-error' },
          { text: trailer, className: 'text-text-tertiary' },
        ]}
      />,
    );
    const pre = screen.getByText(/out 25/).closest('pre') as HTMLElement;
    const shown = (pre.textContent ?? '').split('\n');
    expect(shown[0]).toBe('out 1');
    expect(pre.textContent).toBe(out + err + trailer);
    expect(screen.getByText(/boom/)).toHaveClass('text-status-error');
    expect(screen.getByText('[exit code: 1]')).toHaveClass('text-text-tertiary');
  });

  it('does not treat text between bracketed prefixes as a tool-call error', () => {
    expect(isError('Error: [agent] unexpected [search] tool call failed: unavailable')).toBe(false);
  });

  /** The server's `completedToolExecutionStatus` counts this shape as a
   *  failure while the run step stays `completed`; the card must agree with
   *  the label the server wrote for the same call. */
  it('treats schema-validation feedback as a failed call', () => {
    expect(
      isError(
        'Error: Tool "slow_echo" input failed schema validation. Missing required fields: text.' +
          "Use this tool's declared arguments.\n Please fix your mistakes.",
      ),
    ).toBe(true);
    expect(isError('Error: something went wrong, then it recovered')).toBe(false);
  });
});
