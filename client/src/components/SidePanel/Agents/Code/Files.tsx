import { memo, useMemo, useRef, useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { EToolResources, EModelEndpoint, AgentCapabilities } from 'librechat-data-provider';
import type { ExtendedFile, AgentForm } from '~/common';
import { useFileHandlingNoChatContext } from '~/hooks/Files/useFileHandling';
import { useAgentFileConfig, useLocalize, useLazyEffect } from '~/hooks';
import DropzoneContent, { dropzoneClassName } from '../UploadDropzone';
import FileRow from '~/components/Chat/Input/Files/FileRow';
import { isEphemeralAgent } from '~/common';

const tool_resource = EToolResources.execute_code;

function Files({
  agent_id,
  files: _files,
}: {
  agent_id: string;
  files?: [string, ExtendedFile][];
}) {
  const localize = useLocalize();
  const { setValue } = useFormContext<AgentForm>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Map<string, ExtendedFile>>(new Map());
  const fileHandlingState = useMemo(() => ({ files, setFiles, conversation: null }), [files]);
  const { endpointFileConfig, providerValue, endpointType } = useAgentFileConfig();
  const endpointOverride = providerValue || EModelEndpoint.agents;
  const { abortUpload, handleFileChange } = useFileHandlingNoChatContext(
    {
      fileSetter: setFiles,
      additionalMetadata: { agent_id, tool_resource },
      endpointOverride,
      endpointTypeOverride: endpointType,
    },
    fileHandlingState,
  );

  useLazyEffect(
    () => {
      if (_files) {
        setFiles(new Map(_files));
      }
    },
    [_files],
    750,
  );

  const isUploadDisabled = endpointFileConfig?.disabled ?? false;
  const uploadDisabled = isEphemeralAgent(agent_id);

  const enableExecuteCode = () =>
    setValue(AgentCapabilities.execute_code, true, { shouldDirty: true });

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      enableExecuteCode();
    }
    handleFileChange(event);
  };

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
      <div className="flex flex-col gap-3">
        <div className="rounded-lg text-xs text-text-secondary">
          {localize('com_agents_run_code_files')}
        </div>
        <FileRow
          files={files}
          setFiles={setFiles}
          agent_id={agent_id}
          abortUpload={abortUpload}
          tool_resource={tool_resource}
          Wrapper={({ children }) => <div className="flex flex-wrap gap-2">{children}</div>}
        />
        <div>
          <button
            type="button"
            disabled={uploadDisabled}
            className={dropzoneClassName}
            onClick={handleButtonClick}
          >
            <DropzoneContent
              label={localize('com_ui_upload_code_environment')}
              hint={localize('com_ui_upload_files_hint')}
            />
          </button>
          <input
            multiple={true}
            type="file"
            style={{ display: 'none' }}
            tabIndex={-1}
            ref={fileInputRef}
            disabled={uploadDisabled}
            onChange={handleFileUpload}
          />
        </div>
      </div>
    </div>
  );
}

const MemoizedFiles = memo(Files);
MemoizedFiles.displayName = 'Files';

export default MemoizedFiles;
