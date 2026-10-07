import { useContext, useMemo, useState } from 'react';
import { Button, TextareaAutosize, TooltipAnchor } from '@librechat/client';
import { ChevronDown, MessageCircleQuestion, TriangleAlert } from 'lucide-react';
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
    /** Same footprint reservation as a single question: while the popover owns
     *  the batch, a hidden copy of the card holds its place in the thread, so
     *  moving it between the composer and the chat reflows nothing. */
    const reserved = answerMode.popoverVisible && isLivePause;
    const card = (
      <AskUserQuestionsCard
        actionId={actionId}
        questions={questions}
        live={isLivePause && !reserved}
        reserved={reserved}
        onExpand={answerMode.collapsed && isLivePause ? answerMode.expand : undefined}
      />
    );
    return reserved ? <AskingPlaceholder>{card}</AskingPlaceholder> : card;
  }
  return <AskUserQuestionSingle actionId={actionId} question={question} answerMode={answerMode} />;
}

/** The batch's chat card. Shares the popover's view-transition-name while it is
 *  the live pause's surface, so moving the batch between the composer and the
 *  chat morphs one surface into the other, like a single question does. */
function AskUserQuestionsCard({
  actionId,
  questions,
  live,
  reserved,
  onExpand,
}: {
  actionId: string;
  questions: Agents.AskUserQuestionBatchItem[];
  live: boolean;
  reserved: boolean;
  onExpand?: () => void;
}) {
  const localize = useLocalize();
  return (
    <div
      className={cn(
        'border-border-light bg-surface-secondary my-2 flex w-full flex-col rounded-2xl border',
        live && '[view-transition-name:ask-question]',
        reserved && 'invisible',
      )}
      aria-hidden={reserved || undefined}
      inert={reserved ? '' : undefined}
    >
      <AskUserQuestions
        actionId={actionId}
        questions={questions}
        headerAction={
          onExpand != null && (
            <TooltipAnchor
              description={localize('com_ui_ask_move_to_composer')}
              side="top"
              render={
                <Button
                  variant="row-action"
                  size="icon-xs"
                  aria-label={localize('com_ui_ask_move_to_composer')}
                  onClick={onExpand}
                >
                  <ChevronDown
                    className="size-4 rotate-180 [view-transition-name:ask-question-chevron]"
                    aria-hidden="true"
                  />
                </Button>
              }
            />
          )
        }
      />
    </div>
  );
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
        'border-border-light bg-surface-secondary my-2 flex w-full flex-col gap-2.5 rounded-2xl border p-3',
        showPlaceholder && 'invisible',
        isLivePause && !showPlaceholder && '[view-transition-name:ask-question]',
      )}
      aria-hidden={showPlaceholder || undefined}
    >
      <div className="text-text-secondary flex items-start justify-between gap-2">
        <div className="min-w-0 pt-1">
          <p className="text-text-primary text-sm font-medium [overflow-wrap:anywhere]">
            {question.question}
          </p>
          {question.description != null && question.description.length > 0 && (
            <p className="text-text-secondary mt-0.5 text-xs [overflow-wrap:anywhere]">
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
                variant="row-action"
                size="icon-xs"
                aria-label={localize('com_ui_ask_move_to_composer')}
                onClick={expand}
              >
                <ChevronDown
                  className="size-4 rotate-180 [view-transition-name:ask-question-chevron]"
                  aria-hidden="true"
                />
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
        focusOutline="hidden"
        value={answerValue}
        disabled={locked}
        onChange={(e) => {
          setAnswerValue(e.target.value);
          setAskAnswerDraft(actionId, e.target.value);
        }}
        minRows={2}
        maxRows={12}
        placeholder={otherLabel ?? localize('com_ui_your_answer')}
        className="border-border-light bg-surface-chat text-text-primary placeholder:text-text-secondary focus-visible:ring-text-primary w-full resize-none rounded-lg border px-3 py-2 text-sm focus-visible:ring-2"
        aria-label={localize('com_ui_your_answer')}
      />

      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" disabled={locked} onClick={handleSkip}>
          {localize('com_ui_skip')}
        </Button>
        {(status === 'expired' || status === 'error') && (
          <span className="text-text-warning flex min-w-0 items-center text-xs">
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

  return <AskingPlaceholder>{card}</AskingPlaceholder>;
}

/** Popover has the question: the reserved card sits hidden underneath the
 *  same compact in-progress row the other tools use, so the turn still
 *  shows the call is running. */
function AskingPlaceholder({ children }: { children: React.ReactNode }) {
  const localize = useLocalize();
  return (
    <div className="relative">
      {children}
      <div className="absolute inset-x-0 top-0 my-1 flex h-5 items-center gap-2.5">
        <MessageCircleQuestion className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
        <span className="tool-status-text shimmer text-text-secondary font-medium">
          {localize('com_ui_asking')}
        </span>
      </div>
    </div>
  );
}
