import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import {
  Login,
  VerifyEmail,
  Registration,
  ResetPassword,
  ApiErrorWatcher,
  TwoFactorScreen,
  TwoFactorSetupScreen,
  RequestPasswordReset,
} from '~/components/Auth';
import { OAuthSuccess, OAuthError } from '~/components/OAuth';
import { AuthContextProvider } from '~/hooks/AuthContext';
import { importWithRecovery } from '~/lib/assets/lazy';
import RouteErrorBoundary from './RouteErrorBoundary';
import StartupLayout from './Layouts/Startup';
import MarketplaceRoute from './Marketplace';
import LoginLayout from './Layouts/Login';
import dashboardRoutes from './Dashboard';
import WithRum from '~/lib/rum/WithRum';
import ShareRoute from './ShareRoute';
import ChatRoute from './ChatRoute';
import Search from './Search';
import Root from './Root';

const AuthLayout = () => (
  <AuthContextProvider>
    <WithRum>
      <Outlet />
    </WithRum>
    <ApiErrorWatcher />
  </AuthContextProvider>
);

const loadInlinePromptsView = () =>
  importWithRecovery(() => import('~/components/Prompts/layouts/InlinePromptsView')).then((m) => ({
    Component: m.default,
  }));

const loadSkillsView = () =>
  importWithRecovery(() => import('~/components/Skills/layouts/SkillsView')).then((m) => ({
    Component: m.default,
  }));

const loadInsightsView = () =>
  importWithRecovery(() => import('~/components/Insights')).then((m) => ({
    Component: m.default,
  }));

const loadProjectsView = () =>
  importWithRecovery(() => import('~/components/Projects')).then((m) => ({
    Component: m.ProjectsView,
  }));

const loadProjectWorkspace = () =>
  importWithRecovery(() => import('~/components/Projects')).then((m) => ({
    Component: m.ProjectWorkspace,
  }));

const baseEl = document.querySelector('base');
const baseHref = baseEl?.getAttribute('href') || '/';

export const router = createBrowserRouter(
  [
    {
      path: 'share/:shareId',
      element: <ShareRoute />,
      errorElement: <RouteErrorBoundary />,
    },
    {
      path: 'oauth',
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          path: 'success',
          element: <OAuthSuccess />,
        },
        {
          path: 'error',
          element: <OAuthError />,
        },
      ],
    },
    {
      path: '/',
      element: <StartupLayout />,
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          path: 'register',
          element: <Registration />,
        },
        {
          path: 'forgot-password',
          element: <RequestPasswordReset />,
        },
        {
          path: 'reset-password',
          element: <ResetPassword />,
        },
      ],
    },
    {
      path: 'verify',
      element: <VerifyEmail />,
      errorElement: <RouteErrorBoundary />,
    },
    {
      element: <AuthLayout />,
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          errorElement: <RouteErrorBoundary />,
          children: [
            {
              path: '/',
              element: <LoginLayout />,
              children: [
                {
                  path: 'login',
                  element: <Login />,
                },
                {
                  path: 'login/2fa',
                  element: <TwoFactorScreen />,
                },
                {
                  path: 'login/2fa/setup',
                  element: <TwoFactorSetupScreen />,
                },
              ],
            },
            dashboardRoutes,
            {
              path: '/',
              element: <Root />,
              children: [
                {
                  index: true,
                  element: <Navigate to="/c/new" replace={true} />,
                },
                {
                  path: 'c/:conversationId?',
                  element: <ChatRoute />,
                },
                {
                  path: 'search',
                  element: <Search />,
                },
                {
                  path: 'prompts',
                  element: <Navigate to="/c/new" replace={true} />,
                },
                {
                  /** Prompts are created from a dialog, so there is no "new" page to land on */
                  path: 'prompts/new',
                  element: <Navigate to="/c/new" replace={true} />,
                },
                {
                  path: 'prompts/:promptId',
                  lazy: loadInlinePromptsView,
                },
                {
                  path: 'skills',
                  lazy: loadSkillsView,
                },
                {
                  path: 'insights',
                  lazy: loadInsightsView,
                },
                {
                  path: 'skills/new',
                  lazy: loadSkillsView,
                },
                {
                  path: 'skills/:skillId',
                  lazy: loadSkillsView,
                },
                {
                  path: 'skills/:skillId/edit',
                  lazy: loadSkillsView,
                },
                {
                  path: 'projects',
                  lazy: loadProjectsView,
                },
                {
                  path: 'projects/:projectId',
                  lazy: loadProjectWorkspace,
                },
                {
                  path: 'agents',
                  element: <MarketplaceRoute />,
                },
                {
                  path: 'agents/:category',
                  element: <MarketplaceRoute />,
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  { basename: baseHref },
);
