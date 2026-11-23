import React from 'react';
import { Tools } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ToolCallResult } from 'librechat-data-provider';
import { ToolCallsMapContext } from '~/Providers/ToolCallsMapContext';
import { MessageContext } from '~/Providers/MessageContext';
import CodeBlock from '../CodeBlock';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/Providers', () => ({
  ...jest.requireActual('~/Providers/MessageContext'),
  ...jest.requireActual('~/Providers/ToolCallsMapContext'),
}));
jest.mock('~/hooks/Plugins/useToolCallsMap', () => ({ __esModule: true, default: () => ({}) }));
jest.mock('~/components/Chat/Messages/Content/Parts/LogContent', () => ({
  __esModule: true,
  default: ({ output }: { output?: string }) => <span data-testid="log">{output}</span>,
}));
jest.mock('~/components/Messages/Content/RunCode', () => ({
  __esModule: true,
  default: ({ iconOnly, blockIndex }: { iconOnly?: boolean; blockIndex?: number }) => (
    <button type="button" data-testid={iconOnly ? 'run-floating' : 'run'}>
      {`run ${blockIndex}`}
    </button>
  ),
}));

beforeAll(() => {
  window.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
});

const result = (text: string): ToolCallResult => ({ result: text }) as unknown as ToolCallResult;

function draw(
  runs: Record<string, ToolCallResult[]>,
  props: Partial<React.ComponentProps<typeof CodeBlock>> = {},
) {
  return render(
    <MessageContext.Provider
      value={
        { messageId: 'm1', partIndex: 3, conversationId: 'c1' } as React.ContextType<
          typeof MessageContext
        >
      }
    >
      <ToolCallsMapContext.Provider value={runs}>
        <CodeBlock lang="python" blockIndex={2} codeChildren="print(1)" {...props} />
      </ToolCallsMapContext.Provider>
    </MessageContext.Provider>,
  );
}

const KEY = `m1_3_2_${Tools.execute_code}`;

describe('CodeBlock with LibreChat’s code execution', () => {
  it('draws the run button in both bars and no output before a run', () => {
    draw({});
    expect(screen.getByTestId('run')).toHaveTextContent('run 2');
    expect(screen.getByTestId('run-floating')).toHaveTextContent('run 2');
    expect(screen.queryByTestId('log')).not.toBeInTheDocument();
  });

  it('shows the latest run of this block under the code, and steps back through earlier ones', () => {
    draw({
      [KEY]: [result('first'), result('second')],
      [`m1_3_0_${Tools.execute_code}`]: [result('other')],
    });
    expect(screen.getByText('com_ui_output')).toBeInTheDocument();
    expect(screen.getByTestId('log')).toHaveTextContent('second');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_prev_result' }));
    expect(screen.getByTestId('log')).toHaveTextContent('first');
  });

  it('offers no switcher for a single run', () => {
    draw({ [KEY]: [result('only')] });
    expect(screen.getByTestId('log')).toHaveTextContent('only');
    expect(screen.queryByRole('button', { name: 'com_ui_prev_result' })).not.toBeInTheDocument();
  });

  it('draws no run button and no output where execution is not allowed', () => {
    draw({ [KEY]: [result('hidden')] }, { allowExecution: false });
    expect(screen.queryByTestId('run')).not.toBeInTheDocument();
    expect(screen.queryByTestId('log')).not.toBeInTheDocument();
  });
});
