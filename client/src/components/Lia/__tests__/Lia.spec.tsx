import React, { createRef } from 'react';
import { createStore, Provider } from 'jotai';
import { act, render, screen } from '@testing-library/react';
import Lia, { FAREWELL_MS } from '../index';
import { showLiaAtom } from '~/store/lia';

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
  sending?: boolean;
}

function renderLia({ enabled, mascot, landing = true, sending = false }: Options) {
  const store = createStore();
  store.set(showLiaAtom, enabled);
  mockUseGetStartupConfig.mockReturnValue({
    data: mascot === null ? undefined : { interface: mascot === undefined ? {} : { mascot } },
  });
  const bandRef = createRef<HTMLElement>();
  const view = (props: { landing: boolean; sending: boolean }) => (
    <Provider store={store}>
      <Lia bandRef={bandRef} {...props} />
    </Provider>
  );
  const result = render(view({ landing, sending }));
  return {
    ...result,
    update: (props: { landing: boolean; sending: boolean }) => result.rerender(view(props)),
  };
}

describe('Lia', () => {
  beforeEach(() => localStorage.clear());

  it('shows nothing until the user opts in', () => {
    renderLia({ enabled: false });
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
    update({ landing: false, sending: true });
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
    update({ landing: false, sending: false });
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
