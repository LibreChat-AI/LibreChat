import React, { useEffect } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { render, screen } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';

const mockStartup: {
  current: {
    pullRequestsEnabled?: boolean;
    pullRequestsBatchVersion?: number;
    pullRequestsCodeScoped?: boolean;
  };
} = {
  current: { pullRequestsEnabled: true, pullRequestsBatchVersion: 1, pullRequestsCodeScoped: true },
};
const mockMarkProps: Array<Record<string, unknown>> = [];
/** What the mock mark reports to the row, as the real one does once it has text to show. */
const mockMarkState = { described: true };

jest.mock('@librechat/client', () => ({
  useMediaQuery: () => false,
  useRemScale: () => 1,
  useToastContext: () => ({ showToast: jest.fn() }),
  Spinner: () => <svg data-testid="status-ring" />,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useNavigateToConvo: () => ({ navigateToConvo: jest.fn() }),
  useShiftKey: () => false,
}));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartup.current }),
  useUpdateConversationMutation: () => ({ mutateAsync: jest.fn() }),
  usePinConversationMutation: () => ({ mutate: jest.fn() }),
  useProjectName: () => 'Scheduling',
}));
jest.mock('react-router-dom', () => ({ useParams: () => ({ conversationId: 'convo-1' }) }));
jest.mock('recoil', () => ({ useRecoilValue: () => [] }));
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    allConversationsSelector: 'allConversationsSelector',
    conversationIdByIndex: () => 'conversationIdByIndex',
  },
}));
jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  logger: { error: jest.fn() },
  setDocumentTitle: jest.fn(),
  isConversationUnseen: () => false,
  hasRealTitle: (title: string) => !!title && title !== 'New Chat',
}));
jest.mock('../ConvoOptions', () => ({ ConvoOptions: () => <div data-testid="convo-options" /> }));
jest.mock('../ConversationEndpointIcon', () => ({
  __esModule: true,
  default: () => <div data-testid="convo-icon" />,
}));
jest.mock('../RenameForm', () => ({ __esModule: true, default: () => <form /> }));
/** Named with the `mock` prefix so the factory below may reference it, and a real component so
 *  its hook is legal. It reports its description to the row the way the real mark does. */
function MockRowMark({
  labelId,
  onDescribed,
  ...rest
}: Record<string, unknown> & { labelId: string; onDescribed?: (described: boolean) => void }) {
  mockMarkProps.push({ labelId, ...rest });
  useEffect(() => {
    onDescribed?.(mockMarkState.described);
    return () => onDescribed?.(false);
  }, [onDescribed]);
  if (!mockMarkState.described) return null;
  return (
    <button type="button" data-testid="convo-pull-request">
      <span id={labelId} data-testid="mark-description" />
    </button>
  );
}
const mockRowMark = MockRowMark;

jest.mock('~/components/Chat/PullRequest/RowMark', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => mockRowMark(props as never),
}));

import Conversation from '../Convo';

const conversation = {
  conversationId: 'convo-1',
  title: 'Tool Approval UI',
  codeEnvironmentMode: 'attached',
  codeWorkspaces: [{ environmentId: 'env', workspaceId: 'ws' }],
} as TConversation;
const ordinary = { conversationId: 'convo-1', title: 'Tool Approval UI' } as TConversation;

const renderRow = (props: { isGenerating?: boolean; convo?: TConversation } = {}) =>
  render(
    <DndProvider backend={HTML5Backend}>
      <Conversation
        conversation={props.convo ?? conversation}
        retainView={jest.fn()}
        toggleNav={jest.fn()}
        isGenerating={props.isGenerating}
      />
    </DndProvider>,
  );

const rowButton = () => screen.getByRole('button', { name: /^com_ui_conversation_label/ });

describe('Conversation row pull request', () => {
  beforeEach(() => {
    mockMarkProps.length = 0;
    mockMarkState.described = true;
    mockStartup.current = {
      pullRequestsEnabled: true,
      pullRequestsBatchVersion: 1,
      pullRequestsCodeScoped: true,
    };
  });

  it("keeps the title the conversation's own and puts the pull request beside it, outside the row button", () => {
    renderRow();
    expect(screen.getByText('Tool Approval UI')).toBeInTheDocument();
    const mark = screen.getByTestId('convo-pull-request');
    expect(rowButton()).not.toContainElement(mark);
    expect(screen.getByTestId('convo-item')).toContainElement(mark);
    expect(mark.parentElement?.parentElement).toBe(screen.getByTestId('convo-item'));
  });

  it('sits after the row menu, which grows on hover, so it does not slide out from under the pointer', () => {
    renderRow();
    const row = screen.getByTestId('convo-item');
    const mark = screen.getByTestId('convo-pull-request');
    const menuSlot = screen.getByTestId('convo-options').parentElement as HTMLElement;
    expect(row).toContainElement(menuSlot);
    expect(menuSlot.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.lastElementChild).toBe(mark.parentElement);
  });

  it("names the pull request in the row's description so a screen reader hears what the colors say", () => {
    renderRow();
    const labelId = String(mockMarkProps[0].labelId);
    expect(rowButton().getAttribute('aria-describedby')).toContain(labelId);
    expect(document.getElementById(labelId)).toBeInTheDocument();
  });

  it('tells the mark which conversation it is for and that this row is the open one', () => {
    renderRow();
    expect(mockMarkProps[0]).toMatchObject({ conversationId: 'convo-1', selected: true });
  });

  it('reserves no space around the mark, since an absent mark must leave the row unchanged', () => {
    renderRow();
    const wrapper = screen.getByTestId('convo-pull-request').parentElement as HTMLElement;
    expect(wrapper.className).not.toMatch(/\bm[rlxy]?-\d/);
    expect(wrapper.className).not.toMatch(/\bp[rlxy]?-\d/);
  });

  it('does not point the row at a description that is not in the page', () => {
    mockMarkState.described = false;
    renderRow();
    expect(screen.queryByTestId('convo-pull-request')).not.toBeInTheDocument();
    expect(rowButton().getAttribute('aria-describedby')).toBeNull();
    const ids = (rowButton().getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(ids.every((id) => document.getElementById(id) != null)).toBe(true);
  });

  it.each([
    ['not advertised', {}],
    ['advertised off', { pullRequestsEnabled: false }],
    ['advertised without the batch route', { pullRequestsEnabled: true }],
  ])('draws nothing and describes nothing when the feature is %s', (_label, startup) => {
    mockStartup.current = startup;
    renderRow();
    expect(screen.queryByTestId('convo-pull-request')).not.toBeInTheDocument();
    expect(mockMarkProps).toHaveLength(0);
    expect(rowButton().getAttribute('aria-describedby')).toBeNull();
  });

  it.each([
    ['has no code decision', ordinary],
    [
      'runs without an attached workspace',
      { ...ordinary, codeEnvironmentMode: 'without_attached' },
    ],
  ])('never asks for a chat that %s, so ordinary chats cost no lookup', (_label, convo) => {
    renderRow({ convo: convo as TConversation });
    expect(screen.queryByTestId('convo-pull-request')).not.toBeInTheDocument();
    expect(mockMarkProps).toHaveLength(0);
    expect(rowButton().getAttribute('aria-describedby')).toBeNull();
  });

  it('keeps asking for every row on a server that does not list the code decision', () => {
    mockStartup.current = { pullRequestsEnabled: true, pullRequestsBatchVersion: 1 };
    renderRow({ convo: ordinary });
    expect(screen.getByTestId('convo-pull-request')).toBeInTheDocument();
  });

  it('leaves the mark out while the chat runs, so the ring is the only status', () => {
    renderRow({ isGenerating: true });
    expect(screen.queryByTestId('convo-pull-request')).not.toBeInTheDocument();
    expect(screen.getByTestId('status-ring')).toBeInTheDocument();
  });
});
