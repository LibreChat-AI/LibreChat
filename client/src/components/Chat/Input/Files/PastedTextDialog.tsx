import { useId, useState } from 'react';
import {
  Button,
  OGDialog,
  Textarea,
  OGDialogClose,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
} from '@librechat/client';
import type { PastedTextEdit } from '~/hooks/Files/usePastedTextEdit';
import { useLocalize } from '~/hooks';

/**
 * Opens the text behind a `pasted-text.txt` chip so it can be corrected before sending. Returning
 * the paste to the composer lives on the chip itself rather than here.
 */
export default function PastedTextDialog({
  edit,
  onClose,
  onSave,
}: {
  /** Null while no chip is open; carries the resolved text so the field starts filled. */
  edit: PastedTextEdit | null;
  onClose: () => void;
  onSave: (text: string) => void;
}) {
  const localize = useLocalize();
  const fieldId = useId();
  const [text, setText] = useState('');
  const [openedFileId, setOpenedFileId] = useState<string | null>(null);

  /** Reset on the render that opens a different chip rather than in an effect. */
  const currentFileId = edit?.file.file_id ?? null;
  if (currentFileId !== openedFileId) {
    setOpenedFileId(currentFileId);
    setText(edit?.text ?? '');
  }

  const isEmpty = text.trim() === '';

  return (
    <OGDialog open={edit != null} onOpenChange={(open) => !open && onClose()}>
      <OGDialogContent className="w-11/12 max-w-4xl" showCloseButton={false}>
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_ui_pasted_text_edit')}</OGDialogTitle>
        </OGDialogHeader>
        <Textarea
          id={fieldId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={localize('com_ui_pasted_text_edit')}
          className="h-[65vh] max-h-[70vh] min-h-[20rem] font-mono text-xs"
        />
        <div className="flex justify-end gap-2 pt-4">
          <OGDialogClose asChild>
            <Button variant="outline">{localize('com_ui_cancel')}</Button>
          </OGDialogClose>
          <Button variant="default" disabled={isEmpty} onClick={() => onSave(text)}>
            {localize('com_ui_save')}
          </Button>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
