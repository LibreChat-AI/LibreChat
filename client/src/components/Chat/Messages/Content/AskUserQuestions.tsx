import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { Button, TextareaAutosize } from '@librechat/client';
import { Check, ChevronUp, TriangleAlert, X } from 'lucide-react';
import type { Agents } from 'librechat-data-provider';
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
  onExpand,
  onDismiss,
}: {
  actionId: string;
  questions: Agents.AskUserQuestionBatchItem[];
  className?: string;
  onExpand?: () => void;
  onDismiss?: () => void;
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
  const legend = question.header ?? (stepped ? null : localize('com_ui_question_number', { 0: 1 }));
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
      {(onExpand != null || onDismiss != null) && (
        <div className="flex shrink-0 items-center justify-end border-b border-border-light px-2 py-1">
          {onExpand != null && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={localize('com_ui_expand')}
              className="text-text-secondary"
              onClick={onExpand}
            >
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          {/** The collapsed card is the ONLY surface left for a collapsed
           *   batch, so it has to carry the popover's dismiss too — without it
           *   the pause can only be answered or skipped. */}
          {onDismiss != null && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={localize('com_ui_close')}
              className="text-text-secondary"
              onClick={onDismiss}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
      {stepped && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 py-2">
          <p className="text-xs font-medium text-text-secondary" aria-live="polite">
            {localize('com_ui_question_step', { 0: activeIndex + 1, 1: total })}
          </p>
          <div
            role="group"
            aria-label={localize('com_ui_question_navigation')}
            className="flex flex-wrap items-center justify-end"
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
                  className="flex h-6 items-center justify-center px-1"
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
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3">
        {/* The height floor sits on the step itself, not the scroll container:
            the container needs `min-h-0` to shrink inside the flex column, and
            tailwind-merge would drop it for a second `min-h-*`. */}
        <fieldset
          ref={stepRef}
          tabIndex={-1}
          aria-labelledby={promptId}
          className={cn('py-3 outline-none', stepped && 'min-h-40')}
        >
          {legend != null && (
            <legend className="mb-1 text-xs font-medium text-text-secondary">{legend}</legend>
          )}
          <p
            id={promptId}
            className="text-sm font-medium text-text-primary [overflow-wrap:anywhere]"
          >
            {question.question}
          </p>
          {question.description != null && question.description.length > 0 && (
            <p className="mt-1 text-sm text-text-secondary [overflow-wrap:anywhere]">
              {question.description}
            </p>
          )}
          {choices.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2" role="group">
              {choices.map((option) => {
                const isSelected = selected.includes(option.value);
                return (
                  <Button
                    key={option.value}
                    type="button"
                    size="sm"
                    variant={isSelected ? 'submit' : 'choice'}
                    role={question.multiSelect === true ? 'checkbox' : undefined}
                    aria-checked={question.multiSelect === true ? isSelected : undefined}
                    aria-pressed={question.multiSelect === true ? undefined : isSelected}
                    disabled={form.locked}
                    className="h-auto min-h-9 max-w-full whitespace-normal py-1.5 text-left [overflow-wrap:anywhere]"
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
          <TextareaAutosize
            value={text}
            disabled={form.locked}
            onChange={(event) => form.setText(question, event.target.value)}
            minRows={1}
            maxRows={6}
            placeholder={otherLabel ?? localize('com_ui_your_answer')}
            className="mt-2 w-full resize-none rounded-md border border-border-xheavy bg-surface-primary p-2 text-sm text-text-primary"
            aria-label={`${question.question} ${localize('com_ui_your_answer')}`}
          />
        </fieldset>
      </div>
      {(form.status === 'error' || form.status === 'expired') && (
        <div className="flex items-center gap-1.5 px-3 py-1 text-xs text-text-warning">
          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          {form.status === 'expired'
            ? localize('com_ui_approval_expired')
            : localize('com_ui_ask_answer_error')}
        </div>
      )}
      {showRemaining && (
        <button
          type="button"
          className="shrink-0 px-3 py-1 text-left text-xs text-text-secondary hover:text-text-primary hover:underline"
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
          'flex shrink-0 items-center gap-2 border-t border-border-light p-3',
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
