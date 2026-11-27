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
const ESCAPE_KEY_CODE = 27;
const PROVIDER = 'Mock Provider C';
const MODEL = 'mock-model-c';
const MCP_SERVER = 'E2E Memory';
const SETUP_PROMPT = 'E2E_REPLY:bombadil-steering-setup';
const SETUP_REPLY = 'E2E reply bombadil-steering-setup';
const STEER_LABEL = 'bombadil-steering';
const STEER_PROMPT = `E2E_STEER_TOOL_REPLY:${STEER_LABEL}`;
const STEER_TEXT = `Steer injection ${STEER_LABEL}`;
const FINAL_REPLY = `E2E steer tool reply done ${STEER_LABEL}`;
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
  const messageText = messageElements.map((element) => element.textContent ?? '').join('\n');
  const modelTrigger = state.document.querySelector('button[aria-label="Select a model"]');
  const duringRunSend = state.document.querySelector('[data-testid="during-run-send-button"]');
  const mcpServerItem = Array.from(
    state.document.querySelectorAll('[role="menuitemcheckbox"]'),
  ).find((element) => (element.textContent ?? '').includes(MCP_SERVER));
  const selectedMcpButton = Array.from(
    state.document.querySelectorAll('button[aria-expanded]'),
  ).find((element) => (element.textContent ?? '').includes(MCP_SERVER));
  return {
    path: state.window.location.pathname,
    lastAction: state.lastAction,
    lastActionWasEnter:
      typeof state.lastAction === 'object' &&
      state.lastAction !== null &&
      'PressKey' in state.lastAction &&
      state.lastAction.PressKey.code === ENTER_KEY_CODE,
    messageCount: messageElements.length,
    messageText,
    modelLabel: modelTrigger?.textContent?.trim() ?? '',
    composerValue: inputValue(state, '#prompt-textarea'),
    composerFocused: isFocused(state, '#prompt-textarea'),
    emailValue: inputValue(state, '#email'),
    emailFocused: isFocused(state, '#email'),
    passwordValue: inputValue(state, '#password'),
    passwordFocused: isFocused(state, '#password'),
    mcpSelected:
      mcpServerItem?.getAttribute('aria-checked') === 'true' || selectedMcpButton !== undefined,
    mcpMenuOpen: visiblePoint(state, mcpServerItem ?? null) !== null,
    inFlightSteerCount: state.document.querySelectorAll('[data-testid="in-flight-steer"]').length,
    appliedSteerCount: state.document.querySelectorAll('[data-testid="steer-part"]').length,
    queuedMessageCount: state.document.querySelectorAll('[data-testid="queued-message-row"]')
      .length,
    finalReplyCount: messageElements.filter((element) =>
      (element.textContent ?? '').includes(FINAL_REPLY),
    ).length,
    setupComplete: messageText.includes(SETUP_REPLY),
    duringRunAction: duringRunSend?.getAttribute('data-during-run-action') ?? '',
    isSubmitting:
      state.document.querySelector('[data-testid="stop-generation-button"]') !== null ||
      duringRunSend !== null,
    hasComposer: state.document.querySelector('#prompt-textarea') !== null,
    loginEmail: target(state, '#email', 'Login email'),
    loginPassword: target(state, '#password', 'Login password'),
    loginSubmit: target(state, '[data-testid="login-button"]', 'Login'),
    composer: target(state, '#prompt-textarea', 'Message input'),
    modelTrigger: target(state, 'button[aria-label="Select a model"]', 'Model selector'),
    provider: target(state, '[role="option"]', PROVIDER, PROVIDER),
    model: target(state, '[role="option"]', MODEL, MODEL),
    mcpTrigger: target(state, 'button', 'MCP Servers', 'MCP Servers'),
    mcpServer: target(state, '[role="menuitemcheckbox"]', `Select ${MCP_SERVER}`, MCP_SERVER, true),
  };
});

export { noConsoleErrors, noHttpErrorCodes, noUncaughtExceptions, noUnhandledPromiseRejections };

export const steeringLifecycleActions = actions((): Action[] => {
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

  if (!state.hasComposer) {
    return ['Wait'];
  }

  if (state.composerValue.endsWith(STEER_TEXT)) {
    if (state.duringRunAction !== 'steer') {
      return ['Wait'];
    }
    if (!state.composerFocused) {
      return clickOrWait(state.composer);
    }
    return [{ PressKey: { code: ENTER_KEY_CODE } }];
  }

  if (
    state.setupComplete &&
    state.lastActionWasEnter &&
    state.inFlightSteerCount === 0 &&
    !state.composerValue.endsWith(STEER_TEXT)
  ) {
    return state.composerFocused
      ? [{ TypeText: { text: STEER_TEXT, delayMillis: 0 } }]
      : clickOrWait(state.composer);
  }

  if (state.isSubmitting) {
    if (!state.setupComplete) {
      return ['Wait'];
    }
    if (state.inFlightSteerCount === 1 || state.appliedSteerCount === 1) {
      return ['Wait'];
    }
    if (state.composerValue === '') {
      return state.composerFocused
        ? [{ TypeText: { text: STEER_TEXT, delayMillis: 0 } }]
        : clickOrWait(state.composer);
    }
    if (state.composerValue === STEER_PROMPT) {
      if (!state.composerFocused) {
        return clickOrWait(state.composer);
      }
      return [{ PressKey: { code: ENTER_KEY_CODE } }];
    }
    if (state.duringRunAction !== 'steer') {
      return ['Wait'];
    }
    return state.composerFocused
      ? [{ PressKey: { code: ENTER_KEY_CODE } }]
      : clickOrWait(state.composer);
  }

  if (state.finalReplyCount === 1 && state.appliedSteerCount === 1) {
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
    if (state.modelLabel === '' || state.modelLabel === 'Select a model') {
      return clickOrWait(state.modelTrigger);
    }
    if (state.model) {
      return clickOrWait(state.model);
    }
    if (state.provider) {
      return clickOrWait(state.provider);
    }
    if (!state.modelLabel.includes(MODEL) && !state.modelLabel.includes(PROVIDER)) {
      return clickOrWait(state.modelTrigger);
    }
    if (!state.mcpSelected) {
      return state.mcpServer ? clickOrWait(state.mcpServer) : clickOrWait(state.mcpTrigger);
    }
    if (state.mcpMenuOpen) {
      return [{ PressKey: { code: ESCAPE_KEY_CODE } }];
    }
    if (state.composerValue === '') {
      return state.composerFocused
        ? [{ TypeText: { text: SETUP_PROMPT, delayMillis: 0 } }]
        : clickOrWait(state.composer);
    }
    return state.composerFocused
      ? [{ PressKey: { code: ENTER_KEY_CODE } }]
      : clickOrWait(state.composer);
  }

  if (state.messageCount === 2 && state.setupComplete) {
    if (state.composerValue === '') {
      return state.composerFocused
        ? [{ TypeText: { text: STEER_PROMPT, delayMillis: 0 } }]
        : clickOrWait(state.composer);
    }
    if (!state.composerFocused) {
      return clickOrWait(state.composer);
    }
    return [{ PressKey: { code: ENTER_KEY_CODE } }];
  }

  return ['Wait'];
});

/** A submitted steer must be represented immediately while the run is active. */
export const steerEventuallyBecomesInFlight = eventually(
  () => ui.current.inFlightSteerCount === 1,
).within(30, 'seconds');

/** The steer drains at the MCP tool boundary and becomes durable in-thread state. */
export const steerEventuallyApplies = eventually(
  () =>
    ui.current.appliedSteerCount === 1 &&
    ui.current.inFlightSteerCount === 0 &&
    ui.current.finalReplyCount === 1,
).within(65, 'seconds');

/** A steer is neither duplicated nor degraded into a queued follow-up turn. */
export const steerStaysSingularAndInBand = always(
  () =>
    ui.current.inFlightSteerCount <= 1 &&
    ui.current.appliedSteerCount <= 1 &&
    ui.current.finalReplyCount <= 1 &&
    ui.current.queuedMessageCount === 0 &&
    ui.current.messageCount <= 4,
);

/** The applied steer and terminal response must survive a conversation reload. */
export const appliedSteerSurvivesReload = always(() =>
  now(() => ui.current.lastAction === 'Reload').implies(
    eventually(
      () =>
        ui.current.appliedSteerCount === 1 &&
        ui.current.inFlightSteerCount === 0 &&
        ui.current.finalReplyCount === 1,
    ).within(20, 'seconds'),
  ),
);
