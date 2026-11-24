import { useMemo, useContext } from 'react';
import { AskUserQuestion as Question } from '@librechat/chat/components';
import type { ComponentProps } from 'react';
import { useApprovalContext, useResumeSubmit } from './ApprovalContext';
import useAskAnswerMode from '~/hooks/Input/useAskAnswerMode';
import { ChatContext } from '~/Providers/ChatContext';

type QuestionProps = ComponentProps<typeof Question>;

const keepInCard = (): void => undefined;

/** The app's ask card: answer mode, resume, and the draft the approval host keeps. */
export default function AskUserQuestion(
  props: Omit<
    QuestionProps,
    'answerMode' | 'submitAskAnswer' | 'getAskAnswerDraft' | 'setAskAnswerDraft'
  >,
) {
  const chat = useContext(ChatContext);
  const conversationId = chat?.conversation?.conversationId;
  const mode = useAskAnswerMode(conversationId);
  /**
   * Moving a question into the composer hands it to the main chat's form. A conversation in any
   * other pane has no composer that can take it, so there the question stays in its card.
   */
  const answerMode = useMemo(
    () =>
      (chat?.index ?? 0) === 0
        ? mode
        : { ...mode, collapsed: false, popoverVisible: false, expand: keepInCard },
    [chat, mode],
  );
  const { getAskAnswerDraft, setAskAnswerDraft } = useApprovalContext();
  const { submitAskAnswer } = useResumeSubmit();
  return (
    <Question
      {...props}
      answerMode={answerMode}
      submitAskAnswer={submitAskAnswer}
      getAskAnswerDraft={getAskAnswerDraft}
      setAskAnswerDraft={setAskAnswerDraft}
    />
  );
}
