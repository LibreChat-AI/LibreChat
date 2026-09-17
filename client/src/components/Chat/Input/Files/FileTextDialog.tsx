import React from 'react';
import {
  OGDialog,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
  OGDialogDescription,
} from '@librechat/client';
import ExtractedTextPanel from '~/components/Chat/Input/Files/ExtractedTextPanel';
import { useLocalize } from '~/hooks';

interface FileTextDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileId: string;
  filename: string;
}

/**
 * Shows the text a document parser extracted from an upload.
 *
 * The file list strips `text` to keep payloads small, so the content is fetched
 * on demand and only while the dialog is open.
 */
export default function FileTextDialog({
  open,
  onOpenChange,
  fileId,
  filename,
}: FileTextDialogProps) {
  const localize = useLocalize();

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="w-11/12 max-w-3xl" showCloseButton={true}>
        <OGDialogHeader>
          <OGDialogTitle className="truncate">{filename}</OGDialogTitle>
          <OGDialogDescription>{localize('com_ui_extracted_text_description')}</OGDialogDescription>
        </OGDialogHeader>
        <ExtractedTextPanel fileId={fileId} enabled={open} />
      </OGDialogContent>
    </OGDialog>
  );
}
