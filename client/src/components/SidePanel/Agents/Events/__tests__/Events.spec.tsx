import React from 'react';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { ConnectionChoice, Subscription, RunGrantView } from 'librechat-data-provider';
import { changes, filtersFrom } from '../EventDialog';
import Events from '../Events';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(',')}` : key,
}));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    ...jest.requireActual('librechat-data-provider').dataService,
    getAgentEventSubscriptions: jest.fn(),
    getAgentEventConnections: jest.fn(),
    createAgentEventSubscription: jest.fn(),
    updateAgentEventSubscription: jest.fn(),
    deleteAgentEventSubscription: jest.fn(),
    getAgentEventSubscriptionGrant: jest.fn(),
  },
}));

const service = dataService as jest.Mocked<typeof dataService>;

const connection: ConnectionChoice = {
  id: 'conn_1',
  provider: 'github',
  account: 'acme',
  status: 'active',
};

const subscription: Subscription = {
  id: 'sub_1',
  user: 'user-1',
  connection: 'conn_1',
  agentId: 'agent-1',
  events: ['github.pull_request_review.submitted'],
  target: 'new',
  prompt: 'Review the feedback.',
  actors: 'write',
  bots: false,
  enabled: true,
  revision: 3,
};

const grant = (state: RunGrantView['state']) => ({ state }) as RunGrantView;

function renderEvents(agentId = 'agent-1', canCreate = true, onAgentSave = jest.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  return render(
    <QueryClientProvider client={client}>
      {/* The builder's own form is around the section, as in the agent panel. */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onAgentSave();
        }}
      >
        <Events agentId={agentId || undefined} canCreate={canCreate} />
      </form>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  service.getAgentEventConnections.mockResolvedValue({ connections: [connection] });
  service.getAgentEventSubscriptions.mockResolvedValue({ subscriptions: [subscription] });
  service.getAgentEventSubscriptionGrant.mockResolvedValue(grant('active'));
});

describe('Events', () => {
  it('asks for the agent to be saved first, and reads nothing until it is', () => {
    renderEvents('');
    expect(screen.getByText('com_ui_events_save_first')).toBeInTheDocument();
    expect(service.getAgentEventSubscriptions).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'com_ui_events_add' })).toBeDisabled();
  });

  it('shows that it is loading', () => {
    service.getAgentEventSubscriptions.mockReturnValue(new Promise(() => undefined));
    renderEvents();
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_events_loading');
  });

  it('tells an owner with no connection what an operator has to do, with no add button', async () => {
    service.getAgentEventConnections.mockResolvedValue({ connections: [] });
    service.getAgentEventSubscriptions.mockResolvedValue({ subscriptions: [] });
    renderEvents();
    expect(await screen.findByText('com_ui_events_no_connection')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_events_add' })).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_events_empty')).not.toBeInTheDocument();
  });

  it('says when the agent has no subscription yet', async () => {
    service.getAgentEventSubscriptions.mockResolvedValue({ subscriptions: [] });
    renderEvents();
    expect(await screen.findByText('com_ui_events_empty')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_events_add' })).toBeEnabled();
  });

  it('shows a failed read with a retry that reads again', async () => {
    service.getAgentEventSubscriptions.mockRejectedValueOnce(new Error('down'));
    renderEvents();
    expect(await screen.findByText('com_ui_events_list_error')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(await screen.findByTestId('event-card')).toBeInTheDocument();
    expect(service.getAgentEventSubscriptions).toHaveBeenCalledTimes(2);
  });

  it('lists a subscription by its events and connection', async () => {
    renderEvents();
    const card = await screen.findByTestId('event-card');
    expect(within(card).getByText('com_ui_events_type_review')).toBeInTheDocument();
    expect(within(card).getByText('acme')).toBeInTheDocument();
    expect(within(card).queryByText('com_ui_events_needs_regrant')).not.toBeInTheDocument();
  });

  it.each([
    ['missing', 'com_ui_events_needs_grant'],
    ['changed', 'com_ui_events_needs_regrant'],
    ['expired', 'com_ui_events_grant_expired'],
  ] as const)('marks a %s grant on the card', async (state, label) => {
    service.getAgentEventSubscriptionGrant.mockResolvedValue(grant(state));
    renderEvents();
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it('turns a subscription off from its switch, fenced on the revision it shows', async () => {
    service.updateAgentEventSubscription.mockResolvedValue({ ...subscription, enabled: false });
    renderEvents();
    const toggle = await screen.findByRole('switch', {
      name: 'com_ui_events_enabled: com_ui_events_type_review',
    });
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(service.updateAgentEventSubscription).toHaveBeenCalledWith('sub_1', {
        enabled: false,
        expectedRevision: 3,
      }),
    );
  });

  it("shows the server's code as words, never its text", async () => {
    service.updateAgentEventSubscription.mockRejectedValue(
      Object.assign(new Error('raw server text'), {
        isAxiosError: true,
        response: { data: { code: 'subscription_conflict' } },
      }),
    );
    renderEvents();
    await userEvent.click(await screen.findByRole('switch'));
    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_events_error_conflict');
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
  });

  it('offers no write to a role that may only use subscriptions', async () => {
    renderEvents('agent-1', false);
    const card = await screen.findByTestId('event-card');
    expect(screen.queryByRole('button', { name: 'com_ui_events_add' })).not.toBeInTheDocument();
    expect(within(card).getByRole('switch')).toBeDisabled();
    await userEvent.click(within(card).getByRole('button', { name: /com_ui_events_options/ }));
    expect(await screen.findByRole('menuitem', { name: 'com_ui_delete' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'com_ui_edit' })).not.toBeInTheDocument();
  });

  it('creates a subscription from the dialog with what the owner chose', async () => {
    service.getAgentEventSubscriptions.mockResolvedValue({ subscriptions: [] });
    service.createAgentEventSubscription.mockResolvedValue(subscription);
    const onAgentSave = jest.fn();
    renderEvents('agent-1', true, onAgentSave);
    await userEvent.click(await screen.findByRole('button', { name: 'com_ui_events_add' }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'com_ui_save' });
    expect(save).toBeDisabled();
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'com_ui_events_type_checks' }),
    );
    await userEvent.type(within(dialog).getByLabelText('com_ui_events_prompt'), 'Fix the build.');
    await userEvent.type(
      within(dialog).getByLabelText('com_ui_events_filter_branches'),
      'main, release ',
    );
    await userEvent.click(save);
    await waitFor(() =>
      expect(service.createAgentEventSubscription).toHaveBeenCalledWith({
        connection: 'conn_1',
        agentId: 'agent-1',
        events: ['github.check_suite.completed'],
        prompt: 'Fix the build.',
        actors: 'write',
        bots: false,
        filters: { branches: ['main', 'release'] },
      }),
    );
    // Saving the subscription is not saving the agent around it.
    expect(onAgentSave).not.toHaveBeenCalled();
  });
});

describe('changes', () => {
  const fields = {
    events: subscription.events,
    prompt: subscription.prompt,
    actors: subscription.actors,
    bots: subscription.bots,
    filters: null,
  };

  it('is nothing when nothing changed, so an unchanged save keeps the grant', () => {
    expect(changes(subscription, fields)).toBeNull();
    expect(
      changes({ ...subscription, events: ['b', 'a'] }, { ...fields, events: ['a', 'b'] }),
    ).toBeNull();
  });

  it('is only the fields that changed', () => {
    expect(changes(subscription, { ...fields, prompt: 'Other.' })).toEqual({ prompt: 'Other.' });
    expect(
      changes({ ...subscription, filters: { labels: ['bug'] } }, { ...fields, filters: null }),
    ).toEqual({ filters: null });
  });
});

describe('filtersFrom', () => {
  const stored = { labels: ['team,backend'], branches: ['main'] };
  const text = { repositories: '', branches: 'main', labels: 'team,backend' };

  it('keeps a stored list whose field was left as it was, commas and all', () => {
    expect(filtersFrom(text, stored)).toEqual(stored);
  });

  it('splits a field the owner edited', () => {
    expect(filtersFrom({ ...text, labels: 'team, ops' }, stored)).toEqual({
      branches: ['main'],
      labels: ['team', 'ops'],
    });
  });
});
