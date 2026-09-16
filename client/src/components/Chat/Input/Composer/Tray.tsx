import { memo, useCallback, useEffect, useRef } from 'react';
import { TextQuote, WandSparkles } from 'lucide-react';
import type { TConversation } from 'librechat-data-provider';
import type { ComposerItem, ComposerItemKind } from '~/hooks/Input/useComposerItems';
import type { ExtendedFile, FileSetter } from '~/common';
import { useFileHandlingNoChatContext, useLocalize } from '~/hooks';
import FileRow from '../Files/FileRow';
import Chip from './Chip';

const KIND_ICON: Record<ComposerItemKind, JSX.Element> = {
  quote: <TextQuote className="h-4 w-4" aria-hidden="true" />,
  skill: <WandSparkles className="h-4 w-4" aria-hidden="true" />,
};

const KIND_REMOVE_KEY = {
  quote: 'com_ui_remove_quote',
  skill: 'com_ui_remove_skill',
} as const;

interface ItemChipProps {
  item: ComposerItem;
  onRemove: () => void;
}

function ItemChip({ item, onRemove }: ItemChipProps) {
  const localize = useLocalize();

  return (
    <Chip
      label={item.label}
      title={item.title}
      icon={KIND_ICON[item.kind]}
      onRemove={onRemove}
      removeLabel={localize(KIND_REMOVE_KEY[item.kind])}
      data-testid={`composer-chip-${item.kind}`}
    />
  );
}

interface TrayProps {
  items: ComposerItem[];
  conversation: TConversation | null;
  /** Staged uploads, rendered by `FileRow` with their own delete semantics. */
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
  isRTL: boolean;
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
  conversation,
  files,
  setFiles,
  setFilesLoading,
  isRTL,
  index,
  isPastedTextFile,
  isPasteActionPending,
  onEditPastedText,
  onMovePastedTextInline,
  focusComposer,
}: TrayProps) {
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
      if (quoteItems.length <= 2) {
        focusComposer?.();
        return;
      }
      quoteFocusIndexRef.current = quoteIndex;
    },
    [items, focusComposer],
  );
  const { abortUpload } = useFileHandlingNoChatContext(undefined, {
    files,
    setFiles,
    setFilesLoading,
    conversation,
  });

  if (items.length === 0 && files.size === 0) {
    return null;
  }

  return (
    <div data-testid="composer-tray" className="flex flex-col gap-1.5 px-2 pt-2">
      <FileRow
        files={files}
        setFiles={setFiles}
        isRTL={isRTL}
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

export default memo(Tray);
