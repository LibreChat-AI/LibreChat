import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import type { MCPServerDefinition } from '~/hooks';
import MCPBuilderPanel from './MCPBuilderPanel';

const mockActivateCatalog = jest.fn();
const mockRefresh = jest.fn();
const mockRefetch = jest.fn();
let mockSidebarExpanded = false;
let mockCanUse = true;
let mockCanCreate = false;
const mockManager = {
  availableMCPServers: [] as MCPServerDefinition[],
  isLoading: false,
  isError: false,
  refetch: mockRefetch,
  getServerStatusIconProps: jest.fn(),
  getConfigDialogProps: () => null,
};
const mockUseManager = jest.fn((_options: object) => mockManager);

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: ({ permission }: { permission: string }) =>
    permission === 'USE' ? mockCanUse : mockCanCreate,
  useAuthContext: () => ({ user: { role: 'USER' } }),
  useMCPServerManager: (options: object) => mockUseManager(options),
  activateCatalog: (catalog: string) => mockActivateCatalog(catalog),
}));
jest.mock('~/hooks/MCP/useMCPRefresh', () => ({
  useMCPRefresh: (options: object) => mockRefresh(options),
}));
jest.mock('recoil', () => ({ useRecoilValue: () => mockSidebarExpanded }));
jest.mock('~/store', () => ({ __esModule: true, default: { sidebarExpanded: {} } }));
jest.mock('~/components/ui', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    PanelHeader: jest.requireActual('~/components/ui/PanelHeader').default,
    PanelFooter: ({ children }: { children: React.ReactNode }) => children,
    PanelContent: ReactModule.forwardRef<
      HTMLDivElement,
      {
        children?: React.ReactNode;
        isLoading: boolean;
        skeleton: React.ReactNode;
      }
    >(({ children, isLoading, skeleton }, ref) => (
      <div ref={ref}>{isLoading ? <div role="status">{skeleton}</div> : children}</div>
    )),
  };
});
jest.mock('./MCPServerDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('./MCPAdminSettings', () => ({ __esModule: true, default: () => null }));
jest.mock('~/components/MCP/MCPConfigDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('./MCPServerList', () => ({
  __esModule: true,
  default: ({ servers }: { servers: MCPServerDefinition[] }) => (
    <div data-testid="servers">{servers.map((server) => server.serverName).join(',')}</div>
  ),
}));

function renderPanel(visible?: boolean, path = '/mcp') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MCPBuilderPanel visible={visible} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSidebarExpanded = false;
  mockCanUse = true;
  mockCanCreate = false;
  mockManager.availableMCPServers = [];
  mockManager.isLoading = false;
  mockManager.isError = false;
});

it('activates an explicitly visible page even when the sidebar is collapsed', () => {
  renderPanel(true);
  expect(mockActivateCatalog).toHaveBeenCalledWith('mcpServers');
  expect(mockUseManager).toHaveBeenCalledWith({ observeToolAuthorization: true });
});

it('does not release catalogs or observe tool authorization for a hidden retained host', () => {
  mockSidebarExpanded = true;
  renderPanel(false);
  expect(mockActivateCatalog).not.toHaveBeenCalled();
  expect(mockUseManager).toHaveBeenCalledWith({ observeToolAuthorization: false });
  expect(mockRefresh).toHaveBeenCalledWith({ enabled: false });
});

it('keeps the legacy sidebar visibility adapter when visible is omitted', () => {
  mockSidebarExpanded = true;
  renderPanel();
  expect(mockActivateCatalog).toHaveBeenCalledWith('mcpServers');
});

it('keeps the legacy insights visibility adapter', () => {
  mockSidebarExpanded = true;
  renderPanel(undefined, '/insights');
  expect(mockActivateCatalog).not.toHaveBeenCalled();
});

it('does not release catalogs or display servers without USE or CREATE access', () => {
  mockCanUse = false;
  renderPanel(true);
  expect(mockActivateCatalog).not.toHaveBeenCalled();
  expect(screen.getByText('com_ui_feature_no_access')).toBeInTheDocument();
  expect(screen.queryByTestId('servers')).not.toBeInTheDocument();
});

it('does not leave a CREATE-only host in the disabled catalog loading state', () => {
  mockCanUse = false;
  mockCanCreate = true;
  mockManager.isLoading = true;
  renderPanel(true);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByTestId('servers')).toBeInTheDocument();
});

it('shows collection failure and retries instead of rendering an empty server list', () => {
  mockManager.isError = true;
  renderPanel(true);
  expect(screen.getByRole('alert')).toHaveTextContent('com_ui_collection_load_error');
  expect(screen.queryByTestId('servers')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  expect(mockRefetch).toHaveBeenCalledTimes(1);
});
