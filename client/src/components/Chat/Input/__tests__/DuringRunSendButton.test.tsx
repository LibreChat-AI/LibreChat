import React from 'react';
import { RecoilRoot } from 'recoil';
import { useForm } from 'react-hook-form';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SteeringControls } from '~/hooks/Chat/useSteering';
import type { ShortcutOverride } from '~/store/misc';
import DuringRunSendButton from '../DuringRunSendButton';
import store from '~/store';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

/**
 * Renders the hovercard eagerly. Ariakit's real show path depends on pointer
 * geometry, which jsdom reports as zeros — driving it from a test asserts
 * Ariakit's hover behavior rather than which rows this component disables.
 */
jest.mock('@ariakit/react', () => ({
  HovercardProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HovercardAnchor: ({ render }: { render: React.ReactElement }) => render,
  Hovercard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const TEXT = 'stop, do not run that command';

const mockInterruptSteer = jest.fn(() => true);
const mockSteerFromComposer = jest.fn(() => true);
const mockQueueFromComposer = jest.fn(() => true);
const mockInterruptAndSend = jest.fn(() => true);
const mockOnConsumed = jest.fn();

type StubOptions = {
  pausedOnApproval?: boolean;
  canSteer?: boolean;
  canControlGeneration?: boolean;
};

const steeringStub = ({
  pausedOnApproval = false,
  canSteer = true,
  canControlGeneration = true,
  steerInterruptsByDefault = false,
}: StubOptions & { steerInterruptsByDefault?: boolean }) =>
  ({
    effectiveAction: canSteer ? 'steer' : 'queue',
    canSteer,
    canControlGeneration,
    pausedOnApproval,
    steerInterruptsByDefault,
    interruptSteer: mockInterruptSteer,
    steerFromComposer: mockSteerFromComposer,
    queueFromComposer: mockQueueFromComposer,
    interruptAndSend: mockInterruptAndSend,
  }) as unknown as SteeringControls;

function Harness({
  steering,
  isNewConversation,
  enterToSend,
}: {
  steering: SteeringControls;
  isNewConversation: boolean;
  enterToSend: boolean;
}) {
  const methods = useForm<{ text: string }>({ defaultValues: { text: TEXT } });
  return (
    <DuringRunSendButton
      control={methods.control}
      steering={steering}
      isNewConversation={isNewConversation}
      getText={() => TEXT}
      onConsumed={mockOnConsumed}
      enterToSend={enterToSend}
    />
  );
}

type MenuOptions = StubOptions & {
  enterInterrupts?: boolean;
  enterToSend?: boolean;
  shortcutsEnabled?: boolean;
  customShortcuts?: Record<string, ShortcutOverride>;
  isNewConversation?: boolean;
};

function openMenu(options: MenuOptions = {}) {
  const {
    enterInterrupts = false,
    enterToSend = true,
    shortcutsEnabled = true,
    customShortcuts = {},
    isNewConversation = false,
    ...stub
  } = options;
  render(
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.shortcutsEnabled, shortcutsEnabled);
        set(store.customShortcuts, customShortcuts);
      }}
    >
      <Harness
        steering={steeringStub({ ...stub, steerInterruptsByDefault: enterInterrupts })}
        enterToSend={enterToSend}
        isNewConversation={isNewConversation}
      />
    </RecoilRoot>,
  );
  expect(
    screen.getByText(isNewConversation ? 'com_ui_steer_first_turn_stop' : 'com_ui_interrupt_steer'),
  ).toBeInTheDocument();
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('DuringRunSendButton — Interrupt & steer availability', () => {
  /**
   * `useSteering.interruptSteer` hard-refuses while a run is paused for tool
   * approval, so a live row would silently do nothing at exactly the moment a
   * user is trying to stop a tool call.
   */
  test('disables Interrupt & steer while the run is paused on tool approval', () => {
    openMenu({ pausedOnApproval: true, canSteer: false });

    const row = screen.getByText('com_ui_interrupt_steer').closest('button');
    expect(row).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(row as HTMLButtonElement);
    expect(mockInterruptSteer).not.toHaveBeenCalled();
    expect(mockOnConsumed).not.toHaveBeenCalled();
  });

  /**
   * Guards the gate against being "simplified" to `!canSteer` like the steer
   * row above it. `canSteer` is also false before a conversation exists, where
   * `interruptSteer` deliberately falls back to interrupt & send — disabling
   * the row there would make it dead for the whole first turn.
   */
  test('labels the first-response fallback as stop and send without changing its action', () => {
    openMenu({ pausedOnApproval: false, canSteer: false, isNewConversation: true });

    expect(screen.queryByText('com_ui_interrupt_steer')).not.toBeInTheDocument();
    const row = screen.getByText('com_ui_steer_first_turn_stop').closest('button');
    expect(row).toHaveAttribute('aria-disabled', 'false');

    fireEvent.click(row as HTMLButtonElement);
    expect(mockInterruptSteer).toHaveBeenCalledWith(TEXT);
    expect(mockOnConsumed).toHaveBeenCalled();
  });

  test('the ordinary Steer row stays gated on canSteer', () => {
    openMenu({ pausedOnApproval: false, canSteer: false });

    const row = screen.getByText('com_ui_steer').closest('button');
    expect(row).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(row as HTMLButtonElement);
    expect(mockSteerFromComposer).not.toHaveBeenCalled();
  });

  test('keeps Queue live but disables every generation mutation before the epoch arrives', () => {
    openMenu({ canSteer: false, canControlGeneration: false });

    expect(screen.getByText('com_ui_steer').closest('button')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('com_ui_interrupt_steer').closest('button')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('com_ui_interrupt_send').closest('button')).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    const queue = screen.getByText('com_ui_queue').closest('button') as HTMLButtonElement;
    expect(queue).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(queue);
    expect(mockQueueFromComposer).toHaveBeenCalledWith(TEXT);
    expect(mockOnConsumed).toHaveBeenCalled();
    expect(mockInterruptSteer).not.toHaveBeenCalled();
    expect(mockInterruptAndSend).not.toHaveBeenCalled();
  });

  test('both actions are available during a normal run', () => {
    openMenu({ pausedOnApproval: false, canSteer: true });

    expect(screen.getByText('com_ui_interrupt_steer').closest('button')).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    expect(screen.getByText('com_ui_steer').closest('button')).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });
});

/**
 * With `steerInterruptsByDefault` on, plain Enter routes through
 * `submitDuringRun` and PREEMPTS, while the ordinary Steer row deliberately
 * stays non-preempting when clicked. The ⏎ hint therefore cannot sit on the
 * Steer row — it would advertise a key that does something else.
 */
describe('DuringRunSendButton — Enter hint follows the interrupt preference', () => {
  const kbdFor = (label: string) =>
    screen.getByText(label).closest('button')?.querySelector('kbd')?.textContent ?? null;

  test('Enter is advertised on Steer when the preference is off', () => {
    openMenu({ canSteer: true, enterInterrupts: false });
    expect(kbdFor('com_ui_steer')).toBe('⏎');
    expect(kbdFor('com_ui_interrupt_steer')).not.toBe('⏎');
  });

  test('Enter moves to Interrupt & steer when the preference is on', () => {
    openMenu({ canSteer: true, enterInterrupts: true });
    expect(kbdFor('com_ui_interrupt_steer')).toBe('⏎');
    /** No key reaches the plain Steer row in this mode, so it advertises none. */
    expect(kbdFor('com_ui_steer')).toBeNull();
  });
});

/**
 * Hints come from the same decision table the composer executes
 * (`resolveComposerKeyDown`), so a chord that no longer triggers a row is
 * never advertised on it. Covers codex round 3: a chord rebound to an
 * editing-allowed global shortcut is yielded to the window-level handler,
 * and a submit rebound to Alt+Enter submits instead of interrupting.
 */
describe('DuringRunSendButton — hints follow the effective bindings', () => {
  const kbdFor = (label: string) =>
    screen.getByText(label).closest('button')?.querySelector('kbd')?.textContent ?? null;

  test('defaults advertise every chord', () => {
    openMenu({ canSteer: true });
    expect(kbdFor('com_ui_steer')).toBe('⏎');
    expect(kbdFor('com_ui_queue')).toBe('Ctrl ⏎');
    expect(kbdFor('com_ui_interrupt_steer')).toBe('Ctrl ⇧ ⏎');
    expect(kbdFor('com_ui_interrupt_send')).toBe('Alt ⏎');
  });

  test('drops a hint whose chord is rebound to a global shortcut', () => {
    openMenu({
      canSteer: true,
      customShortcuts: {
        focusSearch: { mac: 'Meta+Shift+Enter', other: 'Ctrl+Shift+Enter' },
      },
    });
    expect(kbdFor('com_ui_interrupt_steer')).toBeNull();
    expect(kbdFor('com_ui_interrupt_send')).toBe('Alt ⏎');
    expect(kbdFor('com_ui_queue')).toBe('Ctrl ⏎');
  });

  test('drops the Interrupt & send hint when submit is rebound to its chord', () => {
    openMenu({
      canSteer: true,
      customShortcuts: {
        submitMessage: { mac: 'Alt+Enter', other: 'Alt+Enter' },
      },
    });
    expect(kbdFor('com_ui_interrupt_send')).toBeNull();
    expect(kbdFor('com_ui_steer')).toBe('⏎');
    expect(kbdFor('com_ui_interrupt_steer')).toBe('Ctrl ⇧ ⏎');
  });

  test('a disabled row never advertises its chord', () => {
    openMenu({ pausedOnApproval: true, canSteer: false });
    /** Its action's own guard refuses the chord while paused on approval. */
    expect(kbdFor('com_ui_interrupt_steer')).toBeNull();
    /** The disabled Steer row drops its alternate-action hint the same way. */
    expect(kbdFor('com_ui_steer')).toBeNull();
    expect(kbdFor('com_ui_interrupt_send')).toBe('Alt ⏎');
  });

  test('moves the default-action hint to Ctrl+Enter when Enter-to-send is off', () => {
    openMenu({ canSteer: true, enterToSend: false });
    /** Plain Enter inserts a newline during a run in this mode; ⌘/Ctrl+Enter submits the default. */
    expect(kbdFor('com_ui_steer')).toBe('Ctrl ⏎');
    expect(kbdFor('com_ui_queue')).toBeNull();
    expect(kbdFor('com_ui_interrupt_steer')).toBe('Ctrl ⇧ ⏎');
    expect(kbdFor('com_ui_interrupt_send')).toBe('Alt ⏎');
  });

  test('keeps plain Enter but hides shortcut hints when shortcuts are disabled', () => {
    openMenu({ canSteer: true, shortcutsEnabled: false });
    expect(kbdFor('com_ui_steer')).toBe('⏎');
    expect(kbdFor('com_ui_queue')).toBeNull();
    expect(kbdFor('com_ui_interrupt_steer')).toBeNull();
    expect(kbdFor('com_ui_interrupt_send')).toBeNull();
  });
});
