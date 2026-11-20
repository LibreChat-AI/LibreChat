import React from 'react';
import { getDefaultStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { PermissionBits } from 'librechat-data-provider';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import type { TPromptGroup } from 'librechat-data-provider';
import { navigationGenerationAtom } from '~/store/navigation';
import ChatGroupItem from '../ChatGroupItem';

const mockMutate = jest.fn();
const mockRecordUsageMutate = jest.fn();
const mockSubmitPrompt = jest.fn();
const mockShowToast = jest.fn();
/** Native groups resolve from local text with no request; a test overrides this
 *  per-call (`mockResolvedValueOnce`/`mockRejectedValueOnce`/a controllable
 *  promise) to drive the Langfuse resolve paths. */
const mockResolve = jest.fn((group: TPromptGroup) =>
  Promise.resolve(group.productionPrompt?.prompt ?? ''),
);

jest.mock('~/data-provider', () => ({
  useRecordPromptUsage: () => ({ mutate: mockRecordUsageMutate }),
  useDeletePromptGroup: () => ({ mutate: mockMutate, isLoading: false }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
  useAuthContext: () => ({ user: { id: 'user-owner' } }),
  useSubmitMessage: () => ({ submitPrompt: mockSubmitPrompt }),
  usePromptContentResolver: () => mockResolve,
}));

/** Only `conversationId` matters: a saved chat's invalidation effect keys on
 *  the id, and a draft chat's keys on the composer draft token instead of
 *  this object, so the mock just needs to return a stable reference until a
 *  test swaps it for a different id. */
const mockConversation = { current: { conversationId: 'convo-1' as string | undefined } };
jest.mock('~/Providers', () => ({
  useLiveAnnouncer: () => ({ announcePolite: jest.fn() }),
  useChatContext: () => ({ conversation: mockConversation.current, index: 0 }),
}));

/** The real token lives in a module-level map keyed by composer index, which
 *  `useNewConvo` renews on a new-chat reset and keeps otherwise; the mock
 *  swaps in a plain symbol a test can renew by assignment. */
const mockDraftToken = { current: Symbol('new-conversation-draft') };
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  getNewConversationDraftToken: () => mockDraftToken.current,
}));

/** Keeps the real DropdownPopup/Ariakit menu behavior; only the tooltip
 *  popup (framer-motion driven) is stubbed to a plain pass-through. */
jest.mock('@librechat/client', () => {
  const actual = jest.requireActual('@librechat/client');
  return {
    ...actual,
    TooltipAnchor: ({ render: content }: { render: React.ReactNode }) => content,
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

/** Resolved relative to this test file, this is the same module ChatGroupItem
 *  imports via `../dialogs/VariableDialog`; stubbing it isolates the resolve/
 *  variables split from VariableForm's own rendering. */
jest.mock('../../dialogs/VariableDialog', () => ({
  __esModule: true,
  default: ({ open, promptText }: { open: boolean; promptText?: string }) =>
    open ? <div data-testid="variable-dialog">{promptText}</div> : null,
}));

function makeGroup(overrides: Partial<TPromptGroup> = {}): TPromptGroup {
  return {
    _id: 'group-1',
    name: 'Example Group',
    author: 'user-owner',
    authorName: 'Owner',
    source: 'native',
    ...overrides,
  } as TPromptGroup;
}

function renderGroup(group: TPromptGroup, permissionBits: number) {
  return render(
    <MemoryRouter>
      <ChatGroupItem group={group} isChatRoute={false} permissionBits={permissionBits} />
    </MemoryRouter>,
  );
}

function renderChatGroup(group: TPromptGroup, permissionBits = 0) {
  return render(
    <MemoryRouter>
      <ChatGroupItem group={group} isChatRoute={true} permissionBits={permissionBits} />
    </MemoryRouter>,
  );
}

/** Fires the same kind of navigation `useNewConvo`'s reset performs on a new
 *  chat: a push to `/c/new`, which produces a fresh router location key even
 *  though the pathname is unchanged. */
function NewChatResetTrigger() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid="simulate-new-chat-reset"
      onClick={() => navigate('/c/new')}
    />
  );
}

function renderDraftChatGroup(group: TPromptGroup, permissionBits = 0) {
  return render(
    <MemoryRouter initialEntries={['/c/new']}>
      <NewChatResetTrigger />
      <ChatGroupItem group={group} isChatRoute={true} permissionBits={permissionBits} />
    </MemoryRouter>,
  );
}

/** Fires a route change to a different path, the way browser Back/Forward
 *  moves `/c/:id` directly through the router without the conversation
 *  object changing first. */
function NavigateAwayTrigger({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" data-testid="navigate-away" onClick={() => navigate(to)} />;
}

function renderChatGroupWithNavigateAway(
  group: TPromptGroup,
  initialPath: string,
  destinationPath: string,
) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <NavigateAwayTrigger to={destinationPath} />
      <ChatGroupItem group={group} isChatRoute={true} />
    </MemoryRouter>,
  );
}

/** The clickable overlay button; its accessible name always starts with this
 *  prefix regardless of whether the group has a category. */
const getCardButton = () => screen.getByRole('button', { name: /com_ui_prompt_group_button/ });

const FULL_BITS =
  PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;

beforeEach(() => {
  mockDraftToken.current = Symbol('new-conversation-draft');
  getDefaultStore().set(navigationGenerationAtom, 0);
});

describe('ChatGroupItem menu', () => {
  beforeEach(() => {
    mockMutate.mockClear();
  });

  afterEach(() => {
    mockRecordUsageMutate.mockClear();
    mockSubmitPrompt.mockClear();
    mockShowToast.mockClear();
    mockResolve.mockReset();
    mockResolve.mockImplementation((group: TPromptGroup) =>
      Promise.resolve(group.productionPrompt?.prompt ?? ''),
    );
  });

  it('shows Edit and Delete for a native group owned by the caller', async () => {
    const user = userEvent.setup();
    renderGroup(makeGroup(), FULL_BITS);
    await user.click(screen.getByRole('button', { name: 'com_nav_convo_menu_options' }));

    expect(await screen.findByRole('menuitem', { name: /com_ui_edit/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /com_ui_delete/ })).toBeInTheDocument();
  });

  it('hides Edit and Delete for a Langfuse-managed group even with full ACL bits', async () => {
    const user = userEvent.setup();
    renderGroup(makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }), FULL_BITS);
    await user.click(screen.getByRole('button', { name: 'com_nav_convo_menu_options' }));

    // Preview always stays available.
    expect(await screen.findByRole('menuitem', { name: /com_ui_preview/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /com_ui_edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /com_ui_delete/ })).not.toBeInTheDocument();
  });

  it('shows a Langfuse badge for an externally managed group', () => {
    renderGroup(makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }), FULL_BITS);
    expect(screen.getByRole('img', { name: 'com_ui_prompt_source_langfuse' })).toBeInTheDocument();
  });

  it('does not show a Langfuse badge for a native group', () => {
    renderGroup(makeGroup(), FULL_BITS);
    expect(
      screen.queryByRole('img', { name: 'com_ui_prompt_source_langfuse' }),
    ).not.toBeInTheDocument();
  });
});

describe('ChatGroupItem chat-route click', () => {
  afterEach(() => {
    mockRecordUsageMutate.mockClear();
    mockSubmitPrompt.mockClear();
    mockShowToast.mockClear();
    mockResolve.mockReset();
    mockResolve.mockImplementation((group: TPromptGroup) =>
      Promise.resolve(group.productionPrompt?.prompt ?? ''),
    );
    mockConversation.current = { conversationId: 'convo-1' };
  });

  it('resolves a Langfuse group before submitting, and records usage once', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValueOnce('Resolved text');
    renderChatGroup(makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }));

    await user.click(getCardButton());

    await waitFor(() => expect(mockSubmitPrompt).toHaveBeenCalledWith('Resolved text'));
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockRecordUsageMutate).toHaveBeenCalledTimes(1);
    expect(mockRecordUsageMutate).toHaveBeenCalledWith('group-1');
  });

  it('ignores a second click while a Langfuse resolve is pending', async () => {
    const user = userEvent.setup();
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    renderChatGroup(makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }));

    const button = getCardButton();
    await user.click(button);
    await user.click(button);

    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockSubmitPrompt).not.toHaveBeenCalled();

    resolveFn('Resolved text');
    await waitFor(() => expect(mockSubmitPrompt).toHaveBeenCalledTimes(1));
    expect(mockSubmitPrompt).toHaveBeenCalledWith('Resolved text');
    expect(mockRecordUsageMutate).toHaveBeenCalledTimes(1);
  });

  it('opens the variable dialog with the resolved text and records nothing', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValueOnce('Hello {{name}}');
    renderChatGroup(makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }));

    await user.click(getCardButton());

    expect(await screen.findByTestId('variable-dialog')).toHaveTextContent('Hello {{name}}');
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(mockRecordUsageMutate).not.toHaveBeenCalled();
  });

  it('closes the variable dialog when a navigation starts while it is open', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValueOnce('Hello {{name}}');
    renderChatGroup(makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }));

    await user.click(getCardButton());
    expect(await screen.findByTestId('variable-dialog')).toBeInTheDocument();

    /** A dialog opened from a resolved Langfuse read must not survive a chat
     *  change and submit a variable fill into another chat. */
    getDefaultStore().set(navigationGenerationAtom, 1);

    await waitFor(() => expect(screen.queryByTestId('variable-dialog')).not.toBeInTheDocument());
  });

  it('shows the resolve error toast and records nothing on failure', async () => {
    const user = userEvent.setup();
    mockResolve.mockRejectedValueOnce(new Error('boom'));
    renderChatGroup(makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }));

    await user.click(getCardButton());

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        status: 'error',
        message: 'com_ui_langfuse_prompt_error_fallback',
      }),
    );
    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(mockRecordUsageMutate).not.toHaveBeenCalled();
  });

  it('submits and records a native prompt with no spinner', async () => {
    const user = userEvent.setup();
    const { container } = renderChatGroup(
      makeGroup({ productionPrompt: { prompt: 'Native text' } }),
    );

    await user.click(getCardButton());

    await waitFor(() => expect(mockSubmitPrompt).toHaveBeenCalledWith('Native text'));
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockRecordUsageMutate).toHaveBeenCalledTimes(1);
    expect(container.querySelector('svg.spinner')).not.toBeInTheDocument();
  });

  it('discards a Langfuse resolve that completes after the row unmounts', async () => {
    const user = userEvent.setup();
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    const { unmount } = renderChatGroup(
      makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }),
    );

    await user.click(getCardButton());
    expect(mockResolve).toHaveBeenCalledTimes(1);

    unmount();
    resolveFn('Resolved text');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(mockRecordUsageMutate).not.toHaveBeenCalled();
  });

  it('discards a Langfuse resolve and clears the busy state when the conversation changes first', async () => {
    const user = userEvent.setup();
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    mockConversation.current = { conversationId: 'convo-1' };
    const { rerender } = renderChatGroup(
      makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }),
    );

    await user.click(getCardButton());
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(getCardButton()).toBeDisabled();

    mockConversation.current = { conversationId: 'convo-2' };
    rerender(
      <MemoryRouter>
        <ChatGroupItem
          group={makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' })}
          isChatRoute={true}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getCardButton()).not.toBeDisabled());

    resolveFn('Resolved text');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(mockRecordUsageMutate).not.toHaveBeenCalled();
  });

  it('discards a Langfuse resolve and clears the busy state when a new-chat reset renews the draft token', async () => {
    const user = userEvent.setup();
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    mockConversation.current = { conversationId: 'new' };
    const { rerender } = renderChatGroup(
      makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }),
    );

    await user.click(getCardButton());
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(getCardButton()).toBeDisabled();

    /** `useNewConvo` renews the draft token on a new-chat reset, including
     *  when the composer is already on an unsaved chat; the invalidation
     *  must key on that, not on the conversation object. */
    mockDraftToken.current = Symbol('new-conversation-draft');
    rerender(
      <MemoryRouter>
        <ChatGroupItem
          group={makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' })}
          isChatRoute={true}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getCardButton()).not.toBeDisabled());

    resolveFn('Resolved text');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(mockRecordUsageMutate).not.toHaveBeenCalled();
  });

  it('discards a Langfuse resolve and clears the busy state when a navigation starts, before the target conversation commits', async () => {
    const user = userEvent.setup();
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    mockConversation.current = { conversationId: 'convo-1' };
    renderChatGroup(makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }));

    await user.click(getCardButton());
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(getCardButton()).toBeDisabled();

    /** `navigateToConvo` bumps `navigationGenerationAtom` as soon as a
     *  navigation starts, before the target conversation's record is
     *  fetched and `conversationId` changes — simulate just that bump,
     *  with the conversation left untouched. */
    getDefaultStore().set(navigationGenerationAtom, 1);

    await waitFor(() => expect(getCardButton()).not.toBeDisabled());

    resolveFn('Resolved text');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(mockRecordUsageMutate).not.toHaveBeenCalled();
  });

  it('discards a Langfuse resolve and clears the busy state when the route pathname changes, before the conversation updates', async () => {
    const user = userEvent.setup();
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    mockConversation.current = { conversationId: 'convo-1' };
    renderChatGroupWithNavigateAway(
      makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }),
      '/c/convo-1',
      '/c/convo-2',
    );

    await user.click(getCardButton());
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(getCardButton()).toBeDisabled();

    /** Browser Back/Forward moves `/c/:id` directly through the router;
     *  ChatRoute keeps the previous conversation mounted while the next one
     *  loads, so `conversationId` has not changed here even though the
     *  pathname has. */
    await user.click(screen.getByTestId('navigate-away'));

    await waitFor(() => expect(getCardButton()).not.toBeDisabled());

    resolveFn('Resolved text');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSubmitPrompt).not.toHaveBeenCalled();
    expect(mockRecordUsageMutate).not.toHaveBeenCalled();
  });

  it('lets a pending Langfuse resolve complete when a navigation changes the router location but keeps the same draft token', async () => {
    const user = userEvent.setup();
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    mockConversation.current = { conversationId: 'new' };
    renderDraftChatGroup(makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }));

    await user.click(getCardButton());
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(getCardButton()).toBeDisabled();

    /** A plain navigation (unlike `useNewConvo`'s reset) never touches the
     *  draft token, so a pending resolve must survive it. */
    await user.click(screen.getByTestId('simulate-new-chat-reset'));
    expect(getCardButton()).toBeDisabled();

    resolveFn('Resolved text');
    await waitFor(() => expect(mockSubmitPrompt).toHaveBeenCalledWith('Resolved text'));
    expect(mockRecordUsageMutate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getCardButton()).not.toBeDisabled());
  });

  it('lets a pending Langfuse resolve complete when a parameter edit replaces the conversation object on a draft chat', async () => {
    const user = userEvent.setup();
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    mockConversation.current = { conversationId: 'new' };
    const { rerender } = renderChatGroup(
      makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }),
    );

    await user.click(getCardButton());
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(getCardButton()).toBeDisabled();

    /** A parameter edit (e.g. `SidePanel/Parameters/Panel.tsx`) replaces the
     *  conversation object without renewing the draft token; the pending
     *  resolve must not be discarded. */
    mockConversation.current = { conversationId: 'new' };
    rerender(
      <MemoryRouter>
        <ChatGroupItem
          group={makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' })}
          isChatRoute={true}
        />
      </MemoryRouter>,
    );

    expect(getCardButton()).toBeDisabled();

    resolveFn('Resolved text');
    await waitFor(() => expect(mockSubmitPrompt).toHaveBeenCalledTimes(1));
    expect(mockSubmitPrompt).toHaveBeenCalledWith('Resolved text');
    expect(mockRecordUsageMutate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getCardButton()).not.toBeDisabled());
  });

  it('lets a pending Langfuse resolve complete when a same-chat update replaces the conversation object with the same id', async () => {
    const user = userEvent.setup();
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    mockConversation.current = { conversationId: 'convo-1' };
    const { rerender } = renderChatGroup(
      makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }),
    );

    await user.click(getCardButton());
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(getCardButton()).toBeDisabled();

    /** Streaming sync, a pin, or a project change replaces the conversation
     *  object without changing its id; the pending resolve must not be
     *  discarded, since the chat identity (the id) has not changed. */
    mockConversation.current = { conversationId: 'convo-1' };
    rerender(
      <MemoryRouter>
        <ChatGroupItem
          group={makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' })}
          isChatRoute={true}
        />
      </MemoryRouter>,
    );

    expect(getCardButton()).toBeDisabled();

    resolveFn('Resolved text');
    await waitFor(() => expect(mockSubmitPrompt).toHaveBeenCalledTimes(1));
    expect(mockSubmitPrompt).toHaveBeenCalledWith('Resolved text');
    expect(mockRecordUsageMutate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getCardButton()).not.toBeDisabled());
  });
});

describe('ChatGroupItem snippet', () => {
  it('renders no snippet text for an external group with no oneliner or text, since the Cloud badge already labels the source', () => {
    const { container } = renderGroup(
      makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }),
      0,
    );
    expect(screen.queryByText('com_ui_prompt_source_langfuse')).not.toBeInTheDocument();
    expect(container.querySelector('p')).toHaveTextContent('');
  });
});
