import { useId, useMemo, useContext } from 'react';
import { useLocalize } from '@librechat/client';
import type { ComponentProps, ReactNode } from 'react';
import type { ApprovalResumeHost } from '../../../react/approval';
import type { AskCardMode } from '../../../react/parts/ask';
import { useApprovalContext, useResumeSubmit } from '../../approval/context';
import { ChatContext } from '../../../react/chat/context';
import Question from './Question';

type QuestionProps = ComponentProps<typeof Question>;

export type PausedQuestionProps = Omit<
  QuestionProps,
  'answerMode' | 'submitAskAnswer' | 'getAskAnswerDraft' | 'setAskAnswerDraft'
> & {
  /** The host composer's share of the live pause; see `MessagePartsHost.useAskAnswerMode`. */
  answerMode?: AskCardMode;
  /** How this view resumes the run. A transport or an `ApprovalResumeHostProvider` above wins. */
  resumeHost?: ApprovalResumeHost | null;
};

const keepInCard = (): void => undefined;

/**
 * A paused `ask_user_question`, answered in its card: the answer resumes the run, and a typed
 * answer survives the card remounting. A view with no way to resume draws the question with its
 * controls disabled and says it cannot be answered here, so an answer is never taken in and
 * dropped.
 */
export default function PausedQuestion({
  answerMode,
  resumeHost = null,
  ...props
}: PausedQuestionProps): ReactNode {
  const localize = useLocalize();
  const noteId = useId();
  const chat = useContext(ChatContext);
  /**
   * Moving a question into the composer hands it to the main chat's form. A conversation in any
   * other pane has no composer that can take it, so there the question stays in its card.
   */
  const mode = useMemo(
    () =>
      answerMode == null || (chat?.index ?? 0) === 0
        ? answerMode
        : { ...answerMode, collapsed: false, popoverVisible: false, expand: keepInCard },
    [chat, answerMode],
  );
  const { getAskAnswerDraft, setAskAnswerDraft } = useApprovalContext();
  const { available, submitAskAnswer } = useResumeSubmit(resumeHost);
  const card = (
    <Question
      {...props}
      answerMode={mode}
      submitAskAnswer={submitAskAnswer}
      getAskAnswerDraft={getAskAnswerDraft}
      setAskAnswerDraft={setAskAnswerDraft}
    />
  );
  if (available) {
    return card;
  }
  /** A disabled fieldset disables every control inside it natively, and keeps the question
   *  itself readable. */
  return (
    <fieldset disabled aria-describedby={noteId} className="min-w-0">
      {card}
      <p id={noteId} className="text-text-secondary text-xs">
        {localize('com_ui_ask_unavailable')}
      </p>
    </fieldset>
  );
}
