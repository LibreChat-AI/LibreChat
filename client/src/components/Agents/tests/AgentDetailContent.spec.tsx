import React from 'react';
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OGDialog, OGDialogTrigger, useToastContext } from '@librechat/client';
import type t from 'librechat-data-provider';
import '@testing-library/jest-dom';
import { MarketplaceHostContext } from '../MarketplaceContext';
import AgentDetailContent from '../AgentDetailContent';

const mockToggleFavoriteAgent = jest.fn();
let mockIsFavorite = false;
let mockIsUpdating = false;
const mockOpenerLabel = 'Marketplace opener';
const queryClients = new Set<QueryClient>();

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useFavorites: () => ({
    isFavoriteAgent: () => mockIsFavorite,
    toggleFavoriteAgent: mockToggleFavoriteAgent,
    isUpdating: mockIsUpdating,
  }),
  useLocalize: () => (key: string, values?: Record<string, string>) => {
    const translations: Record<string, string> = {
      com_agents_category_general: 'General',
      com_agents_contact: 'Contact',
      com_agents_copy_link: 'Copy link',
      com_agents_description_empty: 'Learn more about this agent and start a conversation.',
      com_agents_details_hint: 'Explore this agent and choose how to start your conversation.',
      com_agents_link_copied: 'Link copied',
      com_agents_link_copy_failed: 'Link copy failed',
      com_agents_not_available: 'Agent not available',
      com_agents_starters_heading: 'Try a conversation starter',
      com_agents_starters_hint:
        'Choose a prompt to open a new chat. You can edit it before sending.',
      com_agents_start_chat: 'Start chat',
      com_ui_agent: 'Agent',
      com_ui_close: 'Close',
      com_ui_pin: 'Pin',
      com_ui_unpin: 'Unpin',
      com_ui_updating: 'Updating...',
      com_agents_chat_with: `Chat with ${values?.name ?? ''}`,
    };
    return translations[key] || key;
  },
  useAgentCategories: () => ({
    categories: [{ value: 'general', label: 'com_agents_category_general' }],
  }),
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  renderAgentAvatar: () => <div data-testid="agent-avatar" />,
}));

const baseAgent: t.Agent = {
  id: 'agent-1',
  name: 'Agent One',
  description: 'Agent description',
  created_at: 0,
  avatar: null,
  provider: 'openai',
  model: 'gpt-4',
  model_parameters: {
    temperature: null,
    maxContextTokens: null,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
  },
};

const LocationProbe = () => {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
};
const DetailDialog = ({
  agent = baseAgent,
  morph,
  actionsUnavailable = false,
  actionsDisabled = false,
}: {
  agent?: t.Agent;
  morph?: 'open' | 'closing';
  actionsUnavailable?: boolean;
  actionsDisabled?: boolean;
}) => {
  const [open, setOpen] = React.useState(true);
  /* Stands in for the grid card the dialog morphs out of: the copy the words
     are measured against lives there, not in the dialog. */
  const cardDescription = React.useRef<HTMLParagraphElement>(null);
  return (
    <OGDialog open={open} onOpenChange={setOpen}>
      <OGDialogTrigger asChild>
        <button type="button">{mockOpenerLabel}</button>
      </OGDialogTrigger>
      {morph != null && <p ref={cardDescription}>{agent.description}</p>}
      {open && (
        <AgentDetailContent
          agent={agent}
          morph={morph}
          descriptionSource={morph == null ? undefined : () => cardDescription.current}
          actionsUnavailable={actionsUnavailable}
          actionsDisabled={actionsDisabled}
        />
      )}
    </OGDialog>
  );
};

const renderDetail = (
  agent = baseAgent,
  basename = '/app',
  morph?: 'open' | 'closing',
  actionsUnavailable = false,
  actionsDisabled = false,
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClients.add(queryClient);
  const toastContext = { showToast: jest.fn() };
  jest.mocked(useToastContext).mockReturnValue(toastContext);
  /* The app-global reset the start-chat path asks its host for: dropping the parallel
     conversations a multi-conversation session left open, and the transcript the last
     new chat left behind. The dialog only asks; the host owns that state. */
  const host = { resetNewConversation: jest.fn() };
  const tree = (
    phase?: 'open' | 'closing',
    disabled = actionsDisabled,
    unavailable = actionsUnavailable,
    currentAgent = agent,
  ) => (
    <RecoilRoot>
      <MemoryRouter
        basename={basename}
        initialEntries={[`${basename}/agents/all?q=invoice&sort=popular&mine=1`]}
      >
        <QueryClientProvider client={queryClient}>
          <MarketplaceHostContext.Provider value={host}>
            <DetailDialog
              agent={currentAgent}
              morph={phase}
              actionsUnavailable={unavailable}
              actionsDisabled={disabled}
            />
          </MarketplaceHostContext.Provider>
          <LocationProbe />
        </QueryClientProvider>
      </MemoryRouter>
    </RecoilRoot>
  );
  const view = render(tree(morph));
  return {
    ...view,
    showToast: toastContext.showToast,
    resetNewConversation: host.resetNewConversation,
    setMorph: (phase: 'open' | 'closing') => view.rerender(tree(phase)),
    setAgent: (nextAgent: t.Agent) =>
      view.rerender(tree(morph, actionsDisabled, actionsUnavailable, nextAgent)),
    setActionsDisabled: (disabled: boolean) => view.rerender(tree(morph, disabled)),
    setActionsUnavailable: (unavailable: boolean) =>
      view.rerender(tree(morph, actionsDisabled, unavailable)),
    setIsUpdating: (updating: boolean) => {
      mockIsUpdating = updating;
      view.rerender(tree(morph, actionsDisabled, actionsUnavailable, agent));
    },
  };
};

describe('AgentDetailContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFavorite = false;
    mockIsUpdating = false;
  });

  afterEach(() => {
    for (const queryClient of queryClients) {
      queryClient.clear();
    }
    queryClients.clear();
  });

  it('renders the public identity, readable description, category, and contact', () => {
    renderDetail({
      ...baseAgent,
      category: 'general',
      support_contact: { name: 'Support Team', email: 'support@example.com' },
      description: 'A readable description\nwith more detail.',
    });

    expect(screen.getByRole('heading', { name: 'Agent One' })).toBeInTheDocument();
    expect(screen.getByTestId('agent-avatar')).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText(/A readable description/)).toHaveTextContent(
      'A readable description with more detail.',
    );
    expect(screen.getByRole('link', { name: 'Support Team' })).toHaveAttribute(
      'href',
      'mailto:support@example.com',
    );
    expect(screen.queryByText('Contact:')).not.toBeInTheDocument();
  });

  it('renders a rich description as sanitized markup outside a paragraph', () => {
    renderDetail({
      ...baseAgent,
      description:
        '<span onclick="alert(1)">Assistant. <a href="https://example.com">Read the guide</a><script>alert(1)</script></span>',
    });

    const link = screen.getByRole('link', { name: 'Read the guide' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(document.querySelector('[onclick]')).not.toBeInTheDocument();
    expect(document.querySelector('script')).not.toBeInTheDocument();
    expect(link.closest('p')).not.toBeInTheDocument();
  });

  it('renders the morphed copy word by word without reading it twice', () => {
    const description = 'Compare sources quickly.';
    renderDetail({ ...baseAgent, description }, '/app', 'open');
    const dialog = within(screen.getByRole('dialog'));

    /* Assistive technology gets the description once, as one string ... */
    const copies = dialog.getAllByText(description);
    expect(copies).toHaveLength(1);
    /* ... while the animation gets a node per word, hidden from it. */
    const words = copies[0].parentElement?.querySelectorAll('[aria-hidden="true"] > span');
    expect(Array.from(words ?? [], (word) => word.textContent)).toEqual([
      'Compare',
      'sources',
      'quickly.',
    ]);
  });

  it('keeps the description while the morph hands the surface back', () => {
    const description = 'Compare sources quickly.';
    renderDetail({ ...baseAgent, description }, '/app', 'closing');

    expect(within(screen.getByRole('dialog')).getByText(description)).toBeInTheDocument();
  });

  it('turns the words around when a reopen interrupts the close', async () => {
    /* The close sends the copy back to the card's wrapping and takes the lines
       the card cannot show away with it. Reopening mid-flight has to bring them
       back, not leave the paragraph stuck on its way out. */
    const description = 'Compare sources quickly.';
    const { setMorph } = renderDetail({ ...baseAgent, description }, '/app', 'open');
    const paragraph = () => within(screen.getByRole('dialog')).getByText(description).parentElement;
    const words = () =>
      Array.from(paragraph()?.querySelectorAll<HTMLElement>('[aria-hidden="true"] > span') ?? []);
    await waitFor(() => expect(words().every((word) => word.style.opacity !== '0')).toBe(true));
    expect(words()).toHaveLength(3);

    setMorph('closing');
    expect(words().every((word) => word.style.opacity === '0')).toBe(true);

    setMorph('open');
    await waitFor(() => expect(words().every((word) => word.style.opacity !== '0')).toBe(true));
  });
  it('clears word animation styles when refreshed copy changes during the morph', async () => {
    const initial = { ...baseAgent, description: 'Compare sources quickly.' };
    const refreshed = { ...initial, description: 'Compare sources today.' };
    const { setAgent } = renderDetail(initial, '/app', 'open');
    const initialWords = Array.from(
      within(screen.getByRole('dialog'))
        .getByText(initial.description)
        .parentElement?.querySelectorAll<HTMLElement>('[aria-hidden="true"] > span') ?? [],
    );
    expect(initialWords.some((word) => word.style.willChange !== '')).toBe(true);

    const words = () =>
      Array.from(
        within(screen.getByRole('dialog'))
          .getByText(refreshed.description)
          .parentElement?.querySelectorAll<HTMLElement>('[aria-hidden="true"] > span') ?? [],
      );

    setAgent(refreshed);
    await waitFor(() => {
      expect(words()).toHaveLength(3);
      expect(
        words().every((word) => word.style.willChange === '' && word.style.transition === ''),
      ).toBe(true);
    });
  });

  it('uses the public owner name when no support contact is configured', () => {
    renderDetail({
      ...baseAgent,
      owner_contact: { name: 'Owner User' },
    });

    expect(screen.getByText('Owner User')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Owner User' })).not.toBeInTheDocument();
  });

  it('filters empty starters and opens a new editable chat without submitting', async () => {
    const user = userEvent.setup();
    const agent = {
      ...baseAgent,
      id: 'agent / one',
      conversation_starters: [' ', '  Ask about & pricing?  ', '\t'],
    };
    renderDetail(agent);

    expect(screen.getByRole('button', { name: /Ask about & pricing\?/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^\s*$/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Ask about & pricing\?/ }));

    const location = new URL(
      screen.getByTestId('location').textContent ?? '',
      window.location.origin,
    );
    expect(location.pathname).toBe('/c/new');
    expect(location.searchParams.get('endpoint')).toBe('agents');
    expect(location.searchParams.get('agent_id')).toBe('agent / one');
    expect(location.searchParams.get('prompt')).toBe('Ask about & pricing?');
    expect(location.searchParams.has('submit')).toBe(false);
  });

  it('starts a new agent chat through the router without marketplace parameters', async () => {
    const user = userEvent.setup();
    const { resetNewConversation } = renderDetail({ ...baseAgent, id: 'agent / one' });

    await user.click(screen.getByRole('button', { name: 'Start chat' }));

    const location = new URL(
      screen.getByTestId('location').textContent ?? '',
      window.location.origin,
    );
    expect(location.pathname).toBe('/c/new');
    expect(location.searchParams.get('endpoint')).toBe('agents');
    expect(location.searchParams.get('agent_id')).toBe('agent / one');
    expect(location.searchParams.has('q')).toBe(false);
    expect(location.searchParams.has('sort')).toBe(false);
    expect(location.searchParams.has('mine')).toBe(false);
    /* Whatever a multi-conversation session left open goes with it: the chat route's
       query-param path keeps added conversations, so without the host's reset the new
       agent would open as another column beside them. */
    expect(resetNewConversation).toHaveBeenCalledTimes(1);
  });

  it('confirms a copy on the button itself and resets it, without a toast', async () => {
    const user = userEvent.setup();
    const writeText = jest.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const { showToast } = renderDetail({ ...baseAgent, id: 'agent / one' });

    await user.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/app/c/new?endpoint=agents&agent_id=agent+%2F+one`,
      );
    });
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Link copied');
    expect(showToast).not.toHaveBeenCalled();
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument(),
      { timeout: 4000 },
    );
  });

  it('reports clipboard failures instead of claiming a copy succeeded', async () => {
    const user = userEvent.setup();
    jest
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValueOnce(new Error('Clipboard unavailable'));
    const { showToast } = renderDetail();

    await user.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith({ message: 'Link copy failed' });
    });
    expect(screen.queryByRole('button', { name: 'Link copied' })).not.toBeInTheDocument();
  });

  it('uses the server-backed favorite state and exposes pending updates', async () => {
    const user = userEvent.setup();
    const first = renderDetail();

    const pinButton = screen.getByRole('button', { name: 'Pin' });
    expect(pinButton).toHaveAttribute('aria-pressed', 'false');
    await user.click(pinButton);
    expect(mockToggleFavoriteAgent).toHaveBeenCalledWith('agent-1');
    first.unmount();

    mockIsFavorite = true;
    mockIsUpdating = true;
    renderDetail();
    expect(screen.getByRole('button', { name: 'Unpin' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Unpin' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Unpin' })).toHaveAttribute('aria-busy', 'true');
  });

  it('keeps focus on Pin while the favorite mutation is busy and ignores repeated activation', async () => {
    const user = userEvent.setup();
    const rendered = renderDetail();
    const pinButton = screen.getByRole('button', { name: 'Pin' });
    pinButton.focus();

    await user.keyboard('{Enter}');
    expect(mockToggleFavoriteAgent).toHaveBeenCalledTimes(1);

    rendered.setIsUpdating(true);
    expect(document.activeElement).toBe(pinButton);
    expect(pinButton).toHaveFocus();
    expect(pinButton).toHaveAttribute('aria-disabled', 'true');
    expect(pinButton).toHaveAttribute('aria-busy', 'true');

    await user.keyboard('{Enter}');
    expect(mockToggleFavoriteAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps controls mounted and focused while transient validation disables them', () => {
    const agent = { ...baseAgent, conversation_starters: ['Ask about the latest changes'] };
    const rendered = renderDetail(agent);
    const copy = screen.getByRole('button', { name: 'Copy link' });
    copy.focus();

    rendered.setActionsDisabled(true);

    expect(copy).toBeInTheDocument();
    expect(copy).toHaveAttribute('aria-disabled', 'true');
    expect(copy).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Pin' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Start chat' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: /Ask about the latest changes/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
  it.each([
    ['a conversation starter', /Ask about the latest changes/],
    ['the pin action', 'Pin'],
    ['the copy-link action', 'Copy link'],
    ['the start-chat action', 'Start chat'],
  ])('moves focus to the unavailable status when revalidation removes %s', (_label, name) => {
    const agent = { ...baseAgent, conversation_starters: ['Ask about the latest changes'] };
    const rendered = renderDetail(agent);
    const focusedAction = screen.getByRole('button', { name });
    focusedAction.focus();

    rendered.setActionsUnavailable(true);

    expect(screen.getByRole('status')).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it('leaves focus elsewhere when revalidation removes unavailable actions', () => {
    const rendered = renderDetail();
    const title = screen.getByRole('heading', { name: 'Agent One' });
    title.focus();

    rendered.setActionsUnavailable(true);

    expect(title).toHaveFocus();
    expect(screen.getByRole('status')).not.toHaveFocus();
  });

  it('keeps the captured dialog open but removes actions for an inaccessible agent', () => {
    renderDetail(baseAgent, '/app', undefined, true);

    expect(screen.getByRole('status')).toHaveTextContent('Agent not available');
    expect(screen.queryByRole('button', { name: 'Pin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start chat' })).not.toBeInTheDocument();
  });
  it('dismisses with the localized close control and restores opener focus', async () => {
    const user = userEvent.setup();
    renderDetail();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Agent One' })).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Marketplace opener' })).toHaveFocus();
  });
});
