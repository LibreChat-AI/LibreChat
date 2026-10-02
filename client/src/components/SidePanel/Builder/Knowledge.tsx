import { useState, useRef, useEffect } from 'react';
import {
  mergeFileConfig,
  retrievalMimeTypes,
  getEndpointFileConfig,
} from 'librechat-data-provider';
import type { AssistantsEndpoint } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import FileRow from '~/components/Chat/Input/Files/FileRow';
import { useGetFileConfig } from '~/data-provider';
import { useFileHandling } from '~/hooks/Files';
import { useChatContext } from '~/Providers';
import { useLocalize } from '~/hooks';

const CodeInterpreterFiles = ({ children }: { children: React.ReactNode }) => {
  const localize = useLocalize();
  return (
    <div>
      <div className="text-text-tertiary mb-2 text-xs">
        {localize('com_assistants_code_interpreter_files')}
      </div>
      {/* Files available to Code Interpreter only */}
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
};

export default function Knowledge({
  endpoint,
  assistant_id,
  files: _files,
}: {
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
    additionalMetadata: { assistant_id },
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
    <div className="mb-6">
      <div className="mb-1.5 flex items-center">
        <span>
          <label className="text-text-primary block font-medium">
            {assistant_id
              ? localize('com_assistants_knowledge')
              : localize('com_assistants_knowledge_disabled')}
          </label>
        </span>
      </div>
      <div className="flex flex-col gap-4">
        <div className="text-text-tertiary rounded-lg">
          {assistant_id ? localize('com_assistants_knowledge_info') : ''}
        </div>
        {/* Files available to both tools */}
        <FileRow
          files={files}
          setFiles={setFiles}
          setFilesLoading={setFilesLoading}
          assistant_id={assistant_id}
          fileFilter={(file: ExtendedFile) =>
            retrievalMimeTypes.some((regex) => regex.test(file.type ?? ''))
          }
          Wrapper={({ children }) => <div className="flex flex-wrap gap-2">{children}</div>}
        />
        <FileRow
          files={files}
          setFiles={setFiles}
          setFilesLoading={setFilesLoading}
          assistant_id={assistant_id}
          fileFilter={(file: ExtendedFile) =>
            !retrievalMimeTypes.some((regex) => regex.test(file.type ?? ''))
          }
          Wrapper={CodeInterpreterFiles}
        />
        <div>
          <button
            type="button"
            disabled={!assistant_id}
            className="btn btn-neutral border-border-light relative h-8 rounded-lg font-medium"
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
