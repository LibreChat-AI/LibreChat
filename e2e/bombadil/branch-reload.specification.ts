import { always, eventually, extract } from '@antithesishq/bombadil';
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

type NavigationStatus = {
  current: number;
  total: number;
};

const LOGIN_EMAIL = '__BOMBADIL_E2E_USER_EMAIL__';
const LOGIN_PASSWORD = '__BOMBADIL_E2E_USER_PASSWORD__';
const ENTER_KEY_CODE = 13;
const BRANCH_PROMPT = 'E2E_REPLY:bombadil-branch-reload';
const RELOAD_MARKER = 'bombadil-reload-marker';

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

function target(state: State, selector: string, name: string, last = false): Target | null {
  const candidates = Array.from(state.document.querySelectorAll(selector));
  const elements = last ? candidates.reverse() : candidates;
  for (const element of elements) {
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

function isNamedClick(action: Action | null, name: string): boolean {
  return (
    typeof action === 'object' && action !== null && 'Click' in action && action.Click.name === name
  );
}

const ui = extract((state: State) => {
  const statuses: NavigationStatus[] = [];
  for (const navigation of state.document.querySelectorAll(
    'nav[aria-label="Sibling message navigation"]',
  )) {
    const text = navigation.querySelector('[role="status"]')?.textContent?.trim() ?? '';
    const match = text.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (match) {
      statuses.push({ current: Number(match[1]), total: Number(match[2]) });
    }
  }
  const encodedReloadMarker = state.window.btoa(RELOAD_MARKER);
  const hasSavedReloadMarker = Object.keys(state.window.localStorage).some(
    (key) =>
      key.startsWith('textDraft_') &&
      state.window.localStorage.getItem(key) === encodedReloadMarker,
  );

  return {
    path: state.window.location.pathname,
    lastAction: state.lastAction,
    messageCount: state.document.querySelectorAll('.message-render').length,
    statuses,
    hasSavedReloadMarker,
    composerValue: inputValue(state, '#prompt-textarea'),
    composerFocused: isFocused(state, '#prompt-textarea'),
    emailValue: inputValue(state, '#email'),
    emailFocused: isFocused(state, '#email'),
    passwordValue: inputValue(state, '#password'),
    passwordFocused: isFocused(state, '#password'),
    isSubmitting: state.document.querySelector('button[aria-label="Stop generating"]') !== null,
    hasComposer: state.document.querySelector('#prompt-textarea') !== null,
    loginEmail: target(state, '#email', 'Login email'),
    loginPassword: target(state, '#password', 'Login password'),
    loginSubmit: target(state, '[data-testid="login-button"]', 'Login'),
    composer: target(state, '#prompt-textarea', 'Message input'),
    regenerate: target(state, 'button[title="Regenerate"]', 'Regenerate', true),
    previousSibling: target(
      state,
      'button[aria-label="Previous sibling message"]',
      'Previous sibling message',
      true,
    ),
  };
});

export { noConsoleErrors, noHttpErrorCodes, noUncaughtExceptions, noUnhandledPromiseRejections };

export const branchReloadActions = actions((): Action[] => {
  const state = ui.current;

  if (state.path === '/login') {
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
        return [{ TypeText: { text: BRANCH_PROMPT, delayMillis: 0 } }];
      }
      return clickOrWait(state.composer);
    }
    if (!state.composerFocused) {
      return clickOrWait(state.composer);
    }
    return [{ PressKey: { code: ENTER_KEY_CODE } }];
  }

  const status = state.statuses[state.statuses.length - 1];
  if (state.lastAction === 'Reload') {
    return ['Wait'];
  }
  if (!status) {
    if (isNamedClick(state.lastAction, 'Regenerate')) {
      return ['Wait'];
    }
    return clickOrWait(state.regenerate);
  }
  if (status.total === 2 && status.current === 2) {
    if (state.hasSavedReloadMarker) {
      return ['Wait'];
    }
    return clickOrWait(state.previousSibling);
  }
  if (status.total === 2 && status.current === 1) {
    if (state.composerValue !== RELOAD_MARKER) {
      if (!state.composerFocused) {
        return clickOrWait(state.composer);
      }
      return [{ TypeText: { text: RELOAD_MARKER, delayMillis: 0 } }];
    }
    if (!state.hasSavedReloadMarker) {
      return ['Wait'];
    }
    return ['Reload'];
  }
  return ['Wait'];
});

export const siblingBranchEventuallyExists = eventually(() =>
  ui.current.statuses.some(({ total }) => total === 2),
).within(45, 'seconds');

export const selectedSiblingSurvivesReload = always(
  () =>
    !ui.current.hasSavedReloadMarker ||
    ui.current.messageCount === 0 ||
    !ui.current.statuses.some(({ total }) => total === 2) ||
    ui.current.statuses.some(({ current, total }) => current === 1 && total === 2),
);
