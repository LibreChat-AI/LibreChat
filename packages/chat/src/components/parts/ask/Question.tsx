import { useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { ChevronDown, MessageCircleQuestion, TriangleAlert } from 'lucide-react';
import { Button, Shimmer, TextareaAutosize, TooltipAnchor, useLocalize } from '@librechat/client';
import type { Agents } from 'librechat-data-provider';
import type { KeyboardEvent, ReactNode } from 'react';
import type { AskAnswerSubmit } from '../../../react/parts/ask';
import {
  isCancelKey,
  isReboundSubmitChord,
  resolveComposerKeyDown,
  splitOtherOption,
  ASK_USER_DECLINED_ANSWER,
} from '../../../core';
import useArrivalFocus, { isFocusIdle } from '../../../react/parts/arrival';
import { useOptionalChatSurface } from '../../../react/subagents/surface';
import { forceResize, insertTextAtCursor } from '../../../core/textarea';
import { askSubmitStatusAtom } from '../../../react/parts/ask';
import { NO_HOST_BINDINGS } from '../../../core/shortcuts';
import AskUserQuestions from './Questions';
import AskOptions from '../AskOptions';
import { classes } from '../classes';

/**
 * Single questions whose card has already had its arrival. A card remounts when
 * its row scrolls back into view or the question moves between the chat and the
 * composer, and none of those is a new arrival. Holds only action ids, one per
 * question asked in this tab.
 */
const arrivedSingleQuestions = new Set<string>();

/** What the live pause shares with the composer. Omitted outside a live chat. */
export type AskCardMode = {
  popoverVisible: boolean;
  collapsed: boolean;
  expand: () => void;
  liveAsk: { actionId: string } | null;
  checked: number[];
  toggleChecked: (index: number) => void;
  submitOption: (index: number) => void;
  submitAnswer: (values: string[]) => void;
  answerText: string;
  setAnswerText: (value: string) => void;
};

const INERT_ASK_MODE: AskCardMode = {
  popoverVisible: false,
  collapsed: false,
  expand: () => undefined,
  liveAsk: null,
  checked: [],
  toggleChecked: () => undefined,
  submitOption: () => undefined,
  submitAnswer: () => undefined,
  answerText: '',
  setAnswerText: () => undefined,
};

/**
 * Renders an `ask_user_question` pause: the prompt, optional description, any
 * curated option buttons, and a free-form text answer. Single-select options
 * submit on click; multi-select options toggle and Submit confirms the set
 * (plus any typed text). While this card is the LIVE pause's surface it
 * shares selection state and submit paths with the composer's answer mode, so
 * the composer, the popover, and this card always agree on what will be
 * sent; outside a live pause (Share/search) it falls back to local state.
 */
export default function AskUserQuestion({
  actionId,
  question,
  questions,
  answerMode = INERT_ASK_MODE,
  submitAskAnswer = () => undefined,
  getAskAnswerDraft = () => '',
  setAskAnswerDraft = () => undefined,
}: {
  actionId: string;
  question: Agents.AskUserQuestionRequest;
  questions?: Agents.AskUserQuestionBatchItem[];
  /** The live pause, when this card is inside a chat that can move it to the composer. */
  answerMode?: AskCardMode;
  /** Resumes the run. Absent, the card still renders and submit does nothing. */
  submitAskAnswer?: AskAnswerSubmit;
  /** Restores a free-form answer after the card remounts outside a live pause. */
  getAskAnswerDraft?: (actionId: string) => string;
  setAskAnswerDraft?: (actionId: string, answer: string) => void;
}): ReactNode {
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
        submitAskAnswer={submitAskAnswer}
        onExpand={answerMode.collapsed && isLivePause ? answerMode.expand : undefined}
      />
    );
    return reserved ? <AskingPlaceholder>{card}</AskingPlaceholder> : card;
  }
  return (
    <AskUserQuestionSingle
      actionId={actionId}
      question={question}
      answerMode={answerMode}
      submitAskAnswer={submitAskAnswer}
      getAskAnswerDraft={getAskAnswerDraft}
      setAskAnswerDraft={setAskAnswerDraft}
    />
  );
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
  submitAskAnswer,
}: {
  actionId: string;
  questions: Agents.AskUserQuestionBatchItem[];
  live: boolean;
  reserved: boolean;
  onExpand?: () => void;
  submitAskAnswer: AskAnswerSubmit;
}) {
  const localize = useLocalize();
  return (
    <div
      className={classes(
        'border-border-light bg-surface-secondary my-2 flex w-full flex-col rounded-2xl border',
        live && '[view-transition-name:ask-question]',
        reserved && 'invisible',
      )}
      aria-hidden={reserved || undefined}
      ref={(node) => {
        if (node == null) {
          return;
        }
        if (reserved) {
          node.setAttribute('inert', '');
          return;
        }
        node.removeAttribute('inert');
      }}
    >
      <AskUserQuestions
        actionId={actionId}
        questions={questions}
        focusOnArrival={live}
        submitAskAnswer={submitAskAnswer}
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
  submitAskAnswer,
  getAskAnswerDraft,
  setAskAnswerDraft,
}: {
  actionId: string;
  question: Agents.AskUserQuestionRequest;
  answerMode: AskCardMode;
  submitAskAnswer: AskAnswerSubmit;
  getAskAnswerDraft: (actionId: string) => string;
  setAskAnswerDraft: (actionId: string, answer: string) => void;
}) {
  const localize = useLocalize();
  const statusMap = useAtomValue(askSubmitStatusAtom);
  const getAskStatus = (id: string) => statusMap[id] ?? 'idle';
  const [answer, setAnswer] = useState(() => getAskAnswerDraft(actionId));
  const [localChecked, setLocalChecked] = useState<number[]>([]);
  const surface = useOptionalChatSurface();
  const enterToSend = surface?.enterToSend ?? false;
  const { shortcutsEnabled, submitOverride, yieldedChords } =
    surface?.composerBindings ?? NO_HOST_BINDINGS;
  /**
   * This card is the question's default surface, in thread order and at the
   * thread's width, so it reads the same on a phone as on a desktop. Its
   * chevron moves a live question into the composer popover; while the
   * popover is VISIBLE, rendering the card too would duplicate the question,
   * so the card holds its footprint hidden until the question comes back.
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

  /**
   * The question arriving in the chat puts the user on its first option, or on
   * its answer field when it has none, so keys typed next answer it rather than
   * going out as an ordinary message. Only once it is on screen, and only when
   * focus is idle then (nowhere, or the empty composer that sent the turn).
   */
  const cardRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  useArrivalFocus(
    isLivePause && !showPlaceholder && !locked && !arrivedSingleQuestions.has(actionId),
    cardRef,
    () => {
      if (arrivedSingleQuestions.has(actionId)) {
        return;
      }
      arrivedSingleQuestions.add(actionId);
      if (!isFocusIdle()) {
        return;
      }
      const target = optionRefs.current.find((option) => option != null && !option.disabled);
      (target ?? answerRef.current)?.focus({ preventScroll: true });
    },
  );

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
   * The answer box follows the composer's Enter table, so the user's
   * Enter-to-send preference and any rebound submit chord apply here too. The
   * run is paused on this question rather than generating, so it resolves as
   * idle: Ctrl/Cmd+Enter must submit the answer, not reach the during-run
   * steer/queue actions.
   */
  const handleAnswerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const isComposing = e.nativeEvent.isComposing || e.key === 'Process' || e.keyCode === 229;
    if (!isComposing && isReboundSubmitChord(e.nativeEvent, { shortcutsEnabled, submitOverride })) {
      e.preventDefault();
      if (canSubmit && !locked) {
        submitCombined();
      }
      return;
    }
    const action = resolveComposerKeyDown(e.nativeEvent, {
      isComposing,
      isSubmitting: false,
      allowSubmitWhileGenerating: false,
      hasDuringRunModifier: false,
      shortcutsEnabled,
      enterToSend,
      submitOverride,
      yieldedChords,
    });
    if (action === 'none') {
      return;
    }
    e.preventDefault();
    if (action === 'newline') {
      insertTextAtCursor(e.currentTarget, '\n');
      forceResize(e.currentTarget);
      return;
    }
    if (action === 'submit' && canSubmit && !locked) {
      submitCombined();
    }
  };

  /** Escape skips, but only before anything is entered, so a stray Escape
   *  cannot discard an answer and resume the run. */
  const handleCardKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!isCancelKey(e.nativeEvent) || e.nativeEvent.isComposing) {
      return;
    }
    if (locked || trimmed.length > 0 || (multiSelect && checkedIndices.length > 0)) {
      return;
    }
    e.preventDefault();
    handleSkip();
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
      ref={cardRef}
      className={classes(
        'border-border-light bg-surface-secondary my-2 flex w-full flex-col gap-2.5 rounded-2xl border p-3',
        showPlaceholder && 'invisible',
        isLivePause && !showPlaceholder && '[view-transition-name:ask-question]',
      )}
      aria-hidden={showPlaceholder || undefined}
      onKeyDown={handleCardKeyDown}
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
          optionRefs={optionRefs}
        />
      )}

      <TextareaAutosize
        ref={answerRef}
        focusOutline="hidden"
        value={answerValue}
        disabled={locked}
        onChange={(e) => {
          setAnswerValue(e.target.value);
          setAskAnswerDraft(actionId, e.target.value);
        }}
        onKeyDown={handleAnswerKeyDown}
        minRows={2}
        maxRows={12}
        placeholder={otherLabel ?? localize('com_ui_your_answer')}
        variant="filled"
        className="w-full resize-none"
        aria-label={localize('com_ui_your_answer')}
      />

      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" disabled={locked} onClick={handleSkip}>
          {localize('com_ui_skip')}
        </Button>
        {(status === 'expired' || status === 'error') && (
          <span className="text-text-warning flex min-w-0 items-center text-xs">
            <TriangleAlert className="me-1.5 size-4 shrink-0" aria-hidden="true" />
            {localize(status === 'expired' ? 'com_ui_approval_expired' : 'com_ui_approval_error')}
          </span>
        )}
        <Button
          size="sm"
          variant="submit"
          className="ms-auto"
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
      <div className="text-text-secondary absolute inset-x-0 top-0 my-1 flex h-5 items-center gap-2.5">
        <MessageCircleQuestion className="size-4 shrink-0" aria-hidden="true" />
        <Shimmer className="tool-status-text font-medium">{localize('com_ui_asking')}</Shimmer>
      </div>
    </div>
  );
}
