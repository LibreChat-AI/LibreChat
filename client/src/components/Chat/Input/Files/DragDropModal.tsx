import React, { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { OGDialog, OGDialogTemplate } from '@librechat/client';
import { ImageUpIcon, FileSearch, FileType2Icon, TerminalSquareIcon } from 'lucide-react';
import { inferMimeType, EToolResources, defaultAgentCapabilities } from 'librechat-data-provider';
import {
  useAgentToolPermissions,
  useAgentCapabilities,
  useGetAgentsConfig,
  useLocalize,
} from '~/hooks';
import { ephemeralAgentByConvoId } from '~/store';
import { useDragDropContext } from '~/Providers';
import { isEphemeralAgent } from '~/common';

interface DragDropModalProps {
  onOptionSelect: (option: EToolResources | undefined) => void;
  files: File[];
  isVisible: boolean;
  setShowModal: (showModal: boolean) => void;
}

interface FileOption {
  label: string;
  value?: EToolResources;
  icon: React.JSX.Element;
  condition?: boolean;
}

const DragDropModal = ({ onOptionSelect, setShowModal, files, isVisible }: DragDropModalProps) => {
  const localize = useLocalize();
  const { agentsConfig } = useGetAgentsConfig();
  /** TODO: Ephemeral Agent Capabilities
   * Allow defining agent capabilities on a per-endpoint basis
   * Use definition for agents endpoint for ephemeral agents
   * */
  const capabilities = useAgentCapabilities(agentsConfig?.capabilities ?? defaultAgentCapabilities);
  const { conversationId, agentId } = useDragDropContext();
  const ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId(conversationId ?? ''));
  const { fileSearchAllowedByAgent, codeAllowedByAgent } = useAgentToolPermissions(
    agentId,
    ephemeralAgent,
  );

  // company: tool destinations are offerable in ephemeral (non-saved-agent) chats regardless of
  // toggle state — selecting one enables the toggle; saved agents gate on their tools (see COMPANY.md)
  const isSavedAgent = agentId != null && agentId !== '' && !isEphemeralAgent(agentId);
  const fileSearchOfferable = !isSavedAgent || fileSearchAllowedByAgent;
  const codeOfferable = !isSavedAgent || codeAllowedByAgent;

  const options = useMemo(() => {
    const _options: FileOption[] = [];

    /** Helper to get inferred MIME type for a file */
    const getFileType = (file: File) => inferMimeType(file.name, file.type);

    // company: single images-only "Add Photos" option replaces upstream's provider/image
    // branching — provider uploads are images-only regardless of provider (see COMPANY.md)
    _options.push({
      label: localize('com_ui_add_photos'),
      value: undefined,
      icon: <ImageUpIcon className="icon-md" />,
      condition: files.every((file) => getFileType(file)?.startsWith('image/')),
    });
    if (capabilities.fileSearchEnabled && fileSearchOfferable) {
      _options.push({
        label: localize('com_ui_upload_file_search'),
        value: EToolResources.file_search,
        icon: <FileSearch className="icon-md" />,
      });
    }
    if (capabilities.codeEnabled && codeOfferable) {
      _options.push({
        // company: renamed from com_ui_upload_code_environment (see COMPANY.md)
        label: localize('com_ui_add_files'),
        value: EToolResources.execute_code,
        icon: <TerminalSquareIcon className="icon-md" />,
      });
    }
    if (capabilities.contextEnabled) {
      _options.push({
        label: localize('com_ui_upload_ocr_text'),
        value: EToolResources.context,
        icon: <FileType2Icon className="icon-md" />,
      });
    }

    return _options;
  }, [files, localize, capabilities, codeOfferable, fileSearchOfferable]);

  if (!isVisible) {
    return null;
  }

  return (
    <OGDialog open={isVisible} onOpenChange={setShowModal}>
      <OGDialogTemplate
        title={localize('com_ui_upload_type')}
        className="w-11/12 sm:w-[440px] md:w-[400px] lg:w-[360px]"
        main={
          <div className="flex flex-col gap-2">
            {options.map(
              (option, index) =>
                option.condition !== false && (
                  <button
                    key={index}
                    onClick={() => onOptionSelect(option.value)}
                    className="flex items-center gap-2 rounded-lg p-2 hover:bg-surface-active-alt"
                  >
                    {option.icon}
                    <span>{option.label}</span>
                  </button>
                ),
            )}
          </div>
        }
      />
    </OGDialog>
  );
};

export default DragDropModal;
