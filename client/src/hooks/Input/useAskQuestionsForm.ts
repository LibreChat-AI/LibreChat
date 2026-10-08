import { useCallback, useMemo } from 'react';
import { atom, useAtom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { Agents } from 'librechat-data-provider';
import {
  useAskSubmitStatus,
  useResumeSubmit,
} from '~/components/Chat/Messages/Content/ApprovalContext';
import { ASK_USER_DECLINED_ANSWER } from '~/utils/approval';

interface AskQuestionsFormState {
  /** Index of the question currently on screen. Lives beside the answers so the
   *  composer popover and the chat card resume on the same step when one
   *  surface hands over to the other. */
  step: number;
  text: Record<string, string>;
  selected: Record<string, string[]>;
}

const EMPTY_FORM: AskQuestionsFormState = { step: 0, text: {}, selected: {} };

/** Keyed by action id, so the composer popover and the chat card share one form. */
const askQuestionsFormFamily = atomFamily((_actionId: string) =>
  atom<AskQuestionsFormState>(EMPTY_FORM),
);

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export default function useAskQuestionsForm(
  actionId: string,
  questions: Agents.AskUserQuestionBatchItem[],
) {
  const [state, setState] = useAtom(askQuestionsFormFamily(actionId));
  const resetState = useCallback(() => setState(EMPTY_FORM), [setState]);
  const { submitAskAnswer } = useResumeSubmit();
  const { getAskStatus } = useAskSubmitStatus();
  const status = getAskStatus(actionId);
  const locked = status === 'submitting' || status === 'submitted' || status === 'expired';

  const setText = useCallback(
    (question: Agents.AskUserQuestionBatchItem, value: string) => {
      setState((previous) => ({
        ...previous,
        text: { ...previous.text, [question.id]: value },
        /** A typed answer replaces the choices: the rows lock while the field
         *  has text, so nothing stays selected behind them. */
        selected:
          value.trim().length === 0
            ? previous.selected
            : { ...previous.selected, [question.id]: [] },
      }));
    },
    [setState],
  );

  const selectOption = useCallback(
    (question: Agents.AskUserQuestionBatchItem, value: string) => {
      setState((previous) => {
        const current = ownValue(previous.selected, question.id) ?? [];
        let selected = [value];
        if (question.multiSelect === true) {
          selected = current.includes(value)
            ? current.filter((item) => item !== value)
            : [...current, value];
        }
        return {
          ...previous,
          text:
            question.multiSelect === true ? previous.text : { ...previous.text, [question.id]: '' },
          selected: { ...previous.selected, [question.id]: selected },
        };
      });
    },
    [setState],
  );

  const goToStep = useCallback(
    (index: number) => {
      const bounded = Math.min(Math.max(index, 0), Math.max(questions.length - 1, 0));
      setState((previous) =>
        previous.step === bounded ? previous : { ...previous, step: bounded },
      );
    },
    [questions.length, setState],
  );

  const answers = useMemo(() => {
    const resolved = Object.create(null) as Record<string, string>;
    for (const question of questions) {
      const text = ownValue(state.text, question.id)?.trim() ?? '';
      const selected = ownValue(state.selected, question.id) ?? [];
      const values = question.multiSelect === true ? [...selected] : [];
      if (text.length > 0) {
        values.push(text);
      } else if (question.multiSelect !== true && selected[0] != null) {
        values.push(selected[0]);
      }
      if (values.length > 0) {
        resolved[question.id] = values.join(', ');
      }
    }
    return resolved;
  }, [questions, state.text, state.selected]);

  const canSubmit =
    !locked && questions.every((question) => (ownValue(answers, question.id)?.length ?? 0) > 0);

  const submit = useCallback(() => {
    if (!canSubmit) {
      return false;
    }
    submitAskAnswer(actionId, answers, { onSuccess: resetState });
    return true;
  }, [actionId, answers, canSubmit, resetState, submitAskAnswer]);

  const skip = useCallback(() => {
    if (locked) {
      return false;
    }
    const declined = Object.fromEntries(
      questions.map((question) => [question.id, ASK_USER_DECLINED_ANSWER]),
    );
    submitAskAnswer(actionId, declined, { onSuccess: resetState });
    return true;
  }, [actionId, locked, questions, resetState, submitAskAnswer]);

  return {
    state,
    step: Math.min(state.step, Math.max(questions.length - 1, 0)),
    status,
    locked,
    answers,
    canSubmit,
    setText,
    selectOption,
    goToStep,
    submit,
    skip,
  };
}
