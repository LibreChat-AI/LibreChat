import { Provider, useAtom, createStore } from 'jotai';
import { render, screen, act } from '@testing-library/react';
import { weekStartAtom } from '~/store/weekStart';
import useWeekStart from '../useWeekStart';

// `mock`-prefixed so jest's hoisted factory below may reference it.
const mockSystemLocale = jest.fn();
jest.mock('~/utils/clock', () => ({
  ...jest.requireActual('~/utils/clock'),
  systemLocale: () => mockSystemLocale(),
}));

function Probe() {
  const weekStartsOn = useWeekStart();
  const [, setPreference] = useAtom(weekStartAtom);
  return (
    <>
      <output data-testid="weekStartsOn">{String(weekStartsOn)}</output>
      <button onClick={() => setPreference('monday')}>{'force monday'}</button>
    </>
  );
}

/** A fresh Jotai store per render. The module-level default store (and the
 *  localStorage behind `atomWithStorage`) outlives a test, so a preference one test
 *  writes leaks into the next and the locale branch under test never runs. */
const renderProbe = () =>
  render(
    <Provider store={createStore()}>
      <Probe />
    </Provider>,
  );

describe('useWeekStart', () => {
  afterEach(() => {
    mockSystemLocale.mockReset();
    localStorage.clear();
  });

  it('reacts to the weekStart atom changing', async () => {
    mockSystemLocale.mockReturnValue('en-US');
    renderProbe();
    // en-US defaults to Sunday-first under the 'system' preference
    expect(screen.getByTestId('weekStartsOn')).toHaveTextContent('0');

    await act(async () => {
      screen.getByRole('button').click();
    });
    expect(screen.getByTestId('weekStartsOn')).toHaveTextContent('1');
  });

  it('reads the regional runtime locale, not the normalized translation locale', () => {
    // `i18n.language` would be 'en' here and would report Sunday-first; en-GB is not.
    mockSystemLocale.mockReturnValue('en-GB');
    renderProbe();
    expect(screen.getByTestId('weekStartsOn')).toHaveTextContent('1');
  });
});
