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
const TARGET_MODEL_SPEC = 'E2E Starters';
const INITIAL_PROMPT = 'E2E_REPLY:bombadil-model-lifecycle-initial';
const SELECTED_MODEL_PROMPT = 'E2E_REPLY:bombadil-model-lifecycle-selected';
let reloadIssued = false;

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
  const point = {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
  if (
    point.x < 0 ||
    point.y < 0 ||
    point.x > state.window.innerWidth ||
    point.y > state.window.innerHeight
  ) {
    return null;
  }
  const hitElement = state.document.elementFromPoint(point.x, point.y);
  if (!hitElement || (hitElement !== element && !element.contains(hitElement))) {
    return null;
  }
  return point;
}

function target(state: State, selector: string, name: string, text?: string): Target | null {
  for (const element of state.document.querySelectorAll(selector)) {
    if (text != null && element.textContent?.trim() !== text) {
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

function inputValue(state: State, selector: string): string {
  const element = state.document.querySelector(selector) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  return element?.value ?? '';
}

function isFocused(state: State, selector: string): boolean {
  return state.document.activeElement?.matches(selector) === true;
}

function clickOrWait(targetValue: Target | null): Action[] {
  return targetValue ? [{ Click: targetValue }] : ['Wait'];
}

const ui = extract((state: State) => {
  const modelTrigger = state.document.querySelector('button[aria-label="Select a model"]');
  return {
    path: state.window.location.pathname,
    lastAction: state.lastAction,
    messageCount: state.document.querySelectorAll('.message-render').length,
    composerValue: inputValue(state, '#prompt-textarea'),
    composerFocused: isFocused(state, '#prompt-textarea'),
    emailValue: inputValue(state, '#email'),
    emailFocused: isFocused(state, '#email'),
    passwordValue: inputValue(state, '#password'),
    passwordFocused: isFocused(state, '#password'),
    modelLabel: modelTrigger?.textContent?.trim() ?? '',
    isSubmitting: state.document.querySelector('button[aria-label="Stop generating"]') !== null,
    hasComposer: state.document.querySelector('#prompt-textarea') !== null,
    loginEmail: target(state, '#email', 'Login email'),
    loginPassword: target(state, '#password', 'Login password'),
    loginSubmit: target(state, '[data-testid="login-button"]', 'Login'),
    composer: target(state, '#prompt-textarea', 'Message input'),
    modelTrigger: target(state, 'button[aria-label="Select a model"]', 'Model selector'),
    starterSpec: target(state, '[role="option"]', TARGET_MODEL_SPEC, TARGET_MODEL_SPEC),
  };
});

export { noConsoleErrors, noHttpErrorCodes, noUncaughtExceptions, noUnhandledPromiseRejections };

export const modelLifecycleActions = actions((): Action[] => {
  const state = ui.current;

  if (state.path === '/login') {
    reloadIssued = false;
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

  if (state.isSubmitting || !state.hasComposer) {
    return ['Wait'];
  }

  const isPersistedConversation = state.path.startsWith('/c/') && state.path !== '/c/new';
  if (isPersistedConversation && state.messageCount === 0) {
    return ['Wait'];
  }

  if (state.messageCount === 0) {
    if (state.composerValue === '') {
      if (state.composerFocused) {
        return [{ TypeText: { text: INITIAL_PROMPT, delayMillis: 0 } }];
      }
      return clickOrWait(state.composer);
    }
    if (!state.composerFocused) {
      return clickOrWait(state.composer);
    }
    return [{ PressKey: { code: ENTER_KEY_CODE } }];
  }

  if (state.messageCount === 2) {
    if (state.modelLabel !== TARGET_MODEL_SPEC) {
      if (state.starterSpec) {
        return clickOrWait(state.starterSpec);
      }
      return clickOrWait(state.modelTrigger);
    }
    if (state.composerValue === '') {
      if (state.composerFocused) {
        return [{ TypeText: { text: SELECTED_MODEL_PROMPT, delayMillis: 0 } }];
      }
      return clickOrWait(state.composer);
    }
    if (!state.composerFocused) {
      return clickOrWait(state.composer);
    }
    return [{ PressKey: { code: ENTER_KEY_CODE } }];
  }

  if (state.messageCount >= 4 && state.modelLabel === TARGET_MODEL_SPEC) {
    if (!reloadIssued) {
      reloadIssued = true;
      return ['Reload'];
    }
    return ['Wait'];
  }

  return ['Wait'];
});

/**
 * A model choice can remain local until it is used for a submission. Once a turn
 * has been sent with that model, both the selection and message history must be
 * server-backed and recoverable after reload.
 */
export const submittedModelAndMessagesSurviveReload = always(
  () =>
    ui.current.messageCount < 4 ||
    ui.current.modelLabel === '' ||
    ui.current.modelLabel === TARGET_MODEL_SPEC,
);

export const selectedModelExchangeEventuallyCommits = eventually(
  () => ui.current.messageCount >= 4 && ui.current.modelLabel === TARGET_MODEL_SPEC,
).within(25, 'seconds');

/** The committed model selection and all four turns must rehydrate after reload. */
export const selectedModelExchangeSurvivesReload = always(() =>
  now(() => ui.current.lastAction === 'Reload').implies(
    eventually(
      () => ui.current.messageCount >= 4 && ui.current.modelLabel === TARGET_MODEL_SPEC,
    ).within(20, 'seconds'),
  ),
);
