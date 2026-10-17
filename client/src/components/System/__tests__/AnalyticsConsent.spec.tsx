import { Provider } from 'jotai';
import TagManager from 'react-gtm-module';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import AnalyticsConsent from '../AnalyticsConsent';

jest.mock('react-gtm-module', () => ({
  __esModule: true,
  default: { initialize: jest.fn() },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const initialize = TagManager.initialize as jest.Mock;

const renderConsent = (gtmId?: string | null) =>
  render(
    <Provider>
      <AnalyticsConsent gtmId={gtmId} />
    </Provider>,
  );

const appendContainerScript = (gtmId: string) => {
  const script = document.createElement('script');
  script.src = `https://www.googletagmanager.com/gtm.js?id=${gtmId}`;
  document.head.appendChild(script);
  return script;
};

const getBanner = () => screen.queryByRole('region', { name: 'com_ui_analytics_consent_label' });

describe('AnalyticsConsent', () => {
  beforeEach(() => {
    localStorage.clear();
    initialize.mockClear();
    delete window.google_tag_manager;
    delete window.dataLayer;
  });

  it('renders nothing and never loads GTM when no container is configured', () => {
    localStorage.setItem('analyticsConsent', JSON.stringify('granted'));
    renderConsent(undefined);
    expect(getBanner()).not.toBeInTheDocument();
    expect(initialize).not.toHaveBeenCalled();
  });

  it('asks for consent without loading GTM or taking focus', () => {
    renderConsent('GTM-TEST');
    const banner = getBanner();
    expect(banner).toBeInTheDocument();
    expect(banner).not.toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole('button', { name: 'com_ui_analytics_consent_accept' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'com_ui_analytics_consent_decline' })).toBeVisible();
    expect(initialize).not.toHaveBeenCalled();
  });

  it('loads GTM after Accept and hides the banner', () => {
    renderConsent('GTM-TEST');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_analytics_consent_accept' }));
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledWith({ gtmId: 'GTM-TEST' });
    expect(getBanner()).not.toBeInTheDocument();
    expect(localStorage.getItem('analyticsConsent')).toBe(JSON.stringify('granted'));
    /** Consent defaults reach the data layer before the container loads, advertising denied. */
    expect(Array.from(window.dataLayer?.[0] as ArrayLike<unknown>)).toEqual([
      'consent',
      'default',
      {
        analytics_storage: 'granted',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      },
    ]);
  });

  it('keeps GTM unloaded after Decline and hides the banner', () => {
    renderConsent('GTM-TEST');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_analytics_consent_decline' }));
    expect(initialize).not.toHaveBeenCalled();
    expect(getBanner()).not.toBeInTheDocument();
    expect(localStorage.getItem('analyticsConsent')).toBe(JSON.stringify('denied'));
  });

  it('loads GTM on mount for a viewer who already consented, without asking again', () => {
    localStorage.setItem('analyticsConsent', JSON.stringify('granted'));
    renderConsent('GTM-TEST');
    expect(getBanner()).not.toBeInTheDocument();
    expect(initialize).toHaveBeenCalledWith({ gtmId: 'GTM-TEST' });
  });

  it('does not ask again or load GTM for a viewer who declined', () => {
    localStorage.setItem('analyticsConsent', JSON.stringify('denied'));
    renderConsent('GTM-TEST');
    expect(getBanner()).not.toBeInTheDocument();
    expect(initialize).not.toHaveBeenCalled();
  });

  it('does not load the configured container twice', () => {
    localStorage.setItem('analyticsConsent', JSON.stringify('granted'));
    window.google_tag_manager = { 'GTM-TEST': {} };
    renderConsent('GTM-TEST');
    expect(initialize).not.toHaveBeenCalled();
  });

  it('still loads the configured container when a different one is on the page', () => {
    localStorage.setItem('analyticsConsent', JSON.stringify('granted'));
    window.google_tag_manager = { 'GTM-OTHER': {} };
    renderConsent('GTM-TEST');
    expect(initialize).toHaveBeenCalledWith({ gtmId: 'GTM-TEST' });
  });

  it('tells a loaded container that consent was withdrawn', () => {
    localStorage.setItem('analyticsConsent', JSON.stringify('denied'));
    window.dataLayer = [];
    window.google_tag_manager = { 'GTM-TEST': {} };
    renderConsent('GTM-TEST');
    expect(window.dataLayer).toHaveLength(1);
    expect(Array.from(window.dataLayer[0] as ArrayLike<unknown>)).toEqual([
      'consent',
      'update',
      expect.objectContaining({ analytics_storage: 'denied', ad_storage: 'denied' }),
    ]);
  });

  it('tells a container still on the page that consent was given again', () => {
    localStorage.setItem('analyticsConsent', JSON.stringify('granted'));
    window.dataLayer = [];
    window.google_tag_manager = { 'GTM-TEST': {} };
    renderConsent('GTM-TEST');
    expect(initialize).not.toHaveBeenCalled();
    expect(Array.from(window.dataLayer[0] as ArrayLike<unknown>)).toEqual([
      'consent',
      'update',
      expect.objectContaining({ analytics_storage: 'granted', ad_storage: 'denied' }),
    ]);
  });

  it('leaves the data layer alone when the configured container is not on the page', () => {
    localStorage.setItem('analyticsConsent', JSON.stringify('denied'));
    window.dataLayer = [];
    window.google_tag_manager = { 'GTM-OTHER': {} };
    renderConsent('GTM-TEST');
    renderConsent(undefined);
    expect(window.dataLayer).toHaveLength(0);
  });

  it('does not inject a second container while the first is still loading', () => {
    localStorage.setItem('analyticsConsent', JSON.stringify('granted'));
    const loading = appendContainerScript('GTM-TEST');
    renderConsent('GTM-TEST');
    expect(initialize).not.toHaveBeenCalled();
    loading.remove();
  });

  it('tells a still loading container that consent was withdrawn', () => {
    localStorage.setItem('analyticsConsent', JSON.stringify('denied'));
    window.dataLayer = [];
    const loading = appendContainerScript('GTM-TEST');
    renderConsent('GTM-TEST');
    expect(window.dataLayer).toHaveLength(1);
    loading.remove();
  });

  it('retries a container whose script failed to load', () => {
    localStorage.setItem('analyticsConsent', JSON.stringify('granted'));
    /** Stands in for the GTM snippet: queues the start event, then injects gtm.js. */
    const bootstrap = ({ gtmId }: { gtmId: string }) => {
      window.dataLayer?.push({ event: 'gtm.js' });
      appendContainerScript(gtmId);
    };
    initialize.mockImplementationOnce(bootstrap).mockImplementationOnce(bootstrap);
    const first = renderConsent('GTM-TEST');
    const failed = document.querySelector('script[src*="gtm.js"]');
    expect(failed).not.toBeNull();
    failed?.dispatchEvent(new Event('error'));
    expect(document.querySelector('script[src*="gtm.js"]')).toBeNull();
    first.unmount();
    renderConsent('GTM-TEST');
    expect(initialize).toHaveBeenCalledTimes(2);
    /** Only the retry's start event is left for the container to replay. */
    const startEvents = (window.dataLayer ?? []).filter(
      (entry) => (entry as { event?: unknown } | null)?.event === 'gtm.js',
    );
    expect(startEvents).toHaveLength(1);
    document.querySelector('script[src*="gtm.js"]')?.remove();
  });
});
