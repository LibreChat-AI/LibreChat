import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ComposerItem } from '~/hooks/Input/useComposerItems';
import type { ExtendedFile } from '~/common';
import Tray from '../Tray';

const mockFileRow = jest.fn();
const mockIsPastedTextFile = jest.fn(() => false);
const mockIsPasteActionPending = jest.fn(() => false);
const mockEditPastedText = jest.fn();
const mockMovePastedTextInline = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useFileHandlingNoChatContext: () => ({ abortUpload: jest.fn() }),
}));

/* Files keep their own component, with its own upload/delete stack; the tray's
   job is to hand it the staged map, which is what is asserted here. */
jest.mock('../../Files/FileRow', () => ({
  __esModule: true,
  default: (props: { files: Map<string, unknown> } & Record<string, unknown>) => {
    mockFileRow(props);
    return props.files.size > 0 ? <div data-testid="file-row">{props.files.size}</div> : null;
  },
}));

const item = (overrides: Partial<ComposerItem> = {}): ComposerItem => ({
  id: 'quote:0',
  kind: 'quote',
  label: 'the second paragraph',
  title: 'the second paragraph',
  remove: jest.fn(),
  ...overrides,
});

function renderTray(
  items: ComposerItem[],
  files: Map<string, ExtendedFile> = new Map(),
  focusComposer?: jest.Mock,
) {
  return render(
    <Tray
      items={items}
      conversation={null}
      files={files}
      setFiles={jest.fn()}
      setFilesLoading={jest.fn()}
      isRTL={false}
      index={0}
      isPastedTextFile={mockIsPastedTextFile}
      isPasteActionPending={mockIsPasteActionPending}
      onEditPastedText={mockEditPastedText}
      onMovePastedTextInline={mockMovePastedTextInline}
      focusComposer={focusComposer}
    />,
  );
}

describe('Tray', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders nothing when no context is staged', () => {
    const { container } = renderTray([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('groups every staged kind under one labelled chip list', () => {
    renderTray(
      [
        item({ id: 'quote:0', kind: 'quote', label: 'the second paragraph' }),
        item({ id: 'skill:a', kind: 'skill', label: 'code-review' }),
      ],
      new Map([['f1', {} as ExtendedFile]]),
    );

    expect(screen.getByTestId('composer-tray')).toBeInTheDocument();
    expect(screen.getByTestId('file-row')).toBeInTheDocument();
    const chipList = screen.getByRole('list', { name: 'com_ui_composer_staged_context' });
    expect(chipList).toContainElement(screen.getByTestId('composer-chip-quote'));
    expect(chipList).toContainElement(screen.getByTestId('composer-chip-skill'));
  });

  it('labels each remove button for its own kind', () => {
    renderTray([
      item({ id: 'quote:0', kind: 'quote', label: 'excerpt' }),
      item({ id: 'skill:a', kind: 'skill', label: 'code-review' }),
    ]);

    expect(screen.getByLabelText('com_ui_remove_quote')).toBeInTheDocument();
    expect(screen.getByLabelText('com_ui_remove_skill')).toBeInTheDocument();
  });

  it('invokes the item own remove handler', () => {
    const remove = jest.fn();
    renderTray([item({ remove })]);
    fireEvent.click(screen.getByLabelText('com_ui_remove_quote'));
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('returns focus to the composer when a short quote list is dismissed', () => {
    const focusComposer = jest.fn();
    const remove = jest.fn();
    renderTray(
      [
        item({ id: 'quote:0', remove }),
        item({ id: 'quote:1', label: 'another excerpt' }),
      ],
      new Map(),
      focusComposer,
    );

    fireEvent.click(screen.getByLabelText('com_ui_remove_quote'));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(focusComposer).toHaveBeenCalledTimes(1);
  });

  it('opens for staged files even with nothing else in it', () => {
    renderTray([], new Map([['f1', {} as ExtendedFile]]));
    expect(screen.getByTestId('composer-tray')).toBeInTheDocument();
    expect(screen.getByTestId('file-row')).toBeInTheDocument();
  });

  it('forwards pasted-text actions to the staged file row', () => {
    renderTray([], new Map([['f1', {} as ExtendedFile]]));

    expect(mockFileRow).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 0,
        isPastedTextFile: mockIsPastedTextFile,
        isPasteActionPending: mockIsPasteActionPending,
        onEditPastedText: mockEditPastedText,
        onMovePastedTextInline: mockMovePastedTextInline,
      }),
    );
  });
});
