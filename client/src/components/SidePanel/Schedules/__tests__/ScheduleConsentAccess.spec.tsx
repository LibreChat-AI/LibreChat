import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@librechat/client';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import type { TSchedule } from 'librechat-data-provider';
import ScheduleCard from '../ScheduleCard';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => false,
  useClockFormat: () => true,
  useWeekStart: () => 0,
}));
jest.mock('~/Providers', () => ({ useAgentsMapContext: () => ({ root: { name: 'Root' } }) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
  Trans: () => null,
}));
jest.mock('~/data-provider', () => ({
  useGetAgentByIdQuery: () => ({}),
  useDeleteScheduleMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useUpdateScheduleMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useRunScheduleNowMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));
jest.mock('../Consent', () => ({
  __esModule: true,
  default: ({ canConfirm }: { canConfirm: boolean }) => (
    <div data-testid="consent-inspection">{String(canConfirm)}</div>
  ),
}));
const schedule: TSchedule = {
  id: 'schedule',
  user: 'owner',
  name: 'Digest',
  prompt: 'Read',
  agent_id: 'root',
  cadence: { frequency: 'daily', hour: 8, minute: 0 },
  timezone: 'UTC',
  target: 'new',
  enabled: false,
  runCount: 0,
  failureCount: 0,
  createdAt: '',
  updatedAt: '',
};

it.each([false, true])(
  'keeps inspection after CREATE removal, feature disabled=%s',
  async (disabled) => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <ScheduleCard
            schedule={{ ...schedule, hasMCPConsent: disabled }}
            consentEnabled={!disabled}
          />
        </ToastProvider>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_options: Digest' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'com_ui_schedule_consent_title' }),
    );
    expect(screen.getByTestId('consent-inspection')).toHaveTextContent('false');
    expect(
      screen.queryByRole('menuitem', { name: 'com_ui_schedule_run_now' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  },
);
