import * as reactRouter from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import userEvent from '@testing-library/user-event';
import * as mockDataProvider from 'librechat-data-provider/react-query';
import type { TStartupConfig } from 'librechat-data-provider';
import * as endpointQueries from '~/data-provider/Endpoints/queries';
import { render, waitFor, screen } from 'test/layout-test-utils';
import * as miscDataProvider from '~/data-provider/Misc/queries';
import * as authMutations from '~/data-provider/Auth/mutations';
import * as authQueries from '~/data-provider/Auth/queries';
import Registration from '~/components/Auth/Registration';
import AuthLayout from '~/components/Auth/AuthLayout';
import i18n from '~/locales/i18n';

jest.mock('librechat-data-provider/react-query');

const mockStartupConfig = {
  isFetching: false,
  isLoading: false,
  isError: false,
  data: {
    socialLogins: ['google', 'facebook', 'openid', 'github', 'discord', 'saml'],
    discordLoginEnabled: true,
    facebookLoginEnabled: true,
    githubLoginEnabled: true,
    googleLoginEnabled: true,
    openidLoginEnabled: true,
    openidLabel: 'Test OpenID',
    openidImageUrl: 'http://test-server.com',
    samlLoginEnabled: true,
    samlLabel: 'Test SAML',
    samlImageUrl: 'http://test-server.com',
    registrationEnabled: true,
    socialLoginEnabled: true,
    serverDomain: 'mock-server',
  },
};

const setup = ({
  useGetUserQueryReturnValue = {
    isLoading: false,
    isError: false,
    data: {},
  },
  useRegisterUserMutationReturnValue = {
    isLoading: false,
    isError: false,
    mutate: jest.fn(),
    data: {},
    isSuccess: false,
    error: null as Error | null,
  },
  useRefreshTokenMutationReturnValue = {
    isLoading: false,
    isError: false,
    mutate: jest.fn(),
    data: {
      token: 'mock-token',
      user: {},
    },
  },
  useGetBannerQueryReturnValue = {
    isLoading: false,
    isError: false,
    data: {},
  },
  useGetStartupConfigReturnValue = mockStartupConfig,
} = {}) => {
  const mockUseRegisterUserMutation = jest
    .spyOn(mockDataProvider, 'useRegisterUserMutation')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useRegisterUserMutationReturnValue);
  const mockUseGetUserQuery = jest
    .spyOn(authQueries, 'useGetUserQuery')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useGetUserQueryReturnValue);
  const mockUseGetStartupConfig = jest
    .spyOn(endpointQueries, 'useGetStartupConfig')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useGetStartupConfigReturnValue);
  const mockUseRefreshTokenMutation = jest
    .spyOn(authMutations, 'useRefreshTokenMutation')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useRefreshTokenMutationReturnValue);
  const mockUseOutletContext = jest.spyOn(reactRouter, 'useOutletContext').mockReturnValue({
    startupConfig: useGetStartupConfigReturnValue.data,
  });
  jest
    .spyOn(miscDataProvider, 'useGetBannerQuery')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useGetBannerQueryReturnValue);
  /* `test/setupTests.js` stubs `initReactI18next`, so nothing binds the app's
     i18next instance to react-i18next the way `locales/i18n` does at runtime.
     `Trans` reads it from this provider instead, and renders the sentence it
     renders in the app. */
  const renderResult = render(
    <I18nextProvider i18n={i18n}>
      <AuthLayout
        startupConfig={useGetStartupConfigReturnValue.data as TStartupConfig}
        isFetching={useGetStartupConfigReturnValue.isFetching}
        error={null}
        startupConfigError={null}
        header={'Create your account'}
        pathname="register"
      >
        <Registration />
      </AuthLayout>
    </I18nextProvider>,
  );

  return {
    ...renderResult,
    mockUseGetUserQuery,
    mockUseOutletContext,
    mockUseGetStartupConfig,
    mockUseRegisterUserMutation,
    mockUseRefreshTokenMutation,
  };
};

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  __esModule: true,
  useOutletContext: () => ({
    startupConfig: mockStartupConfig,
  }),
}));

test('renders registration form', () => {
  const { getByText, getByTestId, getByRole } = setup();
  expect(getByText(/Create your account/i)).toBeInTheDocument();
  expect(getByRole('textbox', { name: /Full name/i })).toHaveClass('h-auto');
  expect(getByRole('form', { name: /Registration form/i })).toBeVisible();
  expect(getByRole('textbox', { name: /Username/i })).toBeInTheDocument();
  expect(getByRole('textbox', { name: /Email/i })).toBeInTheDocument();
  expect(getByTestId('password')).toBeInTheDocument();
  expect(getByTestId('confirm_password')).toBeInTheDocument();
  expect(getByRole('button', { name: /Submit registration/i })).toBeInTheDocument();
  expect(getByRole('link', { name: 'Login' })).toBeInTheDocument();
  expect(getByRole('link', { name: 'Login' })).toHaveAttribute('href', '/login');
  expect(getByRole('link', { name: /Continue with Google/i })).toBeInTheDocument();
  expect(getByRole('link', { name: /Continue with Google/i })).toHaveAttribute(
    'href',
    'mock-server/oauth/google',
  );
  expect(getByRole('link', { name: /Continue with Facebook/i })).toBeInTheDocument();
  expect(getByRole('link', { name: /Continue with Facebook/i })).toHaveAttribute(
    'href',
    'mock-server/oauth/facebook',
  );
  expect(getByRole('link', { name: /Continue with Github/i })).toBeInTheDocument();
  expect(getByRole('link', { name: /Continue with Github/i })).toHaveAttribute(
    'href',
    'mock-server/oauth/github',
  );
  expect(getByRole('link', { name: /Continue with Discord/i })).toBeInTheDocument();
  expect(getByRole('link', { name: /Continue with Discord/i })).toHaveAttribute(
    'href',
    'mock-server/oauth/discord',
  );
  expect(getByRole('link', { name: /Test SAML/i })).toBeInTheDocument();
  expect(getByRole('link', { name: /Test SAML/i })).toHaveAttribute(
    'href',
    'mock-server/oauth/saml',
  );
});

// test('calls registerUser.mutate on registration', async () => {
//   const mutate = jest.fn();
//   const { getByTestId, getByRole, history } = setup({
//     // @ts-ignore - we don't need all parameters of the QueryObserverResult
//     useLoginUserReturnValue: {
//       isLoading: false,
//       mutate: mutate,
//       isError: false,
//       isSuccess: true,
//     },
//   });

//   await userEvent.type(getByRole('textbox', { name: /Full name/i }), 'John Doe');
//   await userEvent.type(getByRole('textbox', { name: /Username/i }), 'johndoe');
//   await userEvent.type(getByRole('textbox', { name: /Email/i }), 'test@test.com');
//   await userEvent.type(getByTestId('password'), 'password');
//   await userEvent.type(getByTestId('confirm_password'), 'password');
//   await userEvent.click(getByRole('button', { name: /Submit registration/i }));

//   console.log(history);
//   waitFor(() => {
//     // expect(mutate).toHaveBeenCalled();
//     expect(history.location.pathname).toBe('/c/new');
//   });
// });

test('shows validation error messages', async () => {
  const { getByTestId, getAllByRole, getByRole } = setup();
  await userEvent.type(getByRole('textbox', { name: /Full name/i }), 'J');
  await userEvent.type(getByRole('textbox', { name: /Username/i }), 'j');
  await userEvent.type(getByRole('textbox', { name: /Email/i }), 'test');
  await userEvent.type(getByTestId('password'), 'pass');
  await userEvent.type(getByTestId('confirm_password'), 'password1');
  const alerts = getAllByRole('alert');
  expect(alerts).toHaveLength(6);

  // This first alert is for the theme toggle, which is empty within this test but still picked up by getAllByRole as an alert
  expect(alerts[0]).toHaveTextContent('');

  expect(alerts[1]).toHaveTextContent(/Name must be at least 3 characters/i);
  expect(alerts[2]).toHaveTextContent(/Username must be at least 2 characters/i);
  expect(alerts[3]).toHaveTextContent(/You must enter a valid email address/i);
  expect(alerts[4]).toHaveTextContent(/Password must be at least 8 characters/i);
  expect(alerts[5]).toHaveTextContent(/Passwords do not match/i);
});

test('shows error message when registration fails', async () => {
  const mutate = jest.fn();
  const { getByTestId, getByRole } = setup({
    useRegisterUserMutationReturnValue: {
      isLoading: false,
      isError: true,
      mutate,
      error: new Error('Registration failed'),
      data: {},
      isSuccess: false,
    },
  });

  await userEvent.type(getByRole('textbox', { name: /Full name/i }), 'John Doe');
  await userEvent.type(getByRole('textbox', { name: /Username/i }), 'johndoe');
  await userEvent.type(getByRole('textbox', { name: /Email/i }), 'test@test.com');
  await userEvent.type(getByTestId('password'), 'password');
  await userEvent.type(getByTestId('confirm_password'), 'password');
  await userEvent.click(getByRole('button', { name: /Submit registration/i }));

  waitFor(() => {
    expect(screen.getByTestId('registration-error')).toBeInTheDocument();
    expect(screen.getByTestId('registration-error')).toHaveTextContent(
      /There was an error attempting to register your account. Please try again. Registration failed/i,
    );
  });
});

const withInterface = (interfaceConfig: Partial<NonNullable<TStartupConfig['interface']>>) => ({
  ...mockStartupConfig,
  data: { ...mockStartupConfig.data, interface: interfaceConfig },
});

test('states the consent, with a link to each policy the deployment configured', () => {
  const { getByRole, getByText } = setup({
    useGetStartupConfigReturnValue: withInterface({
      privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      termsOfService: { externalUrl: 'https://example.com/terms' },
    }),
  });

  expect(getByText(/By continuing, you agree to the/i)).toBeInTheDocument();

  const terms = getByRole('link', { name: 'Terms of Service' });
  expect(terms).toHaveAttribute('href', 'https://example.com/terms');
  expect(terms).not.toHaveAttribute('target');

  const privacy = getByRole('link', { name: 'Privacy Policy' });
  expect(privacy).toHaveAttribute('href', 'https://example.com/privacy');
  expect(privacy).not.toHaveAttribute('target');
});

test('claims agreement only to the policy the deployment published', () => {
  const { getByRole, getByText, queryByRole } = setup({
    useGetStartupConfigReturnValue: withInterface({
      privacyPolicy: { externalUrl: 'https://example.com/privacy' },
    }),
  });

  expect(getByText(/By continuing, you acknowledge the/i)).toBeInTheDocument();
  expect(getByRole('link', { name: 'Privacy Policy' })).toBeInTheDocument();
  expect(queryByRole('link', { name: 'Terms of Service' })).not.toBeInTheDocument();
});

test('claims agreement to terms a deployment published without a privacy policy', () => {
  const { getByRole, getByText, queryByRole } = setup({
    useGetStartupConfigReturnValue: withInterface({
      termsOfService: { externalUrl: 'https://example.com/terms' },
    }),
  });

  expect(getByText(/By continuing, you agree to the/i)).toBeInTheDocument();
  expect(getByRole('link', { name: 'Terms of Service' })).toBeInTheDocument();
  expect(queryByRole('link', { name: 'Privacy Policy' })).not.toBeInTheDocument();
});

/** `externalUrl` is an optional string, so an operator can set it to nothing.
 *  A blank one would link back to this page and name a policy that does not
 *  exist, which is worse than saying nothing. */
test('treats a blank policy url as a policy the deployment never published', () => {
  const { getByText, queryByRole } = setup({
    useGetStartupConfigReturnValue: withInterface({
      privacyPolicy: { externalUrl: '  ' },
      termsOfService: { externalUrl: 'https://example.com/terms' },
    }),
  });

  expect(getByText(/By continuing, you agree to the/i)).toBeInTheDocument();
  expect(queryByRole('link', { name: 'Privacy Policy' })).not.toBeInTheDocument();
  expect(document.querySelector('a[href=""]')).toBeNull();
});

test('says nothing about policies a deployment never configured', () => {
  const { queryByText } = setup();

  expect(queryByText(/By continuing/i)).not.toBeInTheDocument();
});

/** A deployment that collects an explicit acceptance after sign-in is not one
 *  where continuing is the agreement, so the form states nothing. */
test('says nothing on a deployment that accepts its terms in a modal', () => {
  const { queryByText } = setup({
    useGetStartupConfigReturnValue: withInterface({
      privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      termsOfService: { externalUrl: 'https://example.com/terms', modalAcceptance: true },
    }),
  });

  expect(queryByText(/By continuing/i)).not.toBeInTheDocument();
});

test('says nothing when every configured policy url is blank', () => {
  const { queryByText } = setup({
    useGetStartupConfigReturnValue: withInterface({
      privacyPolicy: { externalUrl: '' },
      termsOfService: { externalUrl: '' },
    }),
  });

  expect(queryByText(/By continuing/i)).not.toBeInTheDocument();
});
