import copy from 'copy-to-clipboard';
import { MemoryRouter } from 'react-router-dom';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, act, cleanup, renderHook } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';
import type { MutableSnapshot } from 'recoil';
import type { ReactNode } from 'react';
import useKeyboardShortcuts, {
  isOverridden,
  effectiveBinding,
  useShortcutHint,
  getShortcutDisplay,
  getShortcutAriaKey,
  useShortcutDisplay,
  useShortcutAriaKey,
} from './useKeyboardShortcuts';
import store from '~/store';

jest.mock('copy-to-clipboard', () => ({
  __esModule: true,
  default: jest.fn(() => true),
}));

jest.mock('./useNewConvo', () => ({
  __esModule: true,
  default: () => ({ newConversation: jest.fn() }),
}));

const STORAGE_KEY = 'customKeyboardShortcuts';
const copyMock = copy as jest.MockedFunction<typeof copy>;
let queryClient: QueryClient;

function buildConversation(conversationId: string, title: string): TConversation {
  return { conversationId, title, endpoint: 'agents' } as TConversation;
}

function dispatchKey(init: KeyboardEventInit, target: EventTarget = document): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function Harness() {
  useKeyboardShortcuts();
  const deleteTarget = useRecoilValue(store.keyboardDeleteTarget);
  const sidebarExpanded = useRecoilValue(store.sidebarExpanded);
  return (
    <>
      <span data-testid="delete-target">{deleteTarget?.conversationId ?? 'none'}</span>
      <span data-testid="sidebar">{String(sidebarExpanded)}</span>
    </>
  );
}

function renderHarness(
  conversation?: TConversation,
  route = '/c/test-convo',
  initialize?: (snapshot: MutableSnapshot) => void,
) {
  const initializeState = (snapshot: MutableSnapshot) => {
    if (conversation) {
      snapshot.set(store.conversationByIndex(0), conversation);
    }
    initialize?.(snapshot);
  };
  return render(<Harness />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <RecoilRoot initializeState={initializeState}>
          <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
        </RecoilRoot>
      </QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  queryClient = new QueryClient();
  window.localStorage.clear();
  copyMock.mockClear();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  document.body.replaceChildren();
});

function appendCodeBlock(code: string) {
  const turn = document.createElement('div');
  turn.className = 'agent-turn';
  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  turn.appendChild(pre);
  document.body.appendChild(turn);
}

function appendResponseCopyButton(onClick: () => void) {
  const button = document.createElement('button');
  button.dataset.testid = 'copy-response-button';
  button.addEventListener('click', onClick);
  document.body.appendChild(button);
}

function appendEscalationButton(surface: 'bubble' | 'queued', active = false) {
  const onClick = jest.fn();
  const button = document.createElement('button');
  button.dataset.escalateSteer = surface;
  if (active) {
    button.dataset.escalateSteerActive = 'true';
  }
  button.addEventListener('click', onClick);
  document.body.appendChild(button);
  return { button, onClick };
}

describe('binding resolution helpers', () => {
  it('falls back to the default binding when there is no override', () => {
    const binding = effectiveBinding('newChat');
    expect(binding).toMatchObject({ ctrl: true, shift: true, key: 'O' });
    expect(getShortcutDisplay('newChat')).toBe('Ctrl+Shift+O');
    expect(getShortcutAriaKey('newChat')).toBe('Control+Shift+O');
  });

  it('honors a stored custom binding for the current platform', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ newChat: { mac: 'Meta+Shift+P', other: 'Control+Shift+P' } }),
    );
    expect(effectiveBinding('newChat')).toMatchObject({ ctrl: true, shift: true, key: 'P' });
    expect(getShortcutAriaKey('newChat')).toBe('Control+Shift+P');
  });

  it('treats a null platform override as an unbound shortcut', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ newChat: { mac: null, other: null } }),
    );
    expect(effectiveBinding('newChat')).toBeNull();
    expect(getShortcutDisplay('newChat')).toBe('');
  });

  it('keeps a persisted custom chord when a new default later claims the same keys', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        toggleSidebar: { mac: 'Meta+Shift+.', other: 'Control+Shift+.' },
      }),
    );

    expect(effectiveBinding('toggleSidebar')).toMatchObject({
      ctrl: true,
      shift: true,
      key: '.',
    });
    expect(effectiveBinding('escalateSteer')).toBeNull();
    expect(getShortcutDisplay('escalateSteer')).toBe('');
    expect(getShortcutAriaKey('escalateSteer')).toBe('');
  });

  it("does not treat an other-platform edit's copied default as a custom claim", () => {
    const overrides = {
      newChat: { mac: 'Meta+Alt+N', other: 'Control+Shift+O' },
      toggleSidebar: { mac: 'Meta+Shift+O', other: 'Control+Shift+O' },
    };

    expect(effectiveBinding('toggleSidebar', overrides)).toMatchObject({
      ctrl: true,
      shift: true,
      key: 'O',
    });
    expect(effectiveBinding('newChat', overrides)).toBeNull();
  });

  it('detects whether an override diverges from the default', () => {
    expect(isOverridden('newChat', undefined)).toBe(false);
    expect(isOverridden('newChat', { mac: 'Meta+Shift+O', other: 'Control+Shift+O' })).toBe(false);
    expect(isOverridden('newChat', { mac: null, other: null })).toBe(true);
    expect(isOverridden('newChat', { mac: 'Meta+Shift+P', other: 'Control+Shift+P' })).toBe(true);
  });
});

describe('global shortcut dispatch', () => {
  it('runs the matched action and prevents the native event', () => {
    const { getByTestId } = renderHarness();
    const before = getByTestId('sidebar').textContent;

    const event = dispatchKey({ key: 's', ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(getByTestId('sidebar').textContent).not.toBe(before);
  });

  it('yields when a closer handler already claimed the keypress', () => {
    const { getByTestId } = renderHarness();
    const before = getByTestId('sidebar').textContent;
    const widget = document.createElement('div');
    widget.addEventListener('keydown', (e) => e.preventDefault());
    document.body.appendChild(widget);

    dispatchKey({ key: 's', ctrlKey: true, shiftKey: true }, widget);

    expect(getByTestId('sidebar').textContent).toBe(before);
  });

  it('still acts when the same widget lets the keypress through', () => {
    const { getByTestId } = renderHarness();
    const before = getByTestId('sidebar').textContent;
    const widget = document.createElement('div');
    document.body.appendChild(widget);

    const event = dispatchKey({ key: 's', ctrlKey: true, shiftKey: true }, widget);

    expect(event.defaultPrevented).toBe(true);
    expect(getByTestId('sidebar').textContent).not.toBe(before);
  });

  it('yields to a document-level owner that registered after the dispatcher', () => {
    const { getByTestId } = renderHarness();
    const before = getByTestId('sidebar').textContent;
    const claim = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener('keydown', claim);

    try {
      dispatchKey({ key: 's', ctrlKey: true, shiftKey: true });
    } finally {
      document.removeEventListener('keydown', claim);
    }

    expect(getByTestId('sidebar').textContent).toBe(before);
  });

  it('yields an editing-allowed chord that the focused input claimed', () => {
    renderHarness();
    const escalation = appendEscalationButton('bubble');
    const input = document.createElement('input');
    input.addEventListener('keydown', (e) => e.preventDefault());
    document.body.appendChild(input);

    dispatchKey({ key: '.', ctrlKey: true, shiftKey: true }, input);

    expect(escalation.onClick).not.toHaveBeenCalled();
  });

  it('ignores shortcuts while a modal dialog is open', () => {
    renderHarness();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);

    const event = dispatchKey({ key: 's', ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores non-allowed shortcuts while typing in an input', () => {
    renderHarness();
    const input = document.createElement('input');
    document.body.appendChild(input);

    const event = dispatchKey({ key: 's', ctrlKey: true, shiftKey: true }, input);

    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores shortcuts while focus is inside an open menu overlay', () => {
    const { getByTestId } = renderHarness();
    const before = getByTestId('sidebar').textContent;
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    item.setAttribute('role', 'menuitem');
    menu.appendChild(item);
    document.body.appendChild(menu);

    const event = dispatchKey({ key: 's', ctrlKey: true, shiftKey: true }, item);

    expect(event.defaultPrevented).toBe(false);
    expect(getByTestId('sidebar').textContent).toBe(before);
  });

  it('does not prevent the native event when the action is a no-op', () => {
    renderHarness();

    // focusChat (Shift+Escape) with no chat textarea present is a no-op.
    const event = dispatchKey({ key: 'Escape', shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
  });

  it('focuses the chat input and prevents the event when the textarea exists', () => {
    renderHarness();
    const textarea = document.createElement('textarea');
    textarea.id = 'prompt-textarea';
    document.body.appendChild(textarea);

    const event = dispatchKey({ key: 'Escape', shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(textarea);
  });

  it('dispatches a persisted custom owner instead of a colliding new default', () => {
    const overrides = {
      toggleSidebar: { mac: 'Meta+Shift+.', other: 'Control+Shift+.' },
    };
    const { getByTestId } = renderHarness(undefined, '/c/test-convo', (snapshot) => {
      snapshot.set(store.customShortcuts, overrides);
    });
    const before = getByTestId('sidebar').textContent;
    const escalation = appendEscalationButton('bubble');

    const event = dispatchKey({ key: '.', ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(getByTestId('sidebar').textContent).not.toBe(before);
    expect(escalation.onClick).not.toHaveBeenCalled();
  });

  it('targets the active waiting row before falling back to the newest one', () => {
    renderHarness();
    const active = appendEscalationButton('bubble', true);
    const newest = appendEscalationButton('bubble');

    dispatchKey({ key: '.', ctrlKey: true, shiftKey: true });

    expect(active.onClick).toHaveBeenCalledTimes(1);
    expect(newest.onClick).not.toHaveBeenCalled();

    active.button.removeAttribute('data-escalate-steer-active');
    dispatchKey({ key: '.', ctrlKey: true, shiftKey: true });

    expect(newest.onClick).toHaveBeenCalledTimes(1);
  });

  it('dispatches the escalation shortcut by physical key on a non-US layout', () => {
    renderHarness();
    const escalation = appendEscalationButton('bubble');

    const event = dispatchKey({
      key: ':',
      code: 'Period',
      ctrlKey: true,
      shiftKey: true,
    });

    expect(escalation.onClick).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('the keyboard shortcuts switch', () => {
  it('ignores a matched chord and leaves the native event alone when off', () => {
    window.localStorage.setItem('keyboardShortcutsEnabled', JSON.stringify(false));
    const { getByTestId } = renderHarness();
    const before = getByTestId('sidebar').textContent;

    const event = dispatchKey({ key: 's', ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(getByTestId('sidebar').textContent).toBe(before);
  });

  it('still dispatches while on', () => {
    window.localStorage.setItem('keyboardShortcutsEnabled', JSON.stringify(true));
    const { getByTestId } = renderHarness();
    const before = getByTestId('sidebar').textContent;

    const event = dispatchKey({ key: 's', ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(getByTestId('sidebar').textContent).not.toBe(before);
  });

  it('defaults to on, so shortcuts work with nothing stored', () => {
    expect(window.localStorage.getItem('keyboardShortcutsEnabled')).toBeNull();
    const { getByTestId } = renderHarness();
    const before = getByTestId('sidebar').textContent;

    const event = dispatchKey({ key: 's', ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(getByTestId('sidebar').textContent).not.toBe(before);
  });

  it('stops advertising chords through the hint and aria hooks when off', () => {
    window.localStorage.setItem('keyboardShortcutsEnabled', JSON.stringify(false));
    const { result } = renderHook(
      () => ({
        display: useShortcutDisplay('newChat'),
        ariaKey: useShortcutAriaKey('newChat'),
        hint: useShortcutHint('newChat', 'New chat'),
      }),
      {
        wrapper: ({ children }: { children: ReactNode }) => <RecoilRoot>{children}</RecoilRoot>,
      },
    );

    expect(result.current.display).toBe('');
    expect(result.current.ariaKey).toBeUndefined();
    expect(result.current.hint).toBe('New chat');
  });
});

describe('clipboard shortcuts', () => {
  it('copies the last response through the existing message copy button', () => {
    const firstCopy = jest.fn();
    const secondCopy = jest.fn();
    renderHarness();
    appendResponseCopyButton(firstCopy);
    appendResponseCopyButton(secondCopy);

    const event = dispatchKey({ key: ';', ctrlKey: true, shiftKey: true });

    expect(firstCopy).not.toHaveBeenCalled();
    expect(secondCopy).toHaveBeenCalledTimes(1);
    expect(copyMock).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('copies the last code block through the clipboard fallback helper', () => {
    renderHarness();
    appendCodeBlock('const x = 1;');

    const event = dispatchKey({ key: 'k', ctrlKey: true, shiftKey: true });

    expect(copyMock).toHaveBeenCalledWith('const x = 1;', { format: 'text/plain' });
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not copy or prevent the event when there is no code to copy', () => {
    renderHarness();

    const event = dispatchKey({ key: 'k', ctrlKey: true, shiftKey: true });

    expect(copyMock).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('no-op shortcuts', () => {
  it('does not prevent submit shortcut when the send button is unavailable', () => {
    renderHarness();

    const event = dispatchKey({ key: 'Enter', ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
  });

  it('does not prevent submit shortcut when the send button is disabled', () => {
    renderHarness();
    const button = document.createElement('button');
    button.dataset.testid = 'send-button';
    button.disabled = true;
    document.body.appendChild(button);

    const event = dispatchKey({ key: 'Enter', ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
  });
});

function appendSendButton(): jest.Mock {
  const onClick = jest.fn();
  const button = document.createElement('button');
  button.dataset.testid = 'send-button';
  button.addEventListener('click', onClick);
  document.body.appendChild(button);
  return onClick;
}

function appendMainTextarea(): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  textarea.id = 'prompt-textarea';
  document.body.appendChild(textarea);
  return textarea;
}

function bindSubmitMessage(binding: string) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ submitMessage: { mac: binding, other: binding } }),
  );
}

describe('composer submit shortcuts', () => {
  it('defers a custom Alt+Enter submit binding in the composer to the textarea', () => {
    window.localStorage.setItem('enterToSend', 'false');
    bindSubmitMessage('Alt+Enter');
    renderHarness();
    const sendClick = appendSendButton();
    const textarea = appendMainTextarea();

    const event = dispatchKey({ key: 'Enter', altKey: true }, textarea);

    expect(sendClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('defers Ctrl/Cmd+Enter in the composer to the native textarea submit', () => {
    renderHarness();
    const sendClick = appendSendButton();
    const textarea = appendMainTextarea();

    const event = dispatchKey({ key: 'Enter', ctrlKey: true }, textarea);

    expect(sendClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('runs a custom Alt+Enter submit binding outside the composer', () => {
    bindSubmitMessage('Alt+Enter');
    renderHarness();
    const sendClick = appendSendButton();

    const event = dispatchKey({ key: 'Enter', altKey: true });

    expect(sendClick).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('delete shortcut confirmation', () => {
  it('opens the delete confirmation instead of deleting immediately', () => {
    const conversation = buildConversation('test-convo', 'My Chat');
    const { getByTestId } = renderHarness(conversation, '/c/test-convo');

    const event = dispatchKey({ key: 'Backspace', ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(getByTestId('delete-target').textContent).toBe('test-convo');
  });

  it('is a no-op when the active conversation is not the routed one', () => {
    const conversation = buildConversation('other-convo', 'Other');
    const { getByTestId } = renderHarness(conversation, '/c/test-convo');

    const event = dispatchKey({ key: 'Backspace', ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(getByTestId('delete-target').textContent).toBe('none');
  });
});
