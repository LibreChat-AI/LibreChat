import React, { useState } from 'react';
import { FileUp } from 'lucide-react';
import { Button } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils/';

type FileUploadProps = {
  onFileSelected: (jsonData: Record<string, unknown>) => void;
  className?: string;
  containerClassName?: string;
  successText?: string;
  invalidText?: string;
  validator?: ((data: Record<string, unknown>) => boolean) | null;
  text?: string;
  id?: string;
};

const FileUpload: React.FC<FileUploadProps> = ({
  onFileSelected,
  className = '',
  containerClassName = '',
  successText = null,
  invalidText = null,
  validator = null,
  text = null,
  id = '1',
}) => {
  const [statusColor, setStatusColor] = useState<string>('text-text-secondary');
  const [status, setStatus] = useState<null | string>(null);
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
        setStatusColor('text-text-destructive');
        return;
      }

      if (validator) {
        setStatus('success');
        setStatusColor('text-status-success');
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
        variant="ghost"
        size="sm"
        onClick={handleClick}
        className={cn(
          'text-text-secondary hover:bg-surface-hover hover:text-status-success focus:ring-text-primary mr-1 flex h-auto cursor-pointer items-center rounded bg-transparent px-2 py-1 text-xs font-normal transition-colors',
          statusColor,
          containerClassName,
        )}
        aria-label={statusText}
      >
        <FileUp className="mr-1 flex w-[1.375rem] items-center stroke-1" aria-hidden="true" />
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
