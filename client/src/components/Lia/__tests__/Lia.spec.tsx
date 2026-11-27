import React, { createRef } from 'react';
import { createStore, Provider } from 'jotai';
import { act, render, screen } from '@testing-library/react';
import type { TSubmission } from 'librechat-data-provider';
import Lia, { FAREWELL_MS } from '../index';
import { showLiaAtom } from '../store';

const mockUseGetStartupConfig = jest.fn();
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
}));
jest.mock('../Stage', () => ({
  __esModule: true,
  default: () => <div data-testid="lia-stage" />,
}));

interface Options {
  enabled: boolean;
  mascot?: boolean | null;
  landing?: boolean;
  submission?: TSubmission | null;
}

type ViewProps = { landing: boolean; submission: TSubmission | null };
const send = () => ({}) as TSubmission;

function renderLia({ enabled, mascot, landing = true, submission = null }: Options) {
  const store = createStore();
  store.set(showLiaAtom, enabled);
  mockUseGetStartupConfig.mockReturnValue({
    data: mascot === null ? undefined : { interface: mascot === undefined ? {} : { mascot } },
  });
  const bandRef = createRef<HTMLElement>();
  const view = (props: ViewProps) => (
    <Provider store={store}>
      <Lia bandRef={bandRef} {...props} />
    </Provider>
  );
  const result = render(view({ landing, submission }));
  return {
    ...result,
    update: (props: ViewProps) => result.rerender(view(props)),
  };
}

describe('Lia', () => {
  beforeEach(() => localStorage.clear());

  it('shows nothing until the user opts in', () => {
    renderLia({ enabled: false });
    expect(screen.queryByTestId('lia-stage')).toBeNull();
  });

  /* Runs before any other test lets the stage chunk load; the load is remembered per module. */
  it('gives no farewell to a send made before her chunk arrived', async () => {
    const { update } = renderLia({ enabled: true });
    expect(screen.queryByTestId('lia-stage')).toBeNull();
    update({ landing: false, submission: send() });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByTestId('lia-stage')).toBeNull();
  });

  it('shows Lia when the user opted in and the deployment allows it', async () => {
    renderLia({ enabled: true });
    expect(await screen.findByTestId('lia-stage')).toBeInTheDocument();
  });

  it('respects a deployment that turns the mascot off', () => {
    renderLia({ enabled: true, mascot: false });
    expect(screen.queryByTestId('lia-stage')).toBeNull();
  });

  it('waits for the deployment config before showing anything', () => {
    renderLia({ enabled: true, mascot: null });
    expect(screen.queryByTestId('lia-stage')).toBeNull();
  });

  it('stays to wave off the first message, then leaves', async () => {
    jest.useFakeTimers();
    const { update } = renderLia({ enabled: true });
    expect(await screen.findByTestId('lia-stage')).toBeInTheDocument();
    update({ landing: false, submission: send() });
    expect(screen.getByTestId('lia-stage')).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(FAREWELL_MS);
    });
    expect(screen.queryByTestId('lia-stage')).toBeNull();
    jest.useRealTimers();
  });

  it('leaves at once when the user navigates away instead of sending', async () => {
    const { update } = renderLia({ enabled: true });
    expect(await screen.findByTestId('lia-stage')).toBeInTheDocument();
    update({ landing: false, submission: null });
    expect(screen.queryByTestId('lia-stage')).toBeNull();
  });

  it('does not take a send from an earlier conversation for a new one', async () => {
    const stale = send();
    const { update } = renderLia({ enabled: true, submission: stale });
    expect(await screen.findByTestId('lia-stage')).toBeInTheDocument();
    update({ landing: false, submission: stale });
    expect(screen.queryByTestId('lia-stage')).toBeNull();
  });

  it('stays away from conversations', () => {
    renderLia({ enabled: true, landing: false });
    expect(screen.queryByTestId('lia-stage')).toBeNull();
  });

  it('persists the opt-in in local storage', () => {
    const store = createStore();
    store.set(showLiaAtom, true);
    expect(JSON.parse(localStorage.getItem('showLia') ?? 'null')).toBe(true);
  });
});
