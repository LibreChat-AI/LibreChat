import { useEffect } from 'react';
import { useLocalize, useToastContext } from '@librechat/client';
import type { Dispatch, ReactNode, FC, SetStateAction } from 'react';
import type { EToolResources } from 'librechat-data-provider';
import type { ExtendedFile } from '../../../core/files';
import { isInlineablePastedText } from '../../../core/files';
import { useFilesHost } from '../../../react/files';
import FileContainer from './FileContainer';
import Image from './Image';

/**
 * Shared wrapper with a stable module-scope identity. Passing an inline arrow as
 * `Wrapper` makes it a new component type on every render, so React remounts the
 * whole row and any focused control inside it loses focus.
 */
export const FileRowWrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <div className="flex flex-wrap gap-2">{children}</div>
);

export type FileRowProps = {
  files: Map<string, ExtendedFile> | undefined;
  abortUpload?: (fileId?: string) => void;
  setFiles: Dispatch<SetStateAction<Map<string, ExtendedFile>>>;
  setFilesLoading?: Dispatch<SetStateAction<boolean>>;
  fileFilter?: (file: ExtendedFile) => boolean;
  assistant_id?: string;
  agent_id?: string;
  tool_resource?: EToolResources;
  index?: number;
  Wrapper?: FC<{ children: ReactNode }>;
  /** Marks chips the composer generated from a long paste. Provenance comes from the caller's
   * marker registry rather than the filename, which a deliberate upload can share. */
  isPastedTextFile?: (file: ExtendedFile) => boolean;
  /** Hides the paste actions while a replacement upload or inline move is in flight for the
   * chip, so the same original cannot be acted on twice. */
  isPasteActionPending?: (file: ExtendedFile) => boolean;
  /** Opens the paste editor. Only the composer passes it, so other rows stay inert chips. */
  onEditPastedText?: (file: ExtendedFile) => void;
  /** Returns a paste to the composer, offered from the chip's subtitle line. */
  onMovePastedTextInline?: (file: ExtendedFile) => void;
};

export default function FileRow({
  files: _files,
  setFiles,
  abortUpload,
  setFilesLoading,
  assistant_id,
  agent_id,
  tool_resource,
  index,
  fileFilter,
  Wrapper,
  isPastedTextFile,
  isPasteActionPending,
  onEditPastedText,
  onMovePastedTextInline,
}: FileRowProps): React.JSX.Element | null {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const files = Array.from(_files?.values() ?? []).filter((file) =>
    fileFilter ? fileFilter(file) : true,
  );

  const { useDeleteFile, getPreviewUrl } = useFilesHost();
  const deleteFile = useDeleteFile({ agent_id, assistant_id, tool_resource, index });

  useEffect(() => {
    if (!setFilesLoading) return;
    setFilesLoading(files.some((file) => file.progress < 1 && !isInlineablePastedText(file)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  if (files.length === 0) {
    return null;
  }

  const renderFiles = () => {
    return (
      /* `items-center` so a card and a thumbnail of different heights share
         one baseline instead of hanging from the top of the tallest row. */
      <div className="flex w-full max-w-full flex-wrap items-center gap-1.5">
        {files
          .reduce<{ map: Map<string, boolean>; uniqueFiles: ExtendedFile[] }>(
            (acc, current) => {
              if (!acc.map.has(current.file_id)) {
                acc.map.set(current.file_id, true);
                acc.uniqueFiles.push(current);
              }
              return acc;
            },
            { map: new Map<string, boolean>(), uniqueFiles: [] },
          )
          .uniqueFiles.map((file: ExtendedFile, fileIndex: number) => {
            const handleDelete = () => {
              if (abortUpload && file.progress < 1) {
                abortUpload(file.file_id);
              }
              if (file.progress >= 1 && !file.attached) {
                showToast({
                  message: localize('com_ui_deleting_file'),
                  status: 'info',
                });
              }
              deleteFile({ file, setFiles });
            };
            const isImage = file.type?.startsWith('image') ?? false;
            const isPastedText = isPastedTextFile?.(file) === true;
            const textPreview = isPastedText
              ? (file.pastedText ?? file.textPreview ?? file.text)
              : null;
            const isEditablePaste =
              onEditPastedText != null &&
              isPastedText &&
              (file.progress >= 1 || isInlineablePastedText(file) || file.file != null) &&
              !isPasteActionPending?.(file);

            return (
              /* Sized by its content, not parked in a fixed 70px slot: a 56px
                 thumbnail in a 70px slot left 14px of dead space beside it, so
                 the gap between two images read as far wider than the gap
                 beside a file card, which overflowed the same slot. */
              /* `flex`, not the default block: `Image`'s root is inline-block,
                 which sits on a text baseline and adds descender space under
                 the thumbnail, floating it above the cards beside it. */
              <div key={fileIndex} className="flex max-w-full shrink-0">
                {isImage ? (
                  <Image
                    url={getPreviewUrl(file.file_id) ?? file.preview ?? file.filepath}
                    onDelete={handleDelete}
                    progress={file.progress}
                    source={file.source}
                  />
                ) : (
                  /* Ordinary cards match the image height; text previews grow to fit their snippet. */
                  <FileContainer
                    file={file}
                    textPreview={textPreview}
                    containerClassName="max-w-full"
                    onDelete={handleDelete}
                    buttonClassName={isPastedText ? undefined : 'h-[58px]'}
                    onClick={isEditablePaste ? () => onEditPastedText(file) : undefined}
                    ariaLabel={
                      isEditablePaste
                        ? localize('com_ui_pasted_text_edit_chip', { 0: file.filename ?? '' })
                        : undefined
                    }
                    subtitleAction={
                      isEditablePaste && onMovePastedTextInline != null
                        ? {
                            label: localize('com_ui_pasted_text_move_inline'),
                            onClick: () => onMovePastedTextInline(file),
                          }
                        : undefined
                    }
                  />
                )}
              </div>
            );
          })}
      </div>
    );
  };

  if (Wrapper) {
    return <Wrapper>{renderFiles()}</Wrapper>;
  }

  return renderFiles();
}
