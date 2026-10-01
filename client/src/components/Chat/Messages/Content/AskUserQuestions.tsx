import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Input, Button } from '@librechat/client';
import type { Agents } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useAskQuestionsForm from '~/hooks/Input/useAskQuestionsForm';
import AskOptions from '~/components/Chat/ask/options';
import { splitOtherOption } from '~/utils/approval';
import { AutoHeight } from '~/components/ui';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * One bounded batch of `ask_user_question` items, presented a single question at
 * a time. The batch arrives as one interrupt and submits as one answer map — the
 * stepper is purely presentational, so Submit still waits until every question
 * has an answer and Skip still declines the whole batch from any step.
 */
export default function AskUserQuestions({
  actionId,
  questions,
  className,
  headerAction,
}: {
  actionId: string;
  questions: Agents.AskUserQuestionBatchItem[];
  className?: string;
  /** The surface's own control (move to chat, move back), set in the
   *  question's header row so it shares the form's inset. */
  headerAction?: ReactNode;
}) {
  const localize = useLocalize();
  const promptId = useId();
  const form = useAskQuestionsForm(actionId, questions);
  const { goToStep, selectOption } = form;

  const scrollRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<HTMLFieldSetElement>(null);
  /** Set only when a choice click is about to unmount the button that owns
   *  focus, which would otherwise drop focus to <body> mid-batch. */
  const refocusRef = useRef(false);

  const total = questions.length;
  const stepped = total > 1;
  const activeIndex = form.step;
  const isLastStep = activeIndex === total - 1;
  /** Narrower than `locked`: an expired or errored batch is unanswerable but
   *  still worth paging through, so only an in-flight submit freezes the steps. */
  const navLocked = form.status === 'submitting';

  const firstUnanswered = useMemo(() => {
    for (let index = 0; index < questions.length; index++) {
      if (!Object.hasOwn(form.answers, questions[index].id)) {
        return index;
      }
    }
    return -1;
  }, [questions, form.answers]);

  const handleSelectOption = useCallback(
    (question: Agents.AskUserQuestionBatchItem, value: string) => {
      selectOption(question, value);
      if (question.multiSelect === true || activeIndex >= total - 1) {
        return;
      }
      refocusRef.current = true;
      goToStep(activeIndex + 1);
    },
    [activeIndex, goToStep, selectOption, total],
  );

  useEffect(() => {
    if (scrollRef.current != null) {
      scrollRef.current.scrollTop = 0;
    }
    if (!refocusRef.current) {
      return;
    }
    refocusRef.current = false;
    stepRef.current?.focus();
  }, [activeIndex]);

  if (form.status === 'submitted') {
    return null;
  }

  if (questions[activeIndex] == null) {
    return null;
  }

  /** Only worth surfacing when the gap is somewhere the user cannot see: the
   *  last step's own blank answer field already explains a disabled Submit. */
  const remaining = total - Object.keys(form.answers).length;
  const showRemaining =
    stepped &&
    isLastStep &&
    !form.locked &&
    firstUnanswered >= 0 &&
    firstUnanswered !== activeIndex;

  const question = questions[activeIndex];
  const { choices, otherLabel } = splitOtherOption(question.options);
  const selected = Object.hasOwn(form.state.selected, question.id)
    ? form.state.selected[question.id]
    : [];
  const selectedIndices = choices.flatMap((option, optionIndex) =>
    selected.includes(option.value) ? [optionIndex] : [],
  );
  const text = Object.hasOwn(form.state.text, question.id) ? form.state.text[question.id] : '';

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {/* Only the active step renders, laid out at its final size at once.
          One `AutoHeight` holds everything above the buttons and clips only at
          its bottom edge, so the header and title stay put and the footer
          rides that edge as the card eases to the new height. */}
      <AutoHeight>
        {stepped && (
          <p className="sr-only" aria-live="polite">
            {localize('com_ui_question_step', { 0: activeIndex + 1, 1: total })}
          </p>
        )}
        <div className="text-text-secondary flex shrink-0 items-start justify-between gap-2 px-3 pt-3">
          <div className="min-w-0 flex-1">
            {question.header != null && question.header !== '' && (
              <p className="mb-1 text-xs font-medium">{question.header}</p>
            )}
            <p
              id={promptId}
              className="text-text-primary text-sm font-medium [overflow-wrap:anywhere]"
            >
              {question.question}
            </p>
            {question.description != null && question.description.length > 0 && (
              <p className="mt-0.5 text-sm [overflow-wrap:anywhere]">{question.description}</p>
            )}
          </div>
          {(stepped || headerAction != null) && (
            <div className="flex shrink-0 items-center gap-1">
              {stepped && (
                <div
                  role="group"
                  aria-label={localize('com_ui_question_navigation')}
                  className="flex items-center"
                >
                  {questions.map((item, index) => {
                    const isAnswered = Object.hasOwn(form.answers, item.id);
                    const isActive = index === activeIndex;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        disabled={navLocked}
                        aria-current={isActive ? 'step' : undefined}
                        aria-label={localize(
                          isAnswered
                            ? 'com_ui_question_step_answered'
                            : 'com_ui_question_step_unanswered',
                          { 0: index + 1 },
                        )}
                        className="flex h-7 items-center justify-center px-1"
                        onClick={() => goToStep(index)}
                      >
                        <span
                          className={cn(
                            'h-2 rounded-full transition-all duration-300 ease-out motion-reduce:transition-none',
                            isActive ? 'w-4' : 'w-2',
                            isAnswered ? 'bg-surface-submit' : 'bg-border-heavy',
                          )}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
              {headerAction}
            </div>
          )}
        </div>
        {/* `pb-1 -mb-1` keeps the answer field's focus ring inside the padding
          box, so focusing it never counts as overflow and draws a scrollbar. */}
        <div ref={scrollRef} className="-mb-1 max-h-[45vh] overflow-y-auto px-3 pb-1">
          <fieldset
            key={question.id}
            ref={stepRef}
            tabIndex={-1}
            aria-labelledby={promptId}
            className="flex flex-col gap-2 pt-3 outline-hidden"
          >
            {choices.length > 0 && (
              <AskOptions
                options={choices}
                multiSelect={question.multiSelect === true}
                checked={selectedIndices}
                selected={question.multiSelect === true ? null : (selectedIndices[0] ?? null)}
                selectedIsAnswer
                locked={form.locked || text.trim().length > 0}
                onActivate={(optionIndex) =>
                  handleSelectOption(question, choices[optionIndex].value)
                }
                className="flex flex-col"
              />
            )}
            <Input
              value={text}
              disabled={form.locked}
              onChange={(event) => form.setText(question, event.target.value)}
              placeholder={otherLabel ?? localize('com_ui_your_answer')}
              aria-label={`${question.question} ${localize('com_ui_your_answer')}`}
            />
          </fieldset>
        </div>
        <div className="shrink-0 px-3">
          {(form.status === 'error' || form.status === 'expired') && (
            <div className="text-text-warning flex items-center gap-1.5 pt-2 text-xs">
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
              {form.status === 'expired'
                ? localize('com_ui_approval_expired')
                : localize('com_ui_ask_answer_error')}
            </div>
          )}
          {showRemaining && (
            <button
              type="button"
              className="text-text-secondary hover:text-text-primary pt-2 text-left text-xs select-none hover:underline"
              onClick={() => goToStep(firstUnanswered)}
            >
              {localize(
                remaining === 1 ? 'com_ui_questions_remaining_one' : 'com_ui_questions_remaining',
                { 0: remaining },
              )}
            </button>
          )}
        </div>
      </AutoHeight>
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 p-3',
          stepped ? 'justify-between' : 'justify-end',
        )}
      >
        <Button
          type="button"
          className="select-none"
          size="sm"
          variant="outline"
          disabled={form.locked}
          onClick={form.skip}
        >
          {localize('com_ui_skip')}
        </Button>
        <div className="flex items-center gap-2">
          {stepped && (
            <Button
              type="button"
              className="select-none"
              size="sm"
              variant="outline"
              disabled={navLocked || activeIndex === 0}
              onClick={() => goToStep(activeIndex - 1)}
            >
              {localize('com_ui_back')}
            </Button>
          )}
          {isLastStep ? (
            <Button
              type="button"
              className="select-none"
              size="sm"
              variant="submit"
              disabled={!form.canSubmit}
              onClick={form.submit}
            >
              {form.status === 'submitting'
                ? localize('com_ui_submitting')
                : localize('com_ui_submit')}
            </Button>
          ) : (
            <Button
              type="button"
              className="select-none"
              size="sm"
              variant="submit"
              disabled={navLocked}
              onClick={() => goToStep(activeIndex + 1)}
            >
              {localize('com_ui_next')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
