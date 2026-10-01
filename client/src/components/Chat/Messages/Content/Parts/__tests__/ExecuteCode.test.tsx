import React from 'react';
import { RecoilRoot } from 'recoil';
import { render } from '@testing-library/react';
import type { PtcTraceEntry } from '~/store/ptc';
import { ptcTraceByToolCallId, ptcTraceKey } from '~/store/ptc';
import { MessageContext } from '~/Providers/MessageContext';
import ExecuteCode from '../ExecuteCode';
import store from '~/store';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
  useProgress: (initialProgress: number) => initialProgress,
  useExpandCollapse: (isExpanded: boolean) => ({
    style: {
      display: 'grid',
      gridTemplateRows: isExpanded ? '1fr' : '0fr',
      opacity: isExpanded ? 1 : 0,
    },
    ref: { current: null },
  }),
}));

jest.mock('~/components/Chat/Messages/Content/ProgressText', () => ({
  __esModule: true,
  default: () => <div data-testid="progress-text" />,
}));

jest.mock('../CodeWindowHeader', () => ({
  __esModule: true,
  default: () => <div data-testid="code-window-header" />,
}));

jest.mock('../Attachment', () => ({
  AttachmentGroup: () => <div data-testid="attachment-group" />,
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

jest.mock('~/utils', () => ({
  ...jest.requireActual<typeof import('~/utils/toolLabels')>('~/utils/toolLabels'),
  ...jest.requireActual<typeof import('~/utils/runStepDuration')>('~/utils/runStepDuration'),
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

jest.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
jest.mock('~/hooks/MCP', () => ({ useMCPServerNames: () => [] }));

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
    <RecoilRoot initializeState={({ set }) => set(store.autoExpandTools, true)}>
      <ExecuteCode
        initialProgress={0.5}
        isSubmitting={true}
        args={{ lang: 'py', code }}
        output=""
      />
    </RecoilRoot>
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
      <RecoilRoot initializeState={({ set }) => set(store.autoExpandTools, true)}>
        <ExecuteCode
          initialProgress={1}
          isSubmitting={false}
          args={{ lang: 'py', code }}
          output="done"
        />
      </RecoilRoot>
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

  const renderWithTrace = (entries: PtcTraceEntry[]) =>
    render(
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.autoExpandTools, true);
          set(ptcTraceByToolCallId(ptcTraceKey(MESSAGE_ID, TOOL_CALL_ID)), { entries, dropped: 0 });
        }}
      >
        <MessageContext.Provider value={{ messageId: MESSAGE_ID, isExpanded: true }}>
          <ExecuteCode
            initialProgress={0.5}
            isSubmitting={true}
            toolCallId={TOOL_CALL_ID}
            args={{ lang: 'py', code: 'print(1)' }}
            output=""
          />
        </MessageContext.Provider>
      </RecoilRoot>,
    );

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
