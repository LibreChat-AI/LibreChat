import { memo } from 'react';
import { getAskUserQuestionPart } from '@librechat/chat';
import { Part as ChatPart, partRenderers, extendPartRenderers } from '@librechat/chat/components';
import {
  Constants,
  ContentTypes,
  hasToolCallPreview,
  getToolCallPreviewRevision,
} from 'librechat-data-provider';
import type { TMessageContentParts, TAttachment } from 'librechat-data-provider';
import type { PartRenderers } from '@librechat/chat/components';
import { ErrorMessage } from './MessageContent';
import AskUserQuestion from './AskUserQuestion';
import ToolApproval from './ToolApproval';
import { SubagentCall } from './Parts';
import './toolCallSlots';

/**
 * What this app draws that the chat package's own renderers do not: the cards that read this
 * app's state (a paused question, approval controls, a subagent's agents) and
 * its error message. Every other part is the package's to draw.
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
  parts: {
    [ContentTypes.ERROR]: ({ part }) => (
      <ErrorMessage
        text={
          part[ContentTypes.ERROR] ??
          (typeof part[ContentTypes.TEXT] === 'string'
            ? part[ContentTypes.TEXT]
            : part.text?.value) ??
          ''
        }
        className="my-2"
      />
    ),
  },
  tools: {
    [Constants.SUBAGENT]: ({ part, toolCall, attachments, isSubmitting, hideAttachments }) => {
      /** `subagent_content` is the aggregated content-parts array the
       *  backend writes onto the tool_call at message-save time so the
       *  child's activity survives a page refresh. Not present on older
       *  runs recorded before the persistence path existed; those fall
       *  back to the Recoil atom (live session) or the raw tool output
       *  inside `SubagentCall`. */
      const persistedContent = (
        toolCall as unknown as {
          subagent_content?: TMessageContentParts[];
        }
      ).subagent_content;
      return (
        <SubagentCall
          toolCallId={toolCall.id ?? ''}
          args={toolCall.args}
          output={toolCall.output ?? ''}
          initialProgress={toolCall.progress ?? 0.1}
          isSubmitting={isSubmitting}
          runStepStatus={toolCall.runStepStatus}
          attachments={attachments}
          persistedContent={persistedContent}
          contentPreview={
            hasToolCallPreview(toolCall)
              ? {
                  revision: getToolCallPreviewRevision(toolCall),
                  stepId: toolCall.stepId,
                  agentId: part.agentId,
                }
              : undefined
          }
          subagentIdentity={toolCall.subagentIdentity}
          hideAttachments={hideAttachments}
        />
      );
    },
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
