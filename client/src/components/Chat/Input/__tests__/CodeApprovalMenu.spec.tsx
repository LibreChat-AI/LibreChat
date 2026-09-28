import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, Constants, LocalStorageKeys } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import CodeApprovalMenu from '../CodeApprovalMenu';

const mockSetConversation = jest.fn();
const mockUseCodeApprovalMode = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useCodeApprovalMode: () => mockUseCodeApprovalMode(),
}));

const conversation = {
  conversationId: 'conversation-1',
  endpoint: 'agents',
  agent_id: 'agent-1',
  title: 'Code',
} as TConversation;

describe('CodeApprovalMenu', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseCodeApprovalMode.mockReturnValue({
      available: true,
      modes: ['ask', 'acceptEdits'],
      selected: 'ask',
    });
  });

  let queryClient: QueryClient;

  const renderMenu = () => {
    queryClient = new QueryClient();
    return render(
      <QueryClientProvider client={queryClient}>
        <CodeApprovalMenu
          conversation={conversation}
          setConversation={mockSetConversation}
          disabled={false}
        />
      </QueryClientProvider>,
    );
  };

  test('defaults to ask and stores accept-edits on the conversation', async () => {
    renderMenu();

    await userEvent.click(screen.getByTestId('code-approval-mode'));
    await userEvent.click(await screen.findByText('com_ui_code_approval_accept_edits'));

    const update = mockSetConversation.mock.calls[0][0];
    expect(update(conversation)).toEqual({ ...conversation, codeApprovalMode: 'acceptEdits' });
  });

  test('writes the pick into the conversation detail cache', async () => {
    renderMenu();
    const key = [QueryKeys.conversation, conversation.conversationId];
    queryClient.setQueryData<TConversation>(key, { ...conversation, codeApprovalMode: 'ask' });

    await userEvent.click(screen.getByTestId('code-approval-mode'));
    await userEvent.click(await screen.findByText('com_ui_code_approval_accept_edits'));

    expect(queryClient.getQueryData<TConversation>(key)?.codeApprovalMode).toBe('acceptEdits');
  });

  test('seeds a detail record from the live conversation when none exists yet', async () => {
    renderMenu();

    await userEvent.click(screen.getByTestId('code-approval-mode'));
    await userEvent.click(await screen.findByText('com_ui_code_approval_accept_edits'));

    expect(queryClient.getQueryData([QueryKeys.conversation, conversation.conversationId])).toEqual(
      { ...conversation, codeApprovalMode: 'acceptEdits' },
    );
  });

  test('leaves the detail cache alone for a chat that has no id yet', async () => {
    queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <CodeApprovalMenu
          conversation={{ ...conversation, conversationId: Constants.NEW_CONVO as string }}
          setConversation={mockSetConversation}
          disabled={false}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByTestId('code-approval-mode'));
    await userEvent.click(await screen.findByText('com_ui_code_approval_accept_edits'));

    expect(queryClient.getQueryData([QueryKeys.conversation, Constants.NEW_CONVO])).toBeUndefined();
  });

  test('offers every mode as a radio and marks the selected one', async () => {
    renderMenu();

    const trigger = screen.getByTestId('code-approval-mode');
    expect(trigger).toHaveTextContent('com_ui_code_approval_ask');
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const menu = await screen.findByRole('menu', { name: 'com_ui_code_approval_mode' });
    expect(document.querySelector('h1')).toBeNull();
    const options = within(menu).getAllByRole('menuitemradio');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute('aria-checked', 'true');
    expect(options[0]).toHaveTextContent('com_ui_code_approval_ask_description');
    expect(options[1]).toHaveAttribute('aria-checked', 'false');
    expect(options[1]).toHaveTextContent('com_ui_code_approval_accept_edits_description');
  });

  test('draws the trigger from the shared composer control appearance', () => {
    renderMenu();

    expect(screen.getByTestId('code-approval-mode')).toHaveClass(
      'h-theme-control',
      'rounded-theme-control-round',
      'gap-theme-compact',
      'border-border-medium',
    );
  });

  test('offers only the modes the conversation allows', async () => {
    mockUseCodeApprovalMode.mockReturnValue({
      available: true,
      modes: ['ask'],
      selected: 'ask',
    });
    renderMenu();

    await userEvent.click(screen.getByTestId('code-approval-mode'));

    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(1);
  });

  test('hides the control when code approvals are unavailable', () => {
    mockUseCodeApprovalMode.mockReturnValue({ available: false, modes: [] });

    renderMenu();
    expect(screen.queryByTestId('code-approval-mode')).not.toBeInTheDocument();
  });

  test('selects full access on the conversation with sandbox scope explained', async () => {
    mockUseCodeApprovalMode.mockReturnValue({
      available: true,
      modes: ['ask', 'acceptEdits', 'fullAccess'],
      selected: 'ask',
    });
    renderMenu();

    await userEvent.click(screen.getByTestId('code-approval-mode'));
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitemradio')).toHaveLength(3);
    expect(screen.getByText('com_ui_code_approval_full_access_description')).toBeInTheDocument();
    await userEvent.click(screen.getByText('com_ui_code_approval_full_access'));
    expect(mockSetConversation.mock.calls[0][0](conversation)).toEqual({
      ...conversation,
      codeApprovalMode: 'fullAccess',
    });
  });
});

test("remembers the pick as this browser's default for the next chat", async () => {
  localStorage.clear();
  mockUseCodeApprovalMode.mockReturnValue({
    available: true,
    modes: ['ask', 'acceptEdits'],
    selected: 'ask',
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CodeApprovalMenu
        conversation={conversation}
        setConversation={mockSetConversation}
        disabled={false}
      />
    </QueryClientProvider>,
  );

  await userEvent.click(screen.getByTestId('code-approval-mode'));
  await userEvent.click(await screen.findByText('com_ui_code_approval_accept_edits'));

  expect(localStorage.getItem(LocalStorageKeys.LAST_CODE_APPROVAL_MODE)).toBe(
    JSON.stringify('acceptEdits'),
  );
});
