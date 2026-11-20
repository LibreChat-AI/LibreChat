import React, { useRef, useState } from 'react';
import { RecoilRoot } from 'recoil';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import type { PaletteEntry } from '~/hooks/Input/usePaletteEntries';
import { ServersChip, ServersCatalog, useServersEntry } from '../Servers';

/**
 * The MCP Servers chip: whether the MCP pin (seeded by `defaultPinnedTools`, see
 * `useMCPSelect`) and the server list put it on the bar, and that it opens every
 * server rather than the palette's first five.
 */

/* A copy, so the HTTP calls below can be spied on. */
jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

let mockIsPinned = true;
const mockSetIsPinned = jest.fn();
jest.mock('~/Providers', () => ({
  useBadgeRowContext: () => ({
    mcpServerManager: { isPinned: mockIsPinned, setIsPinned: mockSetIsPinned },
  }),
}));

jest.mock('~/hooks/Input/useToolFavorites', () => ({
  __esModule: true,
  default: () => ({ keys: new Set<string>(), toggleFavorite: jest.fn(), isFavorite: () => false }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, string | number>) =>
    options ? `${key}:${options['0']}` : key,
  useAuthContext: () => ({ user: { id: 'user-1' } }),
  useToolFavorites: () => ({ favoriteKeys: new Set<string>(), toggle: jest.fn() }),
}));

const OPEN_LABEL = 'com_ui_composer_show_all_label:com_ui_mcp_servers';

const server = (name: string): PaletteEntry => ({
  key: `mcp:${name}`,
  itemType: 'mcp',
  itemId: name,
  label: name,
  icon: null,
  section: 'mcp',
  active: false,
  pinned: false,
  onSelect: jest.fn(),
});

const tool = (name: string): PaletteEntry => ({
  ...server(name),
  key: `builtin:${name}`,
  itemType: 'builtin',
  section: 'tool',
});

const SERVERS = Array.from({ length: 8 }, (_, i) => server(`server${i}`));

/** Composes the three pieces the way `Bar` does. */
function Harness({ entries }: { entries: PaletteEntry[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const entry = useServersEntry(entries, () => setOpen(true));
  return (
    <>
      {entry != null && <ServersChip entry={entry} triggerRef={triggerRef} />}
      <ServersCatalog
        open={open}
        onClose={() => setOpen(false)}
        entries={entries}
        returnFocusRef={triggerRef}
      />
    </>
  );
}

/** Polls fast enough to observe a second status read within a test. */
const STATUS_INTERVAL = 50;

function renderHarness(entries: PaletteEntry[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <RecoilRoot>
      <QueryClientProvider client={client}>
        <Harness entries={entries} />
      </QueryClientProvider>
    </RecoilRoot>,
  );
}

const chip = () => screen.queryByTestId('composer-mcp-servers');

describe('MCP Servers chip', () => {
  beforeEach(() => {
    mockIsPinned = true;
    mockSetIsPinned.mockClear();
    jest.restoreAllMocks();
    jest.spyOn(dataService, 'getStartupConfig').mockResolvedValue({
      interface: { mcpServers: { statusRefreshInterval: STATUS_INTERVAL } },
    } as unknown as TStartupConfig);
    jest
      .spyOn(dataService, 'getMCPConnectionStatus')
      .mockResolvedValue({ success: true, connectionStatus: {} } as Awaited<
        ReturnType<typeof dataService.getMCPConnectionStatus>
      >);
  });

  it('appears while the MCP pin is on', () => {
    renderHarness(SERVERS);
    expect(chip()).toHaveTextContent('com_ui_mcp_servers');
  });

  it('stays off while the MCP pin is off', () => {
    mockIsPinned = false;
    renderHarness(SERVERS);
    expect(chip()).toBeNull();
  });

  it('stays off when there is no server to list', () => {
    renderHarness([tool('web_search')]);
    expect(chip()).toBeNull();
  });

  it('opens every server in the MCP Servers dialog, whose cards select them', async () => {
    renderHarness(SERVERS);

    fireEvent.click(screen.getByRole('button', { name: OPEN_LABEL }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('com_ui_mcp_servers');
    const cards = dialog.querySelectorAll('li > div > button[aria-pressed]');
    expect(cards).toHaveLength(SERVERS.length);

    fireEvent.click(screen.getByRole('button', { name: /server7/ }));
    expect(SERVERS[7].onSelect).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('polls server statuses only while the dialog is open', async () => {
    const status = jest.mocked(dataService.getMCPConnectionStatus);
    renderHarness(SERVERS);
    await waitFor(() => expect(dataService.getStartupConfig).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, STATUS_INTERVAL * 3));
    expect(status).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: OPEN_LABEL }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(status.mock.calls.length).toBeGreaterThanOrEqual(2));

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const settled = status.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, STATUS_INTERVAL * 4));
    expect(status).toHaveBeenCalledTimes(settled);
  });

  it("unpins through the user's MCP pin", () => {
    renderHarness(SERVERS);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_unpin' }));
    expect(mockSetIsPinned).toHaveBeenCalledWith(false);
  });
});
