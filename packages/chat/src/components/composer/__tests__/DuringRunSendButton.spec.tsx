/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SteeringControls } from '../../../react/steering/useSteering';
import type { ComposerBindings } from '../../../core/shortcuts';
import type { ComposerHost } from '../../../react/input';
import { ComposerHostProvider } from '../../../react/input';
import { NO_HOST_BINDINGS } from '../../../core/shortcuts';
import DuringRunSendButton from '../DuringRunSendButton';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

/** Renders the hovercard eagerly; jsdom reports zero pointer geometry to Ariakit's show path. */
jest.mock('@ariakit/react', () => ({
  HovercardProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HovercardAnchor: ({ render }: { render: React.ReactElement }) => render,
  Hovercard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const TEXT = 'stop, do not run that command';
const steerFromComposer = jest.fn(() => true);
const queueFromComposer = jest.fn(() => true);
const interruptSteer = jest.fn(() => true);
const onConsumed = jest.fn();

const steering = (overrides: Partial<SteeringControls> = {}): SteeringControls =>
  ({
    effectiveAction: 'steer',
    canSteer: true,
    canControlGeneration: true,
    pausedOnApproval: false,
    steerFromComposer,
    queueFromComposer,
    interruptSteer,
    ...overrides,
  }) as SteeringControls;

const hostWith = (bindings: ComposerBindings): ComposerHost => ({
  useComposerBindings: () => bindings,
  useShortcutDisplay: () => '',
  useShortcutAriaKey: () => undefined,
});

function renderButton({
  text = TEXT,
  disabled = false,
  controls = steering(),
  bindings = NO_HOST_BINDINGS,
  enterToSend = true,
}: {
  text?: string;
  disabled?: boolean;
  controls?: SteeringControls;
  bindings?: ComposerBindings;
  enterToSend?: boolean;
} = {}) {
  return render(
    <ComposerHostProvider host={hostWith(bindings)}>
      <DuringRunSendButton
        text={text}
        steering={controls}
        isNewConversation={false}
        getText={() => text}
        onConsumed={onConsumed}
        enterToSend={enterToSend}
        disabled={disabled}
      />
    </ComposerHostProvider>,
  );
}

const row = (label: string) => screen.getByText(label).closest('button') as HTMLButtonElement;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('DuringRunSendButton', () => {
  it('labels the submit slot with the effective action and disables it without text', () => {
    const { rerender } = renderButton();
    const button = screen.getByTestId('during-run-send-button');
    expect(button).toHaveAttribute('aria-label', 'com_ui_steer_send');
    expect(button).toBeEnabled();

    rerender(
      <DuringRunSendButton
        text="   "
        steering={steering()}
        isNewConversation={false}
        getText={() => '   '}
        onConsumed={onConsumed}
        enterToSend
      />,
    );
    expect(screen.getByTestId('during-run-send-button')).toBeDisabled();
  });

  it('runs the chosen row with the trimmed text and consumes the composer', () => {
    renderButton();

    fireEvent.click(row('com_ui_queue'));
    expect(queueFromComposer).toHaveBeenCalledWith(TEXT);
    fireEvent.click(row('com_ui_steer'));
    expect(steerFromComposer).toHaveBeenCalledWith(TEXT);
    expect(onConsumed).toHaveBeenCalledTimes(2);
  });

  it('holds every row while the host disables sending', () => {
    renderButton({ disabled: true });

    for (const label of ['com_ui_steer', 'com_ui_queue', 'com_ui_interrupt_steer']) {
      expect(row(label)).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(row(label));
    }
    expect(steerFromComposer).not.toHaveBeenCalled();
    expect(queueFromComposer).not.toHaveBeenCalled();
    expect(interruptSteer).not.toHaveBeenCalled();
    expect(onConsumed).not.toHaveBeenCalled();
  });

  it('moves the default row hint to the modifier chord when Enter does not send', () => {
    const { unmount } = renderButton();
    expect(row('com_ui_steer')).toHaveTextContent('⏎');
    expect(row('com_ui_steer')).not.toHaveTextContent('Ctrl');
    unmount();

    renderButton({ enterToSend: false });
    expect(row('com_ui_steer')).toHaveTextContent('Ctrl ⏎');
  });
});
