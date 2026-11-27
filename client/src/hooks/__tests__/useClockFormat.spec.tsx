import { Provider, useAtom, createStore } from 'jotai';
import { render, screen, act } from '@testing-library/react';
import { clockFormatAtom } from '~/store/clockFormat';
import useClockFormat from '../useClockFormat';

// `mock`-prefixed so jest's hoisted factory below may reference it.
const mockSystemLocale = jest.fn();
jest.mock('~/utils/clock', () => ({
  ...jest.requireActual('~/utils/clock'),
  systemLocale: () => mockSystemLocale(),
}));

function Probe() {
  const hour12 = useClockFormat();
  const [, setPreference] = useAtom(clockFormatAtom);
  return (
    <>
      <output data-testid="hour12">{String(hour12)}</output>
      <button onClick={() => setPreference('24h')}>{'force 24h'}</button>
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

describe('useClockFormat', () => {
  afterEach(() => {
    mockSystemLocale.mockReset();
    localStorage.clear();
  });

  it('reacts to the clockFormat atom changing', async () => {
    mockSystemLocale.mockReturnValue('en-US');
    renderProbe();
    // en-US defaults to a meridiem clock under the 'system' preference
    expect(screen.getByTestId('hour12')).toHaveTextContent('true');

    await act(async () => {
      screen.getByRole('button').click();
    });
    expect(screen.getByTestId('hour12')).toHaveTextContent('false');
  });

  it('reads the regional runtime locale, not the normalized translation locale', () => {
    // `i18n.language` would be 'en' here (en-GB has no bundle of its own) and would
    // report a 12-hour clock, which is exactly what this must not do.
    mockSystemLocale.mockReturnValue('en-GB');
    renderProbe();
    expect(screen.getByTestId('hour12')).toHaveTextContent('false');
  });
});
