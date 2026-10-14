import { useEffect, useRef } from 'react';
import type { TFile } from 'librechat-data-provider';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import Image from '~/components/Chat/Input/Files/Image';
import { getCachedPreview } from '~/utils';
import { useLocalize } from '~/hooks';

type EditFile = Partial<TFile>;

/**
 * A message's files in the editor, as the composer's chips: each one can be taken off the
 * resubmission. Removal only shapes the rerun, so nothing is deleted from storage, and the message
 * as it was stays on its own branch.
 *
 * Removing a chip takes its button out from under the keyboard, so focus moves to the chip that
 * took its place (or the one before it), and to `onEmpty` once none are left.
 */
export default function EditFiles({
  files,
  onRemove,
  onEmpty,
  disabled = false,
}: {
  files: EditFile[];
  onRemove: (file: EditFile) => void;
  onEmpty: () => void;
  disabled?: boolean;
}) {
  const localize = useLocalize();
  const listRef = useRef<HTMLUListElement | null>(null);
  const removedIndexRef = useRef<number | null>(null);

  useEffect(() => {
    const removedIndex = removedIndexRef.current;
    if (removedIndex == null) {
      return;
    }
    removedIndexRef.current = null;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-remove-file]');
    if (buttons == null || buttons.length === 0) {
      onEmpty();
      return;
    }
    buttons[Math.min(removedIndex, buttons.length - 1)]?.focus();
  }, [files, onEmpty]);

  if (files.length === 0) {
    return null;
  }

  return (
    <ul
      ref={listRef}
      aria-label={localize('com_ui_attachments')}
      className="flex w-full flex-wrap items-center gap-1.5"
    >
      {files.map((file, index) => {
        const name = file.filename ?? '';
        const removeLabel = localize('com_ui_remove_file_named', { 0: name });
        const remove = () => {
          removedIndexRef.current = index;
          onRemove(file);
        };
        const isImage = file.type?.startsWith('image') ?? false;
        return (
          <li key={file.file_id ?? `${name}-${index}`} className="flex shrink-0">
            {isImage ? (
              <Image
                url={
                  (file.file_id ? getCachedPreview(file.file_id) : undefined) ??
                  file.preview ??
                  file.filepath
                }
                onDelete={remove}
                removeLabel={removeLabel}
                removeDisabled={disabled}
                progress={1}
                source={file.source}
              />
            ) : (
              <FileContainer
                file={file}
                onDelete={remove}
                removeLabel={removeLabel}
                removeDisabled={disabled}
                buttonClassName="h-[58px]"
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
