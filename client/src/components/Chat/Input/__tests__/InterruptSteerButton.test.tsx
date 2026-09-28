import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SteeringControls } from '~/hooks/Chat/useSteering';
import InterruptSteerButton from '../InterruptSteerButton';
import en from '~/locales/en/translation.json';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@ariakit/react', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipAnchor: ({ render }: { render: React.ReactElement }) => render,
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const interruptSteer = jest.fn(() => true);
const onConsumed = jest.fn();
const steering = {
  pausedOnApproval: false,
  canControlGeneration: true,
  interruptSteer,
} as unknown as SteeringControls;

beforeEach(() => {
  jest.clearAllMocks();
});

test('the first response advertises the actual stop-and-send fallback', () => {
  render(
    <InterruptSteerButton
      steering={steering}
      isNewConversation
      getText={() => 'please change course'}
      onConsumed={onConsumed}
    />,
  );

  expect(screen.getByRole('button', { name: 'com_ui_steer_first_turn_stop' })).toBeEnabled();
  expect(screen.getByText('com_ui_steer_first_turn_stop_info')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_steer_first_turn_stop' }));
  expect(interruptSteer).toHaveBeenCalledWith('please change course');
  expect(onConsumed).toHaveBeenCalledTimes(1);
});

test('an established conversation advertises earlier steering instead', () => {
  render(
    <InterruptSteerButton
      steering={steering}
      isNewConversation={false}
      getText={() => 'please change course'}
      onConsumed={onConsumed}
    />,
  );

  expect(screen.getByRole('button', { name: 'com_ui_interrupt_steer_button' })).toBeEnabled();
  expect(screen.getByText('com_ui_interrupt_steer_desc')).toBeInTheDocument();
  expect(screen.queryByText('com_ui_steer_first_turn_stop_info')).not.toBeInTheDocument();
});

test('English copy distinguishes requested steering, running tools, and reasoning restarts', () => {
  expect(en.com_ui_steer_in_flight_preempt).toBe('Steer sooner requested');
  expect(en.com_ui_steer_interrupting_info).toMatch(/may pause a text reply/);
  expect(en.com_ui_steer_interrupting_info).toMatch(/restart an attempt.*only reasoning/);
  expect(en.com_ui_steer_interrupting_info).toMatch(/Running tools finish first/);
  expect(en.com_ui_steer_first_turn_stop_info).toMatch(/new turn/);
  expect(en.com_nav_info_during_run_action).toContain(en.com_ui_steer_interrupts_default);
});
