/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  localize: (phraseKey, options) =>
    options?.['0'] != null ? `${phraseKey}:${options['0']}` : phraseKey,
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

const host: ComposerHost = {
  useComposerBindings: () => NO_HOST_BINDINGS,
  useShortcutDisplay: () => '',
  useShortcutAriaKey: () => undefined,
  usePaletteSources: () => sources,
};

const renderPalette = (props: Partial<ComposerPaletteProps> = {}) => {
  const anchor = document.createElement('div');
  const field = document.createElement('textarea');
  field.dataset.testid = 'text-input';
  anchor.appendChild(field);
  document.body.appendChild(anchor);
  const view = render(
    <ComposerHostProvider host={host}>
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
});
