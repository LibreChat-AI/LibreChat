import { always, eventually, extract, now } from '@antithesishq/bombadil';
import { actions } from '@antithesishq/bombadil/browser';
import type { Action, Point, State } from '@antithesishq/bombadil/browser';
import {
  noConsoleErrors,
  noHttpErrorCodes,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from '@antithesishq/bombadil/browser/defaults/properties';

type Target = {
  name: string;
  point: Point;
};

const LOGIN_EMAIL = '__BOMBADIL_E2E_USER_EMAIL__';
const LOGIN_PASSWORD = '__BOMBADIL_E2E_USER_PASSWORD__';
const ENTER_KEY_CODE = 13;
const HITL_MODEL_SPEC = 'E2E HITL';
const HITL_LABEL = 'bombadil-hitl';
const HITL_PROMPT = `E2E_ASK_USER_QUESTION:${HITL_LABEL}`;
const HITL_QUESTION = `Which environment should Bombadil use for ${HITL_LABEL}?`;
const HITL_OPTION = 'Staging';
const FINAL_REPLY = 'E2E mock reply: pong';
const COMPLETED_ANSWER_LABEL = 'You answered:';
/** The settled Q&A record: a collapsed tool-call line naming the question,
 *  over a panel holding the description and the answer. */
const ASK_RECORD = '[data-testid="ask-user-question-call"]';
let reloadIssued = false;
let pausedReloadIssued = false;

function visiblePoint(state: State, element: Element | null): Point | null {
  if (!element) {
    return null;
  }
  const style = state.window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.pointerEvents === 'none' ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return null;
  }
  const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const hitElement = state.document.elementFromPoint(point.x, point.y);
  if (
    point.x < 0 ||
    point.y < 0 ||
    point.x > state.window.innerWidth ||
    point.y > state.window.innerHeight ||
    !hitElement ||
    (hitElement !== element && !element.contains(hitElement))
  ) {
    return null;
  }
  return point;
}

function target(
  state: State,
  selector: string,
  name: string,
  text?: string,
  containsText = false,
): Target | null {
  for (const element of state.document.querySelectorAll(selector)) {
    const content = element.textContent?.trim() ?? '';
    if (text != null && (containsText ? !content.includes(text) : content !== text)) {
      continue;
    }
    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') {
      continue;
    }
    const point = visiblePoint(state, element);
    if (point) {
      return { name, point };
    }
  }
  return null;
}

function visibleCount(state: State, selector: string): number {
  return Array.from(state.document.querySelectorAll(selector)).filter(
    (element) => visiblePoint(state, element) !== null,
  ).length;
}

function visibleTextCount(
  state: State,
  selector: string,
  text: string,
  containsText = false,
): number {
  return Array.from(state.document.querySelectorAll(selector)).filter((element) => {
    const content = element.textContent?.trim() ?? '';
    return (
      (containsText ? content.includes(text) : content === text) &&
      visiblePoint(state, element) !== null
    );
  }).length;
}

function inputValue(state: State, selector: string): string {
  return (
    state.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value ?? ''
  );
}

function isFocused(state: State, selector: string): boolean {
  return state.document.activeElement?.matches(selector) === true;
}

function clickOrWait(targetValue: Target | null): Action[] {
  return targetValue ? [{ Click: targetValue }] : ['Wait'];
}

const ui = extract((state: State) => {
  const messageElements = Array.from(state.document.querySelectorAll('.message-render'));
  const askRecordCount = visibleCount(state, ASK_RECORD);
  const messageText = messageElements.map((element) => element.textContent ?? '').join('\n');
  const modelTrigger = state.document.querySelector('button[aria-label="Select a model"]');
  return {
    path: state.window.location.pathname,
    lastAction: state.lastAction,
    messageCount: messageElements.length,
    messageText,
    modelLabel: modelTrigger?.textContent?.trim() ?? '',
    composerValue: inputValue(state, '#prompt-textarea'),
    composerFocused: isFocused(state, '#prompt-textarea'),
    emailValue: inputValue(state, '#email'),
    emailFocused: isFocused(state, '#email'),
    passwordValue: inputValue(state, '#password'),
    passwordFocused: isFocused(state, '#password'),
    /** Once the pause settles, the record IS the question's presentation, so
     *  count records rather than every node repeating their text — an
     *  expanded record (Auto-expand tool details) shows the question in both
     *  its summary line and its panel, and matching text would count one
     *  record twice. Before a record exists the live pause renders the
     *  question as a paragraph. */
    questionCount:
      askRecordCount > 0 ? askRecordCount : visibleTextCount(state, 'p', HITL_QUESTION),
    answerOptionCount: visibleTextCount(state, 'button', HITL_OPTION, true),
    finalReplyCount: messageElements.filter((element) =>
      (element.textContent ?? '').includes(FINAL_REPLY),
    ).length,
    completedAnswerCount: messageElements.filter((element) => {
      const text = element.textContent ?? '';
      return text.includes(COMPLETED_ANSWER_LABEL) && text.includes(HITL_OPTION);
    }).length,
    isSubmitting: state.document.querySelector('button[aria-label="Stop generating"]') !== null,
    hasComposer: state.document.querySelector('#prompt-textarea') !== null,
    loginEmail: target(state, '#email', 'Login email'),
    loginPassword: target(state, '#password', 'Login password'),
    loginSubmit: target(state, '[data-testid="login-button"]', 'Login'),
    composer: target(state, '#prompt-textarea', 'Message input'),
    modelTrigger: target(state, 'button[aria-label="Select a model"]', 'Model selector'),
    hitlModelSpec: target(state, '[role="option"]', HITL_MODEL_SPEC, HITL_MODEL_SPEC),
    stagingOption: target(state, 'button', 'Answer Staging', HITL_OPTION, true),
    stagingSelected: Array.from(
      state.document.querySelectorAll('button[aria-pressed="true"]'),
    ).some((element) => element.textContent?.trim() === HITL_OPTION),
    answerSubmit: target(state, 'button:not([disabled])', 'Submit answer', 'Submit'),
  };
});

export { noConsoleErrors, noHttpErrorCodes, noUncaughtExceptions, noUnhandledPromiseRejections };

export const hitlLifecycleActions = actions((): Action[] => {
  const state = ui.current;

  if (state.path === '/login') {
    reloadIssued = false;
    pausedReloadIssued = false;
    if (!state.emailFocused && state.emailValue === '') {
      return clickOrWait(state.loginEmail);
    }
    if (state.emailFocused && state.emailValue === '') {
      return [{ TypeText: { text: LOGIN_EMAIL, delayMillis: 0 } }];
    }
    if (!state.passwordFocused && state.passwordValue === '') {
      return clickOrWait(state.loginPassword);
    }
    if (state.passwordFocused && state.passwordValue === '') {
      return [{ TypeText: { text: LOGIN_PASSWORD, delayMillis: 0 } }];
    }
    return clickOrWait(state.loginSubmit);
  }

  if (state.stagingOption) {
    if (!pausedReloadIssued) {
      pausedReloadIssued = true;
      return ['Reload'];
    }
    if (state.stagingSelected) {
      return clickOrWait(state.answerSubmit);
    }
    return clickOrWait(state.stagingOption);
  }

  if (state.isSubmitting || !state.hasComposer) {
    return ['Wait'];
  }

  if (state.finalReplyCount === 1) {
    if (!reloadIssued) {
      reloadIssued = true;
      return ['Reload'];
    }
    return ['Wait'];
  }

  const isPersistedConversation = state.path.startsWith('/c/') && state.path !== '/c/new';
  if (isPersistedConversation && state.messageCount === 0) {
    return ['Wait'];
  }

  if (state.messageCount === 0) {
    if (state.modelLabel !== HITL_MODEL_SPEC) {
      return state.hitlModelSpec
        ? clickOrWait(state.hitlModelSpec)
        : clickOrWait(state.modelTrigger);
    }
    if (state.composerValue === '') {
      return state.composerFocused
        ? [{ TypeText: { text: HITL_PROMPT, delayMillis: 0 } }]
        : clickOrWait(state.composer);
    }
    return state.composerFocused
      ? [{ PressKey: { code: ENTER_KEY_CODE } }]
      : clickOrWait(state.composer);
  }

  return ['Wait'];
});

/** The run must reach a real, answerable ask_user_question pause, including after reload. */
export const hitlQuestionEventuallyPauses = eventually(
  () => ui.current.questionCount === 1 && ui.current.answerOptionCount === 1,
).within(25, 'seconds');

/** Answering resumes the checkpointed run and produces one terminal reply. */
export const hitlAnswerEventuallyResumes = eventually(
  () =>
    ui.current.finalReplyCount === 1 &&
    ui.current.completedAnswerCount === 1 &&
    ui.current.answerOptionCount === 0,
).within(40, 'seconds');

/** Duplicate cards or duplicate resume completions indicate a broken pause lifecycle. */
export const hitlPauseAndResumeStaySingular = always(
  () =>
    ui.current.questionCount <= 1 &&
    ui.current.answerOptionCount <= 1 &&
    ui.current.finalReplyCount <= 1 &&
    ui.current.completedAnswerCount <= 1 &&
    ui.current.messageCount <= 2,
);

/** After reload, the question remains an audit record without becoming answerable again. */
export const answeredHitlStateSurvivesReload = always(() =>
  now(() => ui.current.lastAction === 'Reload').implies(
    eventually(
      () =>
        ui.current.finalReplyCount === 1 &&
        ui.current.completedAnswerCount === 1 &&
        ui.current.questionCount === 1 &&
        ui.current.answerOptionCount === 0,
    ).within(20, 'seconds'),
  ),
);
