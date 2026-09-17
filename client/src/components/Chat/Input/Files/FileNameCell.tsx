import React, { useState } from 'react';
import { FileSources, isParsedDocument } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import FileTextDialog from '~/components/Chat/Input/Files/FileTextDialog';
import FilePreview from '~/components/Chat/Input/Files/FilePreview';
import { getFileType } from '~/utils';
import { useLocalize } from '~/hooks';

/**
 * Whether the record actually holds extracted text.
 *
 * A record whose text replaces its bytes for the model is stamped
 * `llmDeliveryPath: 'text'` by the upload path; records written before storage kept
 * the original document say the same thing with `FileSources.text`. The same PDF
 * uploaded to file_search or execute_code is stored as a binary with no text at all,
 * so the MIME check alone would offer a control that always dead-ends in an empty state.
 */
const hasExtractedText = (file: TFile): boolean =>
  (file.llmDeliveryPath === 'text' || file.source === FileSources.text) &&
  isParsedDocument(file.type, file.filename);

/**
 * Filename cell for the file manager.
 *
 * For parsed documents the name becomes a button that opens the extracted text,
 * which is otherwise invisible: it is sent to the model but stripped from every
 * file listing. Other file types render as plain text, unchanged.
 */
export default function FileNameCell({ file }: { file: TFile }) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const fileType = getFileType(file.type);

  if (!hasExtractedText(file)) {
    return (
      <div className="flex gap-2">
        {fileType && <FilePreview fileType={fileType} className="relative" file={file} />}
        <span className="self-center truncate">{file.filename}</span>
      </div>
    );
  }

  return (
    <>
      <div className="flex gap-2">
        {fileType && <FilePreview fileType={fileType} className="relative" file={file} />}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={localize('com_ui_view_extracted_text_var', { 0: file.filename })}
          className="self-center truncate rounded underline decoration-dotted underline-offset-4 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
        >
          {file.filename}
        </button>
      </div>
      <FileTextDialog
        open={open}
        onOpenChange={setOpen}
        fileId={file.file_id}
        filename={file.filename}
      />
    </>
  );
}
