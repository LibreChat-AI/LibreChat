import { memo } from 'react';
import { Part as ChatPart, partRenderers } from '@librechat/chat/components';
import type { TMessageContentParts, TAttachment } from 'librechat-data-provider';
import type { PartRenderers } from '@librechat/chat/components';
/** Registers the key dialog and recovery actions an error part draws through the host. */
import '~/components/Messages/Content/Error/register';
import useAskAnswerMode from '~/hooks/Input/useAskAnswerMode';
import { useChatApprovalHost } from './ApprovalContext';
import { setAppApprovalHooks } from './Parts/slots';
import './toolCallSlots';

/** A paused question or tool call resumes through the chat's approval host, and a question can
 *  move into this app's composer. */
setAppApprovalHooks({
  useApprovalResumeHost: useChatApprovalHost,
  useAskAnswerMode,
});

/** The chat package's renderers: this app draws every part with them. */
export const renderers: PartRenderers = partRenderers();

type PartProps = {
  part?: TMessageContentParts;
  isLast?: boolean;
  isSubmitting: boolean;
  showCursor: boolean;
  isCreatedByUser: boolean;
  attachments?: TAttachment[];
  hideAttachments?: boolean;
  onToolExpand?: () => void;
};

/** One content part, drawn with the chat package's renderers. */
const Part = memo(function Part(props: PartProps) {
  return <ChatPart {...props} renderers={renderers} />;
});
Part.displayName = 'Part';

export default Part;
