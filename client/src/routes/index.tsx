import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import {
  Login,
  VerifyEmail,
  Registration,
  ResetPassword,
  TwoFactorScreen,
  TwoFactorSetupScreen,
  RequestPasswordReset,
} from '~/components/Auth';
import ParametersPage from '~/components/FeaturePresentation/ParametersPage';
import ChatRouteOwner from '~/components/FeaturePresentation/Route';
import FeaturePage from '~/components/FeaturePresentation/Page';
import { OAuthSuccess, OAuthError } from '~/components/OAuth';
import { AuthContextProvider } from '~/hooks/AuthContext';
import { importWithRecovery } from '~/lib/assets/lazy';
import RouteErrorBoundary from './RouteErrorBoundary';
import ChannelLinkRoute from './ChannelLinkRoute';
import StartupLayout from './Layouts/Startup';
import { codeSetupRoute } from './CodeSetup';
import LoginLayout from './Layouts/Login';
import dashboardRoutes from './Dashboard';
import WithRum from '~/lib/rum/WithRum';
import ShareEntry from './ShareEntry';
import ChatRoute from './ChatRoute';
import Root from './Root';

const AuthLayout = () => (
  <AuthContextProvider>
    <WithRum>
      <Outlet />
    </WithRum>
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

/** These render messages (search results and reviewed conversations) or the agent marketplace,
 *  none of which a fresh chat shows, so they load when first visited; `ShareEntry` does the
 *  same for shared links. */
const loadResponseReview = () =>
  importWithRecovery(() => import('./ResponseReviewRoute')).then((m) => ({
    Component: m.default,
  }));

const loadSearch = () =>
  importWithRecovery(() => import('./Search')).then((m) => ({ Component: m.default }));

const loadMarketplace = () =>
  importWithRecovery(() => import('./Marketplace')).then((m) => ({ Component: m.default }));

const baseEl = document.querySelector('base');
const baseHref = baseEl?.getAttribute('href') || '/';

export const router = createBrowserRouter(
  [
    {
      path: 'responses/:responseId/review',
      lazy: loadResponseReview,
      errorElement: <RouteErrorBoundary />,
    },
    {
      path: 'channels/link',
      element: <ChannelLinkRoute />,
      errorElement: <RouteErrorBoundary />,
    },
    {
      path: 'share/:shareId',
      element: <ShareEntry />,
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
            codeSetupRoute,
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
                  element: (
                    <ChatRouteOwner>
                      <ChatRoute />
                    </ChatRouteOwner>
                  ),
                },
                {
                  path: 'agent-builder',
                  element: <FeaturePage page="agentBuilder" />,
                },
                {
                  path: 'schedules',
                  element: <FeaturePage page="schedules" />,
                },
                {
                  path: 'memories',
                  element: <FeaturePage page="memories" />,
                },
                {
                  path: 'bookmarks',
                  element: <FeaturePage page="bookmarks" />,
                },
                {
                  path: 'parameters',
                  element: <ParametersPage />,
                },
                {
                  path: 'mcp-settings',
                  element: <FeaturePage page="mcpSettings" />,
                },
                {
                  path: 'search',
                  lazy: loadSearch,
                },
                {
                  path: 'prompts',
                  element: <FeaturePage page="prompts" />,
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
                  element: <FeaturePage page="skills" />,
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
                  lazy: loadMarketplace,
                },
                {
                  path: 'agents/:category',
                  lazy: loadMarketplace,
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
