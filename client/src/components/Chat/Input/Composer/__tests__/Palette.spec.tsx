import React from 'react';
import { RecoilRoot } from 'recoil';
import { getDefaultStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';
import type { PaletteEntry } from '~/hooks/Input/usePaletteEntries';
import type { AttachEntry } from '~/hooks/Input/useAttachItems';
import { composerLiftFamily } from '../state';
import Palette from '../Palette';

/**
 * The palette's row model: what the list is made of, in what order, and what a
 * search does to it. The list is virtualized and the motion is measured in a
 * browser, so this covers the part that decides rows rather than draws them.
 */

/* AutoSizer measures its parent, which is zero in jsdom, and a zero width
   renders no rows at all. */
jest.mock('react-virtualized', () => {
  const actual = jest.requireActual('react-virtualized');
  return {
    ...actual,
    AutoSizer: ({ children }: { children: (size: { width: number }) => React.ReactNode }) =>
      children({ width: 640 }),
  };
});

jest.mock('~/hooks/Generic/useElementSize', () => ({
  __esModule: true,
  default: () => ({ ref: { current: null }, height: mockPopupHeight, width: 0 }),
}));

jest.mock('~/components/SharePoint', () => ({ SharePointPickerDialog: () => null }));

const mockToggleFavorite = jest.fn();
jest.mock('~/hooks/Input/useToolFavorites', () => ({
  __esModule: true,
  default: () => ({
    keys: new Set(mockFavoriteKeys),
    toggleFavorite: mockToggleFavorite,
    isFavorite: (key: string) => mockFavoriteKeys.includes(key),
  }),
}));

jest.mock('~/hooks/Input/useRecentFiles', () => ({
  __esModule: true,
  default: () => ({ files: mockRecentFiles, attach: jest.fn() }),
}));

jest.mock('~/hooks/Input/useAttachItems', () => ({
  __esModule: true,
  default: () => ({
    entries: mockAttachEntries,
    inputRef: { current: null },
    onFileChange: jest.fn(),
    isSharePointDialogOpen: false,
    setIsSharePointDialogOpen: jest.fn(),
    onSharePointFilesSelected: jest.fn(),
    isProcessing: false,
    downloadProgress: undefined,
    maxSelectionCount: 10,
  }),
}));
const mockMCPRefresh = jest.fn();
jest.mock('~/hooks/MCP/useMCPRefresh', () => ({
  useMCPRefresh: mockMCPRefresh,
}));

jest.mock('~/Providers', () => ({
  useBadgeRowContext: () => ({
    mcpServerManager: {
      availableMCPServers: [{ serverName: 'github' }],
      getConfigDialogProps: () => ({ isOpen: false }),
    },
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, string | number>) =>
    options ? `${key}:${options['0'] ?? options.count}` : key,
}));

let mockFavoriteKeys: string[] = [];
let mockRecentFiles: Array<Record<string, unknown>> = [];
let mockAttachEntries: AttachEntry[] = [];
let mockPopupHeight = 0;
const defaultInnerHeight = window.innerHeight;
let portalMain: HTMLElement;

const attachEntry = (id: string, label: string, primary = false): AttachEntry => ({
  id,
  label,
  primary,
  icon: null,
  onSelect: jest.fn(),
});

const entry = (over: Partial<PaletteEntry> & Pick<PaletteEntry, 'key'>): PaletteEntry => ({
  itemType: 'tool',
  itemId: over.key,
  label: over.key,
  icon: null,
  section: 'tool',
  active: false,
  pinned: false,
  onSelect: jest.fn(),
  ...over,
});

const ENTRIES: PaletteEntry[] = [
  entry({ key: 'web_search', label: 'Web Search', section: 'tool' }),
  entry({ key: 'execute_code', label: 'Run Code', section: 'tool' }),
  entry({ key: 'skill:writer', label: 'writing-helper', section: 'skill', description: 'Drafts' }),
  entry({ key: 'mcp:github', label: 'Github', section: 'mcp' }),
];

const ATTACH: AttachEntry[] = [
  attachEntry('local:provider', 'Upload to Provider', true),
  attachEntry('local:context', 'Upload as Text'),
  attachEntry('local:file_search', 'Upload for File Search'),
  attachEntry('local:execute_code', 'Upload to Code Environment'),
];

function renderPalette(
  over: {
    canAttach?: boolean;
    entries?: PaletteEntry[];
    onContainerClick?: () => void;
    dictating?: boolean;
    onCancel?: () => void;
    anchorBottom?: number | (() => number);
  } = {},
) {
  const anchorRef = { current: document.createElement('div') };
  if (over.anchorBottom != null) {
    jest.spyOn(anchorRef.current, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          bottom: typeof over.anchorBottom === 'function' ? over.anchorBottom() : over.anchorBottom,
        }) as DOMRect,
    );
  }
  const liftStore = getDefaultStore();
  liftStore.set(composerLiftFamily(0), 0);
  const view = render(
    <RecoilRoot>
      {/* Stands in for the composer box, whose own click handler focuses the
          textarea. The popup is portaled but still a React descendant of it, so
          this is the handler a row's click bubbles into. */}
      <div onClick={over.onContainerClick}>
        <Palette
          index={0}
          conversationId="convo-1"
          conversation={{ conversationId: 'convo-1' } as TConversation}
          files={new Map()}
          setFiles={jest.fn()}
          setFilesLoading={jest.fn()}
          canAttach={over.canAttach ?? true}
          entries={over.entries ?? ENTRIES}
          dictating={over.dictating}
          onCancel={over.onCancel}
          anchorRef={anchorRef as React.RefObject<HTMLElement>}
        />
      </div>
    </RecoilRoot>,
  );
  fireEvent.click(screen.getByTestId('composer-palette-button'));
  return { ...view, liftStore };
}

/** Row labels in list order, headers included, as the user reads them. The
 *  list's own containers are presentational too, so rows are found by the
 *  identity attribute rather than by role alone. */
const rows = () =>
  Array.from(document.querySelectorAll('[id^="composer-palette-list"] [data-row-key]')).map(
    (row) => row.textContent?.trim() ?? '',
  );

/** Just the section headers, which is what carries the order. */
const headers = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>('[id^="composer-palette-list"] [data-row-key^="h:"]'),
  ).map((row) => row.textContent?.trim() ?? '');

/** Row identities in list order, which is what the model actually decides. */
const keys = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>('[id^="composer-palette-list"] [data-row-key]'),
  ).map((row) => row.dataset.rowKey ?? '');

const search = (text: string) => {
  const input = screen.getByTestId('composer-palette-search');
  fireEvent.change(input, { target: { value: text } });
};

describe('Palette', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFavoriteKeys = [];
    mockRecentFiles = [];
    mockAttachEntries = ATTACH;

    mockPopupHeight = 0;
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: defaultInnerHeight,
    });
    portalMain = document.createElement('main');
    document.body.append(portalMain);
  });
  it('refreshes MCP state while the palette is open', () => {
    renderPalette();
    expect(mockMCPRefresh).toHaveBeenLastCalledWith({ enabled: true });
  });

  afterEach(() => {
    portalMain.remove();
    jest.restoreAllMocks();
  });

  it('recalculates the landing lift when the visual viewport changes', () => {
    jest.spyOn(window, 'requestAnimationFrame').mockReturnValue(0);
    mockPopupHeight = 100;
    let viewportHeight = 700;
    const resizeListeners: EventListener[] = [];
    const viewport = {
      addEventListener: jest.fn((type: string, listener: EventListener) => {
        if (type === 'resize') {
          resizeListeners.push(listener);
        }
      }),
      removeEventListener: jest.fn(),
    };
    Object.defineProperties(viewport, {
      height: { get: () => viewportHeight },
      offsetTop: { value: 0 },
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });
    const { liftStore } = renderPalette({ anchorBottom: 650 });
    expect(liftStore.get(composerLiftFamily(0))).toBe(70);

    viewportHeight = 600;
    const updateLift = resizeListeners[0];
    expect(updateLift).toBeDefined();
    act(() => updateLift?.(new Event('resize')));

    expect(liftStore.get(composerLiftFamily(0))).toBe(170);
  });

  it('rebases the lift when the window layout moves the composer', () => {
    jest.spyOn(window, 'requestAnimationFrame').mockReturnValue(0);
    const resizeListeners: EventListener[] = [];
    const addEventListener = window.addEventListener.bind(window);
    jest.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'resize' && typeof listener === 'function') {
        resizeListeners.push(listener);
      }
      addEventListener(type, listener, options);
    });
    mockPopupHeight = 100;
    let anchorBottom = 650;
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 700,
    });
    const { liftStore } = renderPalette({ anchorBottom: () => anchorBottom });
    expect(liftStore.get(composerLiftFamily(0))).toBe(70);

    anchorBottom = 600;
    const handleLayoutResize = resizeListeners.find((listener) =>
      listener.toString().includes('baselineRef'),
    );
    expect(handleLayoutResize).toBeDefined();
    act(() => handleLayoutResize?.(new Event('resize')));

    expect(liftStore.get(composerLiftFamily(0))).toBe(90);
  });

  it('does not advertise its cancel state as the upload shortcut target', () => {
    const onCancel = jest.fn();
    renderPalette({ dictating: true, onCancel });

    expect(screen.getByTestId('composer-palette-button')).toHaveAttribute(
      'data-upload-shortcut',
      'false',
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('marks its portal with the owning chat pane', async () => {
    renderPalette();
    await waitFor(() =>
      expect(document.querySelector('[data-chat-pane-portal]')).toHaveAttribute(
        'data-chat-pane-portal',
        '0',
      ),
    );
  });

  describe('section order', () => {
    it('reads attach, tools, skills, servers, files', () => {
      mockRecentFiles = [{ file_id: 'f1', filename: 'notes.pdf', type: 'application/pdf' }];
      renderPalette();
      expect(headers()).toEqual([
        'com_ui_composer_attach',
        'com_ui_composer_tools',
        'com_ui_skills',
        'com_ui_composer_mcp',
        'com_ui_composer_files',
      ]);
    });

    it('puts favourites above everything, out of their own sections', () => {
      mockFavoriteKeys = ['mcp:github'];
      renderPalette();
      const listed = rows();
      expect(listed[0]).toBe('com_ui_tools_view_favorites');
      expect(listed[1]).toBe('Github');
      /* And not left behind in the section it came from. */
      expect(listed.filter((row) => row === 'Github')).toHaveLength(1);
    });

    it('drops a section whose only member was starred', () => {
      mockFavoriteKeys = ['mcp:github'];
      renderPalette();
      expect(rows()).not.toContain('com_ui_composer_mcp');
    });

    it('offers no upload destinations when the endpoint cannot take them', () => {
      renderPalette({ canAttach: false });
      expect(rows()).not.toContain('com_ui_composer_attach');
      expect(rows()).not.toContain('Upload to Provider');
    });
  });

  describe('the folded upload destinations', () => {
    it('shows the ordinary destination and folds the rest away', () => {
      renderPalette();
      const listed = rows();
      expect(listed).toContain('Upload to Provider');
      expect(listed).toContain('com_ui_composer_attach_more');
      expect(listed).not.toContain('Upload to Code Environment');
    });

    it('reveals them in place, and folds them back', async () => {
      renderPalette();
      fireEvent.click(screen.getByText('com_ui_composer_attach_more'));
      expect(rows()).toContain('Upload to Code Environment');
      expect(rows()).toContain('com_ui_composer_attach_less');

      fireEvent.click(screen.getByText('com_ui_composer_attach_less'));
      /* Closing waits for the rows to fade before taking their space back, so
         the list still holds them for the length of that fade. */
      expect(rows()).toContain('Upload to Code Environment');
      await waitFor(() => expect(rows()).not.toContain('Upload to Code Environment'));
    });

    it('offers no disclosure when there is nothing to fold', () => {
      mockAttachEntries = [attachEntry('local:provider', 'Upload to Provider', true)];
      renderPalette();
      expect(rows()).toContain('Upload to Provider');
      expect(rows()).not.toContain('com_ui_composer_attach_more');
    });
  });

  describe('clicks reaching the composer box', () => {
    const clickRow = (key: string) => {
      const row = document.querySelector<HTMLElement>(`[data-row-key="${key}"]`);
      expect(row).not.toBeNull();
      fireEvent.click(row as HTMLElement);
    };

    /* The click that opens the palette is itself on the disclosure, which sits
       in the composer box and is meant to reach it. Only what a row does after
       that is under test. */
    const openPalette = () => {
      const onContainerClick = jest.fn();
      renderPalette({ onContainerClick });
      onContainerClick.mockClear();
      return onContainerClick;
    };

    it('keeps a catalog toggle from reaching the composer, so focus stays in the palette', () => {
      const onContainerClick = openPalette();

      clickRow('web_search');

      expect(onContainerClick).not.toHaveBeenCalled();
    });

    it('keeps the disclosure from reaching the composer', () => {
      const onContainerClick = openPalette();

      clickRow('attach:more');

      expect(onContainerClick).not.toHaveBeenCalled();
    });

    it('lets a destination that dismisses the palette hand focus back', () => {
      const onContainerClick = openPalette();

      clickRow(ATTACH[0].id);

      expect(onContainerClick).toHaveBeenCalled();
    });
  });

  describe('searching', () => {
    it('reaches a folded destination by name', () => {
      renderPalette();
      search('code environment');
      const listed = rows();
      expect(listed).toContain('Upload to Code Environment');
      /* The disclosure is there to keep the resting list short, not to make a
         row unfindable, so it steps out of the way of a search. */
      expect(listed).not.toContain('com_ui_composer_attach_more');
    });

    it('drops sections with nothing left in them', () => {
      renderPalette();
      search('github');
      expect(keys()).toEqual(['h:mcp', 'mcp:github']);
    });

    it('floats a label match above a description-only match', () => {
      renderPalette({
        canAttach: false,
        entries: [
          entry({ key: 'a', label: 'Notes', description: 'nothing to do with drafting' }),
          entry({ key: 'b', label: 'Drafting', description: 'unrelated' }),
        ],
      });
      search('draft');
      expect(keys()).toEqual(['h:tool', 'b', 'a']);
    });

    it('says so when nothing matches, out loud as well as on screen', () => {
      renderPalette();
      search('nothing matches this');
      const empty = screen.getByText('com_ui_composer_no_results');
      expect(empty).toBeInTheDocument();
      expect(empty).toHaveAttribute('role', 'status');
      /* The widget stays expanded and keeps controlling its (now empty)
         list: collapsing mid-search while the popover is still on screen
         reported a contradictory state exactly when the results changed. */
      const input = screen.getByTestId('composer-palette-search');
      expect(input).toHaveAttribute('aria-expanded', 'true');
      expect(document.getElementById(input.getAttribute('aria-controls') ?? '')).not.toBeNull();
    });
  });

  describe('keyboard', () => {
    it('starts on the first row that can be chosen, never on a header', () => {
      renderPalette();
      const input = screen.getByTestId('composer-palette-search');
      expect(input.getAttribute('aria-activedescendant')).toBe(
        'palette-row-0-006c006f00630061006c003a00700072006f00760069006400650072',
      );
    });

    /* An id that names nothing is the failure mode here: screen readers lose
       the active option entirely and announce nothing in its place. */
    it('always points at a row that is in the document', () => {
      renderPalette();
      const input = screen.getByTestId('composer-palette-search');
      const pointsAtSomething = () => {
        const id = input.getAttribute('aria-activedescendant');
        return id != null && document.getElementById(id) != null;
      };
      expect(pointsAtSomething()).toBe(true);
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(pointsAtSomething()).toBe(true);
      search('code');
      expect(pointsAtSomething()).toBe(true);
    });

    it('supports malformed surrogate keys and keeps punctuation-distinct row ids unique', () => {
      const loneHighSurrogateKey = 'mcp:\ud800';
      const loneLowSurrogateKey = 'mcp:\udc00';
      renderPalette({
        canAttach: false,
        entries: [
          entry({ key: 'mcp:foo.bar', itemType: 'mcp', itemId: 'foo.bar', section: 'mcp' }),
          entry({ key: 'mcp:foo_bar', itemType: 'mcp', itemId: 'foo_bar', section: 'mcp' }),
          entry({
            key: loneHighSurrogateKey,
            itemType: 'mcp',
            itemId: '\ud800',
            section: 'mcp',
          }),
          entry({
            key: loneLowSurrogateKey,
            itemType: 'mcp',
            itemId: '\udc00',
            section: 'mcp',
          }),
        ],
      });
      const input = screen.getByTestId('composer-palette-search');
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-row-key]'));
      const findCell = (key: string) =>
        rows
          .find((row) => row.dataset.rowKey === key)
          ?.querySelector<HTMLElement>('[role="gridcell"][id]');
      const dotted = findCell('mcp:foo.bar');
      const underscored = findCell('mcp:foo_bar');
      const loneHighSurrogate = findCell(loneHighSurrogateKey);
      const loneLowSurrogate = findCell(loneLowSurrogateKey);

      expect(dotted?.id).toBeTruthy();
      expect(underscored?.id).toBeTruthy();
      expect(loneHighSurrogate?.id).toBeTruthy();
      expect(loneLowSurrogate?.id).toBeTruthy();
      expect(dotted?.id).not.toBe(underscored?.id);
      expect(loneHighSurrogate?.id).not.toBe(loneLowSurrogate?.id);
      expect(input).toHaveAttribute('aria-activedescendant', dotted?.id);

      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(input).toHaveAttribute('aria-activedescendant', underscored?.id);
    });

    it('keeps the highlight on a row that moved rather than on its old position', () => {
      mockFavoriteKeys = [];
      renderPalette({ canAttach: false });
      const input = screen.getByTestId('composer-palette-search');
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      const moved = input.getAttribute('aria-activedescendant');
      expect(moved).toBe('palette-row-0-0065007800650063007500740065005f0063006f00640065');

      /* Starring it lifts the row into favourites without changing the row
         count, which is exactly the case a positional highlight got wrong. */
      mockFavoriteKeys = ['execute_code'];
      fireEvent.keyDown(input, { key: 'd', metaKey: true });
      expect(input.getAttribute('aria-activedescendant')).toBe(moved);
    });

    it('leaves the list alone when the pointer moves over it', () => {
      renderPalette();
      const list = document.querySelector('.ReactVirtualized__Grid');
      expect(list?.getAttribute('tabindex')).toBe('-1');
      expect(list?.getAttribute('role')).toBe('presentation');
      expect(list?.getAttribute('aria-label')).toBe('');
    });

    it('steps over headers on the way down', () => {
      renderPalette();
      const input = screen.getByTestId('composer-palette-search');
      const active = () =>
        document.querySelector('[aria-selected="true"]')?.textContent?.trim() ?? '';

      expect(active()).toBe('Upload to Provider');
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(active()).toBe('com_ui_composer_attach_more');
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      /* The tools header sits between them and is skipped. */
      expect(active()).toBe('Web Search');
    });

    it('wraps from the last row back to the first', () => {
      renderPalette({ canAttach: false, entries: [entry({ key: 'only', label: 'Only Tool' })] });
      const input = screen.getByTestId('composer-palette-search');
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(document.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe(
        'Only Tool',
      );
    });

    it('chooses the active row on Enter', () => {
      const onSelect = jest.fn();
      renderPalette({
        canAttach: false,
        entries: [entry({ key: 'only', label: 'Only Tool', onSelect })],
      });
      const input = screen.getByTestId('composer-palette-search');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('stars the active row on Mod+D', () => {
      renderPalette({ canAttach: false, entries: [entry({ key: 'only', label: 'Only Tool' })] });
      const input = screen.getByTestId('composer-palette-search');
      fireEvent.keyDown(input, { key: 'd', metaKey: true });
      expect(mockToggleFavorite).toHaveBeenCalledTimes(1);
    });

    it('does not favorite a temporary catalog placeholder', () => {
      renderPalette({
        canAttach: false,
        entries: [entry({ key: 'temporary', label: 'Temporary', favoritable: false })],
      });
      const input = screen.getByTestId('composer-palette-search');
      fireEvent.keyDown(input, { key: 'd', metaKey: true });

      expect(mockToggleFavorite).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'com_ui_favorite' })).not.toBeInTheDocument();
    });

    it('exposes named keyboard controls for secondary row actions', async () => {
      const user = userEvent.setup();
      const onSelect = jest.fn();
      const onConfigure = jest.fn();
      renderPalette({
        canAttach: false,
        entries: [
          entry({
            key: 'only',
            label: 'Only Tool',
            onSelect,
            modes: [
              {
                id: 'configure',
                label: 'Configure Tool',
                active: false,
                icon: <span aria-hidden="true" />,
                onSelect: onConfigure,
              },
            ],
          }),
        ],
      });

      const configure = screen.getByRole('button', { name: 'Configure Tool' });
      expect(configure.closest('[role="gridcell"]')).not.toHaveAttribute('id');
      expect(configure).toHaveClass(
        'transition-none',
        'opacity-100',
        '[@media(hover:hover)]:opacity-0',
      );

      await waitFor(() => expect(screen.getByTestId('composer-palette-search')).toHaveFocus());
      await user.tab();
      expect(configure).toHaveFocus();
      await user.keyboard(' ');
      expect(onConfigure).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('exposes a touch-visible named favorite action outside the active gridcell', async () => {
      const user = userEvent.setup();
      const onSelect = jest.fn();
      renderPalette({
        canAttach: false,
        entries: [entry({ key: 'only', label: 'Only Tool', onSelect })],
      });

      expect(screen.getByRole('grid')).toBeVisible();
      const favorite = screen.getByRole('button', { name: 'com_ui_favorite' });
      expect(favorite).toHaveAttribute('aria-pressed', 'false');
      expect(favorite).toHaveClass(
        'transition-none',
        'opacity-100',
        '[@media(hover:hover)]:opacity-0',
      );
      expect(favorite).not.toHaveClass('transition-opacity');
      expect(favorite.closest('[role="gridcell"]')).not.toHaveAttribute('id');

      await waitFor(() => expect(screen.getByTestId('composer-palette-search')).toHaveFocus());
      await user.tab();
      expect(favorite).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(mockToggleFavorite).toHaveBeenCalledWith('tool', 'only');
      expect(onSelect).not.toHaveBeenCalled();

      mockToggleFavorite.mockClear();
      await user.click(favorite);
      expect(mockToggleFavorite).toHaveBeenCalledWith('tool', 'only');
      expect(onSelect).not.toHaveBeenCalled();
    });
  });
});
