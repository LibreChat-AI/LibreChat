import { useContext } from 'react';
import { AskUserQuestion as Question } from '@librechat/chat/components';
import type { ComponentProps } from 'react';
import { useApprovalContext, useResumeSubmit } from './ApprovalContext';
import useAskAnswerMode from '~/hooks/Input/useAskAnswerMode';
import { ChatContext } from '~/Providers/ChatContext';

type QuestionProps = ComponentProps<typeof Question>;

/** The app's ask card: answer mode, resume, and the draft the approval host keeps. */
export default function AskUserQuestion(
  props: Omit<
    QuestionProps,
    'answerMode' | 'submitAskAnswer' | 'getAskAnswerDraft' | 'setAskAnswerDraft'
  >,
) {
  const conversationId = useContext(ChatContext)?.conversation?.conversationId;
  const answerMode = useAskAnswerMode(conversationId);
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
