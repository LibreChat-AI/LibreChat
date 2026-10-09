import React from 'react';
import { render, screen } from '@testing-library/react';
import FileAuthoringCall from '../FileAuthoringCall';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, values?: Record<string | number, string>): string => {
      const translations: Record<string, string> = {
        com_ui_created_file: 'Created {{0}}',
        com_ui_creating_file: 'Creating {{0}}',
        com_ui_updated_file: 'Updated {{0}}',
        com_ui_edited_file: 'Edited {{0}}',
        com_ui_editing_file: 'Editing {{0}}',
        com_ui_cancelled: 'Cancelled',
        com_ui_tool_failed: 'failed',
      };
      return (translations[key] ?? key).replace('{{0}}', values?.[0] ?? '');
    },
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

jest.mock('~/components/Chat/Messages/Content/ProgressText', () => ({
  __esModule: true,
  default: ({
    phase,
    inProgressText,
    finishedText,
    icon,
  }: {
    phase: 'running' | 'completed' | 'cancelled' | 'failed';
    inProgressText: string;
    finishedText: string;
    icon: React.ReactNode;
  }) => (
    <div data-testid="progress-text">
      {icon}
      {phase === 'running' ? inProgressText : finishedText}
    </div>
  ),
}));

jest.mock('../CodeWindowHeader', () => ({
  __esModule: true,
  default: ({ language }: { language: string }) => (
    <div data-testid="code-window-header" data-language={language} />
  ),
}));

jest.mock('../Attachment', () => ({
  AttachmentGroup: () => <div data-testid="attachment-group" />,
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

jest.mock('../useToolCallState', () => ({
  __esModule: true,
  /** Mirrors the real hook: options object in, a single `phase` out. */
  default: ({ initialProgress }: { initialProgress: number }) => ({
    showCode: true,
    toggleCode: jest.fn(),
    expandStyle: {},
    expandRef: { current: null },
    progress: initialProgress,
    phase: initialProgress < 1 ? 'running' : 'completed',
  }),
}));

describe('FileAuthoringCall', () => {
  it('shows create_file content args while the call is in progress', () => {
    render(
      <FileAuthoringCall
        toolName="create_file"
        initialProgress={0.5}
        isSubmitting={true}
        args={{
          file_path: 'skills/demo/SKILL.md',
          content: '# Demo\n\nUse this skill for testing.',
        }}
        output=""
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Creating SKILL.md');
    expect(screen.getByTestId('code-window-header')).toHaveAttribute('data-language', 'SKILL.md');
    expect(screen.getByText(/Use this skill for testing/)).toBeInTheDocument();
  });

  it('keeps authored content visible alongside the output after create_file completes', () => {
    render(
      <FileAuthoringCall
        toolName="create_file"
        initialProgress={1}
        isSubmitting={false}
        args={{
          file_path: 'skills/demo/SKILL.md',
          content: '# Demo\n\nLarge generated body stays visible after completion.',
        }}
        output="Created skills/demo/SKILL.md (4096 chars)."
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Created SKILL.md');
    expect(screen.getByTestId('code-window-header')).toHaveAttribute('data-language', 'SKILL.md');
    expect(screen.getByText(/Large generated body stays visible/)).toBeInTheDocument();
    expect(screen.getByText('Created skills/demo/SKILL.md (4096 chars).')).toBeInTheDocument();
  });

  it('labels a create_file overwrite as Updated when the output summary says so', () => {
    render(
      <FileAuthoringCall
        toolName="create_file"
        initialProgress={1}
        isSubmitting={false}
        args={{
          file_path: 'skills/demo/SKILL.md',
          content: '# Demo\n\nRevised body.',
        }}
        output="Updated skills/demo/SKILL.md (8302 chars)."
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Updated SKILL.md');
    expect(document.querySelector('.lucide-file-pen-line')).not.toBeNull();
  });

  it('prefers the output diff over the args preview after edit_file completes', () => {
    const output = [
      'Edited skills/demo/SKILL.md (exact match).',
      '',
      '--- skills/demo/SKILL.md',
      '+++ skills/demo/SKILL.md',
      '@@ -1,1 +1,1 @@',
      '-old line',
      '+new line',
    ].join('\n');
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={1}
        isSubmitting={false}
        args={{
          file_path: 'skills/demo/SKILL.md',
          old_text: 'old line',
          new_text: 'new line',
        }}
        output={output}
      />,
    );

    expect(screen.getByText('old line')).toBeInTheDocument();
    expect(screen.getByText('new line')).toBeInTheDocument();
    expect(screen.queryByText(/--- old_text/)).not.toBeInTheDocument();
  });

  it('shows the attempted input alongside the error output when edit_file fails', () => {
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={1}
        isSubmitting={false}
        args={{
          file_path: 'skills/demo/SKILL.md',
          old_text: 'missing text',
          new_text: 'replacement',
        }}
        output="Error: old_text matched 0 locations in skills/demo/SKILL.md."
      />,
    );

    expect(screen.getByText('missing text')).toBeInTheDocument();
    expect(screen.getByText('replacement')).toBeInTheDocument();
    expect(screen.getByText(/matched 0 locations/)).toBeInTheDocument();
  });

  it('shows edit_file replacement args while the call is in progress', () => {
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={0.5}
        isSubmitting={true}
        args={{
          file_path: 'skills/demo/SKILL.md',
          old_text: 'description: Old behavior',
          new_text: 'description: New behavior',
        }}
        output=""
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Editing SKILL.md');
    expect(screen.getByTestId('code-window-header')).toHaveAttribute('data-language', 'SKILL.md');
    expect(screen.queryByText(/--- old_text/)).not.toBeInTheDocument();
    expect(screen.getByText('description: Old behavior')).toBeInTheDocument();
    expect(screen.getByText('description: New behavior')).toBeInTheDocument();
  });

  it('streams create_file content from partial JSON string args during run_step_delta', () => {
    render(
      <FileAuthoringCall
        toolName="create_file"
        initialProgress={0.5}
        isSubmitting={true}
        args={'{"file_path":"skills/demo/SKILL.md","content":"# Demo\\n\\nStreaming body so far'}
        output=""
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Creating SKILL.md');
    expect(screen.getByTestId('code-window-header')).toHaveAttribute('data-language', 'SKILL.md');
    expect(screen.getByText(/Streaming body so far/)).toBeInTheDocument();
  });

  it('streams edit_file replacement preview from partial JSON string args', () => {
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={0.5}
        isSubmitting={true}
        args={
          '{"file_path":"skills/demo/SKILL.md","old_text":"description: Old behavior","new_text":"description: New beh'
        }
        output=""
      />,
    );

    expect(screen.getByText('description: Old behavior')).toBeInTheDocument();
    expect(screen.getByText('description: New beh')).toBeInTheDocument();
  });

  it('streams batched edit_file previews from a partial edits array', () => {
    const args =
      '{"file_path":"skills/demo/SKILL.md","edits":[' +
      '{"old_text":"first old","new_text":"first new"},' +
      '{"old_text":"second old","new_text":"second n';
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={0.5}
        isSubmitting={true}
        args={args}
        output=""
      />,
    );

    const diff = screen.getByTestId('diff-view');
    expect(screen.getByText('first old')).toBeInTheDocument();
    expect(screen.getByText('first new')).toBeInTheDocument();
    expect(screen.getByText('second old')).toBeInTheDocument();
    expect(screen.getByText('second n')).toBeInTheDocument();
    expect(diff).toBeInTheDocument();
  });

  it('shows batched edit_file replacements from edits args while the call is in progress', () => {
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={0.5}
        isSubmitting={true}
        args={{
          file_path: 'skills/demo/SKILL.md',
          edits: [
            { old_text: 'first old', new_text: 'first new' },
            { old_text: 'second old', new_text: 'second new' },
          ],
        }}
        output=""
      />,
    );

    expect(screen.getByText('first old')).toBeInTheDocument();
    expect(screen.getByText('second new')).toBeInTheDocument();
  });
  it('renders replacements from a JSON-stringified edits batch after workspace update', () => {
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={1}
        isSubmitting={false}
        args={{
          file_path: 'workspace/demo/SKILL.md',
          edits: JSON.stringify([
            { old_text: 'description: Old behavior', new_text: 'description: New behavior' },
            { old_text: 'status: draft', new_text: 'status: published' },
          ]),
        }}
        output="Updated workspace/demo/SKILL.md with 2 exact replacements."
      />,
    );

    expect(screen.getByText('description: Old behavior')).toBeInTheDocument();
    expect(screen.getByText('description: New behavior')).toBeInTheDocument();
    expect(screen.getByText('status: draft')).toBeInTheDocument();
    expect(screen.getByText('status: published')).toBeInTheDocument();
    expect(
      screen.getByText('Updated workspace/demo/SKILL.md with 2 exact replacements.'),
    ).toBeInTheDocument();
  });

  it('renders replacements from JSON-stringified edits entries after workspace update', () => {
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={1}
        isSubmitting={false}
        args={{
          file_path: 'workspace/demo/SKILL.md',
          edits: [
            JSON.stringify({ old_text: 'enabled: false', new_text: 'enabled: true' }),
            JSON.stringify({ old_text: 'tier: free', new_text: 'tier: pro' }),
          ],
        }}
        output="Updated workspace/demo/SKILL.md with 2 exact replacements."
      />,
    );

    expect(screen.getByText('enabled: false')).toBeInTheDocument();
    expect(screen.getByText('enabled: true')).toBeInTheDocument();
    expect(screen.getByText('tier: free')).toBeInTheDocument();
    expect(screen.getByText('tier: pro')).toBeInTheDocument();
  });
});

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

describe('FileAuthoringCall streaming follow-scroll', () => {
  const streamingCreate = (content: string) => (
    <FileAuthoringCall
      toolName="create_file"
      initialProgress={0.5}
      isSubmitting={true}
      args={`{"file_path":"skills/demo/SKILL.md","content":"${content}`}
      output=""
    />
  );

  it('pins the preview to the authored content as rendered, including the highlight commit', () => {
    const { container, rerender } = render(streamingCreate('# Demo\\nline one'));
    const pane = container.querySelector('.overflow-auto') as HTMLElement;
    const state = mockScrollMetrics(pane, 300, { deriveHeightFromText: true });

    rerender(streamingCreate('# Demo\\nline one\\nline two of the streamed body'));

    expect(pane.textContent).toContain('line two of the streamed body');
    expect(state.scrollTop).toBe((pane.textContent?.length ?? 0) * 10);
  });

  it('leaves a finished create_file preview alone', () => {
    const finishedCreate = (content: string) => (
      <FileAuthoringCall
        toolName="create_file"
        initialProgress={1}
        isSubmitting={false}
        args={{ file_path: 'skills/demo/SKILL.md', content }}
        output="Created skills/demo/SKILL.md (4096 chars)."
      />
    );
    const { container, rerender } = render(finishedCreate('# Demo\nline one'));
    const pane = container.querySelector('.overflow-auto') as HTMLElement;
    const state = mockScrollMetrics(pane, 300);
    state.scrollHeight = 1200;

    rerender(finishedCreate('# Demo\nline one\nline two'));

    expect(state.writes).toHaveLength(0);
  });
});
