import React from 'react';
import { Tools } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import MemoryCall from '../MemoryCall';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, params?: { tokens?: number }): string => {
      const translations: Record<string, string> = {
        com_ui_memory_saving: 'Saving memory',
        com_ui_memory_saved: 'Saved memory',
        com_ui_memory_deleting: 'Deleting memory',
        com_ui_memory_removed: 'Deleted memory',
        com_ui_memory_deleted: 'Memory deleted',
        com_ui_memory: 'Memory',
        com_ui_cancelled: 'Cancelled',
        com_ui_tool_failed: 'failed',
        com_ui_memory_would_exceed: `Cannot save: remove ${params?.tokens} tokens to make space.`,
      };
      return translations[key] ?? key;
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
    subtitle,
    hasInput,
  }: {
    phase: 'running' | 'completed' | 'cancelled' | 'failed';
    inProgressText: string;
    finishedText: string;
    subtitle?: string;
    hasInput?: boolean;
  }) => (
    <div data-testid="progress-text" data-has-input={String(!!hasInput)}>
      {phase === 'running' ? inProgressText : finishedText}
      {subtitle ? ` ${subtitle}` : ''}
      {phase === 'failed' ? ' failed' : ''}
    </div>
  ),
}));

jest.mock('../Attachment', () => ({
  AttachmentGroup: () => <div data-testid="attachment-group" />,
}));

jest.mock('../useToolCallState', () => ({
  __esModule: true,
  default: ({
    initialProgress,
    runStepStatus,
    extraError,
  }: {
    initialProgress: number;
    runStepStatus?: 'completed' | 'cancelled' | 'failed';
    extraError?: boolean;
  }) => {
    let phase: 'running' | 'completed' | 'cancelled' | 'failed' =
      initialProgress < 1 ? 'running' : 'completed';
    if (runStepStatus === 'cancelled') {
      phase = 'cancelled';
    } else if (runStepStatus === 'failed' || extraError) {
      phase = 'failed';
    }
    return {
      showCode: true,
      toggleCode: jest.fn(),
      expandStyle: {},
      expandRef: { current: null },
      phase,
    };
  },
}));

describe('MemoryCall', () => {
  it('labels a completed save with the memory key and shows the value', () => {
    render(
      <MemoryCall
        toolName="set_memory"
        initialProgress={1}
        isSubmitting={false}
        args={{ key: 'preferences', value: 'Prefers dark mode.' }}
        output={'Memory set for key "preferences" (4 tokens)'}
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Saved memory preferences');
    expect(screen.getByText('preferences')).toHaveClass('font-bold', 'uppercase');
    expect(screen.getByText('Prefers dark mode.')).toBeInTheDocument();
    expect(screen.queryByText(/Memory set for key/)).not.toBeInTheDocument();
  });

  it('labels an in-flight save without a parsed key', () => {
    render(
      <MemoryCall
        toolName="set_memory"
        initialProgress={0.5}
        isSubmitting={true}
        args={'{"ke'}
        output=""
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Saving memory');
    expect(screen.getByTestId('progress-text')).toHaveAttribute('data-has-input', 'false');
  });

  it('renders a delete as the key with a deletion note', () => {
    render(
      <MemoryCall
        toolName="delete_memory"
        initialProgress={1}
        isSubmitting={false}
        args={{ key: 'outdated_note' }}
        output={'Memory deleted for key "outdated_note"'}
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Deleted memory outdated_note');
    expect(screen.getByText('outdated_note')).toHaveClass('font-bold', 'uppercase');
    expect(screen.getByText('Memory deleted')).toBeInTheDocument();
  });

  it.each([
    ['set_memory', 'Invalid key "invalid". Must be one of: preferences'],
    ['set_memory', 'Memory storage would exceed limit. Cannot save this memory.'],
    ['set_memory', 'Failed to set memory for key "preferences"'],
    ['set_memory', '{"type":"content_filter","message":"Blocked"}'],
    ['delete_memory', 'Failed to delete memory for key "preferences"'],
  ] as const)('surfaces %s failure output instead of optimistic content', (toolName, output) => {
    render(
      <MemoryCall
        toolName={toolName}
        initialProgress={1}
        isSubmitting={false}
        args={{ key: 'preferences', value: 'requested value' }}
        output={output}
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Memory preferences failed');
    expect(screen.getByText(output)).toBeInTheDocument();
    expect(screen.queryByText('requested value')).not.toBeInTheDocument();
    expect(screen.queryByText('Memory deleted')).not.toBeInTheDocument();
  });

  it('honors an explicit failed run step even when the output resembles success', () => {
    render(
      <MemoryCall
        toolName="set_memory"
        initialProgress={1}
        isSubmitting={false}
        runStepStatus="failed"
        args={{ key: 'preferences', value: 'requested value' }}
        output={'Memory set for key "preferences" (4 tokens)'}
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Memory preferences failed');
    expect(screen.getByText(/Memory set for key/)).toBeInTheDocument();
    expect(screen.queryByText('requested value')).not.toBeInTheDocument();
  });

  it('shows the actionable overage from a linked memory error artifact', () => {
    const attachment: TAttachment = {
      type: Tools.memory,
      toolCallId: 'call_0',
      messageId: 'message-1',
      [Tools.memory]: {
        type: 'error',
        key: 'preferences',
        value: JSON.stringify({ errorType: 'would_exceed', tokenCount: 47 }),
      },
    };
    render(
      <MemoryCall
        toolName="set_memory"
        initialProgress={1}
        isSubmitting={false}
        args={{ key: 'preferences', value: 'requested value' }}
        output="Memory storage would exceed limit. Cannot save this memory."
        attachments={[attachment]}
        hideAttachments
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Cannot save: remove 47 tokens to make space.',
    );
    expect(screen.queryByText('requested value')).not.toBeInTheDocument();
  });
});
