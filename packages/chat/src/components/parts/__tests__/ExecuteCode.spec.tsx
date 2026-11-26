/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render } from '@testing-library/react';
import { createStore, useAtomValue, Provider as JotaiProvider } from 'jotai';
import type { PtcTraceEntry } from '../../../core/ptc';
import { ptcTraceByToolCallId, ptcTraceKey } from '../../../react/stream/ptc';
import { MessageContext, useMessageContext } from '../../../react/message';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../react/host';
import ExecuteCode from '../ExecuteCode';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize:
    () =>
    (key: string): string =>
      key,
}));

jest.mock('../../../react/parts/useProgress', () => ({
  __esModule: true,
  default: (initialProgress: number) => initialProgress,
}));

jest.mock('../ProgressText', () => ({
  __esModule: true,
  default: () => <div data-testid="progress-text" />,
}));

jest.mock('../CodeWindowHeader', () => ({
  __esModule: true,
  default: () => <div data-testid="code-window-header" />,
}));

jest.mock('../Attachment', () => ({
  __esModule: true,
  ...jest.requireActual('../Attachment'),
  AttachmentGroup: () => <div data-testid="attachment-group" />,
}));

jest.mock('../useExpandCollapse', () => ({
  __esModule: true,
  ...jest.requireActual('../useExpandCollapse'),
  default: (isExpanded: boolean) => ({
    style: {
      display: 'grid',
      gridTemplateRows: isExpanded ? '1fr' : '0fr',
      opacity: isExpanded ? 1 : 0,
    },
    ref: { current: null },
  }),
}));

jest.mock('../Stdout', () => ({
  __esModule: true,
  default: () => <div data-testid="stdout" />,
}));

jest.mock('../useLazyHighlight', () => {
  const { useState, useEffect } = jest.requireActual<typeof import('react')>('react');
  /** Mirrors the real hook's two-phase contract: the render that changed
   *  `code` still shows the previous highlight (or null), and the new
   *  nodes commit in a later passive effect. */
  const useMockLazyHighlight = (code?: string) => {
    const [highlighted, setHighlighted] = useState<string[] | null>(null);
    useEffect(() => {
      setHighlighted(code == null ? null : [code]);
    }, [code]);
    return highlighted;
  };
  return { __esModule: true, default: useMockLazyHighlight };
});

jest.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));

/**
 * The host these cases run under: tools open on arrival, mirroring the user who watches the code
 * pane while the call runs, and the trace is live state scoped to the card's message.
 */
const host = createMessagePartsHost({
  useAutoExpandTools: () => true,
  useMessage: () => useMessageContext(),
  usePtcTrace: (messageId, toolCallId) =>
    useAtomValue(
      ptcTraceByToolCallId(toolCallId && messageId ? ptcTraceKey(messageId, toolCallId) : ''),
    ),
});

function Host({ children }: { children: React.ReactNode }): React.ReactElement {
  return <MessagePartsHostProvider host={host}>{children}</MessagePartsHostProvider>;
}

/**
 * jsdom has no layout, so the capped pane's scroll geometry is stubbed:
 * `clientHeight` is fixed, `scrollHeight` either reads from mutable state
 * or derives from the pane's rendered text (so the async highlight commit
 * measurably changes it), and every `scrollTop` write the component makes
 * is recorded.
 */
const mockScrollMetrics = (
  el: HTMLElement,
  clientHeight: number,
  opts: { deriveHeightFromText?: boolean } = {},
) => {
  const state = { scrollHeight: 0, scrollTop: 0, writes: [] as number[] };
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () =>
      opts.deriveHeightFromText === true ? (el.textContent?.length ?? 0) * 10 : state.scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = value;
      state.writes.push(value);
    },
  });
  return state;
};

describe('ExecuteCode streaming follow-scroll', () => {
  /** `autoExpandTools` opens the pane at mount, mirroring the user who
   *  watches the code pane while the call runs. */
  const runningCall = (code: string) => (
    <Host>
      <ExecuteCode
        initialProgress={0.5}
        isSubmitting={true}
        args={{ lang: 'py', code }}
        output=""
      />
    </Host>
  );

  it('pins the code pane to the code as rendered, including the async highlight commit', () => {
    const { container, rerender } = render(runningCall('print(1)'));
    const pane = container.querySelector('.overflow-auto') as HTMLElement;
    const state = mockScrollMetrics(pane, 300, { deriveHeightFromText: true });

    rerender(runningCall('print(1)\nprint(2)\nprint(3) # a much longer block'));

    expect(pane.textContent).toContain('a much longer block');
    expect(state.scrollTop).toBe((pane.textContent?.length ?? 0) * 10);
  });

  it('never scrolls a finished call', () => {
    const finishedCall = (code: string) => (
      <Host>
        <ExecuteCode
          initialProgress={1}
          isSubmitting={false}
          args={{ lang: 'py', code }}
          output="done"
        />
      </Host>
    );
    const { container, rerender } = render(finishedCall('print(1)'));
    const pane = container.querySelector('.overflow-auto') as HTMLElement;
    const state = mockScrollMetrics(pane, 300);
    state.scrollHeight = 900;

    rerender(finishedCall('print(1)\nprint(2)'));

    expect(state.writes).toHaveLength(0);
  });
});

describe('ExecuteCode programmatic tool trace', () => {
  const TOOL_CALL_ID = 'call_ptc_1';
  const MESSAGE_ID = 'response-msg-1';

  const renderWithTrace = (entries: PtcTraceEntry[]) => {
    const traceStore = createStore();
    traceStore.set(ptcTraceByToolCallId(ptcTraceKey(MESSAGE_ID, TOOL_CALL_ID)), {
      entries,
      dropped: 0,
    });
    return render(
      <Host>
        <JotaiProvider store={traceStore}>
          <MessageContext.Provider value={{ messageId: MESSAGE_ID, isExpanded: true }}>
            <ExecuteCode
              initialProgress={0.5}
              isSubmitting={true}
              toolCallId={TOOL_CALL_ID}
              args={{ lang: 'py', code: 'print(1)' }}
              output=""
            />
          </MessageContext.Provider>
        </JotaiProvider>
      </Host>,
    );
  };

  it('lists the inner tool calls the running program has made', () => {
    const { getByText } = renderWithTrace([
      { callId: 'a', name: 'read_file', status: 'success', args: 'path=a.ts', durationMs: 1200 },
    ]);

    expect(getByText('path=a.ts')).toBeInTheDocument();
  });

  it('adds nothing to a plain code execution that made no inner calls', () => {
    const { queryByText } = renderWithTrace([]);

    expect(queryByText('com_ui_ptc_trace_title')).not.toBeInTheDocument();
  });
});
