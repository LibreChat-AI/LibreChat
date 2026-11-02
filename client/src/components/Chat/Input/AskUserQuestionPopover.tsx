import { memo } from 'react';
import { useWatch } from 'react-hook-form';
import { AskPopover } from '@librechat/chat/components';
import type { AskPopoverProps } from '@librechat/chat/components';
import AskUserQuestions from '~/components/Chat/Messages/Content/AskUserQuestions';
import useAskAnswerMode from '~/hooks/Input/useAskAnswerMode';
import { useChatFormContext } from '~/Providers';

/** The composer draft, the free-form answer box of a live question. */
function useDraftText(): string {
  const { control } = useChatFormContext();
  return (useWatch({ control, name: 'text' }) ?? '') as string;
}

const renderQuestions: AskPopoverProps['renderQuestions'] = ({
  liveAsk,
  questions,
  onEscape,
  headerAction,
}) => (
  /* Kept at full height so the popover's cap scrolls it rather than clipping its end. */
  <AskUserQuestions
    actionId={liveAsk.actionId}
    questions={questions}
    className="shrink-0"
    focusOnArrival
    onEscape={onEscape}
    headerAction={headerAction}
  />
);

function AskUserQuestionPopoverContent({
  conversationId,
  textAreaRef,
}: {
  conversationId: string;
  textAreaRef?: React.RefObject<HTMLTextAreaElement>;
}) {
  const ask = useAskAnswerMode(conversationId);
  return (
    <AskPopover
      conversationId={conversationId}
      ask={ask}
      useComposerText={useDraftText}
      textAreaRef={textAreaRef}
      renderQuestions={renderQuestions}
    />
  );
}

/** The app's answer mode for a live `ask_user_question` pause, drawn by the chat package's
 *  composer popover. A new conversation has no thread to ask from. */
const AskUserQuestionPopover = memo(function AskUserQuestionPopover({
  conversationId,
  textAreaRef,
}: {
  conversationId?: string | null;
  textAreaRef?: React.RefObject<HTMLTextAreaElement>;
}) {
  if (conversationId == null || conversationId === 'new') {
    return null;
  }
  return (
    <AskUserQuestionPopoverContent conversationId={conversationId} textAreaRef={textAreaRef} />
  );
});

export default AskUserQuestionPopover;
