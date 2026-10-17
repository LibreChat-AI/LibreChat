import { Provider } from 'jotai';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import AnalyticsConsentToggle from '../AnalyticsConsent';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const renderToggle = () =>
  render(
    <Provider>
      <AnalyticsConsentToggle />
    </Provider>,
  );

describe('AnalyticsConsentToggle', () => {
  beforeEach(() => localStorage.clear());

  it('reads as off until the viewer has granted consent', () => {
    renderToggle();
    const toggle = screen.getByRole('switch', { name: 'com_ui_analytics_consent_setting' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAccessibleDescription('com_ui_analytics_consent_setting_description');
  });

  it('grants and then withdraws consent', () => {
    renderToggle();
    const toggle = screen.getByRole('switch', { name: 'com_ui_analytics_consent_setting' });

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem('analyticsConsent')).toBe(JSON.stringify('granted'));

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(localStorage.getItem('analyticsConsent')).toBe(JSON.stringify('denied'));
  });

  it('reflects a consent given through the banner', () => {
    localStorage.setItem('analyticsConsent', JSON.stringify('granted'));
    renderToggle();
    expect(
      screen.getByRole('switch', { name: 'com_ui_analytics_consent_setting' }),
    ).toHaveAttribute('aria-checked', 'true');
  });
});
