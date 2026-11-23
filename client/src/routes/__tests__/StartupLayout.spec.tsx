/* eslint-disable i18next/no-literal-string */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useOutletContext } from 'react-router-dom';
import { clearTwoFactorSetupToken, persistTwoFactorSetupToken } from 'librechat-data-provider';
import type { TStartupConfig } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';
import StartupLayout from '~/routes/Layouts/Startup';
import { SESSION_KEY } from '~/utils';

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(() => ({
    data: null,
    isFetching: false,
    error: null,
  })),
}));

jest.mock('~/hooks', () => ({
  useLocalize: jest.fn(() => (key: string) => key),
  TranslationKeys: {},
}));

jest.mock('~/components/Auth/AuthLayout', () => {
  return function MockAuthLayout({ children }: { children: React.ReactNode }) {
    return <div data-testid="auth-layout">{children}</div>;
  };
});

function ChildRoute() {
  return <div data-testid="child-route">Child</div>;
}

function NewConversation() {
  return <div data-testid="new-conversation">New Conversation</div>;
}

/** Reproduces the real sequence: the layout mounts unauthenticated, then authentication lands. */
function AuthFlipRoute() {
  const [isAuthenticated, setIsAuthenticated] = React.useState(false);

  return (
    <div>
      <button data-testid="authenticate" onClick={() => setIsAuthenticated(true)}>
        authenticate
      </button>
      <StartupLayout isAuthenticated={isAuthenticated} />
    </div>
  );
}

const createTestRouter = (initialEntry: string, isAuthenticated: boolean) =>
  createMemoryRouter(
    [
      {
        path: '/login',
        element: <StartupLayout isAuthenticated={isAuthenticated} />,
        children: [{ index: true, element: <ChildRoute /> }],
      },
      {
        path: '/c/new',
        element: <NewConversation />,
      },
      {
        path: '/c/:conversationId',
        element: <div data-testid="requested-conversation" />,
      },
    ],
    { initialEntries: [initialEntry] },
  );

describe('StartupLayout — redirect race condition', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
    jest.restoreAllMocks();
  });

  it('navigates to /c/new when authenticated with no pending redirect', async () => {
    window.history.replaceState({}, '', '/login');

    const router = createTestRouter('/login', true);
    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/c/new');
    });
  });

  it('navigates to the URL redirect when authentication completes', async () => {
    window.history.replaceState({}, '', '/login?redirect_to=%2Fc%2Fabc123');

    const router = createTestRouter('/login?redirect_to=%2Fc%2Fabc123', true);
    render(<RouterProvider router={router} />);

    await waitFor(() => expect(router.state.location.pathname).toBe('/c/abc123'));
  });

  it('navigates to the stored redirect when authentication completes', async () => {
    window.history.replaceState({}, '', '/login');
    sessionStorage.setItem(SESSION_KEY, '/c/abc123');

    const router = createTestRouter('/login', true);
    render(<RouterProvider router={router} />);

    await waitFor(() => expect(router.state.location.pathname).toBe('/c/abc123'));
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('leaves the pending redirect alone when authentication completes after mount', async () => {
    window.history.replaceState({}, '', '/login');
    sessionStorage.setItem(SESSION_KEY, '/c/abc123');

    const router = createMemoryRouter(
      [
        {
          path: '/login',
          element: <AuthFlipRoute />,
          children: [{ index: true, element: <ChildRoute /> }],
        },
        { path: '/c/new', element: <NewConversation /> },
        { path: '/c/:conversationId', element: <div data-testid="requested-conversation" /> },
      ],
      { initialEntries: ['/login'] },
    );
    render(<RouterProvider router={router} />);

    fireEvent.click(screen.getByTestId('authenticate'));
    await new Promise((resolve) => setTimeout(resolve, 100));

    /** The auth context owns this transition, so the stored destination must still be intact. */
    expect(router.state.location.pathname).toBe('/login');
    expect(sessionStorage.getItem(SESSION_KEY)).toBe('/c/abc123');
  });

  it('does NOT navigate when not authenticated', async () => {
    window.history.replaceState({}, '', '/login');

    const router = createTestRouter('/login', false);
    render(<RouterProvider router={router} />);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(router.state.location.pathname).toBe('/login');
  });
});

describe('StartupLayout: mandatory enrollment', () => {
  const createSetupRouter = (initialEntry: string) =>
    createMemoryRouter(
      [
        {
          path: '/login/2fa/setup',
          element: <StartupLayout isAuthenticated={true} />,
          children: [{ index: true, element: <ChildRoute /> }],
        },
        { path: '/c/new', element: <NewConversation /> },
        { path: '/c/:conversationId', element: <div data-testid="requested-conversation" /> },
      ],
      { initialEntries: [initialEntry] },
    );

  beforeEach(() => {
    sessionStorage.clear();
    clearTwoFactorSetupToken();
  });

  afterEach(() => {
    clearTwoFactorSetupToken();
    window.history.replaceState({}, '', '/');
    jest.restoreAllMocks();
  });

  /**
   * The in-document hand-off leaves the auth context authenticated, so without the exemption this
   * layout redirects the user straight back out of the setup the server is demanding.
   */
  it('stays on the setup route when an authenticated user holds a setup token', async () => {
    window.history.replaceState({}, '', '/login/2fa/setup');
    persistTwoFactorSetupToken('setup-token');

    const router = createSetupRouter('/login/2fa/setup');
    render(<RouterProvider router={router} />);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(router.state.location.pathname).toBe('/login/2fa/setup');
  });

  it('keeps the pending destination banked while enrollment is outstanding', async () => {
    window.history.replaceState({}, '', '/login/2fa/setup');
    sessionStorage.setItem(SESSION_KEY, '/c/abc123');
    persistTwoFactorSetupToken('setup-token');

    const router = createSetupRouter('/login/2fa/setup');
    render(<RouterProvider router={router} />);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(router.state.location.pathname).toBe('/login/2fa/setup');
    expect(sessionStorage.getItem(SESSION_KEY)).toBe('/c/abc123');
  });

  /** The exemption is the live credential, not the path, so a stale visit still moves on. */
  it('redirects an authenticated arrival that carries no setup token', async () => {
    window.history.replaceState({}, '', '/login/2fa/setup');

    const router = createSetupRouter('/login/2fa/setup');
    render(<RouterProvider router={router} />);

    await waitFor(() => expect(router.state.location.pathname).toBe('/c/new'));
  });
});

describe('StartupLayout: startup config in the outlet context', () => {
  type Context = { startupConfig: TStartupConfig | null; isFetching: boolean };
  type Result = { data: TStartupConfig | undefined; isFetching: boolean; error: null };

  const config = { appTitle: 'Configured' } as TStartupConfig;
  const query = jest.mocked(useGetStartupConfig);
  const original = query.getMockImplementation();
  let seen: Context[] = [];
  let result: Result = { data: undefined, isFetching: true, error: null };
  let authenticate: (value: boolean) => void = () => undefined;

  function Recorder() {
    const { startupConfig, isFetching } = useOutletContext<Context>();
    seen.push({ startupConfig, isFetching });
    return null;
  }

  /** The route element stays mounted while the query result and the session change under it. */
  function Driver() {
    const [state, setState] = React.useState({ isAuthenticated: false, renders: 0 });
    React.useEffect(() => {
      authenticate = (isAuthenticated) =>
        setState((prev) => ({ isAuthenticated, renders: prev.renders + 1 }));
    }, []);
    return <StartupLayout isAuthenticated={state.isAuthenticated} />;
  }

  const settle = (next: Result, isAuthenticated = false) =>
    act(() => {
      result = next;
      authenticate(isAuthenticated);
    });

  beforeEach(() => {
    seen = [];
    result = { data: undefined, isFetching: true, error: null };
    query.mockImplementation(() => result as ReturnType<typeof useGetStartupConfig>);
    render(
      <RouterProvider
        router={createMemoryRouter(
          [
            {
              path: '/register',
              element: <Driver />,
              children: [{ index: true, element: <Recorder /> }],
            },
          ],
          { initialEntries: ['/register'] },
        )}
      />,
    );
  });

  afterEach(() => {
    if (original) {
      query.mockImplementation(original);
    }
  });

  it('never hands the screens a settled fetch without the config it fetched', () => {
    settle({ data: config, isFetching: false, error: null });

    const settled = seen.filter((entry) => !entry.isFetching);
    expect(settled.length).toBeGreaterThan(0);
    expect(settled.every((entry) => entry.startupConfig === config)).toBe(true);
  });

  it('keeps the loaded config when authentication moves the query to a key with no data', () => {
    settle({ data: config, isFetching: false, error: null });

    seen = [];
    settle({ data: undefined, isFetching: false, error: null }, true);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.startupConfig === config)).toBe(true);
    expect(query).toHaveBeenLastCalledWith({ enabled: false });
  });
});
