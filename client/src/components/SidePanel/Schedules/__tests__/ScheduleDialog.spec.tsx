import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@librechat/client';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { TSchedule } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import ScheduleDialog from '../ScheduleDialog';

const mockUseClockFormat = jest.fn(() => true);
const mockUseWeekStart = jest.fn(() => 0);

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useClockFormat: () => mockUseClockFormat(),
  useWeekStart: () => mockUseWeekStart(),
}));

/** `@librechat/client` primitives localize through their own `useLocalize`, so the
 *  shared `t` has to resolve too — not just the `i18n` this dialog reads for locale. */
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

const mockMutate = jest.fn();
let createMutationOptions: { onError: (error: Error) => void } | undefined;

/** Server-resolved schedule policy for the render under test. The dialog reads it from
 *  the schedules list query, the same cache entry the panel populates. */
let mockLimits: {
  maxPerUser: number;
  minIntervalMinutes: number;
  requireProject: boolean;
  projectId?: string;
} = {
  maxPerUser: 10,
  minIntervalMinutes: 0,
  requireProject: false,
};

/** A project the paged list has NOT loaded, resolved by its own by-id read. */
let mockFetchedProject: { _id: string; name: string } | undefined;

jest.mock('~/data-provider', () => ({
  useProjectQuery: (projectId?: string | null) => ({
    data: projectId != null && projectId !== '' ? mockFetchedProject : undefined,
  }),
  useListAgentsQuery: () => ({
    data: [
      { id: 'agent-1', name: 'Research Agent' },
      { id: 'agent-2', name: 'Digest Agent' },
    ],
  }),
  useSchedulesQuery: () => ({ data: { schedules: [], limits: mockLimits } }),
  useProjectsInfiniteQuery: () => ({
    data: {
      pages: [
        {
          projects: [
            { _id: 'proj-1', name: 'Weekly Ops' },
            { _id: 'proj-2', name: 'Research' },
          ],
          nextCursor: null,
        },
      ],
    },
    fetchNextPage: jest.fn(),
    isFetchingNextPage: false,
    isLoading: false,
  }),
  useCreateScheduleMutation: (options: { onError: (error: Error) => void }) => {
    createMutationOptions = options;
    return { mutate: mockMutate, isLoading: false };
  },
  useUpdateScheduleMutation: () => ({ mutate: mockMutate, isLoading: false }),
}));

const renderDialog = (schedule?: Partial<TSchedule>, onOpenChange = jest.fn()) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, null, createElement(ToastProvider, null, children)),
    );
  }
  return render(
    <ScheduleDialog
      open={true}
      onOpenChange={onOpenChange}
      schedule={schedule as TSchedule | undefined}
    />,
    { wrapper: Wrapper },
  );
};

const storedSchedule = (over: Partial<TSchedule> = {}): Partial<TSchedule> => ({
  id: 'sched-1',
  name: 'Digest',
  prompt: 'Summarize',
  agent_id: 'agent-1',
  cadence: { frequency: 'daily', hour: 8, minute: 0 },
  timezone: 'America/New_York',
  target: 'new',
  enabled: true,
  configRevision: 3,
  runCount: 0,
  failureCount: 0,
  ...over,
});

/** Fills the two required text fields plus the agent, so a submit exercises the
 *  project rules rather than unrelated validation. */
const fillRequiredFields = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByPlaceholderText('com_ui_schedule_name_placeholder'), 'Digest');
  await user.type(screen.getByPlaceholderText('com_ui_schedule_prompt_placeholder'), 'Summarize');
  const dialog = screen.getByRole('dialog');
  await user.click(within(dialog).getByRole('combobox', { name: 'com_ui_agent' }));
  await user.click(await within(dialog).findByRole('option', { name: /Research Agent/ }));
};

describe('ScheduleDialog', () => {
  afterEach(() => {
    jest.clearAllMocks();
    mockLimits = { maxPerUser: 10, minIntervalMinutes: 0, requireProject: false };
    mockUseClockFormat.mockReturnValue(true);
    mockUseWeekStart.mockReturnValue(0);
    mockFetchedProject = undefined;
    createMutationOptions = undefined;
  });

  /**
   * The agent list must render INSIDE the dialog. Portaled to the body it lands
   * outside Radix's focus trap, where it cannot be clicked, tabbed into, or typed
   * in — and the trap fighting Ariakit for focus locks the page up.
   */
  it('opens the agent list inside the dialog rather than portaling it away', async () => {
    const user = userEvent.setup();
    renderDialog();

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'com_ui_agent' }));

    expect(within(dialog).getByPlaceholderText('com_agents_search_name')).toBeInTheDocument();
  });

  it('closes before opening the agent that owns an admission failure', async () => {
    const user = userEvent.setup();
    const onOpenChange = jest.fn();
    renderDialog(undefined, onOpenChange);
    const error = Object.assign(new Error('missing tool'), {
      response: {
        data: {
          mcp: [
            {
              server: 'Notion',
              agentId: 'child-agent',
              status: 'mcp_configuration_missing',
            },
          ],
        },
      },
    });

    act(() => createMutationOptions?.onError(error));
    await user.click(
      screen.getByRole('button', {
        name: 'Notion, child-agent: com_ui_schedule_mcp_open_agent',
      }),
    );

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('exposes frequency as a radiogroup with the default selected', () => {
    renderDialog();

    const group = screen.getByRole('radiogroup', { name: 'com_ui_schedule_frequency' });
    expect(within(group).getByRole('radio', { name: 'com_ui_schedule_daily' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'com_ui_schedule_weekly' })).not.toBeChecked();
  });

  it('switches the day picker on only for weekly schedules', async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.queryByTestId('schedule-day-1')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'com_ui_schedule_weekly' }));
    expect(screen.getByTestId('schedule-day-1')).toBeInTheDocument();
  });

  /** The submit button sits in the dialog footer, outside the <form>, so it has to
   *  reach it by id — that association is what lets Enter submit from a text field. */
  it('wires the footer submit button to the form', () => {
    renderDialog();

    const form = document.getElementById('schedule-form');
    expect(form).toBeInstanceOf(HTMLFormElement);
    const submit = screen.getByRole('button', { name: 'com_ui_create' });
    expect(submit).toHaveAttribute('type', 'submit');
    expect(submit).toHaveAttribute('form', 'schedule-form');
  });

  it('describes both text fields with placeholders', () => {
    renderDialog();

    expect(screen.getByPlaceholderText('com_ui_schedule_name_placeholder')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('com_ui_schedule_prompt_placeholder')).toBeInTheDocument();
  });

  it('does not offer special-variable insertion in either prompt editor', async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.queryByRole('button', { name: 'com_ui_variables' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'com_ui_expand_editor' }));
    const expandedDialog = screen.getAllByRole('dialog').at(-1);
    expect(expandedDialog).toBeDefined();
    expect(
      within(expandedDialog as HTMLElement).queryByRole('button', { name: 'com_ui_variables' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the expanded prompt editor available and synchronized', async () => {
    const user = userEvent.setup();
    renderDialog();

    const prompt = screen.getByPlaceholderText('com_ui_schedule_prompt_placeholder');
    await user.type(prompt, 'Initial prompt');
    await user.click(screen.getByRole('button', { name: 'com_ui_expand_editor' }));

    const expandedDialog = screen.getAllByRole('dialog').at(-1);
    expect(expandedDialog).toBeDefined();
    const expandedPrompt = within(expandedDialog as HTMLElement).getByRole('textbox', {
      name: 'com_ui_prompt',
    });
    expect(expandedPrompt).toHaveValue('Initial prompt');

    await user.type(expandedPrompt, ' with details');
    expect(prompt).toHaveValue('Initial prompt with details');
  });

  it('preserves prompt validation and accessibility relationships', async () => {
    const user = userEvent.setup();
    renderDialog();

    const prompt = screen.getByPlaceholderText('com_ui_schedule_prompt_placeholder');
    expect(prompt).toHaveAccessibleName('com_ui_prompt');
    expect(prompt).toHaveAttribute('aria-required', 'true');
    expect(prompt).toHaveAttribute('aria-describedby', 'schedule-prompt-message');
    expect(prompt).toHaveAttribute('aria-invalid', 'false');

    await user.click(screen.getByRole('button', { name: 'com_ui_create' }));

    await waitFor(() => expect(prompt).toHaveAttribute('aria-invalid', 'true'));
    expect(document.getElementById('schedule-prompt-message')).toHaveTextContent(
      'com_ui_field_required',
    );
  });

  describe('custom cron cadence', () => {
    it('swaps the structured time controls for an expression field', async () => {
      const user = userEvent.setup();
      renderDialog();

      expect(screen.getByRole('button', { name: /^com_ui_schedule_time/ })).toBeInTheDocument();
      await user.click(screen.getByRole('radio', { name: 'com_ui_schedule_cron' }));

      expect(
        screen.queryByRole('button', { name: /^com_ui_schedule_time/ }),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId('schedule-cron-input')).toBeInTheDocument();
    });

    it('blocks submit on an expression that never runs', async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole('radio', { name: 'com_ui_schedule_cron' }));

      const field = screen.getByTestId('schedule-cron-input');
      await user.clear(field);
      // Syntactically valid, but February never has a 30th: nothing would ever fire.
      await user.type(field, '0 9 30 2 *');

      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('com_ui_schedule_cron_invalid')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'com_ui_create' })).toBeDisabled();
    });

    it('refuses the seconds and year forms the engine cannot honour', async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole('radio', { name: 'com_ui_schedule_cron' }));

      const field = screen.getByTestId('schedule-cron-input');
      await user.clear(field);
      // A seconds field promises a precision a thirty-second tick with jitter cannot
      // keep, and a pinned year makes a cadence that runs out.
      await user.type(field, '0 0 9 * * 1-5');
      expect(field).toHaveAttribute('aria-invalid', 'true');

      await user.clear(field);
      await user.type(field, '0 9 * * 1-5');
      expect(field).toHaveAttribute('aria-invalid', 'false');
    });

    it('previews the next runs in the schedule timezone', async () => {
      const user = userEvent.setup();
      renderDialog(storedSchedule({ cadence: { frequency: 'cron', expression: '0 9 * * *' } }));

      expect(screen.getByTestId('schedule-cron-input')).toHaveValue('0 9 * * *');
      const preview = await screen.findByTestId('schedule-preview');
      // Three occurrences, each rendered at 9 AM in America/New_York rather than at
      // whatever that instant reads as in the browser's own zone.
      expect(within(preview).getAllByRole('listitem')).toHaveLength(3);
      for (const item of within(preview).getAllByRole('listitem')) {
        expect(item).toHaveTextContent(/9:00\s*AM/i);
      }
      await user.click(screen.getByRole('radio', { name: 'com_ui_schedule_daily' }));
      expect(screen.queryByTestId('schedule-preview')).not.toBeInTheDocument();
    });

    it('submits the expression as a cron cadence', async () => {
      const user = userEvent.setup();
      renderDialog();
      await fillRequiredFields(user);
      await user.click(screen.getByRole('radio', { name: 'com_ui_schedule_cron' }));
      const field = screen.getByTestId('schedule-cron-input');
      await user.clear(field);
      await user.type(field, '0 9,17 * * 1-5');

      await user.click(screen.getByRole('button', { name: 'com_ui_create' }));

      await waitFor(() => expect(mockMutate).toHaveBeenCalled());
      expect(mockMutate.mock.calls[0][0].cadence).toEqual({
        frequency: 'cron',
        expression: '0 9,17 * * 1-5',
      });
    });

    it('refuses a cadence the interval floor would reject', async () => {
      mockLimits = { maxPerUser: 10, minIntervalMinutes: 60, requireProject: false };
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole('radio', { name: 'com_ui_schedule_cron' }));
      const field = screen.getByTestId('schedule-cron-input');
      await user.clear(field);
      await user.type(field, '*/15 * * * *');

      expect(screen.getByText(/com_ui_schedule_min_interval/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'com_ui_create' })).toBeDisabled();
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field.getAttribute('aria-describedby')).toContain('schedule-cadence-message');
    });

    it('still lets a disabled schedule below the floor be renamed', async () => {
      // The API accepts a rename that changes no timing, so the dialog must not hold
      // a schedule hostage to a floor raised after it was created.
      mockLimits = { maxPerUser: 10, minIntervalMinutes: 100_000, requireProject: false };
      const user = userEvent.setup();
      renderDialog(storedSchedule({ enabled: false }));

      await user.type(screen.getByPlaceholderText('com_ui_schedule_name_placeholder'), ' v2');
      const save = screen.getByRole('button', { name: 'com_ui_save' });
      expect(save).toBeEnabled();

      await user.click(save);
      await waitFor(() => expect(mockMutate).toHaveBeenCalled());
      expect(mockMutate.mock.calls[0][0].payload.cadence).toBeUndefined();
    });
  });

  describe('weekly days', () => {
    it('offers every day as a toggle, defaulting to the server default day', async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole('radio', { name: 'com_ui_schedule_weekly' }));

      // The long name is the accessible one: "Mon" reads fine at a glance but poorly
      // aloud.
      const monday = screen.getByRole('button', { name: 'Monday' });
      expect(monday).toHaveAttribute('aria-pressed', 'true');
      // And on hover: the narrow visible labels repeat within a week, so the
      // title spells the day out for a sighted user too.
      expect(monday).toHaveAttribute('title', 'Monday');
      expect(screen.getByRole('button', { name: 'Saturday' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('submits several days, sorted, from one weekly cadence', async () => {
      const user = userEvent.setup();
      renderDialog();
      await fillRequiredFields(user);
      await user.click(screen.getByRole('radio', { name: 'com_ui_schedule_weekly' }));
      // Clicked out of order, to prove the submitted set is sorted rather than
      // whatever order the user happened to press.
      await user.click(screen.getByRole('button', { name: 'Friday' }));
      await user.click(screen.getByRole('button', { name: 'Wednesday' }));

      await user.click(screen.getByRole('button', { name: 'com_ui_create' }));

      await waitFor(() => expect(mockMutate).toHaveBeenCalled());
      expect(mockMutate.mock.calls[0][0].cadence).toEqual({
        frequency: 'weekly',
        hour: 9,
        minute: 0,
        daysOfWeek: [1, 3, 5],
      });
    });

    it('shows a stored multi-day schedule as the set it actually runs on', () => {
      // The single-day picker this replaces could only hold `daysOfWeek[0]`, so an
      // API-created multi-day schedule read as running on one day.
      renderDialog(
        storedSchedule({
          cadence: { frequency: 'weekly', hour: 8, minute: 0, daysOfWeek: [2, 4] },
        }),
      );

      expect(screen.getByRole('button', { name: 'Tuesday' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByRole('button', { name: 'Thursday' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByRole('button', { name: 'Monday' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(screen.getByTestId('schedule-summary')).toHaveTextContent(
        'com_ui_schedule_runs_weekly',
      );
    });

    it('blocks submit when every day has been cleared', async () => {
      // Expressible in the form but not on the wire: the payload schema requires at
      // least one day, so this must not silently save as Monday.
      const user = userEvent.setup();
      renderDialog();
      await fillRequiredFields(user);
      await user.click(screen.getByRole('radio', { name: 'com_ui_schedule_weekly' }));
      await user.click(screen.getByRole('button', { name: 'Monday' }));

      expect(screen.getByText('com_ui_schedule_days_required')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'com_ui_create' })).toBeDisabled();
      // The summary must not contradict that message by describing the Monday
      // fallback `buildCadence` substitutes for the empty set.
      expect(screen.queryByTestId('schedule-summary')).not.toBeInTheDocument();
    });
  });

  describe('clock and week preferences', () => {
    it('orders the day pills from the preferred first day of the week', async () => {
      const user = userEvent.setup();
      mockUseWeekStart.mockReturnValue(1);
      renderDialog();
      await user.click(screen.getByRole('radio', { name: 'com_ui_schedule_weekly' }));

      const pills = screen
        .getAllByRole('button')
        .filter((button) => button.dataset.testid?.startsWith('schedule-day-'));
      // The VALUES stay Sunday-first (the indices the cadence stores); only the
      // presentation rotates, so Monday leads and Sunday trails.
      expect(pills.map((pill) => pill.getAttribute('aria-label'))).toEqual([
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
        'Sunday',
      ]);
    });
  });

  describe('time picker', () => {
    it('announces the selected time, not just the field label', () => {
      renderDialog(storedSchedule({ cadence: { frequency: 'daily', hour: 8, minute: 30 } }));

      // `aria-labelledby` REPLACES a button's child text, so naming the trigger after
      // the field alone left the selected time unreadable without opening the columns.
      expect(
        screen.getByRole('button', { name: /^com_ui_schedule_time.*8:30/ }),
      ).toBeInTheDocument();
    });

    it('sets hour and minute together, so a half-applied time cannot submit', async () => {
      const user = userEvent.setup();
      renderDialog(storedSchedule({ cadence: { frequency: 'daily', hour: 8, minute: 0 } }));

      await user.click(screen.getByRole('button', { name: /^com_ui_schedule_time/ }));
      const minutes = screen.getByRole('radiogroup', { name: 'com_ui_schedule_minute' });
      await user.click(within(minutes).getByRole('radio', { name: '45' }));

      await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
      await waitFor(() => expect(mockMutate).toHaveBeenCalled());
      expect(mockMutate.mock.calls[0][0].payload.cadence).toEqual({
        frequency: 'daily',
        hour: 8,
        minute: 45,
      });
    });

    it('drops to a single minutes column for an hourly cadence', async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole('radio', { name: 'com_ui_schedule_hourly' }));

      await user.click(screen.getByRole('button', { name: /^com_ui_schedule_minutes_past_hour/ }));
      expect(
        screen.getByRole('radiogroup', { name: 'com_ui_schedule_minute' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('radiogroup', { name: 'com_ui_schedule_hour' }),
      ).not.toBeInTheDocument();
    });

    it('follows the clock format preference into the columns', async () => {
      const user = userEvent.setup();
      mockUseClockFormat.mockReturnValue(false);
      renderDialog();

      await user.click(screen.getByRole('button', { name: /^com_ui_schedule_time/ }));
      expect(
        screen.queryByRole('radiogroup', { name: 'com_ui_schedule_meridiem' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('timezone', () => {
    it('defaults a new schedule to the browser zone and submits it', async () => {
      const user = userEvent.setup();
      renderDialog();
      await fillRequiredFields(user);

      // Queried directly rather than scoped to role="dialog": the picker popovers
      // render as dialogs of their own, so that scope goes ambiguous mid-file.
      expect(screen.getByRole('combobox', { name: 'com_ui_schedule_timezone' })).toHaveTextContent(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );

      await user.click(screen.getByRole('button', { name: 'com_ui_create' }));
      await waitFor(() => expect(mockMutate).toHaveBeenCalled());
      expect(mockMutate.mock.calls[0][0].timezone).toBe(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
    });

    it('shows the stored zone rather than the browser one when editing', () => {
      renderDialog(storedSchedule());

      expect(screen.getByRole('combobox', { name: 'com_ui_schedule_timezone' })).toHaveTextContent(
        'America/New_York',
      );
      expect(screen.getByTestId('schedule-summary')).toHaveTextContent('America/New_York');
    });

    it('sends a zone change on its own, without a cadence', async () => {
      // The server recomputes the next run whenever the timezone changes, so a
      // zone-only edit is a real timing edit and must reach it.
      const user = userEvent.setup();
      renderDialog(storedSchedule());

      await user.click(screen.getByRole('combobox', { name: 'com_ui_schedule_timezone' }));
      await user.type(screen.getByPlaceholderText('com_ui_schedule_timezone_search'), 'UTC');
      await user.click(await screen.findByRole('option', { name: /^UTC/ }));

      await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
      await waitFor(() => expect(mockMutate).toHaveBeenCalled());
      expect(mockMutate.mock.calls[0][0].payload.timezone).toBe('UTC');
      // And ONLY the zone: a cadence rebuilt from the form would overwrite stored
      // fields the pickers cannot represent (an API-created hourly's nonzero hour).
      expect(mockMutate.mock.calls[0][0].payload.cadence).toBeUndefined();
    });

    it('validates a cron expression against the selected zone, not the browser one', async () => {
      // `0 0,12 * * *` is a 12-hour gap nominally and an 11-hour one in New York on
      // the day it springs forward, so a floor between the two accepts it in one zone
      // and refuses it in the other.
      mockLimits = { maxPerUser: 10, minIntervalMinutes: 700, requireProject: false };
      const user = userEvent.setup();
      renderDialog(
        storedSchedule({
          cadence: { frequency: 'cron', expression: '0 0,12 * * *' },
          timezone: 'UTC',
        }),
      );

      expect(screen.queryByText(/com_ui_schedule_min_interval/)).not.toBeInTheDocument();

      await user.click(screen.getByRole('combobox', { name: 'com_ui_schedule_timezone' }));
      await user.type(
        screen.getByPlaceholderText('com_ui_schedule_timezone_search'),
        'America/New_York',
      );
      await user.click(await screen.findByRole('option', { name: /^America\/New_York/ }));

      expect(screen.getByText(/com_ui_schedule_min_interval/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeDisabled();
    });
  });

  describe('project scope', () => {
    it('submits the chosen project so its runs are filed there', async () => {
      const user = userEvent.setup();
      renderDialog();
      await fillRequiredFields(user);

      await user.click(screen.getByRole('combobox', { name: 'com_ui_project' }));
      // Narrowed through the search field rather than picked from the open list: the
      // popover renders its options through a VIRTUALIZED renderer, which sizes its
      // window from a scroll height jsdom always reports as 0 and so materializes only
      // a couple of rows. Filtering to one match keeps the assertion about the dialog's
      // behaviour instead of the test environment's layout.
      await user.type(screen.getByPlaceholderText('com_ui_search_projects'), 'Weekly');
      await user.click(await screen.findByRole('option', { name: /Weekly Ops/ }));
      await user.click(screen.getByRole('button', { name: 'com_ui_create' }));

      expect(mockMutate).toHaveBeenCalledWith(expect.objectContaining({ chatProjectId: 'proj-1' }));
    });

    /** An unscoped schedule must not send `chatProjectId: ''` — the payload schema
     *  refuses an empty string, so the create would 400 rather than file loose. */
    it('omits the field entirely when no project is chosen', async () => {
      const user = userEvent.setup();
      renderDialog();
      await fillRequiredFields(user);

      await user.click(screen.getByRole('button', { name: 'com_ui_create' }));

      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(mockMutate.mock.calls[0][0]).not.toHaveProperty('chatProjectId');
    });

    /** The server refuses an unscoped create under this policy; blocking it here keeps
     *  the user from losing a filled-in form to a 400. */
    it('blocks submission when the deployment requires a project', async () => {
      mockLimits = { maxPerUser: 10, minIntervalMinutes: 0, requireProject: true };
      const user = userEvent.setup();
      renderDialog();
      await fillRequiredFields(user);

      await user.click(screen.getByRole('button', { name: 'com_ui_create' }));

      expect(mockMutate).not.toHaveBeenCalled();
      expect(await screen.findByText('com_ui_field_required')).toBeInTheDocument();
    });

    /** The server accepts `chatProjectId: null` to clear a scope, but that path is only
     *  reachable if the picker offers something to select — a placeholder cannot be
     *  chosen, so without a real option a scoped schedule could never be unscoped. */
    it('can clear a stored project through a selectable No project option', async () => {
      const user = userEvent.setup();
      renderDialog(storedSchedule({ chatProjectId: 'proj-1' }));

      expect(screen.getByRole('combobox', { name: 'com_ui_project' })).toHaveTextContent(
        'Weekly Ops',
      );
      await user.click(screen.getByRole('combobox', { name: 'com_ui_project' }));
      await user.click(await screen.findByRole('option', { name: /com_ui_schedule_project_none/ }));
      await user.click(screen.getByRole('button', { name: 'com_ui_save' }));

      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ chatProjectId: null }) }),
      );
    });

    /** There is no "no project" to offer when one is mandatory. */
    it('offers no clearing option when a project is required', async () => {
      mockLimits = { maxPerUser: 10, minIntervalMinutes: 0, requireProject: true };
      const user = userEvent.setup();
      renderDialog(storedSchedule({ chatProjectId: 'proj-1' }));

      await user.click(screen.getByRole('combobox', { name: 'com_ui_project' }));

      expect(
        screen.queryByRole('option', { name: /com_ui_schedule_project_none/ }),
      ).not.toBeInTheDocument();
    });

    /** A stored project outside the loaded page would otherwise render the placeholder —
     *  telling the owner a scoped schedule has no project. */
    it('names a stored project the paged list has not loaded', async () => {
      mockFetchedProject = { _id: 'proj-999', name: 'Archived Ops' };
      renderDialog(storedSchedule({ chatProjectId: 'proj-999' }));

      const picker = screen.getByRole('combobox', { name: 'com_ui_project' });
      expect(picker).toHaveTextContent('Archived Ops');
      expect(picker).not.toHaveTextContent('com_ui_schedule_project_none');
    });

    /** Even with no name available, the id beats claiming the schedule is unscoped. */
    it('falls back to the stored id rather than showing the empty placeholder', async () => {
      renderDialog(storedSchedule({ chatProjectId: 'proj-999' }));

      expect(screen.getByRole('combobox', { name: 'com_ui_project' })).toHaveTextContent(
        'proj-999',
      );
    });

    /** The server waives the requirement for an edit that leaves a schedule DISABLED,
     *  so a row auto-disabled for `project_required` can still be renamed. Requiring a
     *  project in the form made that unreachable — and an owner with no projects at all
     *  could not edit the stopped schedule. */
    it('lets a disabled unscoped schedule be edited while a project is required', async () => {
      mockLimits = { maxPerUser: 10, minIntervalMinutes: 0, requireProject: true };
      const user = userEvent.setup();
      renderDialog(storedSchedule({ enabled: false, chatProjectId: undefined }));

      await user.clear(screen.getByPlaceholderText('com_ui_schedule_name_placeholder'));
      await user.type(screen.getByPlaceholderText('com_ui_schedule_name_placeholder'), 'Renamed');
      await user.click(screen.getByRole('button', { name: 'com_ui_save' }));

      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ name: 'Renamed' }) }),
      );
    });

    /** An ENABLED schedule still has to satisfy the requirement. */
    it('still requires a project when the edit leaves the schedule enabled', async () => {
      mockLimits = { maxPerUser: 10, minIntervalMinutes: 0, requireProject: true };
      const user = userEvent.setup();
      renderDialog(storedSchedule({ enabled: true, chatProjectId: undefined }));

      await user.clear(screen.getByPlaceholderText('com_ui_schedule_name_placeholder'));
      await user.type(screen.getByPlaceholderText('com_ui_schedule_name_placeholder'), 'Renamed');
      await user.click(screen.getByRole('button', { name: 'com_ui_save' }));

      expect(mockMutate).not.toHaveBeenCalled();
      expect(await screen.findByText('com_ui_field_required')).toBeInTheDocument();
    });

    /** A pin is the server's decision. Offering a picker would only invite a choice
     *  the write handler rejects, so the dialog shows the destination instead — and
     *  sends nothing, leaving the pin authoritative even if it moved since the dialog
     *  opened. */
    it('shows a pinned project as read-only and never sends it', async () => {
      mockLimits = {
        maxPerUser: 10,
        minIntervalMinutes: 0,
        requireProject: true,
        projectId: 'proj-2',
      };
      const user = userEvent.setup();
      renderDialog();
      await fillRequiredFields(user);

      expect(screen.getByTestId('schedule-project-pinned')).toHaveTextContent('Research');
      expect(screen.queryByRole('combobox', { name: 'com_ui_project' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'com_ui_create' }));

      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(mockMutate.mock.calls[0][0]).not.toHaveProperty('chatProjectId');
    });
  });
});
