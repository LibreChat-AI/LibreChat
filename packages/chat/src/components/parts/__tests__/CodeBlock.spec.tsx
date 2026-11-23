/**
 * @jest-environment jsdom
 */
import React from 'react';
import copy from 'copy-to-clipboard';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { RunCodeProps } from '../CodeBar';
import CodeBlock from '../CodeBlock';

jest.mock('copy-to-clipboard', () => ({ __esModule: true, default: jest.fn() }));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

let observed: Element[] = [];
let report: ((visible: boolean) => void) | undefined;

beforeEach(() => {
  observed = [];
  report = undefined;
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      report = (visible) =>
        callback(
          [{ isIntersecting: visible } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
    }
    observe(element: Element) {
      observed.push(element);
    }
    disconnect() {}
  }
  window.IntersectionObserver = Observer as unknown as typeof IntersectionObserver;
  (copy as jest.Mock).mockClear();
});

const run = jest.fn((props: RunCodeProps) => (
  <button type="button" data-testid={props.iconOnly ? 'run-floating' : 'run'}>
    run {props.lang} {props.blockIndex}
  </button>
));

beforeEach(() => run.mockClear());

describe('CodeBlock', () => {
  it('draws the language, the code and the bar’s copy and download actions', () => {
    const { container } = render(<CodeBlock lang="python" codeChildren="print(1)" />);
    const code = container.querySelector('code');
    expect(code).toHaveClass('hljs', 'language-python');
    expect(code).toHaveTextContent('print(1)');
    expect(screen.getByText('python')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_copy_code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_download_code' })).toBeInTheDocument();
  });

  it('copies the code’s text, trimmed', () => {
    render(<CodeBlock lang="python" codeChildren={'  print(1)\n'} />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_copy_code' }));
    expect(copy).toHaveBeenCalledWith('print(1)', { format: 'text/plain' });
  });

  it('has no run button and no output without a host that runs code', () => {
    render(<CodeBlock lang="python" blockIndex={2} codeChildren="print(1)" />);
    expect(screen.queryByTestId('run')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-floating')).not.toBeInTheDocument();
  });

  it('draws the host’s run button in both bars, and its output under the code', () => {
    const { container } = render(
      <CodeBlock
        lang="python"
        blockIndex={2}
        renderRun={run}
        codeChildren="print(1)"
        output={<div data-testid="output">1</div>}
      />,
    );
    expect(screen.getByTestId('run')).toHaveTextContent('run python 2');
    expect(screen.getByTestId('run-floating')).toHaveTextContent('run python 2');
    const code = container.querySelector('code') as HTMLElement;
    for (const [props] of run.mock.calls) {
      expect(props.codeRef.current).toBe(code);
    }
    const output = screen.getByTestId('output');
    expect(code.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws neither where execution is not allowed', () => {
    render(
      <CodeBlock
        lang="python"
        renderRun={run}
        allowExecution={false}
        codeChildren="print(1)"
        output={<div data-testid="output">1</div>}
      />,
    );
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByTestId('output')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_copy_code' })).toBeInTheDocument();
  });

  it('shows a plugin’s payload as wrapped JSON with no actions', () => {
    const { container } = render(<CodeBlock lang="json" plugin={true} codeChildren="{}" />);
    expect(container.querySelector('code')).not.toHaveClass('hljs');
    expect(screen.queryByRole('button', { name: 'com_ui_copy_code' })).not.toBeInTheDocument();
  });

  it('floats its actions only while the block is hovered and its bar is out of view', () => {
    const { container } = render(<CodeBlock lang="python" codeChildren="print(1)" />);
    const block = container.firstElementChild as HTMLElement;
    const floating = block.querySelector('.absolute') as HTMLElement;
    expect(observed).toHaveLength(1);
    expect(floating).toHaveClass('opacity-0');

    fireEvent.mouseEnter(block);
    expect(floating).toHaveClass('opacity-0');

    act(() => report?.(false));
    expect(floating).toHaveClass('opacity-100');
    expect(within(floating).getAllByRole('button')[0]).toHaveAttribute('tabindex', '0');

    fireEvent.mouseLeave(block);
    expect(floating).toHaveClass('opacity-0');
  });
});
