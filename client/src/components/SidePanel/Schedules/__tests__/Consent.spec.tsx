import { createRef } from 'react';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { RunGrantView } from 'librechat-data-provider';
import { splitToolKey } from '~/components/MCP/GrantTools';
import Consent from '../Consent';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getScheduleMCPConsent: jest.fn(),
      confirmScheduleMCPConsent: jest.fn(),
      revokeScheduleMCPConsent: jest.fn(),
    },
  };
});
const view: RunGrantView = {
  state: 'missing',
  revision: null,
  expiresAtMs: null,
  targets: [
    {
      resource: {
        serverName: 'warehouse',
        url: 'https://warehouse.example/mcp',
        issuer: 'https://issuer.example/',
        audience: 'warehouse',
        scopes: ['read'],
        credentialMode: 'resource_bearer',
        configurationRevision: 'v1',
      },
      policyRevision: 'p1',
      permittedTools: [
        { agentId: 'root', tools: ['export', 'query'] },
        { agentId: 'child', tools: ['query'] },
      ],
    },
  ],
  allowed: {},
  changed: {},
  asking: {},
  tools: { offered: [], allowed: [] },
  everything: false,
  approval: false,
  required: false,
  requireAfterMs: null,
  offer: { digest: 'a'.repeat(64), maxLifetimeHours: 24 },
};
function display() {
  const client = new QueryClient({
    logger: { log: console.log, warn: console.warn, error: jest.fn() },
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Consent id="schedule" name="Digest" onOpenChange={jest.fn()} triggerRef={createRef()} />
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(view);
});
it('renders loading, then the resource, each tool on offer unchecked, and a bounded lifetime', async () => {
  let resolve!: (value: RunGrantView) => void;
  jest.mocked(dataService.getScheduleMCPConsent).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  display();
  expect(screen.queryByText('warehouse')).not.toBeInTheDocument();
  resolve(view);
  expect(await screen.findByText('warehouse')).toBeVisible();
  expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  expect(screen.getByRole('checkbox', { name: 'query' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'export' })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' })).toBeDisabled();
  expect(screen.getByText('com_ui_schedule_consent_none_selected')).toBeVisible();
  expect(screen.getByRole('spinbutton')).toHaveAttribute('max', '24');
  // A schedule runs for as long as it exists: its grant starts at the longest allowed.
  expect(screen.getByRole('spinbutton')).toHaveValue(24);
});
it('confirms for a shorter lifetime when the owner types one', async () => {
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  display();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'query' }));
  const hours = screen.getByRole('spinbutton');
  await userEvent.clear(hours);
  await userEvent.type(hours, '2');
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({ lifetimeHours: 2 }),
    ),
  );
});
it('confirms the offer reference, lifetime and only the tools the owner ticked, then rereads persisted state', async () => {
  const active = {
    ...view,
    state: 'active' as const,
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
  };
  jest.mocked(dataService.confirmScheduleMCPConsent).mockImplementation(async () => {
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(active);
    return active;
  });
  display();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'query' }));
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith('schedule', {
      offerDigest: view.offer!.digest,
      expectedRevision: null,
      lifetimeHours: 24,
      allow: { warehouse: ['query'] },
      ask: {},
      tools: [],
    }),
  );
  expect(await screen.findByText('com_ui_schedule_consent_active')).toBeVisible();
});
it('allows or clears every tool on a server with one box', async () => {
  display();
  const server = await screen.findByRole('checkbox', {
    name: 'com_ui_schedule_consent_allow_server',
  });
  await userEvent.click(server);
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'export' })).toBeChecked();
  expect(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' })).toBeEnabled();

  await userEvent.click(screen.getByRole('checkbox', { name: 'export' }));
  expect(server).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();

  await userEvent.click(server);
  expect(screen.getByRole('checkbox', { name: 'export' })).toBeChecked();
  await userEvent.click(server);
  expect(screen.getByRole('checkbox', { name: 'query' })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' })).toBeDisabled();
});
it('starts from what the stored grant allows and is still on offer', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'active',
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
    allowed: { warehouse: ['query', 'retired'] },
  });
  display();
  expect(await screen.findByRole('checkbox', { name: 'query' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'export' })).not.toBeChecked();
  expect(screen.queryByRole('checkbox', { name: 'retired' })).not.toBeInTheDocument();
});
it('drops ticks for a server or tool that leaves the offer while the dialog is open', async () => {
  const archive = {
    ...view.targets[0],
    resource: { ...view.targets[0].resource, serverName: 'archive' },
    permittedTools: [{ agentId: 'root', tools: ['purge'] }],
  };
  jest
    .mocked(dataService.getScheduleMCPConsent)
    .mockResolvedValue({ ...view, targets: [archive, ...view.targets] });
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  const client = display();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'purge' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'export' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'query' }));
  // The agents drop the archive server and the export tool; the offer is read again.
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    targets: [{ ...view.targets[0], permittedTools: [{ agentId: 'root', tools: ['query'] }] }],
    offer: { digest: 'b'.repeat(64), maxLifetimeHours: 24 },
  });
  await client.invalidateQueries();
  await waitFor(() =>
    expect(screen.queryByRole('checkbox', { name: 'purge' })).not.toBeInTheDocument(),
  );
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({ offerDigest: 'b'.repeat(64), allow: { warehouse: ['query'] } }),
    ),
  );
});
it('leaves a tool the server changed unticked and says why, until the owner allows it again', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'changed',
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
    allowed: { warehouse: ['export', 'query'] },
    changed: { warehouse: ['query'] },
  });
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  display();
  const changed = await screen.findByRole('checkbox', { name: 'query' });
  expect(changed).not.toBeChecked();
  expect(changed).toHaveAccessibleDescription('com_ui_schedule_consent_tool_changed');
  const unchanged = screen.getByRole('checkbox', { name: 'export' });
  expect(unchanged).toBeChecked();
  expect(unchanged).not.toHaveAccessibleDescription();
  await userEvent.click(changed);
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({ allow: { warehouse: ['export', 'query'] } }),
    ),
  );
});
it('unticks a tool that is marked as changed while the owner is choosing, until they tick it again', async () => {
  const granted = {
    ...view,
    state: 'active' as const,
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
    allowed: { warehouse: ['query'] },
  };
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(granted);
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  const client = display();
  // The owner edits a tick, so the dialog now holds their choice and not the stored one.
  await userEvent.click(await screen.findByRole('checkbox', { name: 'export' }));
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();
  // A run then sees `query` with a different definition, and the offer is read again.
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...granted,
    state: 'changed',
    changed: { warehouse: ['query'] },
    offer: { digest: 'c'.repeat(64), maxLifetimeHours: 24 },
  });
  await client.invalidateQueries();
  const marked = await screen.findByRole('checkbox', {
    name: 'query',
    description: 'com_ui_schedule_consent_tool_changed',
  });
  expect(marked).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'export' })).toBeChecked();
  // Ticked again with the warning in view, it is sent, and stays ticked across later edits.
  await userEvent.click(marked);
  await userEvent.click(screen.getByRole('checkbox', { name: 'export' }));
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({ offerDigest: 'c'.repeat(64), allow: { warehouse: ['query'] } }),
    ),
  );
});
it('unticks a tool the owner accepted once it is marked again under a later grant', async () => {
  const marked = {
    ...view,
    state: 'changed' as const,
    revision: 'grant-1',
    expiresAtMs: Date.now() + 60_000,
    allowed: { warehouse: ['query'] },
    changed: { warehouse: ['query'] },
  };
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(marked);
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  const client = display();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'query' }));
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();
  // Confirmed elsewhere, then a run marks the tool again: the same name, another change.
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...marked,
    revision: 'grant-2',
    offer: { digest: 'd'.repeat(64), maxLifetimeHours: 24 },
  });
  await client.invalidateQueries();
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'query' })).not.toBeChecked());
  expect(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' })).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox', { name: 'query' }));
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({
        offerDigest: 'd'.repeat(64),
        expectedRevision: 'grant-2',
        allow: { warehouse: ['query'] },
      }),
    ),
  );
});
it("lists each of the agent's other tools as its own item, and sends the ones the owner ticks", async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    tools: { offered: ['execute_code', 'send_action_mail.example', 'web_search'], allowed: [] },
  });
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  display();
  // Built-in tools go by name; anything else, such as an action, by its key.
  const code = await screen.findByRole('checkbox', { name: 'com_ui_schedule_consent_tool_code' });
  const search = screen.getByRole('checkbox', { name: 'com_ui_schedule_consent_tool_web' });
  const action = screen.getByRole('checkbox', { name: 'send_action_mail.example' });
  for (const box of [code, search, action]) expect(box).not.toBeChecked();
  await userEvent.click(screen.getByRole('checkbox', { name: 'query' }));
  await userEvent.click(code);
  await userEvent.click(action);
  await userEvent.click(action);
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({ allow: { warehouse: ['query'] }, tools: ['execute_code'] }),
    ),
  );
});
describe('a grant that can be made for the whole agent', () => {
  const standing: RunGrantView = {
    ...view,
    tools: { offered: ['web_search'], allowed: [] },
    offer: { ...view.offer!, everything: true },
  };
  const whole = () => screen.findByRole('checkbox', { name: 'com_ui_schedule_consent_everything' });
  const confirm = () => screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' });
  const tool = (name: string) => screen.getByRole('checkbox', { name });

  it('starts on the whole agent, and confirms it with nothing chosen one by one', async () => {
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(standing);
    jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(standing);
    display();
    expect(await whole()).toBeChecked();
    expect(screen.getByText('com_ui_schedule_consent_everything_note')).toBeVisible();
    // There is nothing to tick: no tool is listed, and none is left out.
    expect(screen.queryByRole('checkbox', { name: 'query' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'com_ui_schedule_consent_tool_web' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_schedule_consent_none_selected')).not.toBeInTheDocument();
    expect(confirm()).toBeEnabled();
    await userEvent.click(confirm());
    await waitFor(() =>
      expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith('schedule', {
        offerDigest: view.offer!.digest,
        expectedRevision: null,
        lifetimeHours: 24,
        allow: {},
        everything: true,
      }),
    );
  });

  it('starts tool by tool from every box ticked, so only what the owner unticks is left out', async () => {
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(standing);
    jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(standing);
    display();
    await userEvent.click(await whole());
    const web = screen.getByRole('checkbox', { name: 'com_ui_schedule_consent_tool_web' });
    for (const box of [web, tool('export'), tool('query')]) expect(box).toBeChecked();
    expect(confirm()).toBeEnabled();
    await userEvent.click(tool('export'));
    await userEvent.click(confirm());
    await waitFor(() =>
      expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith('schedule', {
        offerDigest: view.offer!.digest,
        expectedRevision: null,
        lifetimeHours: 24,
        allow: { warehouse: ['query'] },
        ask: {},
        tools: ['web_search'],
      }),
    );
  });

  it('starts a stored grant for the whole agent from every box ticked as well', async () => {
    // Such a grant holds a consent for a declared server and lists none of the other tools.
    const stored = {
      ...standing,
      state: 'active' as const,
      revision: 'grant',
      everything: true,
      allowed: { warehouse: ['query'] },
    };
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(stored);
    jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(stored);
    display();
    await userEvent.click(await whole());
    const web = screen.getByRole('checkbox', { name: 'com_ui_schedule_consent_tool_web' });
    // A tool the agents took up after the grant was made is covered by it too.
    for (const box of [web, tool('export'), tool('query')]) expect(box).toBeChecked();
    await userEvent.click(tool('query'));
    await userEvent.click(confirm());
    await waitFor(() =>
      expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
        'schedule',
        expect.objectContaining({
          expectedRevision: 'grant',
          allow: { warehouse: ['export'] },
          tools: ['web_search'],
        }),
      ),
    );
  });

  it('starts a stored grant that lists its tools from what it lists', async () => {
    const listed = {
      ...standing,
      state: 'active' as const,
      revision: 'grant',
      allowed: { warehouse: ['query'] },
    };
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(listed);
    display();
    expect(await whole()).not.toBeChecked();
    const web = screen.getByRole('checkbox', { name: 'com_ui_schedule_consent_tool_web' });
    expect(tool('query')).toBeChecked();
    for (const box of [web, tool('export')]) expect(box).not.toBeChecked();
    // Ticking the whole agent and unticking it again leaves the listed choice as it was.
    await userEvent.click(await whole());
    await userEvent.click(await whole());
    expect(tool('query')).toBeChecked();
    for (const box of [
      screen.getByRole('checkbox', { name: 'com_ui_schedule_consent_tool_web' }),
      tool('export'),
    ])
      expect(box).not.toBeChecked();
  });

  it('says which tools it still asks about, and renews without touching them', async () => {
    const asked = {
      ...standing,
      state: 'active' as const,
      revision: 'grant',
      everything: true,
      asking: { warehouse: ['query'] },
    };
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(asked);
    jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(asked);
    display();
    expect(await whole()).toBeChecked();
    const keep = screen.getByRole('checkbox', {
      name: 'com_ui_schedule_consent_everything_asking',
    });
    expect(keep).toBeChecked();
    await userEvent.click(confirm());
    await waitFor(() => expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalled());
    // Left out, the server keeps what the stored grant asks about.
    expect(jest.mocked(dataService.confirmScheduleMCPConsent).mock.calls[0][1]).not.toHaveProperty(
      'ask',
    );
    // The owner stops it, here, with the whole agent still ticked.
    await userEvent.click(keep);
    await userEvent.click(confirm());
    await waitFor(() => expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledTimes(2));
    expect(jest.mocked(dataService.confirmScheduleMCPConsent).mock.calls[1][1]).toMatchObject({
      allow: {},
      everything: true,
      ask: {},
    });
  });

  it('offers nothing to keep asking about where the grant asks about nothing', async () => {
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(standing);
    display();
    expect(await whole()).toBeChecked();
    expect(
      screen.queryByRole('checkbox', { name: 'com_ui_schedule_consent_everything_asking' }),
    ).not.toBeInTheDocument();
  });

  it('starts a stored grant from what it is', async () => {
    const listed = {
      ...standing,
      state: 'active' as const,
      revision: 'grant',
      allowed: { warehouse: ['query'] },
    };
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(listed);
    display();
    expect(await whole()).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();
    cleanup();
    jest
      .mocked(dataService.getScheduleMCPConsent)
      .mockResolvedValue({ ...listed, everything: true });
    display();
    expect(await whole()).toBeChecked();
  });
});

it('offers the skills of the agent as one item, by name, and sends it like any other', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    targets: [],
    tools: { offered: ['skills', 'web_search'], allowed: [] },
  });
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  display();
  const skills = await screen.findByRole('checkbox', {
    name: 'com_ui_schedule_consent_tool_skills',
  });
  expect(skills).not.toBeChecked();
  await userEvent.click(skills);
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({ allow: {}, tools: ['skills'] }),
    ),
  );
});
it('lists a tool on a server the operator did not declare by its name and server, and sends its key', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    targets: [],
    tools: {
      offered: ['lookup_mcp_notes', 'sys__all__sys_mcp_archive', 'web_search'],
      allowed: [],
    },
  });
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  display();
  // One tool by name, and a selection of a whole server as one item.
  const tool = await screen.findByRole('checkbox', {
    name: 'com_ui_schedule_consent_tool_on_server',
  });
  const every = screen.getByRole('checkbox', { name: 'com_ui_schedule_consent_tools_on_server' });
  expect(screen.queryByRole('checkbox', { name: 'lookup_mcp_notes' })).not.toBeInTheDocument();
  await userEvent.click(tool);
  await userEvent.click(every);
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({
        allow: {},
        tools: ['lookup_mcp_notes', 'sys__all__sys_mcp_archive'],
      }),
    ),
  );
});
it('reads the tool and the server out of a key against the servers in use, not by position', () => {
  // A server name may contain the delimiter. So may a tool's.
  expect(splitToolKey('lookup_mcp_Finance_mcp_EU', ['Finance_mcp_EU', 'EU'])).toEqual({
    name: 'lookup',
    server: 'Finance_mcp_EU',
  });
  expect(splitToolKey('read_mcp_log_mcp_notes', ['notes'])).toEqual({
    name: 'read_mcp_log',
    server: 'notes',
  });
  // The agent may have the key under the normalized spelling of the server.
  expect(splitToolKey('lookup_mcp_My_Notes', ['My Notes'])).toEqual({
    name: 'lookup',
    server: 'My Notes',
  });
  // A selection of a whole server is told by its marker even with no server to match.
  expect(splitToolKey('sys__all__sys_mcp_Finance_mcp_EU', [])).toEqual({
    name: 'sys__all__sys',
    server: 'Finance_mcp_EU',
  });
  expect(splitToolKey('send_action_mail.example', ['notes'])).toBeUndefined();
});

it('offers a selection of a whole server as its own item, which ticks and locks each named tool', async () => {
  const whole: RunGrantView = {
    ...view,
    approval: true,
    targets: [
      {
        ...view.targets[0],
        permittedTools: [{ agentId: 'root', tools: ['query', 'sys__all__sys'] }],
      },
    ],
  };
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(whole);
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(whole);
  display();
  const every = await screen.findByRole('checkbox', {
    name: 'com_ui_schedule_consent_server_every',
  });
  const all = screen.getByRole('checkbox', { name: 'com_ui_schedule_consent_allow_server' });
  const query = screen.getByRole('checkbox', { name: 'query' });
  expect(every).not.toBeChecked();
  expect(screen.queryByRole('checkbox', { name: 'sys__all__sys' })).not.toBeInTheDocument();
  // Ticking every named tool is not allowing whatever the server gains later.
  await userEvent.click(all);
  expect(query).toBeChecked();
  expect(every).not.toBeChecked();
  await userEvent.click(all);
  expect(query).not.toBeChecked();
  // The whole server is every tool on it: the named ones are ticked with it, and stay so.
  await userEvent.click(every);
  expect(query).toBeChecked();
  expect(query).toBeDisabled();
  expect(all).toBeChecked();
  expect(all).toBeDisabled();
  // It names no tool, so there is nothing to be asked about for it: only `query` has a box.
  expect(
    screen.getAllByRole('checkbox', { name: 'com_ui_schedule_consent_ask_tool' }),
  ).toHaveLength(1);
  // Unticked, the named tools are the owner's to choose again, starting from ticked.
  await userEvent.click(every);
  expect(query).toBeChecked();
  expect(query).toBeEnabled();
  await userEvent.click(every);
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({ allow: { warehouse: ['query', 'sys__all__sys'] } }),
    ),
  );
});

it('unticks the whole-server item and names the tools that changed under it', async () => {
  const stored: RunGrantView = {
    ...view,
    state: 'changed',
    revision: 'grant',
    targets: [
      {
        ...view.targets[0],
        permittedTools: [{ agentId: 'root', tools: ['query', 'sys__all__sys'] }],
      },
    ],
    // `export` was used under the whole server and has changed. It is not listed by name.
    allowed: { warehouse: ['query', 'sys__all__sys'] },
    changed: { warehouse: ['export'] },
  };
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(stored);
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(stored);
  display();
  const every = await screen.findByRole('checkbox', {
    name: 'com_ui_schedule_consent_server_every',
  });
  // Allowing the new definition is a decision, made with the warning in view.
  expect(every).not.toBeChecked();
  expect(every).toHaveAccessibleDescription('com_ui_schedule_consent_server_changed');
  expect(screen.getByRole('checkbox', { name: 'query' })).toBeChecked();
  await userEvent.click(every);
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({ allow: { warehouse: ['query', 'sys__all__sys'] } }),
    ),
  );
});

it('keeps sending a question about a tool the whole-server item still covers', async () => {
  // The grant asks about `query`. No agent names `query` any more: only the whole server.
  const stored: RunGrantView = {
    ...view,
    approval: true,
    state: 'active',
    revision: 'grant',
    targets: [
      { ...view.targets[0], permittedTools: [{ agentId: 'root', tools: ['sys__all__sys'] }] },
    ],
    allowed: { warehouse: ['sys__all__sys'] },
    asking: { warehouse: ['query'] },
  };
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(stored);
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(stored);
  display();
  expect(
    await screen.findByRole('checkbox', { name: 'com_ui_schedule_consent_server_every' }),
  ).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({
        allow: { warehouse: ['sys__all__sys'] },
        ask: { warehouse: ['query'] },
      }),
    ),
  );
});

describe('the whole-server item beside named tools', () => {
  const every = () =>
    screen.findByRole('checkbox', { name: 'com_ui_schedule_consent_server_every' });
  const confirm = () => screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' });
  const stored = (over: Partial<RunGrantView>, tools: string[]): RunGrantView => ({
    ...view,
    approval: true,
    state: 'active',
    revision: 'grant',
    targets: [{ ...view.targets[0], permittedTools: [{ agentId: 'root', tools }] }],
    ...over,
  });

  it('is unticked by a change to a tool that also has a box of its own', async () => {
    // The root holds the whole server, the child names `query`, and `query` has changed.
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(
      stored(
        {
          state: 'changed',
          allowed: { warehouse: ['query', 'sys__all__sys'] },
          changed: { warehouse: ['query'] },
        },
        ['query', 'sys__all__sys'],
      ),
    );
    display();
    // Left ticked, the whole server would allow the new definition for the root unseen.
    expect(await every()).not.toBeChecked();
    expect(await every()).toHaveAccessibleDescription('com_ui_schedule_consent_server_changed');
    expect(screen.getByRole('checkbox', { name: 'query' })).not.toBeChecked();
    expect(confirm()).toBeDisabled();
  });

  it('lets the owner stop a question about a tool that has no box of its own', async () => {
    const data = stored(
      { allowed: { warehouse: ['sys__all__sys'] }, asking: { warehouse: ['query'] } },
      ['sys__all__sys'],
    );
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(data);
    jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(data);
    display();
    expect(await every()).toBeChecked();
    // No agent names `query`, so it has no row. Its question does.
    expect(screen.queryByRole('checkbox', { name: 'query' })).not.toBeInTheDocument();
    const asked = screen.getByRole('checkbox', { name: 'com_ui_schedule_consent_ask_tool' });
    expect(asked).toBeChecked();
    await userEvent.click(asked);
    expect(
      screen.queryByRole('checkbox', { name: 'com_ui_schedule_consent_ask_tool' }),
    ).not.toBeInTheDocument();
    await userEvent.click(confirm());
    await waitFor(() =>
      expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
        'schedule',
        expect.objectContaining({ allow: { warehouse: ['sys__all__sys'] }, ask: {} }),
      ),
    );
  });

  it('allows a tool another agent names along with the whole server, not only for the agent that holds it', async () => {
    // The root selects the whole server and the child names `query`. The grant on file holds
    // the whole server alone, so the child is refused `query` while the root may call it.
    const data: RunGrantView = {
      ...stored({ allowed: { warehouse: ['sys__all__sys'] }, asking: { warehouse: ['query'] } }, [
        'sys__all__sys',
      ]),
      targets: [
        {
          ...view.targets[0],
          permittedTools: [
            { agentId: 'root', tools: ['sys__all__sys'] },
            { agentId: 'child', tools: ['query'] },
          ],
        },
      ],
    };
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(data);
    jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(data);
    display();
    expect(await every()).toBeChecked();
    // One list for the server: with the whole of it ticked, no tool on it is shown left out.
    const query = screen.getByRole('checkbox', { name: 'query' });
    expect(query).toBeChecked();
    expect(query).toBeDisabled();
    // Its question shows once, on its own row.
    const asks = screen.getAllByRole('checkbox', { name: 'com_ui_schedule_consent_ask_tool' });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toBeChecked();
    await userEvent.click(confirm());
    await waitFor(() =>
      expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
        'schedule',
        expect.objectContaining({
          allow: { warehouse: ['query', 'sys__all__sys'] },
          ask: { warehouse: ['query'] },
        }),
      ),
    );
  });

  it('starts the tools a whole-server grant already allows as ticked, once the agents name them', async () => {
    // Granted as a whole. The agent now names its tools, and no longer selects the whole.
    const data = stored({ allowed: { warehouse: ['sys__all__sys'] } }, ['export', 'query']);
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(data);
    jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(data);
    display();
    expect(await screen.findByRole('checkbox', { name: 'query' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'export' })).toBeChecked();
    // Confirming as shown keeps what is authorized now.
    await userEvent.click(confirm());
    await waitFor(() =>
      expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
        'schedule',
        expect.objectContaining({ allow: { warehouse: ['export', 'query'] } }),
      ),
    );
  });
});

it('authorizes a schedule whose agent uses no MCP server, once one of its tools is ticked', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    targets: [],
    tools: { offered: ['execute_code', 'web_search'], allowed: [] },
  });
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  display();
  const confirm = await screen.findByRole('button', { name: 'com_ui_schedule_consent_confirm' });
  expect(confirm).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox', { name: 'com_ui_schedule_consent_tool_web' }));
  expect(confirm).toBeEnabled();
  await userEvent.click(confirm);
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({ allow: {}, tools: ['web_search'] }),
    ),
  );
});
it('allows every server, tool and other tool in one click', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    tools: { offered: ['execute_code', 'web_search'], allowed: [] },
  });
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  display();
  await userEvent.click(
    await screen.findByRole('button', { name: 'com_ui_schedule_consent_allow_all' }),
  );
  for (const box of screen.getAllByRole('checkbox')) expect(box).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({
        allow: { warehouse: ['export', 'query'] },
        tools: ['execute_code', 'web_search'],
      }),
    ),
  );
});
it('starts from the other tools the stored grant allows, and names them when there is nothing to confirm', async () => {
  const granted = {
    ...view,
    state: 'active' as const,
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
    allowed: { warehouse: ['query'] },
    tools: { offered: ['execute_code', 'web_search'], allowed: ['web_search'] },
  };
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(granted);
  const first = display();
  expect(
    await screen.findByRole('checkbox', { name: 'com_ui_schedule_consent_tool_web' }),
  ).toBeChecked();
  expect(
    screen.getByRole('checkbox', { name: 'com_ui_schedule_consent_tool_code' }),
  ).not.toBeChecked();
  first.clear();
  cleanup();
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({ ...granted, offer: null });
  display();
  expect(await screen.findByText('com_ui_schedule_consent_other_allowed')).toBeVisible();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});
it('names the changed tools when there is nothing to confirm', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'changed',
    revision: 'grant',
    allowed: { warehouse: ['export', 'query'] },
    changed: { warehouse: ['query'] },
    offer: null,
  });
  display();
  expect(await screen.findByText('com_ui_schedule_consent_changed_tools')).toBeVisible();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});
it('says nothing about a requirement where the schedule is free to run unauthorized', async () => {
  display();
  expect(await screen.findByText('com_ui_schedule_consent_missing')).toBeVisible();
  expect(screen.queryByText('com_ui_schedule_consent_required')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_schedule_consent_required_after')).not.toBeInTheDocument();
});
it('tells the owner when the schedule stops working without authorization', async () => {
  jest
    .mocked(dataService.getScheduleMCPConsent)
    .mockResolvedValue({ ...view, requireAfterMs: Date.now() + 86_400_000 });
  display();
  expect(await screen.findByText('com_ui_schedule_consent_required_after')).toBeVisible();
  expect(screen.queryByText('com_ui_schedule_consent_required')).not.toBeInTheDocument();
});
it('tells the owner the schedule is refused MCP tools until they confirm', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({ ...view, required: true });
  display();
  expect(await screen.findByText('com_ui_schedule_consent_required')).toBeVisible();
  expect(screen.queryByText('com_ui_schedule_consent_required_after')).not.toBeInTheDocument();
});
it('offers no way to ask first where a scheduled run cannot pause', async () => {
  display();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'query' }));
  expect(
    screen.queryByRole('checkbox', { name: 'com_ui_schedule_consent_ask_tool' }),
  ).not.toBeInTheDocument();
});
it('lets the owner ask first for an allowed tool, and sends only those', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({ ...view, approval: true });
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  display();
  // Nothing to ask about until a tool is allowed.
  await screen.findByRole('checkbox', { name: 'query' });
  expect(screen.queryAllByRole('checkbox', { name: 'com_ui_schedule_consent_ask_tool' })).toEqual(
    [],
  );
  await userEvent.click(screen.getByRole('checkbox', { name: 'query' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'export' }));
  const boxes = screen.getAllByRole('checkbox', { name: 'com_ui_schedule_consent_ask_tool' });
  expect(boxes).toHaveLength(2);
  // Tools are listed in order: export, then query.
  await userEvent.click(boxes[0]);
  await userEvent.click(boxes[1]);
  // Disallowing a tool drops its question with it.
  await userEvent.click(screen.getByRole('checkbox', { name: 'export' }));
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({ allow: { warehouse: ['query'] }, ask: { warehouse: ['query'] } }),
    ),
  );
});
it('starts from what the stored grant asks about, and sends no question once cleared', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'active',
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
    approval: true,
    allowed: { warehouse: ['export', 'query'] },
    asking: { warehouse: ['query'] },
  });
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  display();
  await screen.findByRole('checkbox', { name: 'query' });
  const [exportAsk, queryAsk] = screen.getAllByRole('checkbox', {
    name: 'com_ui_schedule_consent_ask_tool',
  });
  expect(exportAsk).not.toBeChecked();
  expect(queryAsk).toBeChecked();
  await userEvent.click(queryAsk);
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() => expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalled());
  // Sent empty, not left out: the server keeps the stored questions when told nothing.
  expect(jest.mocked(dataService.confirmScheduleMCPConsent).mock.calls[0][1]).toMatchObject({
    ask: {},
  });
});
it('keeps a changed tool asking first when the owner allows its new definition', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'changed',
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
    approval: true,
    allowed: { warehouse: ['export', 'query'] },
    asking: { warehouse: ['query'] },
    changed: { warehouse: ['query'] },
  });
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  display();
  // Changed, so it starts unticked, and an unticked tool shows no question.
  const query = await screen.findByRole('checkbox', { name: 'query' });
  expect(query).not.toBeChecked();
  expect(
    screen.getAllByRole('checkbox', { name: 'com_ui_schedule_consent_ask_tool' }),
  ).toHaveLength(1);
  await userEvent.click(query);
  // Allowed again, it still asks: accepting the new definition is not dropping the question.
  const [, queryAsk] = screen.getAllByRole('checkbox', {
    name: 'com_ui_schedule_consent_ask_tool',
  });
  expect(queryAsk).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({
        allow: { warehouse: ['export', 'query'] },
        ask: { warehouse: ['query'] },
      }),
    ),
  );
});
it('takes up a question added to a grant confirmed elsewhere, over an earlier edit of its own', async () => {
  const granted = {
    ...view,
    state: 'active' as const,
    revision: 'grant-1',
    expiresAtMs: Date.now() + 60_000,
    approval: true,
    allowed: { warehouse: ['export', 'query'] },
    asking: { warehouse: ['query'] },
  };
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(granted);
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  const client = display();
  await screen.findByRole('checkbox', { name: 'query' });
  const asks = () => screen.getAllByRole('checkbox', { name: 'com_ui_schedule_consent_ask_tool' });
  // The owner clears the question on `query` here, then the grant is replaced in another tab
  // by one that also asks about `export`.
  await userEvent.click(asks()[1]);
  expect(asks()[1]).not.toBeChecked();
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...granted,
    revision: 'grant-2',
    asking: { warehouse: ['export', 'query'] },
    offer: { digest: 'e'.repeat(64), maxLifetimeHours: 24 },
  });
  await client.invalidateQueries();
  await waitFor(() => expect(asks()[0]).toBeChecked());
  expect(asks()[1]).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({
        expectedRevision: 'grant-2',
        ask: { warehouse: ['export', 'query'] },
      }),
    ),
  );
});
it('keeps what the stored grant asks about where a run cannot pause, and offers no new question', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'active',
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
    approval: false,
    allowed: { warehouse: ['export', 'query'] },
    asking: { warehouse: ['query'] },
  });
  jest.mocked(dataService.confirmScheduleMCPConsent).mockResolvedValue(view);
  display();
  await screen.findByRole('checkbox', { name: 'query' });
  // Only the stored question has a box, and it says why the tool is refused for now.
  const stored = screen.getByRole('checkbox', {
    name: 'com_ui_schedule_consent_ask_tool',
    description: 'com_ui_schedule_consent_ask_unavailable',
  });
  expect(stored).toBeChecked();
  expect(screen.getAllByRole('checkbox', { name: 'com_ui_schedule_consent_ask_tool' })).toEqual([
    stored,
  ]);
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  await waitFor(() =>
    expect(dataService.confirmScheduleMCPConsent).toHaveBeenCalledWith(
      'schedule',
      expect.objectContaining({
        allow: { warehouse: ['export', 'query'] },
        ask: { warehouse: ['query'] },
      }),
    ),
  );
  // Dropping it is the owner's to choose; the note goes with the last question.
  await userEvent.click(stored);
  expect(screen.queryByText('com_ui_schedule_consent_ask_unavailable')).not.toBeInTheDocument();
});
it('names the tools a stored grant asks about when there is nothing to confirm', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'revoked',
    revision: 'revoked',
    allowed: { warehouse: ['query'] },
    asking: { warehouse: ['query'] },
    offer: null,
  });
  display();
  expect(await screen.findByText('com_ui_schedule_consent_asking')).toBeVisible();
});
it('lists the allowed tools without boxes when there is nothing to confirm', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'revoked',
    revision: 'revoked',
    allowed: { warehouse: ['query'] },
    offer: null,
  });
  display();
  expect(await screen.findByText('com_ui_schedule_consent_allowed')).toBeVisible();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});
it('reopens with persisted expiry and explicitly revokes without enabling a schedule', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    state: 'active',
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
  });
  jest.mocked(dataService.revokeScheduleMCPConsent).mockImplementation(async () => {
    jest
      .mocked(dataService.getScheduleMCPConsent)
      .mockResolvedValue({ ...view, state: 'revoked', revision: 'revoked', offer: null });
  });
  display();
  expect(await screen.findByText('com_ui_schedule_consent_deadline')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_revoke' }));
  await waitFor(() =>
    expect(dataService.revokeScheduleMCPConsent).toHaveBeenCalledWith('schedule', 'grant'),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'com_ui_schedule_consent_revoke' }),
    ).not.toBeInTheDocument(),
  );
});
it('has no confirmation action when no trusted target resolver is installed', async () => {
  jest
    .mocked(dataService.getScheduleMCPConsent)
    .mockResolvedValue({ ...view, state: 'unsupported', targets: [], offer: null });
  display();
  expect(await screen.findByText('com_ui_schedule_consent_unsupported')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'com_ui_schedule_consent_confirm' }),
  ).not.toBeInTheDocument();
});
it('shows API errors and retries without silently accepting a grant', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockRejectedValueOnce(new Error('offline'));
  display();
  expect(await screen.findByText('com_ui_schedule_consent_error')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  expect(await screen.findByText('warehouse')).toBeVisible();
});
it('reports a stale confirmation and reloads the current offer', async () => {
  jest.mocked(dataService.confirmScheduleMCPConsent).mockRejectedValueOnce(new Error('conflict'));
  display();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'query' }));
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_consent_confirm' }));
  expect(await screen.findByText('com_ui_schedule_consent_error')).toBeVisible();
  await waitFor(() => expect(dataService.getScheduleMCPConsent).toHaveBeenCalledTimes(2));
});

it('keeps persisted inspection and revocation when CREATE is removed, without offering confirmation', async () => {
  const active = {
    ...view,
    state: 'active' as const,
    revision: 'grant',
    expiresAtMs: Date.now() + 60_000,
  };
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(active);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Consent
        canConfirm={false}
        id="schedule"
        name="Digest"
        onOpenChange={jest.fn()}
        triggerRef={createRef()}
      />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole('button', { name: 'com_ui_schedule_consent_revoke' }),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'com_ui_schedule_consent_confirm' }),
  ).not.toBeInTheDocument();
});

describe('what the form says about asking first', () => {
  const note = () => screen.queryByText('com_ui_schedule_consent_ask_note');

  it('explains it where a run can pause and a tool can be set to ask', async () => {
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({ ...view, approval: true });
    display();
    await screen.findByRole('checkbox', { name: 'query' });
    expect(note()).toBeVisible();
  });

  it('says nothing about it where a run cannot pause', async () => {
    display();
    await screen.findByRole('checkbox', { name: 'query' });
    expect(note()).not.toBeInTheDocument();
  });

  it('says nothing about it while the whole agent is chosen, or with no tool that can ask', async () => {
    const standing = {
      ...view,
      approval: true,
      offer: { ...view.offer!, everything: true as const },
    };
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(standing);
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient()}>
        <Consent id="schedule" name="Digest" onOpenChange={jest.fn()} triggerRef={createRef()} />
      </QueryClientProvider>,
    );
    const whole = await screen.findByRole('checkbox', {
      name: 'com_ui_schedule_consent_everything',
    });
    expect(note()).not.toBeInTheDocument();
    await userEvent.click(whole);
    expect(note()).toBeVisible();
    unmount();
    // A selection of the whole server names no tool, and it cannot be asked about.
    jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
      ...view,
      approval: true,
      targets: [
        { ...view.targets[0], permittedTools: [{ agentId: 'root', tools: ['sys__all__sys'] }] },
      ],
    });
    display();
    await screen.findByRole('checkbox', { name: 'com_ui_schedule_consent_server_every' });
    expect(note()).not.toBeInTheDocument();
  });
});

it('renders no list of tools under a server that offers only the whole of itself', async () => {
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue({
    ...view,
    targets: [
      { ...view.targets[0], permittedTools: [{ agentId: 'root', tools: ['sys__all__sys'] }] },
    ],
  });
  display();
  const every = await screen.findByRole('checkbox', {
    name: 'com_ui_schedule_consent_server_every',
  });
  const server = every.closest('fieldset');
  expect(server).not.toBeNull();
  expect(server!.querySelector('ul')).toBeNull();
  // A server with named tools still lists them.
  cleanup();
  jest.mocked(dataService.getScheduleMCPConsent).mockResolvedValue(view);
  display();
  const query = await screen.findByRole('checkbox', { name: 'query' });
  expect(query.closest('fieldset')!.querySelectorAll('li')).toHaveLength(2);
});
