import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChildConversationTurn } from './adapters';
import type { TurnAuthor } from './author';
import SubagentConversation from './SubagentConversation';
import { ChatSurfaceHarness } from 'test/harness';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => undefined,
}));

jest.mock('~/components/Chat/Messages/Content/ContentParts', () => ({
  __esModule: true,
  default: ({
    content,
    messageId,
  }: {
    content: Array<Record<string, unknown>>;
    messageId: string;
  }) => (
    <div data-testid="shared-content-parts" data-message-id={messageId}>
      {content.map((part, index) => (
        <span key={index}>
          {(part.text as string | undefined) ??
            (part.think as string | undefined) ??
            (part.tool_call as { name?: string } | undefined)?.name ??
            ''}
        </span>
      ))}
    </div>
  ),
}));

jest.mock('~/components/Chat/Messages/Content/Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('~/components/Chat/Messages/Content/Parts', () => ({
  EmptyText: ({ underHeaderIcon }: { underHeaderIcon?: boolean }) => (
    <div data-testid="thinking-cursor" data-under-header-icon={String(underHeaderIcon === true)} />
  ),
}));

jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: () => <span data-testid="message-icon" />,
}));

jest.mock('lucide-react', () => ({
  AlertCircle: () => null,
  Bot: () => null,
  CheckCircle2: () => null,
  Clock3: () => null,
  ChevronDown: () => null,
  CornerDownRight: () => null,
  Radio: () => null,
  XCircle: () => null,
  Zap: () => null,
}));

const author: TurnAuthor = { name: 'Research child', icon: <span data-testid="child-face" /> };
const parentAuthor: TurnAuthor = { name: 'Lia', icon: <span data-testid="parent-face" /> };

const turns: ChildConversationTurn[] = [
  {
    taskId: 'task-1',
    trigger: {
      kind: 'parent_dispatch',
      summary: 'Investigate the release.',
      createdAt: '2026-08-25T12:00:00.000Z',
    },
    activity: {
      title: 'Research child',
      status: 'completed',
      items: [
        { type: 'reasoning', text: 'Checked the constraints.' },
        {
          type: 'tool',
          toolCallId: 'search-1',
          name: 'search',
          status: 'completed',
          outputTruncated: true,
        },
        { type: 'writing', text: 'The release is ready.' },
      ],
    },
  },
  {
    taskId: 'task-2',
    trigger: {
      kind: 'external_event',
      summary: '',
      externalEvent: {
        eventType: 'chess.turn.ready',
        sourceType: 'speed-chess',
        occurredAt: '2026-08-25T12:01:00.000Z',
        expectedActionToolName: 'submit_move',
      },
    },
    activity: {
      title: 'Research child',
      status: 'running',
      items: [],
    },
  },
];

describe('SubagentConversation', () => {
  it('renders parent turns and child activity through the main chat row and content modules', () => {
    const { container } = render(
      <ChatSurfaceHarness>
        <SubagentConversation turns={turns} author={author} parentAuthor={parentAuthor} />
      </ChatSurfaceHarness>,
    );

    /** The parent's briefing is a user turn in the parent's name, filled like
     *  one; only the external event, which no agent wrote, is a system turn. */
    const briefing = screen.getByRole('group', { name: 'com_ui_subagent_trigger_parent_dispatch' });
    expect(briefing).toHaveClass('justify-end');
    expect(within(briefing).getByRole('heading', { name: /Lia$/ })).toBeInTheDocument();
    expect(within(briefing).getByTestId('parent-face')).toBeInTheDocument();
    expect(within(briefing).getByTestId('message-body')).toHaveClass('bg-surface-tertiary');
    expect(screen.queryByText('com_ui_subagent_trigger_parent_dispatch')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_subagent_trigger_external_event')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: /^com_ui_system_event/ })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'Research child' })).toHaveLength(2);
    expect(screen.getByText('Investigate the release.')).toBeInTheDocument();
    expect(screen.getByText('Checked the constraints.')).toBeInTheDocument();
    expect(screen.getByText('search')).toBeInTheDocument();
    expect(screen.getByText('The release is ready.')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_subagent_thread_status_completed')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_subagent_thread_status_running')).not.toBeInTheDocument();
    /** Both halves of the main chat author column: the shared glyph, and the
     *  streaming dot inset onto that glyph's axis the way main chat insets it. */
    expect(screen.getAllByTestId('child-face')).toHaveLength(2);
    expect(screen.getByTestId('thinking-cursor')).toHaveAttribute('data-under-header-icon', 'true');
    expect(container.querySelectorAll('.message-render')).toHaveLength(4);
    expect(container.querySelectorAll('.user-turn')).toHaveLength(2);
    expect(container.querySelectorAll('.agent-turn')).toHaveLength(2);
    expect(container.querySelector('[data-subagent-conversation]')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_prompt')).not.toBeInTheDocument();
    expect(
      screen.queryByText('com_ui_subagent_activity_details_truncated'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('com_ui_subagent_activity_details_unavailable'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('stream-elapsed')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', {
        name: /com_ui_subagent_trigger_external_event.*chess\.turn\.ready.*speed-chess/,
      }),
    );
    expect(screen.getByText('chess.turn.ready')).toBeInTheDocument();
    expect(screen.getByText('speed-chess')).toBeInTheDocument();
    expect(screen.getByText('submit_move')).toBeInTheDocument();
  });

  it('names an empty parent follow-up instead of rendering a blank bubble', () => {
    const followUp: ChildConversationTurn = {
      ...turns[0],
      taskId: 'task-4',
      trigger: { kind: 'parent_continuation', summary: '' },
    };
    render(
      <ChatSurfaceHarness>
        <SubagentConversation turns={[followUp]} author={author} parentAuthor={parentAuthor} />
      </ChatSurfaceHarness>,
    );

    const row = screen.getByRole('group', { name: 'com_ui_subagent_trigger_parent_continuation' });
    expect(within(row).getByRole('heading', { name: /Lia$/ })).toBeInTheDocument();
    expect(
      within(row).getByText('com_ui_subagent_trigger_parent_continuation'),
    ).toBeInTheDocument();
    expect(within(row).queryByTestId('shared-content-parts')).not.toBeInTheDocument();
  });

  it('requests an exact bounded projection only when shortened turn activity is opened', () => {
    const loadDetails = jest.fn();
    const shortened = [
      { ...turns[0], activity: { ...turns[0].activity, activityTruncated: true } },
    ];
    render(
      <ChatSurfaceHarness>
        <SubagentConversation
          turns={shortened}
          author={author}
          parentAuthor={parentAuthor}
          onLoadTurnDetails={loadDetails}
        />
      </ChatSurfaceHarness>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_subagent_show_full_activity' }));
    expect(loadDetails).toHaveBeenCalledWith('task-1');
  });

  it('gives repeated external-event disclosures distinguishable accessible names', () => {
    const secondEvent: ChildConversationTurn = {
      ...turns[1],
      taskId: 'task-3',
      trigger: {
        kind: 'external_event',
        summary: '',
        externalEvent: {
          eventType: 'chess.turn.ready',
          sourceType: 'speed-chess',
          occurredAt: '2026-08-25T12:02:00.000Z',
        },
      },
    };

    render(
      <ChatSurfaceHarness>
        <SubagentConversation
          turns={[turns[1], secondEvent]}
          author={author}
          parentAuthor={parentAuthor}
        />
      </ChatSurfaceHarness>,
    );

    expect(
      screen.getByRole('button', {
        name: /com_ui_subagent_trigger_external_event.*chess\.turn\.ready.*speed-chess.*2026-08-25T12:01:00.000Z/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /com_ui_subagent_trigger_external_event.*chess\.turn\.ready.*speed-chess.*2026-08-25T12:02:00.000Z/,
      }),
    ).toBeInTheDocument();
  });
});
