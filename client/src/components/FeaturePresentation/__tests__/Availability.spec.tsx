import React from 'react';
import { Provider } from 'jotai';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  dataService,
  PermissionTypes,
  Permissions,
  resolveNavigation,
} from 'librechat-data-provider';
import type { MCPServersListResponse } from 'librechat-data-provider';
import { useSideNavDestinations } from '~/hooks/Nav/useSideNavLinks';
import { resetCatalogWarmup } from '~/hooks/useCatalogWarmup';
import { FeaturePresentationProvider } from '../Context';
import FeaturePage from '../Page';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, getMCPServers: jest.fn() } };
});

let mockUse = true;
let mockCreate = false;
const consumer = jest.fn(() => <div>{'MCP content'}</div>);
const features = { mcpSettings: consumer };
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: ({
    permissionType,
    permission,
  }: {
    permissionType: PermissionTypes;
    permission: Permissions;
  }) => {
    const { PermissionTypes, Permissions } = jest.requireActual('librechat-data-provider');
    return (
      permissionType === PermissionTypes.MCP_SERVERS &&
      (permission === Permissions.USE ? mockUse : permission === Permissions.CREATE && mockCreate)
    );
  },
  useAgentCapabilities: () => ({ skillsEnabled: false }),
  useGetAgentsConfig: () => ({}),
  useMCPServerManager: (...args: object[]) =>
    jest.requireActual('~/hooks/MCP/useMCPServerManager').useMCPServerManager(...args),
  useCatalogReady: (...args: string[]) =>
    jest.requireActual('~/hooks/useCatalogWarmup').useCatalogReady(...args),
  activateCatalog: (...args: string[]) =>
    jest.requireActual('~/hooks/useCatalogWarmup').activateCatalog(...args),
  useMCPSelect: () => ({ mcpValues: [], setMCPValues: jest.fn() }),
  useMCPConnectionStatus: () => ({}),
}));
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider/MCP/queries'),
  useGetStartupConfig: () => ({}),
}));
jest.mock('librechat-data-provider/react-query', () => ({
  useGetAllEffectivePermissionsQuery: () => ({}),
  useCancelMCPOAuthMutation: () => ({}),
  useReinitializeMCPServerMutation: () => ({}),
  useUpdateUserPluginsMutation: () => ({}),
}));
jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
  MCPIcon: () => null,
  OpenAIMinimalIcon: () => null,
  Spinner: () => <span />,
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
jest.mock('~/hooks/Nav/useDrawerViewport', () => ({ __esModule: true, default: () => false }));
jest.mock('~/components/Chat/Menus/OpenSidebar', () => () => null);
jest.mock('~/components/SidePanel/MCPBuilder/MCPBuilderPanel', () => () => null);
jest.mock('~/components/SidePanel/Agents/AgentPanelSwitch', () => () => null);
jest.mock('~/components/SidePanel/Bookmarks/BookmarkPanel', () => () => null);
jest.mock('~/components/SidePanel/Builder/PanelSwitch', () => () => null);
jest.mock('~/components/SidePanel/Schedules', () => ({ SchedulePanel: () => null }));
jest.mock('~/components/SidePanel/Parameters/Panel', () => () => null);
jest.mock('~/components/SidePanel/Memories', () => ({ MemoryPanel: () => null }));
jest.mock('~/components/Prompts', () => ({ PromptsAccordion: () => null }));
jest.mock('~/components/Skills', () => ({ SkillsAccordion: () => null }));

function setup({ enabled = true, entry = '/mcp-settings' } = {}) {
  const navigation = resolveNavigation({ pages: { mcpSettings: { enabled } } });
  function Layout() {
    const { links, mcpAvailability } = useSideNavDestinations({
      keyProvided: true,
      interfaceConfig: {},
      endpointsConfig: {},
      requestMCP: enabled && entry === '/mcp-settings',
    });
    return (
      <FeaturePresentationProvider
        links={links}
        features={features}
        navigation={navigation}
        availability={
          enabled && entry === '/mcp-settings' ? { mcpSettings: mcpAvailability } : undefined
        }
        onPanelOpen={jest.fn()}
      >
        {entry === '/mcp-settings' && <FeaturePage page="mcpSettings" />}
      </FeaturePresentationProvider>
    );
  }
  const router = createMemoryRouter(
    [
      { path: '/mcp-settings', element: <Layout /> },
      { path: '/c/new', element: entry === '/c/new' ? <Layout /> : <div>{'Chat'}</div> },
    ],
    { initialEntries: [entry] },
  );
  render(
    <Provider>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>
    </Provider>,
  );
  return router;
}

beforeEach(() => {
  mockUse = true;
  mockCreate = false;
  consumer.mockClear();
  jest.mocked(dataService.getMCPServers).mockReset();
  resetCatalogWarmup();
});

it('waits for an explicitly requested USE-only catalog before mounting the MCP consumer', async () => {
  let resolve!: (servers: MCPServersListResponse) => void;
  const fetch = jest.mocked(dataService.getMCPServers).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const router = setup();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(router.state.location.pathname).toBe('/mcp-settings');
  expect(screen.getByRole('status')).toBeInTheDocument();
  expect(consumer).not.toHaveBeenCalled();
  await act(async () =>
    resolve({
      server: {
        serverName: 'server',
        title: 'Server',
        type: 'streamable-http',
        url: 'http://localhost/mcp',
      },
    }),
  );
  expect(await screen.findByText('MCP content')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/mcp-settings');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('treats a successfully loaded empty catalog as definitive unavailability', async () => {
  jest.mocked(dataService.getMCPServers).mockResolvedValue({});
  const router = setup();
  await waitFor(() => expect(router.state.location.pathname).toBe('/c/new'));
  expect(consumer).not.toHaveBeenCalled();
});

it.each([{ denied: true }, { enabled: false }])(
  'does not query or mount a denied or disabled page: %p',
  async (options) => {
    mockUse = !options.denied;
    const fetch = jest.mocked(dataService.getMCPServers).mockResolvedValue({});
    const router = setup(options);
    await waitFor(() => expect(router.state.location.pathname).toBe('/c/new'));
    expect(fetch).not.toHaveBeenCalled();
    expect(consumer).not.toHaveBeenCalled();
  },
);

it('shows catalog failure and retries without navigating away or mounting a denied consumer', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = jest
    .mocked(dataService.getMCPServers)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({
      server: {
        serverName: 'server',
        title: 'Server',
        type: 'streamable-http',
        url: 'http://localhost/mcp',
      },
    });
  const router = setup();
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/mcp-settings');
  expect(consumer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  expect(await screen.findByText('MCP content')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not release the MCP catalog on an ordinary chat startup', () => {
  const fetch = jest.mocked(dataService.getMCPServers).mockResolvedValue({});
  setup({ entry: '/c/new' });
  expect(fetch).not.toHaveBeenCalled();
});
