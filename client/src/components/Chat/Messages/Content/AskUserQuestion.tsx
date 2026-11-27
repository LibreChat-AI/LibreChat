import { useContext } from 'react';
import { PausedQuestion } from '@librechat/chat/components';
import type { PausedQuestionProps } from '@librechat/chat/components';
import useAskAnswerMode from '~/hooks/Input/useAskAnswerMode';
import { useChatApprovalHost } from './ApprovalContext';
import { ChatContext } from '~/Providers/ChatContext';

/** The ask card for views outside a message, such as a response review: the chat package's card
 *  with this app's composer answer mode and resume host. */
export default function AskUserQuestion(
  props: Omit<PausedQuestionProps, 'answerMode' | 'resumeHost'>,
) {
  const conversationId = useContext(ChatContext)?.conversation?.conversationId;
  const answerMode = useAskAnswerMode(conversationId);
  const resumeHost = useChatApprovalHost();
  return <PausedQuestion {...props} answerMode={answerMode} resumeHost={resumeHost} />;
}
