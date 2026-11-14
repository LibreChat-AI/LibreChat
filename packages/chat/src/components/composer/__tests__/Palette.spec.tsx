/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PaletteEntryView, PaletteSources } from '../../../react/palette';
import type { ComposerHost } from '../../../react/input';
import type { ComposerPaletteProps } from '../Palette';
import { emptyPaletteSources } from '../../../react/palette';
import { ComposerHostProvider } from '../../../react/input';
import { NO_HOST_BINDINGS } from '../../../core/shortcuts';
import ComposerPalette from '../Palette';

/**
 * Keyboard and list contract of the package palette. The app host supplies real rows; here the
 * host is a fixture, and the list is the unwindowed fallback so every row is mounted.
 */

const entry = (
  over: Partial<PaletteEntryView> & Pick<PaletteEntryView, 'key'>,
): PaletteEntryView => ({
  itemType: 'tool',
  itemId: over.key,
  label: over.key,
  icon: null,
  section: 'tool',
  active: false,
  onSelect: jest.fn(),
  ...over,
});

const sources: PaletteSources = {
  ...emptyPaletteSources(),
  attachEntries: [
    {
      id: 'local:provider',
      label: 'Upload to Provider',
      primary: true,
      icon: null,
      onSelect: jest.fn(),
    },
  ],
};

const hostWith = (palette: PaletteSources): ComposerHost => ({
  useComposerBindings: () => NO_HOST_BINDINGS,
  useShortcutDisplay: () => '',
  useShortcutAriaKey: () => undefined,
  usePaletteSources: () => palette,
});

const host = hostWith(sources);

const renderPalette = (
  props: Partial<ComposerPaletteProps> = {},
  withHost: ComposerHost = host,
) => {
  const anchor = document.createElement('div');
  const field = document.createElement('textarea');
  field.dataset.testid = 'text-input';
  anchor.appendChild(field);
  document.body.appendChild(anchor);
  const view = render(
    <ComposerHostProvider host={withHost}>
      <ComposerPalette
        index={0}
        conversationId="convo-1"
        conversation={null}
        files={new Map()}
        setFiles={jest.fn()}
        setFilesLoading={jest.fn()}
        canAttach
        entries={[entry({ key: 'web_search', label: 'Web Search' })]}
        anchorRef={{ current: anchor }}
        {...props}
      />
    </ComposerHostProvider>,
  );
  fireEvent.click(screen.getByTestId('composer-palette-button'));
  return { ...view, anchor, field };
};

describe('ComposerPalette', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.body.appendChild(document.createElement('main'));
  });

  it('names the grid and moves the active row with the arrows', () => {
    renderPalette();
    const input = screen.getByTestId('composer-palette-search');
    const grid = screen.getByRole('grid', { name: 'com_ui_composer_palette' });

    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', grid.id);
    expect(input.getAttribute('aria-activedescendant')).toBeTruthy();
    expect(
      document.getElementById(input.getAttribute('aria-activedescendant') ?? ''),
    ).toHaveTextContent('Upload to Provider');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(document.querySelector('[aria-selected="true"]')).toHaveTextContent('Web Search');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(document.querySelector('[aria-selected="true"]')).toHaveTextContent(
      'Upload to Provider',
    );
  });

  it('chooses the active row on Enter and says when a search matches nothing', () => {
    const onSelect = jest.fn();
    renderPalette({
      canAttach: false,
      entries: [entry({ key: 'only', label: 'Only Tool', onSelect })],
    });
    const input = screen.getByTestId('composer-palette-search');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: 'nothing matches this' } });
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_composer_no_results');
    expect(input).toHaveAttribute('aria-expanded', 'true');
  });

  it('returns focus to the message field on Escape', async () => {
    const { field } = renderPalette();
    const input = screen.getByTestId('composer-palette-search');
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByTestId('composer-palette-search')).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it('leaves focus on the text field a press outside moved it to', async () => {
    const { field } = renderPalette();
    const other = document.createElement('input');
    document.body.appendChild(other);
    await screen.findByTestId('composer-palette-search');

    /* The press as a browser orders it: the popover is dismissed on the press itself, and the
       field takes focus afterwards. */
    const pointer = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(pointer, 'pointerType', { value: 'mouse' });
    act(() => {
      other.dispatchEvent(pointer);
    });
    fireEvent.mouseDown(other);
    act(() => other.focus());
    fireEvent.click(other);

    await waitFor(() =>
      expect(screen.queryByTestId('composer-palette-search')).not.toBeInTheDocument(),
    );
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));
    expect(document.activeElement).toBe(other);
    expect(document.activeElement).not.toBe(field);
  });

  it('leaves the keys of an IME composition to the composition', () => {
    const picked = jest.fn();
    renderPalette({
      canAttach: false,
      entries: [
        entry({ key: 'a', label: 'Alpha' }),
        entry({ key: 'b', label: 'Bravo', onSelect: picked }),
      ],
    });
    const input = screen.getByTestId('composer-palette-search');
    const active = () => document.querySelector('[aria-selected="true"]');

    fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true });
    expect(active()).toHaveTextContent('Alpha');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(picked).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(active()).toHaveTextContent('Bravo');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(picked).toHaveBeenCalledTimes(1);
  });

  describe('without a windowed list', () => {
    const tools = Array.from({ length: 20 }, (_, i) =>
      entry({ key: `tool-${i}`, label: `Tool ${i}` }),
    );
    const scrolled: Element[] = [];

    beforeEach(() => {
      scrolled.length = 0;
      HTMLElement.prototype.scrollIntoView = jest.fn(function scrollIntoView(this: Element) {
        scrolled.push(this);
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    });

    it('bounds a long list and scrolls the active row into view', () => {
      renderPalette({ canAttach: false, entries: tools });
      const grid = screen.getByRole('grid', { name: 'com_ui_composer_palette' });
      expect(grid.style.height).toBe('300px');
      expect(grid).toHaveClass('overflow-y-auto');

      fireEvent.keyDown(screen.getByTestId('composer-palette-search'), { key: 'ArrowDown' });
      const active = document.querySelector('[aria-selected="true"]');
      expect(active).toHaveTextContent('Tool 1');
      expect(scrolled).toContain(active);
    });

    it('lists a long section whole when the host has no dialog for it', () => {
      const skills = Array.from({ length: 8 }, (_, i) =>
        entry({ key: `skill-${i}`, label: `Skill ${i}`, section: 'skill' }),
      );
      renderPalette({ canAttach: false, entries: skills });

      expect(document.querySelectorAll('[data-row-key^="skill-"]')).toHaveLength(8);
      expect(screen.queryByRole('button', { name: /show_all/ })).not.toBeInTheDocument();
    });

    it('draws no favorite control and ignores the shortcut where the host stores none', () => {
      const toggleFavorite = jest.fn();
      renderPalette(
        { canAttach: false },
        hostWith({ ...sources, favorites: false, toggleFavorite }),
      );
      fireEvent.keyDown(screen.getByTestId('composer-palette-search'), { key: 'd', ctrlKey: true });

      expect(screen.queryByRole('button', { name: 'com_ui_favorite' })).not.toBeInTheDocument();
      expect(toggleFavorite).not.toHaveBeenCalled();
    });

    it('draws the star and takes the shortcut where the host stores favorites', () => {
      const toggleFavorite = jest.fn();
      renderPalette(
        { canAttach: false },
        hostWith({ ...sources, favorites: true, toggleFavorite }),
      );
      fireEvent.keyDown(screen.getByTestId('composer-palette-search'), { key: 'd', ctrlKey: true });

      expect(screen.getByRole('button', { name: 'com_ui_favorite' })).toBeInTheDocument();
      expect(toggleFavorite).toHaveBeenCalledTimes(1);
    });

    it('keeps the cap and the Show all button where the host has the dialog', () => {
      const skills = Array.from({ length: 8 }, (_, i) =>
        entry({ key: `skill-${i}`, label: `Skill ${i}`, section: 'skill' }),
      );
      renderPalette(
        { canAttach: false, entries: skills },
        hostWith({ ...sources, catalogs: ['skill'] }),
      );

      expect(document.querySelectorAll('[data-row-key^="skill-"]')).toHaveLength(5);
      expect(
        screen.getByRole('button', { name: 'com_ui_composer_show_all_label' }),
      ).toBeInTheDocument();
    });
  });
});
