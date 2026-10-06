import { useState, useRef, useEffect } from 'react';
import { EToolResources, mergeFileConfig, getEndpointFileConfig } from 'librechat-data-provider';
import type { AssistantsEndpoint } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import FileRow, { FileRowWrapper } from '~/components/Chat/Input/Files/FileRow';
import { useGetFileConfig } from '~/data-provider';
import { useFileHandling } from '~/hooks/Files';
import { useChatContext } from '~/Providers';
import { useLocalize } from '~/hooks';

const tool_resource = EToolResources.code_interpreter;

export default function CodeFiles({
  endpoint,
  assistant_id,
  files: _files,
}: {
  version: number | string;
  endpoint: AssistantsEndpoint;
  assistant_id: string;
  files?: [string, ExtendedFile][];
}) {
  const localize = useLocalize();
  const { setFilesLoading } = useChatContext();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Map<string, ExtendedFile>>(new Map());
  const { data: fileConfig = null } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });
  const { handleFileChange } = useFileHandling({
    additionalMetadata: { assistant_id, tool_resource },
    fileSetter: setFiles,
  });

  useEffect(() => {
    if (_files) {
      setFiles(new Map(_files));
    }
  }, [_files]);

  const endpointFileConfig = getEndpointFileConfig({
    fileConfig,
    endpoint,
    endpointType: endpoint,
  });
  const isUploadDisabled = endpointFileConfig?.disabled ?? false;

  if (isUploadDisabled) {
    return null;
  }

  const handleButtonClick = () => {
    // necessary to reset the input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    fileInputRef.current?.click();
  };

  return (
    <div className="mb-2 w-full">
      <div className="flex flex-col gap-4">
        <div className="text-text-secondary rounded-lg text-xs">
          {localize('com_assistants_code_interpreter_files')}
        </div>
        <FileRow
          files={files}
          setFiles={setFiles}
          assistant_id={assistant_id}
          tool_resource={tool_resource}
          setFilesLoading={setFilesLoading}
          Wrapper={FileRowWrapper}
        />
        <div>
          <button
            type="button"
            disabled={!assistant_id}
            className="btn btn-neutral border-border-light relative h-9 w-full rounded-lg font-medium"
            onClick={handleButtonClick}
          >
            <div className="flex w-full items-center justify-center gap-2">
              <input
                multiple={true}
                type="file"
                style={{ display: 'none' }}
                tabIndex={-1}
                ref={fileInputRef}
                disabled={!assistant_id}
                onChange={handleFileChange}
              />
              {localize('com_ui_upload_files')}
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
