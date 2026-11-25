import { render, waitFor } from '@testing-library/react';
import { clickDropdown, flushDropdownEffects } from 'test/dropdown';
import ClockFormatSelector from './ClockFormatSelector';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('ClockFormatSelector', () => {
  beforeEach(() => {
    localStorage.clear();
    global.ResizeObserver = class MockedResizeObserver {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
    } as unknown as typeof ResizeObserver;
  });

  it('renders with System selected by default', async () => {
    const { getByText, getByTestId } = render(<ClockFormatSelector />);

    expect(getByText('com_nav_clock_format')).toBeInTheDocument();
    expect(getByTestId('clock-format-selector')).toHaveTextContent('com_nav_clock_format_system');

    await flushDropdownEffects();
  });

  it('persists the selected preference to the clockFormat atom', async () => {
    const { getByTestId, getByText } = render(<ClockFormatSelector />);

    await clickDropdown(getByTestId('clock-format-selector'));
    await clickDropdown(getByText('com_nav_clock_format_24h'));

    await waitFor(() => {
      expect(getByTestId('clock-format-selector')).toHaveTextContent('com_nav_clock_format_24h');
    });
    expect(JSON.parse(localStorage.getItem('clockFormat') ?? '""')).toBe('24h');
  });
});
