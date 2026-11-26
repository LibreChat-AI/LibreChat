import React, { useState } from 'react';
import { FileUp } from 'lucide-react';
import { cn, Button, useLocalize } from '@librechat/client';

type FileUploadProps = {
  onFileSelected: (jsonData: Record<string, unknown>) => void;
  className?: string;
  successText?: string;
  invalidText?: string;
  validator?: ((data: Record<string, unknown>) => boolean) | null;
  text?: string;
  id?: string;
};

const FileUpload: React.FC<FileUploadProps> = ({
  onFileSelected,
  className = '',
  successText = null,
  invalidText = null,
  validator = null,
  text = null,
  id = '1',
}) => {
  const [status, setStatus] = useState<null | 'success' | 'invalid'>(null);
  const localize = useLocalize();

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const jsonData = JSON.parse(e.target?.result as string);
      if (validator && !validator(jsonData)) {
        setStatus('invalid');
        return;
      }

      if (validator) {
        setStatus('success');
      }

      onFileSelected(jsonData);
    };
    reader.readAsText(file);
  };

  let statusText: string;
  if (!status) {
    statusText = text ?? localize('com_ui_import');
  } else if (status === 'success') {
    statusText = successText ?? localize('com_ui_upload_success');
  } else {
    statusText = invalidText ?? localize('com_ui_upload_invalid');
  }

  const handleClick = () => {
    const fileInput = document.getElementById(`file-upload-${id}`) as HTMLInputElement;
    if (fileInput) {
      fileInput.click();
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="field-import"
        onClick={handleClick}
        data-status={status ?? undefined}
        className="me-1 flex w-full cursor-pointer items-center"
        aria-label={statusText}
      >
        <FileUp className="me-1 flex size-5.5 items-center stroke-1" aria-hidden="true" />
        <span className="flex text-xs">{statusText}</span>
      </Button>
      <input
        id={`file-upload-${id}`}
        value=""
        type="file"
        className={cn('hidden', className)}
        accept=".json"
        onChange={handleFileChange}
        tabIndex={-1}
      />
    </>
  );
};

export default FileUpload;
