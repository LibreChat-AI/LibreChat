/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../react/host';
import CodeAnalyze from '../CodeAnalyze';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

jest.mock('../../../react/parts/useProgress', () => ({
  __esModule: true,
  default: (initial: number) => initial,
}));

beforeAll(() => {
  window.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
});

/** `autoExpand` is the reader's setting that tool cards open by themselves. */
const draw = (props: Partial<React.ComponentProps<typeof CodeAnalyze>> = {}, autoExpand = true) =>
  render(
    <MessagePartsHostProvider
      host={createMessagePartsHost({ useAutoExpandTools: () => autoExpand })}
    >
      <CodeAnalyze initialProgress={1} code="print(1)" outputs={[]} {...props} />
    </MessagePartsHostProvider>,
  );

describe('CodeAnalyze', () => {
  it('announces that it is analyzing while the call runs, and that it finished after', () => {
    const { container, unmount } = draw({ initialProgress: 0.1 });
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('com_ui_analyzing');
    unmount();
    const finished = draw({ initialProgress: 1 });
    expect(finished.container.querySelector('[aria-live="polite"]')).toHaveTextContent(
      'com_ui_analyzing_finished',
    );
  });

  it('shows the code it ran as a Python block where tool cards open by themselves', () => {
    const { container } = draw();
    const block = container.querySelector('.code-analyze-block');
    expect(block?.querySelector('code.language-python')).toHaveTextContent('print(1)');
  });

  it('joins the logs of its outputs under the code, and skips outputs with none', () => {
    const { container } = draw({
      outputs: [{ logs: 'first' }, { image: 'file_1' }, { logs: 'second' }],
    });
    expect(screen.getByText('com_ui_result')).toBeInTheDocument();
    expect(container.querySelector('.code-analyze-block pre[dir="ltr"]')?.textContent).toBe(
      'first\nsecond\n',
    );
  });

  it('has no result pane when nothing was logged', () => {
    draw({ outputs: [{ image: 'file_1' }] });
    expect(screen.queryByText('com_ui_result')).not.toBeInTheDocument();
  });

  it('stays folded where they do not, and tells the caller when the reader opens it', () => {
    const onExpand = jest.fn();
    const { container } = draw({ onExpand }, false);
    expect(container.querySelector('.code-analyze-block')).toBeNull();

    const toggle = screen.getByRole('button', { name: /com_ui_analyzing_finished/ });
    fireEvent.click(toggle);
    expect(container.querySelector('.code-analyze-block')).not.toBeNull();
    expect(onExpand).toHaveBeenCalledTimes(1);

    fireEvent.click(toggle);
    expect(container.querySelector('.code-analyze-block')).toBeNull();
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('offers nothing to open when the call has no code', () => {
    draw({ code: '' });
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
