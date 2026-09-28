import { useContext, useMemo, useState } from 'react';
import { Button, TextareaAutosize, TooltipAnchor } from '@librechat/client';
import { ChevronUp, MessageCircleQuestion, TriangleAlert } from 'lucide-react';
import type { Agents } from 'librechat-data-provider';
import { useApprovalContext, useAskSubmitStatus, useResumeSubmit } from './ApprovalContext';
import { splitOtherOption, ASK_USER_DECLINED_ANSWER } from '~/utils/approval';
import useAskAnswerMode from '~/hooks/Input/useAskAnswerMode';
import AskOptions from '~/components/Chat/ask/options';
import { ChatContext } from '~/Providers/ChatContext';
import AskUserQuestions from './AskUserQuestions';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * Renders an `ask_user_question` pause: the prompt, optional description, any
 * curated option buttons, and a free-form text answer. Single-select options
 * submit on click; multi-select options toggle and Submit confirms the set
 * (plus any typed text). While this card is the LIVE pause's surface it
 * shares selection state and submit paths with {@link useAskAnswerMode}, so
 * the composer, the popover, and this card always agree on what will be
 * sent; outside a live pause (Share/search) it falls back to local state.
 */
export default function AskUserQuestion({
  actionId,
  question,
  questions,
}: {
  actionId: string;
  question: Agents.AskUserQuestionRequest;
  questions?: Agents.AskUserQuestionBatchItem[];
}) {
  const conversationId = useContext(ChatContext)?.conversation?.conversationId;
  const answerMode = useAskAnswerMode(conversationId);
  const isLivePause = answerMode.liveAsk?.actionId === actionId;
  if (questions != null && questions.length > 0) {
    if (answerMode.popoverVisible && isLivePause) {
      return null;
    }
    return (
      <AskUserQuestions
        actionId={actionId}
        questions={questions}
        className="my-2 max-h-[70vh] w-full rounded-lg border border-border-light bg-surface-secondary"
        onExpand={answerMode.collapsed && isLivePause ? answerMode.expand : undefined}
      />
    );
  }
  return <AskUserQuestionSingle actionId={actionId} question={question} answerMode={answerMode} />;
}

function AskUserQuestionSingle({
  actionId,
  question,
  answerMode,
}: {
  actionId: string;
  question: Agents.AskUserQuestionRequest;
  answerMode: ReturnType<typeof useAskAnswerMode>;
}) {
  const localize = useLocalize();
  const { getAskAnswerDraft, setAskAnswerDraft } = useApprovalContext();
  const { getAskStatus } = useAskSubmitStatus();
  const { submitAskAnswer } = useResumeSubmit();
  const [answer, setAnswer] = useState(() => getAskAnswerDraft(actionId));
  const [localChecked, setLocalChecked] = useState<number[]>([]);
  /**
   * The composer popover is the primary answer surface — while it's VISIBLE
   * for this pause, rendering the card too duplicates the question. The card
   * takes over once the question is moved to the chat (the popover's chevron,
   * which also releases the composer; this card's chevron moves it back), and
   * in contexts without a ChatContext, where the popover can't exist.
   */
  const { popoverVisible, collapsed, expand, liveAsk } = answerMode;
  const isLivePause = liveAsk?.actionId === actionId;

  /** Same fold as the popover: a model-supplied catch-all "Other" option
   *  becomes the free-form textarea's placeholder, not a submittable row. */
  const { choices, otherLabel } = useMemo(
    () => splitOtherOption(question.options),
    [question.options],
  );

  const status = getAskStatus(actionId);
  const locked = status === 'submitting' || status === 'submitted' || status === 'expired';
  const showPlaceholder = popoverVisible && isLivePause;

  if (status === 'submitted') {
    return null;
  }

  const multiSelect = question.multiSelect === true;
  /** Live pause: share the hook's checked set so the composer's Enter and
   *  this card submit exactly what the card displays. */
  const checkedIndices = isLivePause ? answerMode.checked : localChecked;
  const answerValue = isLivePause ? answerMode.answerText : answer;
  const setAnswerValue = (value: string) => {
    if (isLivePause) {
      answerMode.setAnswerText(value);
      return;
    }
    setAnswer(value);
  };
  const toggleIndex = (index: number) => {
    if (isLivePause) {
      answerMode.toggleChecked(index);
      return;
    }
    setLocalChecked((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index],
    );
  };

  const trimmed = answerValue.trim();
  const canSubmit = multiSelect
    ? checkedIndices.length > 0 || trimmed.length > 0
    : trimmed.length > 0;

  const submitSingle = (index: number) => {
    if (isLivePause) {
      answerMode.submitOption(index);
      return;
    }
    const value = choices[index]?.value;
    if (value != null) {
      submitAskAnswer(actionId, value);
    }
  };

  /** `answerMode.skip()` is gated on answer mode being ACTIVE, which a
   *  question moved to the chat is not. That is precisely when this card
   *  is the only surface left. Decline through the answer path instead,
   *  which is gated on the live pause rather than on answer mode. */
  const handleSkip = () => {
    if (isLivePause) {
      answerMode.submitAnswer([ASK_USER_DECLINED_ANSWER]);
      return;
    }
    submitAskAnswer(actionId, ASK_USER_DECLINED_ANSWER);
  };

  const submitCombined = () => {
    const values = multiSelect
      ? checkedIndices
          .map((index) => choices[index]?.value)
          .filter((value): value is string => typeof value === 'string')
      : [];
    if (trimmed.length > 0) {
      values.push(trimmed);
    }
    if (values.length === 0) {
      return;
    }
    if (isLivePause) {
      answerMode.submitAnswer(values);
      return;
    }
    submitAskAnswer(actionId, values.join(', '));
  };

  /**
   * The live card shares its view-transition-name with the popover panel, so
   * collapse/expand morphs one surface into the other. The placeholder copy
   * is `visibility: hidden` (out of the tab order and the a11y tree) and
   * carries NO transition name because duplicate names would void the morph, but
   * it still occupies the card's exact footprint, so the thread reserves the
   * space while the question lives in the composer and nothing reflows when
   * it moves back.
   */
  const card = (
    <div
      className={cn(
        'my-2 flex w-full flex-col gap-2.5 rounded-xl border border-border-light bg-surface-secondary p-3',
        showPlaceholder && 'invisible',
      )}
      aria-hidden={showPlaceholder || undefined}
      style={isLivePause && !showPlaceholder ? { viewTransitionName: 'ask-question' } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary [overflow-wrap:anywhere]">
            {question.question}
          </p>
          {question.description != null && question.description.length > 0 && (
            <p className="mt-0.5 text-xs text-text-secondary [overflow-wrap:anywhere]">
              {question.description}
            </p>
          )}
        </div>
        {collapsed && isLivePause && (
          <TooltipAnchor
            description={localize('com_ui_ask_move_to_composer')}
            side="top"
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={localize('com_ui_ask_move_to_composer')}
                className="size-auto rounded-md p-1 text-text-secondary"
                onClick={expand}
              >
                <ChevronUp className="size-4" aria-hidden="true" />
              </Button>
            }
          />
        )}
      </div>

      {choices.length > 0 && (
        <AskOptions
          options={choices}
          multiSelect={multiSelect}
          checked={checkedIndices}
          locked={locked}
          onActivate={(index) => (multiSelect ? toggleIndex(index) : submitSingle(index))}
        />
      )}

      <TextareaAutosize
        value={answerValue}
        disabled={locked}
        onChange={(e) => {
          setAnswerValue(e.target.value);
          setAskAnswerDraft(actionId, e.target.value);
        }}
        minRows={2}
        maxRows={12}
        placeholder={otherLabel ?? localize('com_ui_your_answer')}
        className="w-full resize-none rounded-lg border border-border-light bg-surface-chat px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
        aria-label={localize('com_ui_your_answer')}
      />

      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" disabled={locked} onClick={handleSkip}>
          {localize('com_ui_skip')}
        </Button>
        {(status === 'expired' || status === 'error') && (
          <span className="flex min-w-0 items-center text-xs text-text-warning">
            <TriangleAlert className="mr-1.5 size-4 shrink-0" aria-hidden="true" />
            {localize(status === 'expired' ? 'com_ui_approval_expired' : 'com_ui_approval_error')}
          </span>
        )}
        <Button
          size="sm"
          variant="submit"
          className="ml-auto"
          disabled={!canSubmit || locked}
          onClick={submitCombined}
        >
          {status === 'submitting' ? localize('com_ui_submitting') : localize('com_ui_submit')}
        </Button>
      </div>
    </div>
  );

  if (!showPlaceholder) {
    return card;
  }

  /** Popover has the question: the reserved card sits hidden underneath the
   *  same compact in-progress row the other tools use, so the turn still
   *  shows the call is running. */
  return (
    <div className="relative">
      {card}
      <div className="absolute inset-x-0 top-0 my-1 flex h-5 items-center gap-2.5">
        <MessageCircleQuestion className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="tool-status-text shimmer font-medium text-text-secondary">
          {localize('com_ui_asking')}
        </span>
      </div>
    </div>
  );
}
