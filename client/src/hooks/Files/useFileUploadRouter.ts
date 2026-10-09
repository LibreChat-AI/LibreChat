import { useCallback } from 'react';
import { useSetRecoilState } from 'recoil';
import { Constants, EToolResources } from 'librechat-data-provider';
import type { UploadLifecycleCallbacks } from './useFileHandling';
import { useChatContext } from '~/Providers/ChatContext';
import { ephemeralAgentByConvoId } from '~/store';
import useFileHandling from './useFileHandling';

/**
 * Returns a function that attaches files to a chosen upload destination, enabling the
 * matching ephemeral-agent capability first (file search is left for explicit opt-in to
 * preserve legacy behavior). Shared by the paste, drag, and modal flows. Resolves to
 * whether the files were accepted, so callers can gate success messaging on it.
 */
export default function useFileUploadRouter() {
  const { handleFiles } = useFileHandling();
  const { conversation } = useChatContext();
  const setEphemeralAgent = useSetRecoilState(
    ephemeralAgentByConvoId(conversation?.conversationId ?? Constants.NEW_CONVO),
  );

  return useCallback(
    (files: File[], toolResource?: EToolResources, uploadLifecycle?: UploadLifecycleCallbacks) => {
      if (toolResource && toolResource !== EToolResources.file_search) {
        setEphemeralAgent((prev) => ({
          ...prev,
          [toolResource]: true,
        }));
      }
      return handleFiles(files, toolResource, uploadLifecycle);
    },
    [handleFiles, setEphemeralAgent],
  );
}
