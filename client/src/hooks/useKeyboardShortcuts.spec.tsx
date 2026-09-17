import { MemoryRouter } from 'react-router-dom';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, act, cleanup, renderHook, fireEvent, screen } from '@testing-library/react';
import type { SettingDefinition, TConversation } from 'librechat-data-provider';
import type { MutableSnapshot } from 'recoil';
import type { ReactNode } from 'react';
import type * as ReasoningModule from '~/components/Chat/Input/Reasoning';
import useKeyboardShortcuts, {
  isOverridden,
  effectiveBinding,
  useShortcutHint,
  useShortcutActions,
  getShortcutDisplay,
  getShortcutAriaKey,
  useShortcutDisplay,
  useShortcutAriaKey,
} from './useKeyboardShortcuts';
import { ReasoningControl } from '~/components/Chat/Input/Reasoning';
import Thinking from '~/components/Chat/Input/Composer/Thinking';
import store from '~/store';

/** `copy-to-clipboard` exports a single callable: `copy(text, options?)`. */
const mockCopy = jest.fn((_text: string, _options?: { format?: string }) => true);

jest.mock('~/components/Chat/Input/Reasoning', () => ({
  __esModule: true,
  ReasoningControl: jest.requireActual<typeof ReasoningModule>('~/components/Chat/Input/Reasoning')
    .ReasoningControl,
  useComposerReasoning: () => ({
    setting: {
      key: 'reasoning_effort',
      type: 'enum',
      default: 'low',
      options: ['auto', 'low', 'high'],
    } as SettingDefinition,
    value: { key: 'reasoning_effort', value: 'low' },
    setValue: jest.fn(),
  }),
}));

jest.mock('~/data-provider/Endpoints/queries', () => ({
  ...jest.requireActual('~/data-provider/Endpoints/queries'),
  useGetStartupConfig: () => ({ data: { interface: { parameters: true } } }),
}));

jest.mock('~/Providers', () => ({
  useChatContext: () => ({
    conversation: { conversationId: 'test-convo', endpoint: 'openAI', model: 'gpt-4o' },
  }),
}));

jest.mock('~/hooks/Generic/useReducedMotion', () => ({
  __esModule: true,
  default: () => true,
}));

jest.mock('copy-to-clipboard', () => ({
  __esModule: true,
  default: (text: string, options?: { format?: string }) => mockCopy(text, options),
}));
jest.mock('./useNewConvo', () => ({
  __esModule: true,
  default: () => ({ newConversation: jest.fn() }),
}));

const STORAGE_KEY = 'customKeyboardShortcuts';
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
  children?: ReactNode,
) {
  const initializeState = (snapshot: MutableSnapshot) => {
    if (conversation) {
      snapshot.set(store.conversationByIndex(0), conversation);
    }
    initialize?.(snapshot);
  };
  return render(
    <>
      <Harness />
      {children}
    </>,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <RecoilRoot initializeState={initializeState}>
            <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
          </RecoilRoot>
        </QueryClientProvider>
      ),
    },
  );
}

beforeEach(() => {
  queryClient = new QueryClient();
  window.localStorage.clear();
  mockCopy.mockClear();
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

/** A composer form carrying the stop control the way `ChatForm` renders it:
 *  visible when it owns the action slot, hidden behind the during-run send
 *  button while the user types a steer. */
function appendComposerForm({ hidden = false }: { hidden?: boolean } = {}) {
  const onClick = jest.fn();
  const pane = document.createElement('div');
  pane.dataset.chatPane = String(document.querySelectorAll('[data-chat-pane]').length);
  const form = document.createElement('form');
  const textarea = document.createElement('textarea');
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.testid = 'stop-generation-button';
  if (hidden) {
    button.style.display = 'none';
  }
  button.addEventListener('click', onClick);
  form.append(textarea, button);
  pane.appendChild(form);
  document.body.appendChild(pane);
  return { form: pane, textarea, onClick };
}

/** A composer form carrying the palette disclosure the upload shortcut clicks.
 *  Identified by test id rather than by `id`, which two mounted composers
 *  cannot share. */
function appendPaletteForm({ uploadShortcut = true }: { uploadShortcut?: boolean } = {}) {
  const onClick = jest.fn();
  const pane = document.createElement('div');
  pane.dataset.chatPane = String(document.querySelectorAll('[data-chat-pane]').length);
  const form = document.createElement('form');
  const textarea = document.createElement('textarea');
  const anchor = document.createElement('button');
  anchor.type = 'button';
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.testid = 'composer-palette-button';
  button.dataset.uploadShortcut = String(uploadShortcut);
  button.addEventListener('click', onClick);
  form.append(textarea, anchor, button);
  pane.appendChild(form);
  document.body.appendChild(pane);
  return { form: pane, textarea, anchor, onClick };
}

function appendEscalationButton(
  surface: 'bubble' | 'queued',
  active = false,
  parent: HTMLElement = document.body,
) {
  const onClick = jest.fn();
  const button = document.createElement('button');
  button.dataset.escalateSteer = surface;
  if (active) {
    button.dataset.escalateSteerActive = 'true';
  }
  button.addEventListener('click', onClick);
  parent.appendChild(button);
  return { button, onClick };
}

function appendPortalFocus(paneIndex: number, tag: 'button' | 'input' = 'button') {
  const portal = document.createElement('div');
  portal.dataset.chatPanePortal = String(paneIndex);
  const focusTarget = document.createElement(tag);
  portal.appendChild(focusTarget);
  document.body.appendChild(portal);
  focusTarget.focus();
  return focusTarget;
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
  it('ignores hidden dialog shells but suppresses shortcuts for visible dialogs', () => {
    renderHarness();
    const hiddenDialog = document.createElement('div');
    hiddenDialog.setAttribute('role', 'dialog');
    hiddenDialog.hidden = true;
    document.body.appendChild(hiddenDialog);

    const hiddenEvent = dispatchKey({ key: 's', ctrlKey: true, shiftKey: true });
    expect(hiddenEvent.defaultPrevented).toBe(true);

    hiddenDialog.remove();
    const visibleDialog = document.createElement('div');
    visibleDialog.setAttribute('role', 'dialog');
    document.body.appendChild(visibleDialog);

    const visibleEvent = dispatchKey({ key: 's', ctrlKey: true, shiftKey: true });
    expect(visibleEvent.defaultPrevented).toBe(false);
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

  it('keeps escalation inside the pane containing keyboard focus', () => {
    renderHarness();
    const focusedPane = document.createElement('section');
    const otherPane = document.createElement('section');
    focusedPane.dataset.chatPane = '0';
    otherPane.dataset.chatPane = '1';
    const textarea = document.createElement('textarea');
    const focused = appendEscalationButton('bubble', false, focusedPane);
    const other = appendEscalationButton('bubble', true, otherPane);
    focusedPane.appendChild(textarea);
    document.body.append(focusedPane, otherPane);
    textarea.focus();

    const event = dispatchKey({ key: '.', ctrlKey: true, shiftKey: true }, textarea);

    expect(focused.onClick).toHaveBeenCalledTimes(1);
    expect(other.onClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps escalation scoped while focus is inside a portaled palette', () => {
    renderHarness();
    const firstPane = document.createElement('section');
    const secondPane = document.createElement('section');
    firstPane.dataset.chatPane = '0';
    secondPane.dataset.chatPane = '1';
    const first = appendEscalationButton('bubble', true, firstPane);
    const second = appendEscalationButton('bubble', false, secondPane);
    document.body.append(firstPane, secondPane);
    const focusTarget = appendPortalFocus(1, 'input');

    const event = dispatchKey({ key: '.', ctrlKey: true, shiftKey: true }, focusTarget);

    expect(second.onClick).toHaveBeenCalledTimes(1);
    expect(first.onClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
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
    expect(mockCopy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('copies the last code block through the clipboard fallback helper', () => {
    renderHarness();
    appendCodeBlock('const x = 1;');

    const event = dispatchKey({ key: 'k', ctrlKey: true, shiftKey: true });

    expect(mockCopy).toHaveBeenCalledWith('const x = 1;', { format: 'text/plain' });
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not copy or prevent the event when there is no code to copy', () => {
    renderHarness();

    const event = dispatchKey({ key: 'k', ctrlKey: true, shiftKey: true });

    expect(mockCopy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('stop generating shortcut', () => {
  it('stops the run of the pane the user is focused in', () => {
    renderHarness();
    const first = appendComposerForm();
    const second = appendComposerForm();
    second.textarea.focus();

    const event = dispatchKey({ key: 'x', ctrlKey: true, shiftKey: true }, second.textarea);

    expect(second.onClick).toHaveBeenCalledTimes(1);
    expect(first.onClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });
  it('clicks the visible stop control when a hidden control is mounted first', () => {
    renderHarness();
    const hiddenClick = jest.fn();
    const visibleClick = jest.fn();
    const hidden = document.createElement('button');
    hidden.dataset.testid = 'stop-generation-button';
    hidden.style.display = 'none';
    hidden.addEventListener('click', hiddenClick);
    const visible = document.createElement('button');
    visible.dataset.testid = 'stop-generation-button';
    visible.addEventListener('click', visibleClick);
    const focusTarget = document.createElement('input');
    document.body.append(hidden, visible, focusTarget);
    focusTarget.focus();

    const event = dispatchKey({ key: 'x', ctrlKey: true, shiftKey: true }, focusTarget);

    expect(hiddenClick).not.toHaveBeenCalled();
    expect(visibleClick).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('uses the visible model selector when a hidden selector is mounted first', () => {
    renderHarness();
    const hiddenClick = jest.fn();
    const visibleClick = jest.fn();
    const hidden = document.createElement('button');
    hidden.dataset.testid = 'model-selector-button';
    hidden.style.display = 'none';
    hidden.addEventListener('click', hiddenClick);
    const visible = document.createElement('button');
    visible.dataset.testid = 'model-selector-button';
    visible.addEventListener('click', visibleClick);
    document.body.append(hidden, visible);
    visible.focus();

    const event = dispatchKey({ key: 'm', ctrlKey: true, shiftKey: true }, visible);

    expect(hiddenClick).not.toHaveBeenCalled();
    expect(visibleClick).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('stops through the hidden control while the during-run send button owns the slot', () => {
    renderHarness();
    const other = appendComposerForm();
    const focused = appendComposerForm({ hidden: true });
    focused.textarea.focus();

    const event = dispatchKey({ key: 'x', ctrlKey: true, shiftKey: true }, focused.textarea);

    expect(focused.onClick).toHaveBeenCalledTimes(1);
    expect(other.onClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('stops the owning pane while focus is inside its portaled palette', () => {
    renderHarness();
    const first = appendComposerForm();
    const second = appendComposerForm();
    first.form.dataset.chatPane = '0';
    second.form.dataset.chatPane = '1';
    const focusTarget = appendPortalFocus(1, 'input');

    const event = dispatchKey({ key: 'x', ctrlKey: true, shiftKey: true }, focusTarget);

    expect(second.onClick).toHaveBeenCalledTimes(1);
    expect(first.onClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('stops only the secondary pane from its numeric reasoning input and slider', () => {
    const setting = {
      key: 'thinkingBudget',
      label: 'com_endpoint_thinking_budget',
      type: 'number',
      range: { min: -1, positiveMin: 128, max: 32768, step: 128 },
    } as SettingDefinition;
    let stop: (() => boolean | void) | undefined;
    function NumericReasoning() {
      stop = useShortcutActions().find((action) => action.id === 'stopGenerating')?.run;
      return (
        <ReasoningControl
          index={1}
          setting={setting}
          value={{ key: 'thinkingBudget', value: 4096 }}
          onChange={jest.fn()}
        />
      );
    }
    renderHarness(undefined, '/c/test-convo', undefined, <NumericReasoning />);
    const first = appendComposerForm();
    const second = appendComposerForm();
    first.form.dataset.chatPane = '0';
    second.form.dataset.chatPane = '1';
    fireEvent.click(screen.getByRole('button', { name: /Reasoning for next message/ }));

    for (const role of ['spinbutton', 'slider']) {
      const control = screen.getByRole(role);
      control.focus();
      act(() => {
        expect(stop?.()).toBe(true);
      });
    }

    expect(second.onClick).toHaveBeenCalledTimes(2);
    expect(first.onClick).not.toHaveBeenCalled();
  });
  it('stops only the secondary pane from its thinking effort radios', () => {
    let stop: (() => boolean | void) | undefined;
    function EnumThinking() {
      stop = useShortcutActions().find((action) => action.id === 'stopGenerating')?.run;
      return <Thinking index={1} disabled={false} hasAddedConversation={false} />;
    }

    renderHarness(undefined, '/c/test-convo', undefined, <EnumThinking />);
    const first = appendComposerForm();
    const second = appendComposerForm();
    first.form.dataset.chatPane = '0';
    second.form.dataset.chatPane = '1';

    fireEvent.click(screen.getByRole('button', { name: /thinking/i }));
    const effort = screen.getByRole('radio', { name: 'Low' });
    effort.focus();

    act(() => {
      expect(stop?.()).toBe(true);
    });

    expect(second.onClick).toHaveBeenCalledTimes(1);
    expect(first.onClick).not.toHaveBeenCalled();
  });

  it('does nothing when focus is in an idle pane while another pane is generating', () => {
    renderHarness();
    const generating = appendComposerForm();
    const idle = appendComposerForm();
    generating.form.dataset.chatPane = '0';
    idle.form.dataset.chatPane = '1';
    idle.form.querySelector('[data-testid="stop-generation-button"]')?.remove();
    idle.textarea.focus();

    const event = dispatchKey({ key: 'x', ctrlKey: true, shiftKey: true }, idle.textarea);

    expect(generating.onClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not prevent the event when nothing is generating', () => {
    renderHarness();

    const event = dispatchKey({ key: 'x', ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
  });
});

describe('upload file shortcut', () => {
  /* Focus sits on a button rather than the textarea: `uploadFile` is not in
     EDITING_ALLOWED_SHORTCUTS, so the chord is filtered out entirely while the
     caret is in a composer. Pane resolution matters for the focus that is left,
     anywhere in a pane that is not an editing context. */
  it('opens the palette of the pane the user is focused in', () => {
    renderHarness();
    const first = appendPaletteForm();
    const second = appendPaletteForm();
    second.anchor.focus();

    const event = dispatchKey({ key: 'u', ctrlKey: true, shiftKey: true }, second.anchor);

    expect(second.onClick).toHaveBeenCalledTimes(1);
    expect(first.onClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens the owning palette while focus is inside its portal', () => {
    renderHarness();
    const first = appendPaletteForm();
    const second = appendPaletteForm();
    first.form.dataset.chatPane = '0';
    second.form.dataset.chatPane = '1';
    const focusTarget = appendPortalFocus(1);

    const event = dispatchKey({ key: 'u', ctrlKey: true, shiftKey: true }, focusTarget);

    expect(second.onClick).toHaveBeenCalledTimes(1);
    expect(first.onClick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens the palette while the caret is in a composer', () => {
    renderHarness();
    const only = appendPaletteForm();
    only.textarea.focus();

    const event = dispatchKey({ key: 'u', ctrlKey: true, shiftKey: true }, only.textarea);

    expect(only.onClick).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('falls back to the document when focus sits outside any composer', () => {
    renderHarness();
    const only = appendPaletteForm();

    const event = dispatchKey({ key: 'u', ctrlKey: true, shiftKey: true });

    expect(only.onClick).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not cancel dictation or fall through to another pane', () => {
    renderHarness();
    const other = appendPaletteForm();
    const dictating = appendPaletteForm({ uploadShortcut: false });
    dictating.anchor.focus();

    const event = dispatchKey({ key: 'u', ctrlKey: true, shiftKey: true }, dictating.anchor);

    expect(dictating.onClick).not.toHaveBeenCalled();
    expect(other.onClick).not.toHaveBeenCalled();
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
