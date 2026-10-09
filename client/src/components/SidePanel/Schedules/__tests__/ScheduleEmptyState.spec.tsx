import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import ScheduleEmptyState from '../ScheduleEmptyState';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

describe('ScheduleEmptyState', () => {
  it('shows the title and the create hint for a role that can create', () => {
    render(<ScheduleEmptyState canCreate />);

    expect(screen.getByText('com_ui_no_schedules_title')).toBeInTheDocument();
    expect(screen.getByText('com_ui_no_schedules')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('drops the create hint for a role the panel offers no create button to', () => {
    render(<ScheduleEmptyState />);

    expect(screen.getByText('com_ui_no_schedules_title')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_no_schedules')).not.toBeInTheDocument();
  });

  it('swaps to the error message and retries on request', async () => {
    const onRetry = jest.fn();
    render(<ScheduleEmptyState isError onRetry={onRetry} />);

    expect(screen.getByText('com_ui_schedules_error')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_no_schedules_title')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
