import { memo, useCallback, useEffect, useRef } from 'react';
import { useLocalize } from '@librechat/client';
import { TextQuote, WandSparkles } from 'lucide-react';
import type { Dispatch, MemoExoticComponent, SetStateAction } from 'react';
import type { FileMapSetter } from '../../react/files';
import type { ComposerItem } from '../../react/items';
import type { ExtendedFile } from '../../core/files';
import FileRow from './files/FileRow';
import Chip from './bar/Chip';

const KIND_ICON = {
  quote: TextQuote,
  skill: WandSparkles,
} as const;

const KIND_REMOVE_KEY = {
  quote: 'com_ui_remove_quote',
  skill: 'com_ui_remove_skill',
} as const;

interface ItemChipProps {
  item: ComposerItem;
  onRemove: () => void;
}

function ItemChip({ item, onRemove }: ItemChipProps): React.JSX.Element {
  const localize = useLocalize();
  const Icon = KIND_ICON[item.kind];

  return (
    <Chip
      label={item.label}
      title={item.title}
      icon={<Icon className="h-4 w-4" aria-hidden="true" />}
      onRemove={onRemove}
      removeLabel={localize(KIND_REMOVE_KEY[item.kind])}
      data-testid={`composer-chip-${item.kind}`}
    />
  );
}

export interface TrayProps {
  items: ComposerItem[];
  /** Staged uploads, rendered by `FileRow` with their own delete semantics. */
  files: Map<string, ExtendedFile>;
  setFiles: FileMapSetter;
  setFilesLoading: Dispatch<SetStateAction<boolean>>;
  /** Stops a part-done upload; the host owns the upload stack. */
  abortUpload?: (fileId?: string) => void;
  index: number;
  isPastedTextFile: (file: ExtendedFile) => boolean;
  isPasteActionPending: (file: ExtendedFile) => boolean;
  onEditPastedText: (file: ExtendedFile) => void;
  onMovePastedTextInline: (file: ExtendedFile) => void;
  /** Guarded focus restore after the last staged quote is dismissed. */
  focusComposer?: () => void;
}

/**
 * The composer's staged-context region: file cards first, then the quote and
 * manual-skill pills. Queued and failed-steer rows live elsewhere (the Queue
 * rail and the thread, respectively).
 *
 * Files keep `FileRow` rather than being flattened into pills: the card is
 * where an image preview opens full size, where upload progress and the storage
 * source are drawn, and where aborting a part-done upload differs from deleting
 * a finished one.
 */
function Tray({
  items,
  files,
  setFiles,
  setFilesLoading,
  abortUpload,
  index,
  isPastedTextFile,
  isPasteActionPending,
  onEditPastedText,
  onMovePastedTextInline,
  focusComposer,
}: TrayProps): React.JSX.Element | null {
  const localize = useLocalize();
  const quoteFocusIndexRef = useRef<number | null>(null);
  const chipListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const index = quoteFocusIndexRef.current;
    if (index == null) {
      return;
    }
    quoteFocusIndexRef.current = null;
    const buttons = chipListRef.current?.querySelectorAll<HTMLButtonElement>(
      '[data-testid="composer-chip-quote"] button',
    );
    if (buttons?.length) {
      buttons[Math.min(index, buttons.length - 1)].focus();
    }
  }, [items]);

  const removeItem = useCallback(
    (item: ComposerItem) => {
      if (item.kind !== 'quote') {
        item.remove();
        return;
      }
      const quoteItems = items.filter((candidate) => candidate.kind === 'quote');
      const quoteIndex = quoteItems.findIndex((candidate) => candidate.id === item.id);
      item.remove();
      /* Every quote is its own chip, so focus moves to a remaining quote's remove
         control and only returns to the composer once the last one is gone. */
      if (quoteItems.length <= 1) {
        focusComposer?.();
        return;
      }
      quoteFocusIndexRef.current = quoteIndex;
    },
    [items, focusComposer],
  );

  if (items.length === 0 && files.size === 0) {
    return null;
  }

  return (
    <div data-testid="composer-tray" className="flex flex-col gap-1.5 px-2 pt-2">
      <FileRow
        files={files}
        setFiles={setFiles}
        abortUpload={abortUpload}
        setFilesLoading={setFilesLoading}
        index={index}
        isPastedTextFile={isPastedTextFile}
        isPasteActionPending={isPasteActionPending}
        onEditPastedText={onEditPastedText}
        onMovePastedTextInline={onMovePastedTextInline}
      />
      {items.length > 0 && (
        <div
          ref={chipListRef}
          role="list"
          aria-label={localize('com_ui_composer_staged_context')}
          className="flex flex-wrap gap-1.5"
        >
          {items.map((item) => (
            <ItemChip key={item.id} item={item} onRemove={() => removeItem(item)} />
          ))}
        </div>
      )}
    </div>
  );
}

const MemoTray: MemoExoticComponent<typeof Tray> = memo(Tray);

export default MemoTray;
