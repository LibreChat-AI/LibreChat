import { always, eventually, extract, from, integers, next, now } from '@antithesishq/bombadil';
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
  previousDisabled: boolean;
  nextDisabled: boolean;
};

const LOGIN_EMAIL = '__BOMBADIL_E2E_USER_EMAIL__';
const LOGIN_PASSWORD = '__BOMBADIL_E2E_USER_PASSWORD__';
const ENTER_KEY_CODE = 13;
const RENAME_MARKER_PREFIX = ' — Bombadil:';
const MAX_CONVERSATION_FINGERPRINT_LENGTH = 80;
const PROMPT_VARIANTS = from([
  { name: 'short', suffix: '' },
  { name: 'unicode-雪-🙂', suffix: '' },
  { name: 'spaces', suffix: ' with internal spaces' },
  { name: 'markdown', suffix: ' [x](y)' },
  { name: 'long', suffix: `-${'x'.repeat(256)}` },
]);
const PROMPT_NONCES = integers().min(0).max(2_147_483_647);

function generatePrompt(): string {
  const variant = PROMPT_VARIANTS.generate();
  return `E2E_REPLY:bombadil-${variant.name}-${PROMPT_NONCES.generate()}${variant.suffix}`;
}

function promptMarker(text: string): string {
  return text.match(/E2E_REPLY:[^\s]+/)?.[0] ?? '';
}

function conversationFingerprint(text: string): string {
  return promptMarker(text).slice(0, MAX_CONVERSATION_FINGERPRINT_LENGTH);
}

function expectedReply(text: string): string {
  const marker = promptMarker(text);
  return marker === '' ? '' : `E2E reply ${marker.slice('E2E_REPLY:'.length)}`;
}

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

function target(
  state: State,
  selector: string,
  name: string,
  text?: string,
  last = false,
): Target | null {
  const candidates = Array.from(state.document.querySelectorAll(selector)).filter((element) => {
    if (text == null) {
      return true;
    }
    return element.textContent?.trim() === text;
  });
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

function conversationTargets(state: State): Target[] {
  return Array.from(state.document.querySelectorAll('[data-testid="convo-item"]')).flatMap(
    (element, index) => {
      if (element.querySelector('[aria-current="page"]')) {
        return [];
      }
      const point = visiblePoint(state, element);
      return point ? [{ name: `Open conversation ${index + 1}`, point }] : [];
    },
  );
}

function clickedConversationIndex(lastAction: unknown): number | null {
  if (typeof lastAction !== 'object' || lastAction === null || !('Click' in lastAction)) {
    return null;
  }
  const click = lastAction.Click;
  if (typeof click !== 'object' || click === null || !('name' in click)) {
    return null;
  }
  const match = String(click.name).match(/^Open conversation (\d+)$/);
  return match ? Number(match[1]) : null;
}

function isPersistedConversation(pathname: string): boolean {
  return pathname.startsWith('/c/') && pathname !== '/c/new';
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

function clickAction(targetValue: Target | null): Action[] {
  return targetValue ? [{ Click: targetValue }] : [];
}

function clickOrWait(targetValue: Target | null): Action[] {
  const clicks = clickAction(targetValue);
  return clicks.length > 0 ? clicks : ['Wait'];
}

const ui = extract((state: State) => {
  const statuses: NavigationStatus[] = [];
  for (const navigation of state.document.querySelectorAll(
    'nav[aria-label="Sibling message navigation"]',
  )) {
    const text = navigation.querySelector('[role="status"]')?.textContent?.trim() ?? '';
    const match = text.match(/^(\d+)\s*\/\s*(\d+)$/);
    const previous = navigation.querySelector(
      'button[aria-label="Previous sibling message"]',
    ) as HTMLButtonElement | null;
    const nextButton = navigation.querySelector(
      'button[aria-label="Next sibling message"]',
    ) as HTMLButtonElement | null;
    if (match && previous && nextButton) {
      statuses.push({
        current: Number(match[1]),
        total: Number(match[2]),
        previousDisabled: previous.disabled || previous.getAttribute('aria-disabled') === 'true',
        nextDisabled: nextButton.disabled || nextButton.getAttribute('aria-disabled') === 'true',
      });
    }
  }

  const messageIds = Array.from(state.document.querySelectorAll('.message-render'))
    .map((element) => element.id)
    .filter(Boolean);
  const messageText = Array.from(state.document.querySelectorAll('.message-render'))
    .map((element) => element.textContent ?? '')
    .join('\n');
  const parallelColumnCounts = Array.from(
    state.document.querySelectorAll('.sibling-content-group'),
  ).map((group) => group.children.length);
  const modelTrigger = state.document.querySelector('button[aria-label="Select a model"]');
  const conversationElements = Array.from(
    state.document.querySelectorAll('[data-testid="convo-item"]'),
  );
  const activeConversationIndexes = conversationElements.flatMap((element, index) =>
    element.querySelector('[aria-current="page"]') ? [index + 1] : [],
  );
  const activeConversation = conversationElements.find((element) =>
    element.querySelector('[aria-current="page"]'),
  );

  return {
    path: state.window.location.pathname,
    lastAction: state.lastAction,
    messageText,
    messageIds,
    statuses,
    parallelColumnCounts,
    composerValue: inputValue(state, '#prompt-textarea'),
    composerFocused: isFocused(state, '#prompt-textarea'),
    renameValue: inputValue(state, 'input[aria-label="New Conversation Title"]'),
    renameFocused: isFocused(state, 'input[aria-label="New Conversation Title"]'),
    emailValue: inputValue(state, '#email'),
    emailFocused: isFocused(state, '#email'),
    passwordValue: inputValue(state, '#password'),
    passwordFocused: isFocused(state, '#password'),
    modelLabel: modelTrigger?.textContent?.trim() ?? '',
    activeConversationIndexes,
    activeConversationTitle: activeConversation?.textContent?.trim() ?? '',
    modelOptionsOpen: state.document.querySelector('[role="option"]') !== null,
    hasAddedConversation:
      state.document.querySelector('button[aria-label="Close added conversation"]') !== null,
    isSubmitting: state.document.querySelector('button[aria-label="Stop generating"]') !== null,
    hasComposer: state.document.querySelector('#prompt-textarea') !== null,
    loginEmail: target(state, '#email', 'Login email'),
    loginPassword: target(state, '#password', 'Login password'),
    loginSubmit: target(state, '[data-testid="login-button"]', 'Login'),
    modelTrigger: target(state, 'button[aria-label="Select a model"]', 'Model selector'),
    providerA: target(state, '[role="option"]', 'Mock Provider A', 'Mock Provider A'),
    providerB: target(state, '[role="option"]', 'Mock Provider B', 'Mock Provider B'),
    modelA: target(state, '[role="option"]', 'mock-model-a', 'mock-model-a'),
    modelB: target(state, '[role="option"]', 'mock-model-b', 'mock-model-b'),
    starterSpec: target(state, '[role="option"]', 'E2E Starters', 'E2E Starters'),
    composer: target(state, '#prompt-textarea', 'Message input'),
    addMultiConversation: target(
      state,
      '[data-testid="add-multi-convo-button"]',
      'Add multi-conversation',
    ),
    closeAddedConversation: target(
      state,
      'button[aria-label="Close added conversation"]',
      'Close added conversation',
    ),
    regenerate: target(state, 'button[title="Regenerate"]', 'Regenerate', undefined, true),
    previousSibling: target(
      state,
      'button[aria-label="Previous sibling message"]',
      'Previous sibling message',
      undefined,
      true,
    ),
    nextSibling: target(
      state,
      'button[aria-label="Next sibling message"]',
      'Next sibling message',
      undefined,
      true,
    ),
    branchParallel: target(
      state,
      'button[aria-label="Create branch from this response"]',
      'Create branch from parallel response',
      undefined,
      true,
    ),
    newConversation: target(state, '[data-testid="new-chat-button"]', 'New conversation'),
    conversationItems: conversationTargets(state),
    conversationMenu: target(
      state,
      'button[aria-label="Conversation Menu Options"]',
      'Conversation menu',
    ),
    renameMenuItem: target(state, '[role="menuitem"]', 'Rename conversation', 'Rename'),
    renameInput: target(state, 'input[aria-label="New Conversation Title"]', 'Conversation title'),
    renameSave: target(state, 'button[aria-label="Save"]', 'Save conversation title'),
  };
});

export { noConsoleErrors, noHttpErrorCodes, noUncaughtExceptions, noUnhandledPromiseRejections };

export const libreChatActions = actions(() => {
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

  if (state.renameInput) {
    if (!state.renameFocused) {
      return clickAction(state.renameInput);
    }
    if (!state.renameValue.includes(RENAME_MARKER_PREFIX.trim())) {
      const fingerprint = conversationFingerprint(state.messageText);
      return fingerprint === ''
        ? ['Wait']
        : [{ TypeText: { text: `${RENAME_MARKER_PREFIX}${fingerprint}`, delayMillis: 0 } }];
    }
    return clickOrWait(state.renameSave);
  }

  if (state.isSubmitting) {
    return ['Wait'];
  }

  const selectorActions: Action[] = ['Wait'];
  if (state.providerA) {
    selectorActions.push(...clickAction(state.providerA));
  }
  if (state.providerB) {
    selectorActions.push(...clickAction(state.providerB));
  }
  if (state.modelA) {
    selectorActions.push(...clickAction(state.modelA));
  }
  if (state.modelB) {
    selectorActions.push(...clickAction(state.modelB));
  }
  if (state.starterSpec) {
    selectorActions.push(...clickAction(state.starterSpec));
  }
  if (state.modelOptionsOpen || selectorActions.length > 1) {
    if (state.modelOptionsOpen) {
      // Clicking a visible point outside the popover closes unknown submenu
      // states without getting trapped in a keyboard-action retry loop.
      selectorActions.push(...clickAction(state.composer));
    }
    return selectorActions;
  }

  if (state.renameMenuItem) {
    return ['Wait', ...clickAction(state.renameMenuItem)];
  }

  const isPersisted = isPersistedConversation(state.path);
  if (!state.hasComposer || (isPersisted && state.messageIds.length === 0)) {
    return ['Wait'];
  }

  const possible: Action[] = ['Wait'];
  if (state.modelLabel === '' || state.modelLabel === 'Select a model') {
    possible.push(...clickAction(state.modelTrigger));
    return possible;
  }

  const composeActions = (): Action[] => {
    if (state.composerValue !== '') {
      if (state.composerFocused) {
        return [{ PressKey: { code: ENTER_KEY_CODE } }];
      }
      return clickOrWait(state.composer);
    }
    if (state.composerFocused) {
      return [{ TypeText: { text: generatePrompt(), delayMillis: 0 } }];
    }
    return clickOrWait(state.composer);
  };

  if (state.messageIds.length === 0) {
    return composeActions();
  }

  if (state.parallelColumnCounts.length === 0) {
    if (!state.hasAddedConversation) {
      return clickOrWait(state.addMultiConversation);
    }
    return composeActions();
  }

  if (state.statuses.length === 0 && state.branchParallel) {
    return clickAction(state.branchParallel);
  }
  if (state.composerValue === '') {
    if (state.composerFocused) {
      possible.push({ TypeText: { text: generatePrompt(), delayMillis: 0 } });
    } else {
      possible.push(...clickAction(state.composer));
    }
  } else if (state.composerFocused) {
    possible.push({ PressKey: { code: ENTER_KEY_CODE } });
  }

  possible.push(...clickAction(state.modelTrigger));
  possible.push(...clickAction(state.addMultiConversation));
  possible.push(...clickAction(state.closeAddedConversation));
  possible.push(...clickAction(state.regenerate));
  possible.push(...clickAction(state.previousSibling));
  possible.push(...clickAction(state.nextSibling));
  possible.push(...clickAction(state.branchParallel));
  possible.push(...clickAction(state.newConversation));
  possible.push(...state.conversationItems.map((item) => ({ Click: item }) as Action));
  possible.push(...clickAction(state.conversationMenu));
  possible.push(...clickAction(state.renameMenuItem));

  if (state.path.startsWith('/c/') && state.path !== '/c/new') {
    possible.push('Reload');
  }
  return possible;
});

export const messageIdsRemainUnique = always(() => {
  const ids = ui.current.messageIds;
  return new Set(ids).size === ids.length;
});

export const siblingNavigationRemainsValid = always(() =>
  ui.current.statuses.every(
    ({ current, total, previousDisabled, nextDisabled }) =>
      total > 1 &&
      current >= 1 &&
      current <= total &&
      previousDisabled === (current === 1) &&
      nextDisabled === (current === total),
  ),
);

export const multiConversationAlwaysRendersTwoColumns = always(() =>
  ui.current.parallelColumnCounts.every((count) => count === 2),
);

export const sidebarNavigationEventuallySelectsTarget = always(() => {
  const expectedIndex = clickedConversationIndex(ui.current.lastAction);
  return now(() => expectedIndex !== null).implies(
    eventually(() => {
      const action = ui.current.lastAction;
      const newerIndex = clickedConversationIndex(action);
      const startsNewConversation =
        typeof action === 'object' &&
        action !== null &&
        'Click' in action &&
        action.Click.name === 'New conversation';
      if (startsNewConversation || (newerIndex !== null && newerIndex !== expectedIndex)) {
        return true;
      }
      return (
        expectedIndex !== null &&
        isPersistedConversation(ui.current.path) &&
        ui.current.activeConversationIndexes.length === 1 &&
        ui.current.activeConversationIndexes[0] === expectedIndex &&
        ui.current.messageIds.length > 0
      );
    }).within(10, 'seconds'),
  );
});

export const sidebarEventuallyMatchesRenderedConversation = always(() =>
  now(
    () =>
      isPersistedConversation(ui.current.path) &&
      ui.current.hasComposer &&
      ui.current.messageIds.length > 0,
  ).implies(
    eventually(() => {
      const state = ui.current;
      const fingerprint = conversationFingerprint(state.activeConversationTitle);
      return (
        isPersistedConversation(state.path) &&
        state.activeConversationIndexes.length === 1 &&
        (fingerprint === '' || state.messageText.includes(fingerprint))
      );
    }).within(10, 'seconds'),
  ),
);

export const loginEventuallySucceeds = eventually(() => ui.current.path !== '/login').within(
  30,
  'seconds',
);

export const anExchangeEventuallyHappens = eventually(
  () => ui.current.messageIds.length >= 2,
).within(60, 'seconds');

export const multiConversationEventuallyRenders = eventually(
  () => ui.current.parallelColumnCounts.length > 0,
).within(75, 'seconds');

export const aBranchEventuallyRenders = eventually(() => ui.current.statuses.length > 0).within(
  85,
  'seconds',
);

export const streamingEventuallyTerminates = always(() =>
  now(() => ui.current.isSubmitting).implies(
    eventually(() => !ui.current.isSubmitting).within(45, 'seconds'),
  ),
);

export const submittedPromptEventuallyAppears = always(() => {
  const submittedText = ui.current.composerValue.trim();
  const marker = promptMarker(submittedText);
  const eligible = ui.current.composerFocused && submittedText !== '';
  return next(
    now(
      () =>
        eligible &&
        typeof ui.current.lastAction === 'object' &&
        ui.current.lastAction !== null &&
        'PressKey' in ui.current.lastAction &&
        ui.current.lastAction.PressKey.code === ENTER_KEY_CODE,
    ).implies(
      eventually(() => marker !== '' && ui.current.messageText.includes(marker)).within(
        30,
        'seconds',
      ),
    ),
  );
});

export const assistantReplyEventuallyAppears = always(() => {
  const replyText = expectedReply(ui.current.composerValue.trim());
  const eligible = ui.current.composerFocused && replyText !== '';
  return next(
    now(
      () =>
        eligible &&
        typeof ui.current.lastAction === 'object' &&
        ui.current.lastAction !== null &&
        'PressKey' in ui.current.lastAction &&
        ui.current.lastAction.PressKey.code === ENTER_KEY_CODE,
    ).implies(eventually(() => ui.current.messageText.includes(replyText)).within(30, 'seconds')),
  );
});

export const composerEventuallyClearsAfterSubmit = always(() => {
  const eligible = ui.current.composerFocused && ui.current.composerValue.trim() !== '';
  return next(
    now(
      () =>
        eligible &&
        typeof ui.current.lastAction === 'object' &&
        ui.current.lastAction !== null &&
        'PressKey' in ui.current.lastAction &&
        ui.current.lastAction.PressKey.code === ENTER_KEY_CODE,
    ).implies(eventually(() => ui.current.composerValue === '').within(5, 'seconds')),
  );
});

export const multiConversationSubmissionEventuallyRendersInParallel = always(() => {
  const submittedText = ui.current.composerValue.trim();
  const marker = promptMarker(submittedText);
  const eligible =
    ui.current.hasAddedConversation && ui.current.composerFocused && submittedText !== '';
  return next(
    now(
      () =>
        eligible &&
        typeof ui.current.lastAction === 'object' &&
        ui.current.lastAction !== null &&
        'PressKey' in ui.current.lastAction &&
        ui.current.lastAction.PressKey.code === ENTER_KEY_CODE,
    ).implies(
      eventually(() => {
        const counts = ui.current.parallelColumnCounts;
        return (
          marker !== '' &&
          ui.current.messageText.includes(marker) &&
          counts.length > 0 &&
          counts[counts.length - 1] === 2
        );
      }).within(30, 'seconds'),
    ),
  );
});
