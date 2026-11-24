import { memo } from 'react';
import { getAskUserQuestionPart } from '@librechat/chat';
import { Part as ChatPart, partRenderers, extendPartRenderers } from '@librechat/chat/components';
import type { TMessageContentParts, TAttachment } from 'librechat-data-provider';
import type { PartRenderers } from '@librechat/chat/components';
/** Registers the key dialog and recovery actions an error part draws through the host. */
import '~/components/Messages/Content/Error/register';
import AskUserQuestion from './AskUserQuestion';
import ToolApproval from './ToolApproval';
import './toolCallSlots';

/**
 * What this app draws that the chat package's own renderers do not: the cards that read this
 * app's state (a paused question, approval controls). Every other part is the package's to
 * draw.
 */
export const renderers: PartRenderers = extendPartRenderers({
  claim: ({ part }) => {
    const askUserQuestion = getAskUserQuestionPart(part);
    if (!askUserQuestion) {
      return undefined;
    }
    return (
      <AskUserQuestion
        key={askUserQuestion.ask_user_question.actionId}
        actionId={askUserQuestion.ask_user_question.actionId}
        question={askUserQuestion.ask_user_question.question}
        questions={askUserQuestion.ask_user_question.questions}
      />
    );
  },
  /**
   * Approval controls for ANY paused agent tool, not just the generic card, so a HITL policy
   * that gates a specialized tool (bash, code, file…) still surfaces approve/reject/edit/respond.
   * Only while the call is unresolved (no output yet).
   */
  wrapTool: (card, props) => {
    const prepared = partRenderers().wrapTool?.(card, props) ?? card;
    const { toolCall } = props;
    if (toolCall.approval == null || (toolCall.output?.length ?? 0) > 0) {
      return prepared;
    }
    return (
      <>
        {prepared}
        <ToolApproval
          approval={toolCall.approval}
          toolCallId={toolCall.id ?? ''}
          args={toolCall.args}
        />
      </>
    );
  },
});

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

/** One content part, drawn with the chat package's renderers and this app's own over them. */
const Part = memo(function Part(props: PartProps) {
  return <ChatPart {...props} renderers={renderers} />;
});
Part.displayName = 'Part';

export default Part;
