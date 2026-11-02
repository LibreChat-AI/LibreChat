/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { SteeringControls } from '../../../../react/steering/useSteering';
import type { ComposerActionsProps } from '../Actions';
import ComposerActions from '../Actions';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

jest.mock('@ariakit/react', () => ({
  ...jest.requireActual('@ariakit/react'),
  HovercardProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HovercardAnchor: ({ render }: { render: React.ReactElement }) => render,
  Hovercard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const steering = (overrides: Partial<SteeringControls> = {}): SteeringControls =>
  ({
    effectiveAction: 'steer',
    canSteer: true,
    canControlGeneration: true,
    pausedOnApproval: false,
    duringRunActive: false,
    steerFromComposer: jest.fn(() => true),
    queueFromComposer: jest.fn(() => true),
    interruptSteer: jest.fn(() => true),
    ...overrides,
  }) as unknown as SteeringControls;

const renderActions = (props: Partial<ComposerActionsProps> = {}) =>
  render(
    <ComposerActions
      text=""
      submitButtonRef={React.createRef<HTMLButtonElement>()}
      isSubmitting={false}
      answersAsk={false}
      hasEndpoint
      steering={steering()}
      isNewConversation={false}
      getText={() => ''}
      onConsumed={jest.fn()}
      enterToSend
      fileCount={0}
      sendDisabled={false}
      duringRunDisabled={false}
      showStopButton={false}
      setShowStopButton={jest.fn()}
      stop={jest.fn()}
      canStop
      isPreparingFromUrl={false}
      {...props}
    />,
  );

const sendButton = () => screen.queryByTestId('send-button');
const stopButton = () => screen.queryByRole('button', { name: /com_nav_stop_generating/ });

describe('ComposerActions', () => {
  it('offers send when idle, and nothing without an endpoint', () => {
    const { unmount } = renderActions({ text: 'hello' });
    expect(sendButton()).toBeEnabled();
    unmount();

    renderActions({ hasEndpoint: false, text: 'hello' });
    expect(sendButton()).toBeNull();
  });

  it('shows Stop while a run goes and the draft is empty', () => {
    renderActions({
      isSubmitting: true,
      showStopButton: true,
      steering: steering({ duringRunActive: true }),
    });
    expect(stopButton()).toBeVisible();
    expect(sendButton()).toBeNull();
  });

  it('swaps in the during-run send once there is text, keeping Stop mounted but hidden', () => {
    renderActions({
      text: 'actually, use the other file',
      isSubmitting: true,
      showStopButton: true,
      steering: steering({ duringRunActive: true }),
    });
    expect(screen.getByTestId('during-run-send-button')).toBeInTheDocument();
    expect(screen.getByTestId('stop-generation-button')).toHaveAttribute('hidden');
  });

  it('keeps a disabled send while the run has not yet offered Stop', () => {
    renderActions({ text: 'hello', isSubmitting: true });
    expect(sendButton()).toBeDisabled();
  });

  it('sends an ask answer even while the run is paused on it', () => {
    renderActions({ text: 'yes', isSubmitting: true, answersAsk: true, showStopButton: true });
    expect(sendButton()).toBeEnabled();
  });
});
