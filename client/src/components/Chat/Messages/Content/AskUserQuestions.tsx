import { AskUserQuestions as Questions } from '@librechat/chat/components';
import type { ComponentProps } from 'react';
import { useResumeSubmit } from './ApprovalContext';

type QuestionsProps = ComponentProps<typeof Questions>;

/** The app's question batch: resume goes through the approval host. */
export default function AskUserQuestions(props: Omit<QuestionsProps, 'submitAskAnswer'>) {
  const { submitAskAnswer } = useResumeSubmit();
  return <Questions {...props} submitAskAnswer={submitAskAnswer} />;
}
