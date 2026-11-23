import { useCallback, useMemo } from 'react';
import { atomFamily } from 'jotai/utils';
import { atom, useAtom, useAtomValue } from 'jotai';
import type { Agents } from 'librechat-data-provider';
import type { AskAnswerStatus, AskAnswerSubmit } from './ask';
import { ASK_USER_DECLINED_ANSWER } from '../../core/parts/questions';
import { askSubmitStatusAtom } from './ask';

interface AskQuestionsFormState {
  /** Index of the question currently on screen. Lives beside the answers so the
   *  composer popover and the chat card resume on the same step when one
   *  surface hands over to the other. */
  step: number;
  text: Record<string, string>;
  selected: Record<string, string[]>;
  /** The batch's arrival already placed focus. Moving it between the composer
   *  popover and the chat card remounts it, and that is not a new arrival. */
  arrivalFocused: boolean;
}

const EMPTY_FORM: AskQuestionsFormState = {
  step: 0,
  text: {},
  selected: {},
  arrivalFocused: false,
};

/** Keyed by action id, so the composer popover and the chat card share one form. */
const askQuestionsFormFamily = atomFamily((_actionId: string) =>
  atom<AskQuestionsFormState>(EMPTY_FORM),
);

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

interface AskQuestionsForm {
  state: AskQuestionsFormState;
  step: number;
  status: AskAnswerStatus;
  locked: boolean;
  answers: Record<string, string>;
  canSubmit: boolean;
  setText: (question: Agents.AskUserQuestionBatchItem, value: string) => void;
  selectOption: (question: Agents.AskUserQuestionBatchItem, value: string) => void;
  goToStep: (index: number) => void;
  submit: () => boolean;
  skip: () => boolean;
  arrivalFocused: boolean;
  markArrivalFocused: () => void;
}

export default function useAskQuestionsForm(
  actionId: string,
  questions: Agents.AskUserQuestionBatchItem[],
  submitAskAnswer: AskAnswerSubmit,
): AskQuestionsForm {
  const [state, setState] = useAtom(askQuestionsFormFamily(actionId));
  const resetState = useCallback(() => setState(EMPTY_FORM), [setState]);
  const statusMap = useAtomValue(askSubmitStatusAtom);
  const status: AskAnswerStatus = ownValue(statusMap, actionId) ?? 'idle';
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

  const markArrivalFocused = useCallback(
    () =>
      setState((previous) =>
        previous.arrivalFocused ? previous : { ...previous, arrivalFocused: true },
      ),
    [setState],
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
    arrivalFocused: state.arrivalFocused,
    markArrivalFocused,
  };
}
