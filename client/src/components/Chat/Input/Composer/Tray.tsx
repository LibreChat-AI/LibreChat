import { memo } from 'react';
import { ComposerTray } from '@librechat/chat/components';
import type { ComposerTrayProps } from '@librechat/chat/components';
import type { TConversation } from 'librechat-data-provider';
import { useFileHandlingNoChatContext } from '~/hooks';

interface TrayProps extends Omit<ComposerTrayProps, 'abortUpload'> {
  conversation: TConversation | null;
}

/** The chat package's staged-context tray, fed the app's upload stack. */
function Tray({ conversation, ...props }: TrayProps) {
  const { abortUpload } = useFileHandlingNoChatContext(undefined, {
    index: props.index,
    files: props.files,
    setFiles: props.setFiles,
    setFilesLoading: props.setFilesLoading,
    conversation,
  });

  return <ComposerTray {...props} abortUpload={abortUpload} />;
}

export default memo(Tray);
