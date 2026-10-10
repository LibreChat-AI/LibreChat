import { I18nextProvider } from 'react-i18next';
import type { TStartupConfig } from 'librechat-data-provider';
import * as endpointQueries from '~/data-provider/Endpoints/queries';
import * as miscDataProvider from '~/data-provider/Misc/queries';
import { render, screen } from 'test/layout-test-utils';
import AuthLayout from '~/components/Auth/AuthLayout';
import i18n from '~/locales/i18n';

/**
 * The auth layout decides where the consent is stated, and a screen that states
 * it does not also carry the footer bar linking the same two policies. Both
 * ways in state it: which of them can create an account is not knowable here
 * (a provider sign-in and an LDAP sign-in both create one, and
 * ALLOW_SOCIAL_REGISTRATION is server-side), and the sentence is about
 * continuing, which both screens do.
 *
 * `test/setupTests.js` stubs `initReactI18next`, so nothing binds the app's
 * i18next instance to react-i18next the way `locales/i18n` does at runtime;
 * `Trans` reads it from the provider below instead.
 */

const PRIVACY_URL = 'https://example.com/privacy';
const TERMS_URL = 'https://example.com/terms';

const policies = {
  privacyPolicy: { externalUrl: PRIVACY_URL },
  termsOfService: { externalUrl: TERMS_URL },
};

type Options = {
  pathname?: string;
  isFetching?: boolean;
  startupConfigError?: unknown;
  socialLoginEnabled?: boolean;
  /** What `socialLogins` lists, and whether the listed provider's own flag is
   *  set: a button needs both, not just the global switch. */
  providers?: string[];
  googleLoginEnabled?: boolean;
  /** Partial on purpose: a fixture sets the policies under test, and the field
   *  names are still checked against the real interface config. */
  interfaceConfig?: Partial<NonNullable<TStartupConfig['interface']>>;
};

function setup({
  pathname = 'register',
  isFetching = false,
  startupConfigError = null,
  socialLoginEnabled = false,
  providers,
  googleLoginEnabled,
  interfaceConfig,
}: Options) {
  const startupConfig = {
    appTitle: 'LibreChat',
    socialLoginEnabled,
    socialLogins: providers ?? (socialLoginEnabled ? ['google'] : []),
    googleLoginEnabled: googleLoginEnabled ?? socialLoginEnabled,
    serverDomain: 'mock-server',
    interface: interfaceConfig,
  } as unknown as TStartupConfig;

  jest
    .spyOn(endpointQueries, 'useGetStartupConfig')
    //@ts-ignore - the layout reads only the resolved data
    .mockReturnValue({ data: startupConfig, isFetching: false, isError: false });
  jest
    .spyOn(miscDataProvider, 'useGetBannerQuery')
    //@ts-ignore - the banner is not under test
    .mockReturnValue({ data: null, isLoading: false, isError: false });

  return render(
    <I18nextProvider i18n={i18n}>
      <AuthLayout
        startupConfig={startupConfig}
        isFetching={isFetching}
        error={null}
        startupConfigError={startupConfigError}
        header={'Create your account'}
        pathname={pathname}
      >
        <form aria-label="Registration form" />
      </AuthLayout>
    </I18nextProvider>,
  );
}

const consent = () => screen.queryByText(/By continuing/i);
const footerBar = () => document.querySelector('[role="contentinfo"]');

describe('AuthLayout legal placement', () => {
  /** The registration form states the consent itself, under its own submit
   *  button (Registration.spec covers that); the layout's part is dropping the
   *  footer bar so the same two policies are not linked twice. */
  test('registration drops the footer bar the consent replaces', () => {
    setup({ pathname: 'register', interfaceConfig: policies });

    expect(footerBar()).toBeNull();
    expect(consent()).not.toBeInTheDocument();
  });

  test('the login screen states it too', () => {
    setup({ pathname: 'login', socialLoginEnabled: true, interfaceConfig: policies });

    expect(consent()).toBeInTheDocument();
    expect(document.querySelectorAll(`a[href="${PRIVACY_URL}"]`)).toHaveLength(1);
    expect(document.querySelectorAll(`a[href="${TERMS_URL}"]`)).toHaveLength(1);
    expect(footerBar()).toBeNull();
  });

  /** No provider button is needed for the screen to be a way in: a first LDAP
   *  sign-in creates the account through this very form. */
  test('a login screen with no provider button states it as well', () => {
    setup({ pathname: 'login', socialLoginEnabled: false, interfaceConfig: policies });

    expect(consent()).toBeInTheDocument();
    expect(footerBar()).toBeNull();
  });

  /** The second factor is not a way in of its own; the screen that sent the
   *  reader here already stated the consent. */
  test('the second factor states nothing', () => {
    setup({ pathname: 'login/2fa', socialLoginEnabled: true, interfaceConfig: policies });

    expect(consent()).not.toBeInTheDocument();
    expect(footerBar()).not.toBeNull();
  });

  /** The consent and the footer bar read policy urls the same way, so a blank
   *  one is not a policy on one screen and a link to nowhere on the other. */
  test('a blank policy url leaves neither a consent nor a link in the footer bar', () => {
    setup({ pathname: 'login', interfaceConfig: { privacyPolicy: { externalUrl: '  ' } } });

    expect(consent()).not.toBeInTheDocument();
    expect(footerBar()).not.toBeNull();
    expect(document.querySelector('[role="contentinfo"] a')).toBeNull();
  });

  /** Registration renders its form, and with it the consent, only once the
   *  config has loaded without error. The footer bar carries the policies
   *  until then, so the screen is never left with neither. */
  test('registration refetching its config keeps the footer bar', () => {
    setup({ pathname: 'register', isFetching: true, interfaceConfig: policies });

    expect(consent()).not.toBeInTheDocument();
    expect(footerBar()).not.toBeNull();
  });

  test('registration whose config failed keeps the footer bar', () => {
    setup({
      pathname: 'register',
      startupConfigError: new Error('config unavailable'),
      interfaceConfig: policies,
    });

    expect(consent()).not.toBeInTheDocument();
    expect(footerBar()).not.toBeNull();
  });

  /** The login screen states it itself, so a background refetch of an already
   *  known config must not swap the sentence for the bar and back. */
  test('the login screen keeps the consent across a background refetch', () => {
    setup({ pathname: 'login', isFetching: true, interfaceConfig: policies });

    expect(consent()).toBeInTheDocument();
    expect(footerBar()).toBeNull();
  });

  /** A deployment that asks for explicit acceptance in a modal after sign-in
   *  must not be told it already agreed by continuing. */
  test('a modal-acceptance deployment keeps the bare links instead', () => {
    setup({
      pathname: 'register',
      interfaceConfig: {
        privacyPolicy: { externalUrl: PRIVACY_URL },
        termsOfService: { externalUrl: TERMS_URL, modalAcceptance: true },
      },
    });

    expect(consent()).not.toBeInTheDocument();
    expect(footerBar()).not.toBeNull();
    expect(document.querySelectorAll(`a[href="${TERMS_URL}"]`)).toHaveLength(1);
  });

  test('a deployment with no policies keeps the footer bar it always had', () => {
    setup({ pathname: 'register', interfaceConfig: undefined });

    expect(consent()).not.toBeInTheDocument();
    expect(footerBar()).not.toBeNull();
  });
});
