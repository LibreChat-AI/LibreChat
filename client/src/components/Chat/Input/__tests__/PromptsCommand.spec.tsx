/**
 * Locks in the `/` prompts popover keyboard contract, specifically the
 * empty-result edge case that mirrors the `$` skills command and the `@`
 * mention popover: when filtering yields zero matches the arrow keys must
 * be no-ops (never `% 0` into a `NaN` active index) and Enter/Tab must
 * close the popover and return focus to the textarea. Deleting back to a
 * non-empty list has to leave keyboard navigation working.
 */
import React from 'react';
import { Cloud } from 'lucide-react';
import { getDefaultStore } from 'jotai';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TPromptGroup } from 'librechat-data-provider';
import type { PromptOption } from '~/common';
import { navigationGenerationAtom } from '~/store/navigation';

const PLACEHOLDER = 'com_ui_command_usage_placeholder';

const mockSetShowPromptsPopover = jest.fn();
const mockShowPromptsPopover = { current: true };
const mockRequestAllPromptGroups = jest.fn();

jest.mock('recoil', () => {
  const actual = jest.requireActual('recoil');
  return {
    ...actual,
    useRecoilValue: jest.fn((atom: unknown) =>
      atom === 'show-prompts-popover' ? mockShowPromptsPopover.current : undefined,
    ),
    useSetRecoilState: jest.fn((atom: unknown) =>
      atom === 'show-prompts-popover' ? mockSetShowPromptsPopover : jest.fn(),
    ),
  };
});

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    showPromptsPopoverFamily: () => 'show-prompts-popover',
  },
}));

const mockRecordUsage = jest.fn();
jest.mock('~/data-provider', () => ({
  useRecordPromptUsage: () => ({ mutate: mockRecordUsage }),
}));

const mockPromptGroupsContext = jest.fn();
/** Only `conversationId` matters: a saved chat's invalidation effect keys on
 *  the id, and a draft chat's keys on the composer draft token instead of
 *  this object, so the mock just needs to return a stable reference until a
 *  test swaps it for a different id. */
const mockConversation = { current: { conversationId: 'convo-1' as string | undefined } };
jest.mock('~/Providers', () => ({
  usePromptGroupsContext: () => mockPromptGroupsContext(),
  useChatContext: () => ({ conversation: mockConversation.current }),
}));

/** The real token lives in a module-level map keyed by composer index, which
 *  `useNewConvo` renews on a new-chat reset and keeps otherwise; the mock
 *  swaps in a plain symbol a test can renew by assignment. */
const mockDraftToken = { current: Symbol('new-conversation-draft') };
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  getNewConversationDraftToken: () => mockDraftToken.current,
}));

jest.mock('~/components/Prompts', () => ({
  VariableDialog: ({ open, promptText }: { open: boolean; promptText?: string }) =>
    open ? <div data-testid="variable-dialog">{promptText}</div> : null,
}));

const mockShowToast = jest.fn();
jest.mock('@librechat/client', () => {
  const actual = jest.requireActual('@librechat/client');
  return {
    ...actual,
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

/** Native groups resolve from local text with no request; a test overrides this
 *  per-call to drive the Langfuse resolve paths. */
const mockResolve = jest.fn((group: TPromptGroup) =>
  Promise.resolve(group.productionPrompt?.prompt ?? ''),
);

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  activateCatalog: jest.fn(),
  usePromptContentResolver: () => mockResolve,
}));

/* react-virtualized renders nothing in jsdom without a measured size; replace
   AutoSizer + List with a flat ul so every row's MentionItem button renders. */
jest.mock('react-virtualized', () => ({
  ...jest.requireActual('react-virtualized'),
  AutoSizer: ({ children }: { children: (size: { width: number }) => React.ReactNode }) =>
    children({ width: 320 }),
  List: ({
    rowCount,
    rowRenderer,
  }: {
    rowCount: number;
    rowRenderer: (args: {
      index: number;
      key: string;
      style: React.CSSProperties;
    }) => React.ReactNode;
  }) => {
    const rows: React.ReactNode[] = [];
    for (let i = 0; i < rowCount; i++) {
      rows.push(rowRenderer({ index: i, key: `row-${i}`, style: {} }));
    }
    return <ul data-testid="prompts-list">{rows}</ul>;
  },
}));

import PromptsCommand from '../PromptsCommand';

const makeTextarea = (initial = '/') => {
  const textarea = document.createElement('textarea');
  textarea.value = initial;
  document.body.appendChild(textarea);
  return { current: textarea } as React.MutableRefObject<HTMLTextAreaElement | null>;
};

const makePrompt = (overrides: Partial<PromptOption>): PromptOption => ({
  id: '1',
  type: 'prompt',
  label: 'Alpha',
  value: 'Alpha',
  description: '',
  ...overrides,
});

const promptGroups: PromptOption[] = [
  makePrompt({ id: '1', label: 'Alpha', value: 'Alpha' }),
  makePrompt({ id: '2', label: 'Beta', value: 'Beta' }),
];

const promptsMap = {
  '1': { _id: '1', productionPrompt: { prompt: 'Alpha body' } },
  '2': { _id: '2', productionPrompt: { prompt: 'Beta body' } },
};

const activeItemId = () =>
  document.querySelector('.bg-surface-active')?.closest('button')?.id ?? null;

const getInput = () => screen.getByPlaceholderText(PLACEHOLDER);

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  /* `clearAllMocks` keeps a queued `mockResolvedValueOnce`/`mockRejectedValueOnce` from a
     prior test; reset fully so each test starts from the plain pass-through resolver. */
  mockResolve.mockReset();
  mockResolve.mockImplementation((group: TPromptGroup) =>
    Promise.resolve(group.productionPrompt?.prompt ?? ''),
  );
  document.body.innerHTML = '';
  mockShowPromptsPopover.current = true;
  mockConversation.current = { conversationId: 'convo-1' };
  mockDraftToken.current = Symbol('new-conversation-draft');
  getDefaultStore().set(navigationGenerationAtom, 0);
  mockPromptGroupsContext.mockReturnValue({
    hasAccess: true,
    allPromptGroups: {
      data: { promptGroups, promptsMap },
      isLoading: false,
    },
    requestAllPromptGroups: mockRequestAllPromptGroups,
  });
});

const renderCommand = () => {
  const textAreaRef = makeTextarea('/');
  const utils = render(
    <MemoryRouter initialEntries={['/c/convo-1']}>
      <PromptsCommand index={0} textAreaRef={textAreaRef} submitPrompt={jest.fn()} />
    </MemoryRouter>,
  );
  return { textAreaRef, ...utils };
};

/** Renders `PromptsCommand` with a caller-supplied `textAreaRef`/`submitPrompt`,
 *  inside the same `MemoryRouter` the real app provides, since the component
 *  reads `useLocation()`. */
const renderPromptsCommand = (
  textAreaRef: React.MutableRefObject<HTMLTextAreaElement | null>,
  submitPrompt: (textPrompt: string) => void,
  initialPath = '/c/convo-1',
) =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <PromptsCommand index={0} textAreaRef={textAreaRef} submitPrompt={submitPrompt} />
    </MemoryRouter>,
  );

/** Fires a route change to a different path, the way browser Back/Forward
 *  moves `/c/:id` directly through the router without the conversation
 *  object changing first. */
function NavigateAwayTrigger({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" data-testid="navigate-away" onClick={() => navigate(to)} />;
}

describe('PromptsCommand keyboard navigation', () => {
  it('renders nothing when the popover atom is false', () => {
    mockShowPromptsPopover.current = false;
    const { container } = renderCommand();
    expect(container).toBeEmptyDOMElement();
  });
  it('moves the active highlight with ArrowDown/ArrowUp and wraps around', () => {
    renderCommand();
    const input = getInput();

    expect(activeItemId()).toBe('prompt-item-0');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeItemId()).toBe('prompt-item-1');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeItemId()).toBe('prompt-item-0');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeItemId()).toBe('prompt-item-1');
  });

  it('keeps navigation working after filtering to zero matches and back', () => {
    renderCommand();
    const input = getInput();

    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.queryByRole('button')).toBeNull();

    /* Arrow keys on an empty list must be no-ops, not `% 0` -> NaN. */
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getAllByRole('button')).toHaveLength(2);

    /* Without the guard the active index would still be NaN here and no
       item would highlight; with it, navigation resumes from a valid index. */
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeItemId()).toBe('prompt-item-1');
  });

  it('closes the popover and refocuses the textarea when Enter is pressed with no matches', () => {
    const { textAreaRef } = renderCommand();
    const input = getInput();

    fireEvent.change(input, { target: { value: 'zzz' } });
    const notPrevented = fireEvent.keyDown(input, { key: 'Enter' });

    expect(notPrevented).toBe(false);
    expect(mockSetShowPromptsPopover).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(textAreaRef.current);
  });

  it('prevents the default Tab action when closing on no matches so the refocus sticks', () => {
    const { textAreaRef } = renderCommand();
    const input = getInput();

    fireEvent.change(input, { target: { value: 'zzz' } });
    const notPrevented = fireEvent.keyDown(input, { key: 'Tab' });

    /* Without preventDefault the browser's default Tab would move focus off
       the textarea right after we refocus it. */
    expect(notPrevented).toBe(false);
    expect(mockSetShowPromptsPopover).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(textAreaRef.current);
  });

  it('clears the stale search filter when the popover closes', () => {
    renderCommand();
    const input = getInput();

    fireEvent.change(input, { target: { value: 'zzz' } });
    expect((input as HTMLInputElement).value).toBe('zzz');

    /* PromptsCommand stays mounted across close (unlike Mention), so a leftover
       no-match query has to be cleared or the popover reopens still filtered. */
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((getInput() as HTMLInputElement).value).toBe('');
  });
});

describe('PromptsCommand lazy prompt loading', () => {
  it('requests the full prompt list when the popover is shown', () => {
    mockShowPromptsPopover.current = true;
    renderCommand();
    expect(mockRequestAllPromptGroups).toHaveBeenCalledTimes(1);
  });

  it('does not request the full prompt list while the popover is hidden', () => {
    mockShowPromptsPopover.current = false;
    renderCommand();
    expect(mockRequestAllPromptGroups).not.toHaveBeenCalled();
  });
});

describe('PromptsCommand Langfuse resolve', () => {
  const langfuseGroup = {
    _id: '3',
    source: 'langfuse',
    sourcePromptName: 'lf-prompt',
  } as TPromptGroup;

  const extendedPromptsMap = { ...promptsMap, '3': langfuseGroup };
  const extendedPromptGroups: PromptOption[] = [
    ...promptGroups,
    makePrompt({
      id: '3',
      label: 'Gamma',
      value: 'Gamma',
      description: 'com_ui_prompt_source_langfuse',
      icon: (
        <span data-testid="cloud-icon">
          <Cloud />
        </span>
      ),
    }),
  ];

  beforeEach(() => {
    mockPromptGroupsContext.mockReturnValue({
      hasAccess: true,
      allPromptGroups: {
        data: { promptGroups: extendedPromptGroups, promptsMap: extendedPromptsMap },
        isLoading: false,
      },
      requestAllPromptGroups: mockRequestAllPromptGroups,
    });
  });

  it('renders a Cloud icon and the source description on a Langfuse row', () => {
    renderCommand();
    expect(screen.getByTestId('cloud-icon')).toBeInTheDocument();
    expect(screen.getByText('com_ui_prompt_source_langfuse')).toBeInTheDocument();
  });

  it('shows the resolving toast, submits the resolved text, and records usage once', async () => {
    mockResolve.mockResolvedValueOnce('Resolved Gamma text');
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    renderPromptsCommand(textAreaRef, submitPrompt);

    fireEvent.click(screen.getByText('Gamma'));

    expect(mockShowToast).toHaveBeenCalledWith({
      status: 'info',
      message: 'com_ui_prompt_resolving',
    });

    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith('Resolved Gamma text'));
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith('3');
    expect(textAreaRef.current).toBe(document.activeElement);
  });

  it('submits and records nothing, and refocuses the textarea, when a Langfuse resolve returns only whitespace', async () => {
    mockResolve.mockResolvedValueOnce('   ');
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    renderPromptsCommand(textAreaRef, submitPrompt);

    fireEvent.click(screen.getByText('Gamma'));

    await waitFor(() => expect(mockResolve).toHaveBeenCalledTimes(1));
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(mockRecordUsage).not.toHaveBeenCalled();
    expect(textAreaRef.current).toBe(document.activeElement);
  });

  it('shows the error toast and submits/records nothing when resolution fails', async () => {
    mockResolve.mockRejectedValueOnce(new Error('boom'));
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    renderPromptsCommand(textAreaRef, submitPrompt);

    fireEvent.click(screen.getByText('Gamma'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        status: 'error',
        message: 'com_ui_langfuse_prompt_error_fallback',
      }),
    );
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('focuses the textarea when a Tab-selected Langfuse resolve fails', async () => {
    mockResolve.mockRejectedValueOnce(new Error('boom'));
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    renderPromptsCommand(textAreaRef, submitPrompt);

    const input = getInput();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Tab' });

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        status: 'error',
        message: 'com_ui_langfuse_prompt_error_fallback',
      }),
    );
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(textAreaRef.current).toBe(document.activeElement);
  });

  it('discards a Langfuse resolve that completes after the popover unmounts', async () => {
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    const { unmount } = renderPromptsCommand(textAreaRef, submitPrompt);

    fireEvent.click(screen.getByText('Gamma'));
    expect(mockResolve).toHaveBeenCalledTimes(1);

    unmount();
    resolveFn('Resolved Gamma text');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitPrompt).not.toHaveBeenCalled();
    expect(mockRecordUsage).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('discards a Langfuse resolve and clears the busy flag when a new-chat reset renews the draft token', async () => {
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    mockConversation.current = { conversationId: 'new' };
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    const { rerender } = renderPromptsCommand(textAreaRef, submitPrompt);

    fireEvent.click(screen.getByText('Gamma'));
    expect(mockResolve).toHaveBeenCalledTimes(1);

    /** `useNewConvo` renews the draft token on a new-chat reset, including
     *  when the composer is already on an unsaved chat; the invalidation
     *  must key on that, not on the conversation object, so a fresh
     *  selection is not blocked by the stale pending resolve. */
    mockDraftToken.current = Symbol('new-conversation-draft');
    rerender(
      <MemoryRouter initialEntries={['/c/convo-1']}>
        <PromptsCommand index={0} textAreaRef={textAreaRef} submitPrompt={submitPrompt} />
      </MemoryRouter>,
    );

    /* Selecting Gamma closed the popover; reopen it the same way a user
       would (focusing the input) before picking a fresh entry. */
    fireEvent.focus(getInput());
    fireEvent.click(screen.getByText('Alpha'));
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith('Alpha body'));
    expect(mockRecordUsage).toHaveBeenCalledWith('1');

    resolveFn('Resolved Gamma text');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitPrompt).not.toHaveBeenCalledWith('Resolved Gamma text');
    expect(mockRecordUsage).not.toHaveBeenCalledWith('3');
  });

  it('discards a Langfuse resolve and clears the busy flag when a navigation starts, before the target conversation commits', async () => {
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    mockConversation.current = { conversationId: 'convo-1' };
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    renderPromptsCommand(textAreaRef, submitPrompt);

    fireEvent.click(screen.getByText('Gamma'));
    expect(mockResolve).toHaveBeenCalledTimes(1);

    /** `navigateToConvo` bumps `navigationGenerationAtom` as soon as a
     *  navigation starts, before the target conversation's record is
     *  fetched and `conversationId` changes — simulate just that bump,
     *  with the conversation left untouched. `act` flushes the resulting
     *  re-render synchronously, the same way a real navigation's state
     *  update would land before this component's next render. */
    act(() => {
      getDefaultStore().set(navigationGenerationAtom, 1);
    });

    resolveFn('Resolved Gamma text');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitPrompt).not.toHaveBeenCalledWith('Resolved Gamma text');
    expect(mockRecordUsage).not.toHaveBeenCalledWith('3');

    /* The busy flag was cleared by the generation bump, not just by the
       discarded resolve's own `finally` block, so a fresh selection right
       after is not blocked. */
    fireEvent.focus(getInput());
    fireEvent.click(screen.getByText('Alpha'));
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith('Alpha body'));
    expect(mockRecordUsage).toHaveBeenCalledWith('1');
  });

  it('discards a Langfuse resolve and clears the busy flag when the route pathname changes, before the conversation updates', async () => {
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    mockConversation.current = { conversationId: 'convo-1' };
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    render(
      <MemoryRouter initialEntries={['/c/convo-1']}>
        <NavigateAwayTrigger to="/c/convo-2" />
        <PromptsCommand index={0} textAreaRef={textAreaRef} submitPrompt={submitPrompt} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Gamma'));
    expect(mockResolve).toHaveBeenCalledTimes(1);

    /** Browser Back/Forward moves `/c/:id` directly through the router;
     *  ChatRoute keeps the previous conversation mounted while the next one
     *  loads, so `conversationId` has not changed here even though the
     *  pathname has. */
    fireEvent.click(screen.getByTestId('navigate-away'));

    resolveFn('Resolved Gamma text');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitPrompt).not.toHaveBeenCalledWith('Resolved Gamma text');
    expect(mockRecordUsage).not.toHaveBeenCalledWith('3');

    /* The busy flag was cleared by the pathname change, not just by the
       discarded resolve's own `finally` block, so a fresh selection right
       after is not blocked. */
    fireEvent.focus(getInput());
    fireEvent.click(screen.getByText('Alpha'));
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith('Alpha body'));
    expect(mockRecordUsage).toHaveBeenCalledWith('1');
  });

  it('lets a pending Langfuse resolve complete when a same-path re-navigation leaves the pathname unchanged', async () => {
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    mockConversation.current = { conversationId: 'new' };
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    render(
      <MemoryRouter initialEntries={['/c/new']}>
        <NavigateAwayTrigger to="/c/new" />
        <PromptsCommand index={0} textAreaRef={textAreaRef} submitPrompt={submitPrompt} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Gamma'));
    expect(mockResolve).toHaveBeenCalledTimes(1);

    /** A same-path re-navigation to `/c/new`, such as a new-chat reset that
     *  lands back where it started, leaves the pathname unchanged and must
     *  not cancel the pending resolve. */
    fireEvent.click(screen.getByTestId('navigate-away'));

    resolveFn('Resolved Gamma text');
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith('Resolved Gamma text'));
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith('3');
  });

  it('lets a pending Langfuse resolve complete when a parameter edit replaces the conversation object on a draft chat', async () => {
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    mockConversation.current = { conversationId: 'new' };
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    const { rerender } = renderPromptsCommand(textAreaRef, submitPrompt);

    fireEvent.click(screen.getByText('Gamma'));
    expect(mockResolve).toHaveBeenCalledTimes(1);

    /** A parameter edit (e.g. `SidePanel/Parameters/Panel.tsx`) replaces the
     *  conversation object without renewing the draft token; the pending
     *  resolve must not be discarded. */
    mockConversation.current = { conversationId: 'new' };
    rerender(
      <MemoryRouter initialEntries={['/c/convo-1']}>
        <PromptsCommand index={0} textAreaRef={textAreaRef} submitPrompt={submitPrompt} />
      </MemoryRouter>,
    );

    resolveFn('Resolved Gamma text');
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith('Resolved Gamma text'));
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith('3');
  });

  it('lets a pending Langfuse resolve complete when a same-chat update replaces the conversation object with the same id', async () => {
    mockResolve.mockImplementationOnce(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('Resolved Gamma text'), 0)),
    );
    mockConversation.current = { conversationId: 'convo-1' };
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    const { rerender } = renderPromptsCommand(textAreaRef, submitPrompt);

    fireEvent.click(screen.getByText('Gamma'));
    expect(mockResolve).toHaveBeenCalledTimes(1);

    /** Streaming sync, a pin, or a project change replaces the conversation
     *  object without changing its id; the pending resolve must not be
     *  discarded, since the chat identity (the id) has not changed. */
    mockConversation.current = { conversationId: 'convo-1' };
    rerender(
      <MemoryRouter initialEntries={['/c/convo-1']}>
        <PromptsCommand index={0} textAreaRef={textAreaRef} submitPrompt={submitPrompt} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith('Resolved Gamma text'));
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith('3');

    /* The busy flag clears normally through the resolve's own `finally`
       block, so a fresh selection right after is not blocked. */
    fireEvent.focus(getInput());
    fireEvent.click(screen.getByText('Alpha'));
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith('Alpha body'));
    expect(mockRecordUsage).toHaveBeenCalledWith('1');
  });

  it('shows no toast and submits immediately for a native entry', async () => {
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    renderPromptsCommand(textAreaRef, submitPrompt);

    fireEvent.click(screen.getByText('Alpha'));

    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith('Alpha body'));
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(mockRecordUsage).toHaveBeenCalledWith('1');
  });

  it('closes the variable dialog when a navigation starts while it is open', async () => {
    mockResolve.mockResolvedValueOnce('Hello {{name}}');
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    renderPromptsCommand(textAreaRef, submitPrompt);

    fireEvent.click(screen.getByText('Gamma'));
    expect(await screen.findByTestId('variable-dialog')).toBeInTheDocument();

    /** A dialog opened from a resolved Langfuse read must not survive a chat
     *  change and submit a variable fill into another chat. */
    act(() => {
      getDefaultStore().set(navigationGenerationAtom, 1);
    });

    await waitFor(() => expect(screen.queryByTestId('variable-dialog')).not.toBeInTheDocument());
  });

  it('supersedes a pending Langfuse resolve with a new selection, closing the popover and inserting the new prompt', async () => {
    let resolveFn: (value: string) => void = () => {};
    mockResolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    const submitPrompt = jest.fn();
    const textAreaRef = makeTextarea('/');
    renderPromptsCommand(textAreaRef, submitPrompt);

    fireEvent.click(screen.getByText('Gamma'));
    expect(mockResolve).toHaveBeenCalledTimes(1);

    /** Gamma's own selection already closed the popover; reopen it the same
     *  way a user would before picking a different entry while Gamma's
     *  resolve is still pending. */
    fireEvent.focus(getInput());
    fireEvent.click(screen.getByText('Alpha'));

    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith('Alpha body'));
    expect(mockRecordUsage).toHaveBeenCalledWith('1');
    expect(mockSetShowPromptsPopover).toHaveBeenLastCalledWith(false);

    /** Gamma's late result is discarded: the second selection bumped the
     *  request token before this resolve settled. */
    resolveFn('Resolved Gamma text');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitPrompt).not.toHaveBeenCalledWith('Resolved Gamma text');
    expect(mockRecordUsage).not.toHaveBeenCalledWith('3');
  });
});
