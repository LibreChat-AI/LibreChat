import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import type { TConversation, TEndpointsConfig } from 'librechat-data-provider';
import FavoriteItem from '~/components/Nav/Favorites/FavoriteItem';
import PinnedSection from '../PinnedSection';

const mockSetExpanded = jest.fn();
let mockIsExpanded = true;
let mockPinnedOrder: string[] | undefined;
let mockOrderFetched = true;
let mockOrderFetching = false;
/** When each side of the pruning decision was fetched. Membership later than
 *  the order is the ordinary case: the order is one small record while the
 *  pinned list drains page by page. */
let mockOrderUpdatedAt = 1000;
const MEMBERSHIP_FETCHED_AT = 2000;
const mockReorderFavorites = jest.fn();
const mockUpdatePinnedOrder = jest.fn();

const mockFavoritesData = {
  favorites: [] as Array<Record<string, string>>,
  isLoading: false,
  isLoaded: true,
  dataUpdatedAt: MEMBERSHIP_FETCHED_AT,
  isAgentsLoading: false,
  agentsMap: {} as Record<string, unknown>,
  specsMap: {} as Record<string, unknown>,
  endpointsConfig: {},
  reorderFavorites: mockReorderFavorites,
  onSelectEndpoint: jest.fn(),
  onSelectSpec: jest.fn(),
};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useLocalStorage: () => [mockIsExpanded, mockSetExpanded],
}));

jest.mock('~/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  getSpecAgentAvatarURL: () => null,
}));

jest.mock('~/data-provider', () => ({
  useActiveJobs: () => ({ data: undefined }),
  useGetPinnedOrderQuery: () => ({
    data: mockPinnedOrder,
    isSuccess: mockOrderFetched,
    isFetching: mockOrderFetching,
    dataUpdatedAt: mockOrderUpdatedAt,
  }),
  useUpdatePinnedOrderMutation: () => ({ mutate: mockUpdatePinnedOrder }),
  usePinConversationMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('@librechat/client', () => ({
  /* The section headers compose through the shared variant recipe. */
  buttonVariants: () => '',
  Skeleton: () => <div data-testid="favorite-skeleton" />,
  useMediaQuery: () => true,
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/components/Nav/Favorites/useFavoritesData', () => ({
  __esModule: true,
  default: () => mockFavoritesData,
}));

jest.mock('../Convo', () => {
  /* A mock factory cannot close over imports, so React is required in here. */
  const { useEffect, useRef } = jest.requireActual<typeof import('react')>('react');
  function MockConvo({
    conversation,
    onRenamingChange,
  }: {
    conversation: { title: string };
    onRenamingChange?: (renaming: boolean) => void;
  }) {
    /* Mirrors the real row's contract: a row removed mid-rename reports the
     * rename ending on its way out. */
    const report = useRef(onRenamingChange);
    report.current = onRenamingChange;
    useEffect(
      () => () => {
        report.current?.(false);
      },
      [],
    );
    return (
      <div data-testid="pinned-convo">
        <button type="button">{conversation.title}</button>
        {/* No text content: `itemLabels` reads the row's text to assert order. */}
        <button
          type="button"
          aria-label="rename"
          data-testid={`rename-${conversation.title}`}
          onClick={() => onRenamingChange?.(true)}
        />
      </div>
    );
  }
  return { __esModule: true, default: MockConvo };
});

jest.mock('~/components/Nav/Favorites/FavoriteItem', () => ({
  __esModule: true,
  default: jest.fn(
    ({
      item,
      type,
      keyShortcuts,
    }: {
      item: { model?: string; id?: string; label?: string };
      type: string;
      keyShortcuts?: string;
    }) => {
      const label = item.id ?? item.label ?? item.model ?? '';
      return (
        <div data-testid="favorite-item" data-type={type} aria-keyshortcuts={keyShortcuts}>
          {label}
        </div>
      );
    },
  ),
}));

const pinnedConvo = (id: string, title: string) =>
  ({ conversationId: id, title, pinned: true }) as unknown as TConversation;

const renderTree = (conversations: TConversation[]) => (
  <DndProvider backend={HTML5Backend}>
    <PinnedSection conversations={conversations} toggleNav={jest.fn()} />
  </DndProvider>
);

const renderSection = (conversations: TConversation[]) => render(renderTree(conversations));

const itemLabels = () =>
  Array.from(
    screen
      .getAllByTestId(/pinned-convo|favorite-item|favorite-skeleton/)
      .map((el) => el.textContent?.trim()),
  );

describe('PinnedSection unified list', () => {
  beforeEach(() => {
    mockIsExpanded = true;
    mockPinnedOrder = undefined;
    mockOrderFetched = true;
    mockOrderFetching = false;
    mockOrderUpdatedAt = 1000;
    mockSetExpanded.mockReset();
    mockReorderFavorites.mockReset();
    mockUpdatePinnedOrder.mockReset();
    mockFavoritesData.favorites = [];
    mockFavoritesData.isLoading = false;
    mockFavoritesData.isLoaded = true;
    mockFavoritesData.dataUpdatedAt = MEMBERSHIP_FETCHED_AT;
    mockFavoritesData.isAgentsLoading = false;
    mockFavoritesData.agentsMap = {};
    mockFavoritesData.specsMap = {};
    mockFavoritesData.endpointsConfig = {};
  });

  it('renders nothing when there are no favorites or pinned conversations', () => {
    const { container } = renderSection([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders favorites followed by pinned conversations in natural order', () => {
    mockFavoritesData.favorites = [{ model: 'gpt-4o', endpoint: 'openAI' }];
    renderSection([pinnedConvo('c1', 'Pinned Chat'), pinnedConvo('c2', 'Another Pin')]);
    expect(itemLabels()).toEqual(['gpt-4o', 'Pinned Chat', 'Another Pin']);
  });

  it('forwards endpoint config to pinned models when the config loads', () => {
    const item = { model: 'claude-sonnet-4-5', endpoint: 'AnthropicClaude' };
    mockFavoritesData.favorites = [item];
    const { rerender } = renderSection([]);

    expect(FavoriteItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'model', item, endpointsConfig: {} }),
      expect.anything(),
    );

    const endpointsConfig: TEndpointsConfig = {
      AnthropicClaude: { iconURL: 'anthropic', order: 0 },
    };
    mockFavoritesData.endpointsConfig = endpointsConfig;
    rerender(renderTree([]));

    expect(FavoriteItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'model', item, endpointsConfig }),
      expect.anything(),
    );
  });

  /* Chats and favorites are two independently ordered groups: an order saved
   * before that rule, with the two interleaved, is read back grouped. */
  it('orders each kind by the stored order and keeps the kinds grouped', () => {
    mockFavoritesData.favorites = [{ model: 'gpt-4o', endpoint: 'openAI' }, { agentId: 'agent-1' }];
    mockFavoritesData.agentsMap = { 'agent-1': { id: 'agent-1' } };
    mockPinnedOrder = ['convo:c2', 'agent:agent-1', 'model:6:openAI:gpt-4o', 'convo:c1'];
    renderSection([pinnedConvo('c1', 'Pinned Chat'), pinnedConvo('c2', 'Another Pin')]);
    expect(itemLabels()).toEqual(['agent-1', 'gpt-4o', 'Another Pin', 'Pinned Chat']);
  });

  it('appends items missing from the stored order and ignores stale keys', () => {
    mockFavoritesData.favorites = [{ spec: 'fast' }];
    mockFavoritesData.specsMap = { fast: { name: 'fast', label: 'Fast' } };
    mockPinnedOrder = ['convo:gone', 'model:6:openAI:removed'];
    renderSection([pinnedConvo('c1', 'Pinned Chat')]);
    expect(itemLabels()).toEqual(['Fast', 'Pinned Chat']);
  });

  it('shows a skeleton row while favorites are still loading', () => {
    mockFavoritesData.isLoading = true;
    renderSection([pinnedConvo('c1', 'Pinned Chat')]);
    expect(screen.getAllByTestId('favorite-skeleton').length).toBeGreaterThan(0);
    expect(screen.getByText('Pinned Chat')).toBeInTheDocument();
  });

  it('hides an unresolved agent favorite once agents are loaded', () => {
    mockFavoritesData.favorites = [{ agentId: 'agent-gone' }];
    mockFavoritesData.isAgentsLoading = false;
    renderSection([]);
    expect(screen.queryAllByTestId('favorite-item')).toHaveLength(0);
  });

  it('renders the section for favorites alone', () => {
    mockFavoritesData.favorites = [{ model: 'gpt-4o', endpoint: 'openAI' }];
    const { container } = renderSection([]);
    expect(screen.getByTestId('favorite-item')).toBeInTheDocument();
    expect(container).not.toBeEmptyDOMElement();
  });

  describe('keyboard reordering', () => {
    const moveFocusedRow = (label: string, key: 'ArrowUp' | 'ArrowDown') =>
      fireEvent.keyDown(screen.getByText(label), { key, altKey: true });

    it('moves a row down with Alt+ArrowDown and persists the new order', () => {
      mockFavoritesData.favorites = [
        { model: 'gpt-4o', endpoint: 'openAI' },
        { model: 'gpt-4o-mini', endpoint: 'openAI' },
      ];
      renderSection([pinnedConvo('c1', 'Pinned Chat')]);
      expect(itemLabels()).toEqual(['gpt-4o', 'gpt-4o-mini', 'Pinned Chat']);

      moveFocusedRow('gpt-4o', 'ArrowDown');

      expect(itemLabels()).toEqual(['gpt-4o-mini', 'gpt-4o', 'Pinned Chat']);
      expect(mockUpdatePinnedOrder).toHaveBeenCalledWith(
        ['model:6:openAI:gpt-4o-mini', 'model:6:openAI:gpt-4o', 'convo:c1'],
        expect.anything(),
      );
    });

    it('moves a row up with Alt+ArrowUp', () => {
      renderSection([pinnedConvo('c1', 'First'), pinnedConvo('c2', 'Second')]);

      moveFocusedRow('Second', 'ArrowUp');

      expect(itemLabels()).toEqual(['Second', 'First']);
    });

    /* The pointer cannot drag a chat through a pinned agent or model, so the
     * keyboard must not either: a step that would leave the row's own group
     * does nothing rather than interleaving the two. */
    it('refuses a step that would cross into the other kind', () => {
      mockFavoritesData.favorites = [{ model: 'gpt-4o', endpoint: 'openAI' }];
      renderSection([pinnedConvo('c1', 'Pinned Chat')]);

      moveFocusedRow('gpt-4o', 'ArrowDown');
      moveFocusedRow('Pinned Chat', 'ArrowUp');

      expect(itemLabels()).toEqual(['gpt-4o', 'Pinned Chat']);
      expect(mockUpdatePinnedOrder).not.toHaveBeenCalled();
    });

    /* Reordering against an order that has not arrived yet would merge into
     * `[]` and, since `onMutate` cancels that GET, post only what is on screen,
     * discarding the saved positions of everything else. */
    /* A write that settles after the user has arranged the list again must not
     * clear the snapshot showing that newer arrangement. */
    it('keeps a newer arrangement when an older write settles', () => {
      renderSection([
        pinnedConvo('c1', 'First'),
        pinnedConvo('c2', 'Second'),
        pinnedConvo('c3', 'Third'),
      ]);

      moveFocusedRow('First', 'ArrowDown');
      const firstSettle = mockUpdatePinnedOrder.mock.calls[0][1].onSettled;

      moveFocusedRow('First', 'ArrowDown');
      const arranged = itemLabels();

      act(() => firstSettle());

      /* Releasing after this would otherwise save an order no longer on screen. */
      expect(itemLabels()).toEqual(arranged);
    });

    /* Alt/Option+Arrow moves the caret word-wise inside a text field, so the
     * shortcut has to stand down wherever the drag source does. */
    it('leaves Alt+Arrow to the rename input while a row title is being edited', () => {
      renderSection([pinnedConvo('c1', 'Pinned Chat'), pinnedConvo('c2', 'Second')]);

      fireEvent.click(screen.getByTestId('rename-Pinned Chat'));
      moveFocusedRow('Pinned Chat', 'ArrowDown');

      expect(itemLabels()).toEqual(['Pinned Chat', 'Second']);
      expect(mockUpdatePinnedOrder).not.toHaveBeenCalled();
    });

    /* A failed GET still reports as fetched, so the gate is on success. */
    it('refuses to reorder until the stored order was fetched successfully', () => {
      mockOrderFetched = false;
      mockFavoritesData.favorites = [{ model: 'gpt-4o', endpoint: 'openAI' }];
      renderSection([pinnedConvo('c1', 'Pinned Chat')]);

      moveFocusedRow('gpt-4o', 'ArrowDown');

      expect(itemLabels()).toEqual(['gpt-4o', 'Pinned Chat']);
      expect(mockUpdatePinnedOrder).not.toHaveBeenCalled();
    });

    /* A favorites fetch that exhausted its retries stops loading with nothing
     * to show, and pruning against that empty list would drop every favorite
     * key from the stored order. */
    it('keeps merging when the favorites fetch never delivered', () => {
      mockFavoritesData.isLoaded = false;
      mockPinnedOrder = ['convo:gone', 'convo:c1'];
      render(
        <DndProvider backend={HTML5Backend}>
          <PinnedSection
            conversations={[pinnedConvo('c1', 'Pinned Chat'), pinnedConvo('c2', 'Second')]}
            toggleNav={jest.fn()}
            membershipComplete
            membershipUpdatedAt={MEMBERSHIP_FETCHED_AT}
          />
        </DndProvider>,
      );

      moveFocusedRow('Pinned Chat', 'ArrowDown');

      expect(mockUpdatePinnedOrder).toHaveBeenCalledWith(
        ['convo:gone', 'convo:c2', 'convo:c1'],
        expect.anything(),
      );
    });

    it('prunes keys that are gone once the whole list is known', () => {
      mockPinnedOrder = ['convo:gone', 'model:6:openAI:gpt-4o', 'convo:c1', 'convo:c2'];
      mockFavoritesData.favorites = [{ model: 'gpt-4o', endpoint: 'openAI' }];
      render(
        <DndProvider backend={HTML5Backend}>
          <PinnedSection
            conversations={[pinnedConvo('c1', 'Pinned Chat'), pinnedConvo('c2', 'Second')]}
            toggleNav={jest.fn()}
            membershipComplete
            membershipUpdatedAt={MEMBERSHIP_FETCHED_AT}
          />
        </DndProvider>,
      );

      moveFocusedRow('Pinned Chat', 'ArrowDown');

      /* Merging forever would grow the array until the size guard rejected
       * every write, so a complete membership load compacts it. */
      expect(mockUpdatePinnedOrder).toHaveBeenCalledWith(
        ['model:6:openAI:gpt-4o', 'convo:c2', 'convo:c1'],
        expect.anything(),
      );
    });

    it('does nothing at the ends of the list', () => {
      mockFavoritesData.favorites = [{ model: 'gpt-4o', endpoint: 'openAI' }];
      renderSection([pinnedConvo('c1', 'Pinned Chat')]);

      moveFocusedRow('gpt-4o', 'ArrowUp');

      expect(itemLabels()).toEqual(['gpt-4o', 'Pinned Chat']);
      expect(mockUpdatePinnedOrder).not.toHaveBeenCalled();
    });

    it('ignores a bare arrow key so list navigation still works', () => {
      mockFavoritesData.favorites = [{ model: 'gpt-4o', endpoint: 'openAI' }];
      renderSection([pinnedConvo('c1', 'Pinned Chat')]);

      fireEvent.keyDown(screen.getByText('gpt-4o'), { key: 'ArrowDown' });

      expect(itemLabels()).toEqual(['gpt-4o', 'Pinned Chat']);
      expect(mockUpdatePinnedOrder).not.toHaveBeenCalled();
    });

    it('announces the new position', () => {
      renderSection([pinnedConvo('c1', 'First'), pinnedConvo('c2', 'Second')]);

      moveFocusedRow('First', 'ArrowDown');

      expect(screen.getByRole('status')).toHaveTextContent('com_ui_moved_to_position');
    });

    /* Rows can be missing from view for reasons the section cannot tell apart:
     * a bookmark filter hides them, or the pinned query is still draining its
     * cursor. Persisting only what is on screen would drop those keys and lose
     * their positions, so the order is always merged, never replaced — and an
     * order saved while the two kinds interleaved is normalized on the way out,
     * so the hidden chat keeps its place among chats rather than being carried
     * across the favorite that used to sit above it. */
    it('keeps keys it cannot see in the stored order', () => {
      mockPinnedOrder = ['convo:hidden', 'model:6:openAI:gpt-4o', 'convo:c1', 'convo:c2'];
      mockFavoritesData.favorites = [{ model: 'gpt-4o', endpoint: 'openAI' }];
      renderSection([pinnedConvo('c1', 'Pinned Chat'), pinnedConvo('c2', 'Second')]);

      moveFocusedRow('Pinned Chat', 'ArrowDown');

      expect(mockUpdatePinnedOrder).toHaveBeenCalledWith(
        ['model:6:openAI:gpt-4o', 'convo:hidden', 'convo:c2', 'convo:c1'],
        expect.anything(),
      );
    });

    it('does not write the favorites array a second time', () => {
      mockPinnedOrder = ['model:6:openAI:gpt-4o', 'model:6:openAI:gpt-4o-mini'];
      mockFavoritesData.favorites = [
        { model: 'gpt-4o', endpoint: 'openAI' },
        { model: 'gpt-4o-mini', endpoint: 'openAI' },
      ];
      renderSection([]);

      moveFocusedRow('gpt-4o', 'ArrowDown');

      /* `pinnedOrder` is the only ordering the section reads, and a second
       * whole-array write would race the favorites membership mutations. */
      expect(mockUpdatePinnedOrder).toHaveBeenCalled();
      expect(mockReorderFavorites).not.toHaveBeenCalled();
    });
  });

  it('renders one row per favorite even when the stored list repeats one', () => {
    /* The `/favorites` payload validator accepts a duplicate entry. Two rows
     * keyed the same would collide in React and make every reorder POST fail
     * the endpoint's uniqueness check. */
    mockFavoritesData.favorites = [
      { model: 'gpt-4o', endpoint: 'openAI' },
      { model: 'gpt-4o', endpoint: 'openAI' },
    ];
    renderSection([]);

    expect(screen.getAllByTestId('favorite-item')).toHaveLength(1);
  });

  /* A row removed mid-rename never reports the rename ending, so the owner
   * would keep its drag source released even after it came back. */
  it('reconnects the drag source when a renaming row is removed and returns', () => {
    const { rerender } = renderSection([pinnedConvo('c1', 'Pinned Chat')]);

    fireEvent.click(screen.getByTestId('rename-Pinned Chat'));
    expect(screen.getByTestId('pinned-convo').parentElement).not.toHaveAttribute(
      'draggable',
      'true',
    );

    rerender(
      <DndProvider backend={HTML5Backend}>
        <PinnedSection conversations={[]} toggleNav={jest.fn()} />
      </DndProvider>,
    );
    rerender(
      <DndProvider backend={HTML5Backend}>
        <PinnedSection conversations={[pinnedConvo('c1', 'Pinned Chat')]} toggleNav={jest.fn()} />
      </DndProvider>,
    );

    expect(screen.getByTestId('pinned-convo').parentElement).toHaveAttribute('draggable', 'true');
  });

  it('releases the drag source while a row title is being edited', () => {
    renderSection([pinnedConvo('c1', 'Pinned Chat')]);

    const row = screen.getByTestId('pinned-convo').parentElement as HTMLElement;
    expect(row).toHaveAttribute('draggable', 'true');

    fireEvent.click(screen.getByTestId('rename-Pinned Chat'));

    /* A `draggable` ancestor swallows drag-select inside the rename input. */
    expect(row).not.toHaveAttribute('draggable', 'true');
  });

  /* Dragging a pin onto a project row above the section, or onto Chats below
   * it, sweeps the pointer across sibling rows whose hover handlers shift the
   * order. That movement is incidental to a filing action, not a reorder. */
  it('writes nothing when a drag ends without a reorder', () => {
    mockFavoritesData.favorites = [{ model: 'gpt-4o', endpoint: 'openAI' }];
    renderSection([pinnedConvo('c1', 'Pinned Chat')]);

    const row = screen.getByTestId('pinned-convo').parentElement as HTMLElement;
    fireEvent.dragStart(row);
    fireEvent.dragEnd(row);

    expect(mockUpdatePinnedOrder).not.toHaveBeenCalled();
  });

  /* An arrangement that arrives while the order is reconciling is held and
   * written when the fresh order lands. The flush runs on every settle, so it
   * has to stay quiet when there is nothing being held: reposting a committed
   * arrangement would undo whatever that reconciliation just brought in. */
  it('does not repost an arrangement that was already written', () => {
    const rows = [pinnedConvo('c1', 'First'), pinnedConvo('c2', 'Second')];
    const view = renderSection(rows);

    fireEvent.keyDown(screen.getByText('First'), { key: 'ArrowDown', altKey: true });
    expect(mockUpdatePinnedOrder).toHaveBeenCalledTimes(1);

    mockOrderFetching = true;
    view.rerender(renderTree(rows));
    mockOrderFetching = false;
    view.rerender(renderTree(rows));

    expect(mockUpdatePinnedOrder).toHaveBeenCalledTimes(1);
  });

  it('keeps two model favorites distinct when a component contains the delimiter', () => {
    /* The favorites API accepts any string for either half, so joining them on
     * `::` collides: `a::b` + `c` and `a` + `b::c` would key the same and the
     * dedupe would hide one of two genuinely different favorites. */
    mockFavoritesData.favorites = [
      { endpoint: 'a::b', model: 'c' },
      { endpoint: 'a', model: 'b::c' },
    ];
    renderSection([]);

    expect(screen.getAllByTestId('favorite-item')).toHaveLength(2);
  });

  /* A screen-reader user tabbing straight to a row never meets the section's
   * written hint, so the shortcut has to be declared where focus lands. */
  it('declares the reorder shortcut on the rows that take focus', () => {
    mockFavoritesData.favorites = [{ model: 'gpt-4o', endpoint: 'openAI' }];
    renderSection([pinnedConvo('c1', 'Pinned Chat')]);

    expect(screen.getByTestId('favorite-item')).toHaveAttribute(
      'aria-keyshortcuts',
      'Alt+ArrowUp Alt+ArrowDown',
    );
  });

  it('does not advertise the shortcut before reordering is possible', () => {
    mockOrderFetched = false;
    mockFavoritesData.favorites = [{ model: 'gpt-4o', endpoint: 'openAI' }];
    renderSection([]);

    expect(screen.getByTestId('favorite-item')).not.toHaveAttribute('aria-keyshortcuts');
  });

  /* The pinned query holds its data for five minutes while the order has none,
   * so focusing a tab reconciles the order on its own. Pruning the newer order
   * against the membership beside it would drop the key of a conversation
   * another tab pinned in between, which no later fetch can bring back. */
  it('keeps merging when the order reconciled more recently than membership', () => {
    mockPinnedOrder = ['convo:unseen', 'convo:c1'];
    mockOrderUpdatedAt = MEMBERSHIP_FETCHED_AT + 1;
    render(
      <DndProvider backend={HTML5Backend}>
        <PinnedSection
          conversations={[pinnedConvo('c1', 'Pinned Chat'), pinnedConvo('c2', 'Second')]}
          toggleNav={jest.fn()}
          membershipComplete
          membershipUpdatedAt={MEMBERSHIP_FETCHED_AT}
        />
      </DndProvider>,
    );

    fireEvent.keyDown(screen.getByText('Pinned Chat'), { key: 'ArrowDown', altKey: true });

    expect(mockUpdatePinnedOrder).toHaveBeenCalledWith(
      ['convo:unseen', 'convo:c2', 'convo:c1'],
      expect.anything(),
    );
  });

  it('preserves unseen favorite positions until favorites catch up with the order', () => {
    mockPinnedOrder = ['model:6:openAI:unseen', 'convo:c1'];
    mockFavoritesData.dataUpdatedAt = mockOrderUpdatedAt - 1;
    const tree = (
      <DndProvider backend={HTML5Backend}>
        <PinnedSection
          conversations={[pinnedConvo('c1', 'Pinned Chat'), pinnedConvo('c2', 'Second')]}
          toggleNav={jest.fn()}
          membershipComplete
          membershipUpdatedAt={MEMBERSHIP_FETCHED_AT}
        />
      </DndProvider>
    );
    const { rerender } = render(tree);

    fireEvent.keyDown(screen.getByText('Pinned Chat'), { key: 'ArrowDown', altKey: true });

    expect(mockUpdatePinnedOrder).toHaveBeenLastCalledWith(
      ['model:6:openAI:unseen', 'convo:c2', 'convo:c1'],
      expect.anything(),
    );

    mockFavoritesData.dataUpdatedAt = mockOrderUpdatedAt;
    act(() => mockUpdatePinnedOrder.mock.calls[0][1].onSettled());
    rerender(tree);
    fireEvent.keyDown(screen.getByText('Pinned Chat'), { key: 'ArrowDown', altKey: true });

    expect(mockUpdatePinnedOrder).toHaveBeenLastCalledWith(
      ['convo:c2', 'convo:c1'],
      expect.anything(),
    );
  });

  it('preserves newly reconciled keys while an older arrangement remains active', () => {
    mockPinnedOrder = ['model:6:openAI:new-favorite', 'convo:c1', 'convo:c2'];
    mockFavoritesData.isLoaded = false;
    const conversations = [pinnedConvo('c1', 'First'), pinnedConvo('c2', 'Second')];
    const tree = () => (
      <DndProvider backend={HTML5Backend}>
        <PinnedSection
          conversations={conversations}
          toggleNav={jest.fn()}
          membershipComplete
          membershipUpdatedAt={MEMBERSHIP_FETCHED_AT}
        />
      </DndProvider>
    );
    const { rerender } = render(tree());
    fireEvent.keyDown(screen.getByText('First'), { key: 'ArrowDown', altKey: true });

    mockFavoritesData.favorites = [{ model: 'new-favorite', endpoint: 'openAI' }];
    mockFavoritesData.isLoaded = true;
    mockFavoritesData.dataUpdatedAt = MEMBERSHIP_FETCHED_AT;
    rerender(tree());
    fireEvent.keyDown(screen.getByText('First'), { key: 'ArrowUp', altKey: true });

    expect(mockUpdatePinnedOrder).toHaveBeenLastCalledWith(
      ['model:6:openAI:new-favorite', 'convo:c1', 'convo:c2'],
      expect.anything(),
    );
    act(() => mockUpdatePinnedOrder.mock.calls[1][1].onSettled());
    expect(itemLabels()).toEqual(['new-favorite', 'First', 'Second']);
  });

  /* An optimistic favorite removal leaves the earlier GET's success standing,
   * so pruning then would drop the ordering key of a write that has not landed
   * and cannot be recovered if it fails. */
  it('keeps merging while a favorites write is in flight', () => {
    mockFavoritesData.isLoaded = false;
    mockPinnedOrder = ['convo:gone', 'convo:c1'];
    render(
      <DndProvider backend={HTML5Backend}>
        <PinnedSection
          conversations={[pinnedConvo('c1', 'Pinned Chat'), pinnedConvo('c2', 'Second')]}
          toggleNav={jest.fn()}
          membershipComplete
          membershipUpdatedAt={MEMBERSHIP_FETCHED_AT}
        />
      </DndProvider>,
    );

    fireEvent.keyDown(screen.getByText('Pinned Chat'), { key: 'ArrowDown', altKey: true });

    expect(mockUpdatePinnedOrder).toHaveBeenCalledWith(
      ['convo:gone', 'convo:c2', 'convo:c1'],
      expect.anything(),
    );
  });
});
