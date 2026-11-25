import { render, waitFor } from '@testing-library/react';
import { clickDropdown, flushDropdownEffects } from 'test/dropdown';
import WeekStartSelector from './WeekStartSelector';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('WeekStartSelector', () => {
  beforeEach(() => {
    localStorage.clear();
    global.ResizeObserver = class MockedResizeObserver {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
    } as unknown as typeof ResizeObserver;
  });

  it('renders with System selected by default', async () => {
    const { getByText, getByTestId } = render(<WeekStartSelector />);

    expect(getByText('com_nav_week_start')).toBeInTheDocument();
    expect(getByTestId('week-start-selector')).toHaveTextContent('com_nav_week_start_system');

    await flushDropdownEffects();
  });

  it('persists the selected preference to the weekStart atom', async () => {
    const { getByTestId, getByText } = render(<WeekStartSelector />);

    await clickDropdown(getByTestId('week-start-selector'));
    await clickDropdown(getByText('com_nav_week_start_monday'));

    await waitFor(() => {
      expect(getByTestId('week-start-selector')).toHaveTextContent('com_nav_week_start_monday');
    });
    expect(JSON.parse(localStorage.getItem('weekStart') ?? '""')).toBe('monday');
  });
});
