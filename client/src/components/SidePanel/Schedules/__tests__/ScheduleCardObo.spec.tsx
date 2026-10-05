import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@librechat/client';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { TSchedule } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import ScheduleCard from '../ScheduleCard';

const mockAuthorize = jest.fn();
const mockRevoke = jest.fn();
const mockInspect = dataService.inspectScheduledObo as jest.MockedFunction<
  typeof dataService.inspectScheduledObo
>;

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, inspectScheduledObo: jest.fn() } };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useClockFormat: () => false,
  useWeekStart: () => 0,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => ({ root: { name: 'Research Agent' } }),
}));
jest.mock('~/data-provider', () => ({
  useScheduledOboTargetQuery: jest.requireActual('~/data-provider/Schedules/queries')
    .useScheduledOboTargetQuery,
  useGetAgentByIdQuery: () => ({ data: null }),
  useAuthorizeScheduledOboMutation: () => ({ mutate: mockAuthorize, isLoading: false }),
  useRevokeScheduledOboMutation: () => ({ mutate: mockRevoke, isLoading: false }),
  useDeleteScheduleMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useUpdateScheduleMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useRunScheduleNowMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));

const schedule = {
  id: 'sched-1',
  name: 'Morning digest',
  agent_id: 'root',
  cadence: { frequency: 'daily', hour: 9, minute: 0 },
  timezone: 'UTC',
  enabled: false,
  runCount: 0,
  failureCount: 0,
} as TSchedule;

function renderCard(oboServers = ['Files'], oboGrants: string[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(ToastProvider, null, children)),
    );
  }
  return render(
    <ScheduleCard schedule={schedule} oboServers={oboServers} oboGrants={oboGrants} />,
    { wrapper: Wrapper },
  );
}

describe('saved schedule OBO grant actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInspect.mockResolvedValue({
      server: 'Files',
      scopes: 'api://files/Read',
      url: 'https://mcp.example.test',
      binding: 'opaque-preview-binding',
    });
  });

  it('previews the exact provider scope before authorizing the named server', async () => {
    const user = userEvent.setup();
    renderCard();
    expect(screen.getByRole('button', { name: 'com_ui_schedule_obo_authorize' })).toHaveClass(
      'h-theme-button-sm',
    );
    await user.click(screen.getByRole('button', { name: 'com_ui_schedule_obo_authorize' }));
    expect(mockInspect).toHaveBeenCalledWith('sched-1', 'Files', expect.any(AbortSignal));
    const dialog = await screen.findByRole('dialog', { name: 'com_ui_schedule_obo_confirm_title' });
    await waitFor(() => expect(within(dialog).getByText('api://files/Read')).toBeInTheDocument());
    expect(mockAuthorize).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'com_ui_schedule_obo_authorize' }));
    await waitFor(() =>
      expect(mockAuthorize).toHaveBeenCalledWith({
        id: 'sched-1',
        server: 'Files',
        expectedScopes: 'api://files/Read',
        expectedBinding: 'opaque-preview-binding',
      }),
    );
  });

  it('can revoke only the specified schedule and server', async () => {
    const user = userEvent.setup();
    renderCard(['Files'], ['Files']);
    expect(screen.getByRole('button', { name: 'com_ui_schedule_obo_revoke' })).toHaveClass(
      'h-theme-button-sm',
    );
    await user.click(screen.getByRole('button', { name: 'com_ui_schedule_obo_revoke' }));
    expect(mockRevoke).toHaveBeenCalledWith({ id: 'sched-1', server: 'Files' });
  });

  it('keeps an enrolled grant revocable when policy no longer allows new enrollment', async () => {
    const user = userEvent.setup();
    renderCard([], ['Files']);
    expect(screen.queryByRole('button', { name: 'com_ui_schedule_obo_authorize' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'com_ui_schedule_obo_revoke' }));
    expect(mockRevoke).toHaveBeenCalledWith({ id: 'sched-1', server: 'Files' });
    expect(mockInspect).not.toHaveBeenCalled();
  });

  it('never shows revoke for a server with no stored grant', () => {
    renderCard(['Files']);
    expect(screen.queryByRole('button', { name: 'com_ui_schedule_obo_revoke' })).toBeNull();
  });

  it('shows inspection failure without enabling authorization and supports an explicit retry', async () => {
    const user = userEvent.setup();
    mockInspect.mockRejectedValueOnce(new Error('private provider detail'));
    renderCard();
    await user.click(screen.getByRole('button', { name: 'com_ui_schedule_obo_authorize' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('alert');
    expect(
      within(dialog).getByRole('button', { name: 'com_ui_schedule_obo_authorize' }),
    ).toBeDisabled();
    expect(screen.queryByText('private provider detail')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'com_ui_retry' }));
    await waitFor(() => expect(within(dialog).getByText('api://files/Read')).toBeInTheDocument());
    expect(mockInspect).toHaveBeenCalledTimes(2);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('cancels a pending inspection when the owner closes the consent dialog', async () => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    mockInspect.mockImplementationOnce(async (_id, _server, received) => {
      signal = received;
      return new Promise((_, reject) =>
        received?.addEventListener('abort', () => reject(received.reason), { once: true }),
      );
    });
    renderCard();
    await user.click(screen.getByRole('button', { name: 'com_ui_schedule_obo_authorize' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('button', { name: 'com_ui_schedule_obo_authorize' }),
    ).toBeDisabled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(mockAuthorize).not.toHaveBeenCalled();
  });
});
