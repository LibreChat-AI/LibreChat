import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { Input, Button } from '@librechat/client';
import { Check, TriangleAlert } from 'lucide-react';
import type { Agents } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useAskQuestionsForm from '~/hooks/Input/useAskQuestionsForm';
import { splitOtherOption } from '~/utils/approval';
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

  const question = questions[activeIndex];
  if (question == null) {
    return null;
  }

  const { choices, otherLabel } = splitOtherOption(question.options);
  const selected = Object.hasOwn(form.state.selected, question.id)
    ? form.state.selected[question.id]
    : [];
  const text = Object.hasOwn(form.state.text, question.id) ? form.state.text[question.id] : '';
  const stepLabel = stepped
    ? localize('com_ui_question_step', { 0: activeIndex + 1, 1: total })
    : null;
  const eyebrow = question.header != null && question.header !== '' ? question.header : null;
  /** Only worth surfacing when the gap is somewhere the user cannot see: the
   *  last step's own blank textarea already explains a disabled Submit. */
  const remaining = total - Object.keys(form.answers).length;
  const showRemaining =
    stepped &&
    isLastStep &&
    !form.locked &&
    firstUnanswered >= 0 &&
    firstUnanswered !== activeIndex;

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="text-text-secondary flex shrink-0 items-start justify-between gap-2 px-3 pt-3">
        <div className="min-w-0">
          {(stepLabel != null || eyebrow != null) && (
            <p className="mb-1 text-xs font-medium">
              {stepLabel != null && <span aria-live="polite">{stepLabel}</span>}
              {stepLabel != null && eyebrow != null && ' · '}
              {eyebrow}
            </p>
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
                          'h-2 rounded-full',
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3">
        <fieldset
          ref={stepRef}
          tabIndex={-1}
          aria-labelledby={promptId}
          className={cn('flex flex-col gap-2 pt-3 outline-hidden', stepped && 'min-h-20')}
        >
          {choices.length > 0 && (
            <div className="flex flex-wrap gap-2" role="group">
              {choices.map((option) => {
                const isSelected = selected.includes(option.value);
                return (
                  <Button
                    key={option.value}
                    type="button"
                    size="sm"
                    variant={isSelected ? 'default' : 'choice'}
                    role={question.multiSelect === true ? 'checkbox' : undefined}
                    aria-checked={question.multiSelect === true ? isSelected : undefined}
                    aria-pressed={question.multiSelect === true ? undefined : isSelected}
                    disabled={form.locked}
                    className="h-auto min-h-9 max-w-full py-1.5 text-left [overflow-wrap:anywhere] whitespace-normal"
                    onClick={() => handleSelectOption(question, option.value)}
                  >
                    {question.multiSelect === true && isSelected && (
                      <Check className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    )}
                    {option.label}
                  </Button>
                );
              })}
            </div>
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
      {(form.status === 'error' || form.status === 'expired') && (
        <div className="text-text-warning flex items-center gap-1.5 px-3 pt-2 text-xs">
          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          {form.status === 'expired'
            ? localize('com_ui_approval_expired')
            : localize('com_ui_ask_answer_error')}
        </div>
      )}
      {showRemaining && (
        <button
          type="button"
          className="text-text-secondary hover:text-text-primary shrink-0 px-3 pt-2 text-left text-xs hover:underline"
          onClick={() => goToStep(firstUnanswered)}
        >
          {localize(
            remaining === 1 ? 'com_ui_questions_remaining_one' : 'com_ui_questions_remaining',
            { 0: remaining },
          )}
        </button>
      )}
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 p-3',
          stepped ? 'justify-between' : 'justify-end',
        )}
      >
        <Button
          type="button"
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
