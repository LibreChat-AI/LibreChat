import { useContext } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import type { PausedQuestionProps } from '../parts/ask/Paused';
import { ChatContext } from '../../react/chat/context';
import { useMessagePartsHost } from '../../react/host';
import PausedQuestion from '../parts/ask/Paused';
import ToolApproval from './ToolApproval';

const useNoResumeHost = (): null => null;
const useNoAnswerMode = (): undefined => undefined;

/** A paused question inside a message, resumed and shared with a composer as the host says. */
export function HostedQuestion(
  props: Omit<PausedQuestionProps, 'answerMode' | 'resumeHost'>,
): ReactNode {
  const { useApprovalResumeHost = useNoResumeHost, useAskAnswerMode = useNoAnswerMode } =
    useMessagePartsHost();
  const conversationId = useContext(ChatContext)?.conversation?.conversationId;
  const answerMode = useAskAnswerMode(conversationId);
  const resumeHost = useApprovalResumeHost();
  return <PausedQuestion {...props} answerMode={answerMode} resumeHost={resumeHost} />;
}

/** Approval controls for a tool call paused inside a message, resumed as the host says. */
export function HostedToolApproval(
  props: Omit<ComponentProps<typeof ToolApproval>, 'resumeHost' | 'surface'>,
): ReactNode {
  const { useApprovalResumeHost = useNoResumeHost } = useMessagePartsHost();
  const resumeHost = useApprovalResumeHost();
  return <ToolApproval {...props} resumeHost={resumeHost} />;
}
