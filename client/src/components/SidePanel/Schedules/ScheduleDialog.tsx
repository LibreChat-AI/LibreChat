import { useMemo, useRef, useState } from 'react';
import { v4 } from 'uuid';
import { Folder } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useForm, Controller } from 'react-hook-form';
import {
  Input,
  Label,
  Radio,
  Button,
  TimePicker,
  MinutePicker,
  FieldMessage,
  Spinner,
  OGDialog,
  ControlCombobox,
  OGDialogTemplate,
  useToastContext,
} from '@librechat/client';
import {
  PermissionBits,
  isCronCadence,
  nextRunInstants,
  scheduleFrequencies,
  isValidCronExpression,
  cadenceIntervalMinutes,
  SCHEDULE_CRON_MAX_LENGTH,
} from 'librechat-data-provider';
import type {
  TSchedule,
  TCreateSchedule,
  TScheduleCadence,
  ScheduleFrequency,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import {
  describeCadence,
  formatRunInstant,
  formatScheduleDay,
  formatScheduleDayNarrow,
  resolveLocalTimezone,
  buildTimezoneOptions,
  formatTimezoneOffset,
} from './cadence';
import {
  useProjectQuery,
  useListAgentsQuery,
  useSchedulesQuery,
  useCreateScheduleMutation,
  useUpdateScheduleMutation,
} from '~/data-provider';
import { scheduleMCPErrorMessage, scheduleMCPErrorOutcomes } from './errors';
import { useLocalize, useClockFormat, useWeekStart } from '~/hooks';
import { useChatProjectPicker } from './useScheduleProjects';
import { VariableEditor } from '~/components/Variables';
import ScheduleMCPRecovery from './ScheduleMCPRecovery';
import { rotateWeekFrom } from '~/utils/clock';
import { cn } from '~/utils';

interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule?: TSchedule;
  triggerRef?: React.MutableRefObject<HTMLButtonElement | null>;
}

type ScheduleFormValues = {
  name: string;
  prompt: string;
  agent_id: string;
  /** `''` means unscoped; the picker has no null option of its own. */
  chatProjectId: string;
  frequency: ScheduleFrequency;
  hour: number;
  minute: number;
  daysOfWeek: number[];
  /** Only read when `frequency` is `cron`; held across a switch away and back so a
   *  user who tries a preset does not lose the expression they typed. */
  expression: string;
  timezone: string;
};

const FREQUENCY_LABELS: Record<ScheduleFrequency, TranslationKeys> = {
  hourly: 'com_ui_schedule_hourly',
  daily: 'com_ui_schedule_daily',
  weekdays: 'com_ui_schedule_weekdays',
  weekly: 'com_ui_schedule_weekly',
  cron: 'com_ui_schedule_cron',
};

/** Every weekday at 09:00: a recognisable starting point to edit rather than an
 *  empty field the user has to guess the field order from. */
const DEFAULT_CRON = '0 9 * * 1-5';

/** Mirrors the server's default weekly day (Monday) when a weekly cadence carries no
 *  days, so a new weekly schedule opens on the same day an API-created one fires. */
const DEFAULT_WEEKLY_DAYS = [1];

/** Enough previewed occurrences to show the SHAPE of a cadence (that `0 9,17 * * 1-5`
 *  fires twice a day), which a single row cannot. Kept small deliberately so the
 *  schedule's next occurrences remain easy to scan in the dialog. */
const PREVIEW_RUN_COUNT = 3;

const FORM_ID = 'schedule-form';

const getDefaultValues = (schedule?: TSchedule): ScheduleFormValues => {
  const localTimezone = resolveLocalTimezone();
  if (!schedule) {
    return {
      name: '',
      prompt: '',
      agent_id: '',
      chatProjectId: '',
      frequency: 'daily',
      hour: 9,
      minute: 0,
      daysOfWeek: DEFAULT_WEEKLY_DAYS,
      expression: DEFAULT_CRON,
      timezone: localTimezone,
    };
  }
  const identity = {
    name: schedule.name,
    prompt: schedule.prompt,
    agent_id: schedule.agent_id,
    chatProjectId: schedule.chatProjectId ?? '',
    // A stored row always has one; the fallback only covers a legacy row written
    // before the field existed, which would otherwise render an empty picker.
    timezone: schedule.timezone || localTimezone,
  };
  const cadence = schedule.cadence;
  if (isCronCadence(cadence)) {
    // A cron row carries no hour or minute of its own, so the structured pickers keep
    // their defaults: switching away from Custom then lands on a sensible time rather
    // than on whatever the expression's first field happened to be.
    return {
      ...identity,
      frequency: 'cron',
      hour: 9,
      minute: 0,
      daysOfWeek: DEFAULT_WEEKLY_DAYS,
      expression: cadence.expression,
    };
  }
  return {
    ...identity,
    frequency: cadence.frequency,
    hour: cadence.hour,
    minute: cadence.minute,
    daysOfWeek: cadence.daysOfWeek?.length
      ? [...cadence.daysOfWeek].sort((a, b) => a - b)
      : DEFAULT_WEEKLY_DAYS,
    expression: DEFAULT_CRON,
  };
};

type CadenceFormValues = Pick<
  ScheduleFormValues,
  'frequency' | 'hour' | 'minute' | 'daysOfWeek' | 'expression'
>;

const buildCadence = (values: CadenceFormValues): TScheduleCadence => {
  if (values.frequency === 'cron') {
    return { frequency: 'cron', expression: values.expression.trim() };
  }
  if (values.frequency === 'hourly') {
    return { frequency: 'hourly', hour: 0, minute: values.minute };
  }
  if (values.frequency === 'weekly') {
    return {
      frequency: 'weekly',
      hour: values.hour,
      minute: values.minute,
      daysOfWeek: values.daysOfWeek.length
        ? [...values.daysOfWeek].sort((a, b) => a - b)
        : DEFAULT_WEEKLY_DAYS,
    };
  }
  return { frequency: values.frequency, hour: values.hour, minute: values.minute };
};

export default function ScheduleDialog({
  open,
  onOpenChange,
  schedule,
  triggerRef,
}: ScheduleDialogProps) {
  const navigate = useNavigate();
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const { showToast } = useToastContext();
  const locale = i18n.language;
  const [mcpRecoveryOutcomes, setMCPRecoveryOutcomes] = useState<
    ReturnType<typeof scheduleMCPErrorOutcomes>
  >([]);

  const {
    control,
    register,
    watch,
    setValue,
    handleSubmit,
    formState: { dirtyFields, errors },
  } = useForm<ScheduleFormValues>({
    defaultValues: getDefaultValues(schedule),
    mode: 'onChange',
  });
  /** The revision the form defaults were built from, captured at the same instant.
   *  The `schedule` prop keeps refreshing while the dialog is open (the schedules
   *  query polls), so fencing with the LIVE prop's revision would stamp a freshly
   *  refreshed revision onto a cadence rebuilt from this stale snapshot — exactly
   *  the overwrite the fence exists to refuse. */
  const openedConfigRevision = useRef(schedule?.configRevision);
  const frequency = watch('frequency');
  const hour = watch('hour');
  const minute = watch('minute');
  const daysOfWeek = watch('daysOfWeek');
  const expression = watch('expression');
  const timezone = watch('timezone');
  const selectedAgentId = watch('agent_id');
  /** Not named `hour12`: that is already the form's own 12-hour clock VALUE (1-12).
   *  This is the preference deciding whether a time is written with a meridiem. */
  const prefersMeridiem = useClockFormat();
  const weekStartsOn = useWeekStart();
  /** The day pills read in the user's own week order. Their VALUES are still the
   *  Sunday-first indices the cadence stores; only the presentation rotates. */
  const weekdayIndexes = useMemo(() => rotateWeekFrom(weekStartsOn), [weekStartsOn]);

  const { data: agents } = useListAgentsQuery(
    { requiredPermission: PermissionBits.VIEW },
    { select: (res) => res.data },
  );

  const agentItems = useMemo(
    () => (agents ?? []).map((agent) => ({ label: agent.name || agent.id, value: agent.id })),
    [agents],
  );
  const agentNames = useMemo(
    () => Object.fromEntries((agents ?? []).map((agent) => [agent.id, agent.name || agent.id])),
    [agents],
  );

  /** Reads the SAME cached list query the panel already holds, so the dialog needs no
   *  request of its own — and so the form mirrors exactly the policy the write handler
   *  enforces rather than a second, client-side interpretation of the config. */
  const { data: schedulesData } = useSchedulesQuery();
  const pinnedProjectId = schedulesData?.limits.projectId;
  const minIntervalMinutes = schedulesData?.limits.minIntervalMinutes;
  const requireProject = schedulesData?.limits.requireProject === true;
  const {
    items: loadedProjectItems,
    namesById: projectNames,
    hasNextPage: hasMoreProjects,
    fetchNextPage: fetchMoreProjects,
    isFetchingNextPage: isFetchingMoreProjects,
  } = useChatProjectPicker(open);
  const selectedProjectId = watch('chatProjectId');

  /** Clearing the scope needs a real OPTION, not just the placeholder: with only live
   *  projects in the list, a schedule that has one could never be set back to none, and
   *  the server's `chatProjectId: null` clearing path would be unreachable from the UI.
   *  Omitted when a project is mandatory — there is nothing valid to select. */
  const projectItems = useMemo(
    () =>
      requireProject
        ? loadedProjectItems
        : [
            {
              label: localize('com_ui_schedule_project_none'),
              value: '',
              icon: <Folder className="h-4 w-4 text-text-secondary" aria-hidden="true" />,
            },
            ...loadedProjectItems,
          ],
    [requireProject, loadedProjectItems, localize],
  );

  /** The stored (or pinned) project can sit outside the pages loaded so far, and the
   *  combobox renders its PLACEHOLDER for an unknown name — telling the owner a scoped
   *  schedule has no project. Read that one project directly instead. */
  const displayedProjectId = pinnedProjectId ?? (selectedProjectId || undefined);
  const isProjectPaged = displayedProjectId != null && projectNames.has(displayedProjectId);
  const { data: fetchedProject } = useProjectQuery(isProjectPaged ? undefined : displayedProjectId);
  const projectDisplayName = (projectId: string): string =>
    projectNames.get(projectId) ??
    (fetchedProject?._id === projectId ? fetchedProject.name : undefined) ??
    projectId;

  const frequencyOptions = useMemo(
    () =>
      scheduleFrequencies.map((value) => ({
        value,
        label: localize(FREQUENCY_LABELS[value]),
      })),
    [localize],
  );

  /** The picker takes its wording as props so the primitive carries no translation
   *  keys of its own. */
  const timeLabels = useMemo(
    () => ({
      hour: localize('com_ui_schedule_hour'),
      minute: localize('com_ui_schedule_minute'),
      meridiem: localize('com_ui_schedule_meridiem'),
      am: localize('com_ui_schedule_am'),
      pm: localize('com_ui_schedule_pm'),
    }),
    [localize],
  );

  const timezoneItems = useMemo(() => {
    const zones = buildTimezoneOptions(resolveLocalTimezone(), schedule?.timezone);
    return zones.map((zone) => {
      const offset = formatTimezoneOffset(zone, locale);
      return { value: zone, label: offset ? `${zone} (${offset})` : zone };
    });
  }, [schedule?.timezone, locale]);

  /** Idempotency key for the create being attempted. Held in a ref so every retry of
   *  the same intent reuses it, and rotated when the attempt SUCCEEDS or when the
   *  form content changes after a failed one (the server pins each key to the exact
   *  payload it first saw, so retrying edited content under the old key answers 409).
   *  `uuid` rather than `crypto.randomUUID`, which secure contexts gate — an HTTP/IP
   *  deployment would throw here and never open the dialog. */
  const createRequestId = useRef(v4());
  /** Fingerprint of the payload the current key was last attempted with. */
  const lastAttemptedPayload = useRef<string | null>(null);

  const createSchedule = useCreateScheduleMutation({
    onSuccess: () => {
      setMCPRecoveryOutcomes([]);
      createRequestId.current = v4();
      lastAttemptedPayload.current = null;
      showToast({ message: localize('com_ui_schedule_created'), status: 'success' });
      onOpenChange(false);
    },
    onError: (error) => {
      setMCPRecoveryOutcomes(scheduleMCPErrorOutcomes(error));
      showToast({
        message: scheduleMCPErrorMessage(error, localize) ?? localize('com_ui_error'),
        status: 'error',
      });
    },
  });

  const updateSchedule = useUpdateScheduleMutation({
    onSuccess: () => {
      setMCPRecoveryOutcomes([]);
      showToast({ message: localize('com_ui_schedule_updated'), status: 'success' });
      onOpenChange(false);
    },
    onError: (error) => {
      setMCPRecoveryOutcomes(scheduleMCPErrorOutcomes(error));
      const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
      showToast({
        message:
          scheduleMCPErrorMessage(error, localize) ??
          localize(status === 409 ? 'com_ui_schedule_conflict' : 'com_ui_error'),
        status: 'error',
      });
    },
  });

  const isLoading = createSchedule.isLoading || updateSchedule.isLoading;

  /** Whether this submit carries a cadence at all: a pure rename does not, and the
   *  API only validates a cadence it actually receives. Only touched cadence
   *  CONTROLS count: a zone-only edit must not ship a cadence rebuilt from this
   *  form, which would overwrite stored fields it cannot represent (an
   *  API-created hourly cadence's nonzero hour, for one). */
  const cadenceTouched =
    dirtyFields.frequency === true ||
    dirtyFields.hour === true ||
    dirtyFields.minute === true ||
    dirtyFields.daysOfWeek != null ||
    dirtyFields.expression === true;
  /** Whether this submit changes the schedule's TIMING. The zone alone re-times
   *  every occurrence (the server recomputes the next run and re-measures the
   *  interval floor against the effective cadence/zone pair), so the floor below
   *  validates it even though no cadence travels with it. */
  const timingTouched = cadenceTouched || dirtyFields.timezone === true;

  const onSubmit = (values: ScheduleFormValues) => {
    if (schedule) {
      // Preserve the stored cadence entirely on a pure rename (no cadence control
      // touched).
      const cadence = buildCadence(values);
      // PATCH only the fields the user actually touched, like the cadence handling
      // above: submitting the whole form snapshot silently overwrites fields another
      // tab or session edited while this dialog sat open (the server's revision fence
      // reads the CURRENT revision, so it cannot catch a stale full-form write).
      const payload = {
        ...(dirtyFields.name ? { name: values.name.trim() } : {}),
        ...(dirtyFields.prompt ? { prompt: values.prompt.trim() } : {}),
        ...(dirtyFields.agent_id ? { agent_id: values.agent_id } : {}),
        // Explicit `null` is the only way to CLEAR the scope; omitting the field
        // leaves the stored project alone. Never sent while pinned — the server owns
        // the destination there, and echoing it back would only be a chance to
        // disagree with a pin that changed since the dialog opened.
        ...(dirtyFields.chatProjectId && pinnedProjectId == null
          ? { chatProjectId: values.chatProjectId || null }
          : {}),
        ...(cadenceTouched ? { cadence } : {}),
        ...(dirtyFields.timezone === true ? { timezone: values.timezone } : {}),
      };
      // Nothing touched: a field-less PATCH is refused server-side (it would rotate
      // the schedule's fencing for a request that changes nothing), so just close.
      if (Object.keys(payload).length === 0) {
        onOpenChange(false);
        return;
      }
      updateSchedule.mutate({
        id: schedule.id,
        // Fence on the revision this dialog OPENED with (not the live prop, which
        // polling refreshes under the stale form): cadence is rebuilt whole from
        // the opening snapshot, so an edit from another tab would otherwise be
        // silently overwritten — the server answers 409 instead.
        payload: {
          ...payload,
          ...(openedConfigRevision.current != null
            ? { expectedConfigRevision: openedConfigRevision.current }
            : {}),
        },
      });
      return;
    }
    const content = {
      name: values.name.trim(),
      prompt: values.prompt.trim(),
      agent_id: values.agent_id,
      ...(pinnedProjectId == null && values.chatProjectId
        ? { chatProjectId: values.chatProjectId }
        : {}),
      cadence: buildCadence(values),
      timezone: values.timezone,
      target: 'new' as const,
      enabled: true,
    };
    // STABLE across retries of the SAME intent, which is the whole point: the server
    // commits the row and arms it in two writes, so a failure between them leaves the
    // client unable to tell what persisted, and a fresh key per attempt would make
    // each retry a new schedule. But the server pins each key to the exact payload it
    // first saw — so once the user EDITS the form after a failed attempt, this is a
    // new intent and needs a new key, or the retry answers 409 until the dialog is
    // reopened.
    const fingerprint = JSON.stringify(content);
    if (lastAttemptedPayload.current != null && lastAttemptedPayload.current !== fingerprint) {
      createRequestId.current = v4();
    }
    lastAttemptedPayload.current = fingerprint;
    const payload: TCreateSchedule = {
      ...content,
      clientRequestId: createRequestId.current,
    };
    createSchedule.mutate(payload);
  };

  /** Flattened so the memo below depends on its VALUE: the array identity changes on
   *  every render, which would re-walk croner each time. */
  const daysKey = daysOfWeek.join(',');

  /** Read by the summary, the preview and the interval floor, each of which walks
   *  croner. Memoized so a name or prompt keystroke does not re-derive all three. */
  const previewCadence = useMemo(
    () => buildCadence({ frequency, hour, minute, daysOfWeek, expression }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `daysKey` IS `daysOfWeek`
    [frequency, hour, minute, daysKey, expression],
  );

  /** Weekly with nothing selected is expressible in the form but not on the wire (the
   *  payload schema requires at least one day), so it blocks submit rather than
   *  silently saving as Monday. */
  const daysAreValid = frequency !== 'weekly' || daysOfWeek.length > 0;

  /** Validated in the schedule's own timezone, the same argument the server passes, so
   *  a zone-sensitive expression cannot pass here and be refused there. */
  /** Memoized like every derivation around it: `watch()` re-renders the dialog on
   *  each keystroke in ANY field, and this walks croner. */
  const cronIsValid = useMemo(
    () => frequency !== 'cron' || isValidCronExpression(expression.trim(), timezone),
    [frequency, expression, timezone],
  );

  const previewRuns = useMemo(
    () =>
      frequency === 'cron' && cronIsValid && daysAreValid
        ? nextRunInstants(previewCadence, timezone, PREVIEW_RUN_COUNT)
        : [],
    [frequency, cronIsValid, daysAreValid, previewCadence, timezone],
  );

  /** The floor binds exactly where the API binds it: to a cadence that will actually
   *  be submitted, and to any edit leaving the schedule enabled. Renaming a DISABLED
   *  schedule whose stored cadence predates a raised floor is a valid maintenance edit
   *  the API accepts, so the dialog must not hold it hostage to a timing change. */
  const floorApplies = schedule == null || timingTouched || schedule.enabled;

  /** Checked against the SAME function the server enforces with, so the dialog never
   *  offers a submit the API would answer 400 to. Only meaningful once the expression
   *  parses: an unfireable one reports a zero-minute gap, which would otherwise
   *  surface as "too frequent" instead of "never runs". Memoized because the cron
   *  branch walks 32 occurrences to find its tightest gap. */
  const belowFloor = useMemo(
    () =>
      floorApplies &&
      cronIsValid &&
      daysAreValid &&
      minIntervalMinutes != null &&
      // The zone is load-bearing, not decoration: without it this measures the nominal
      // gap while the API measures the DST-compressed one, and the dialog offers a
      // Create the API then rejects.
      cadenceIntervalMinutes(previewCadence, timezone) < minIntervalMinutes,
    [floorApplies, cronIsValid, daysAreValid, minIntervalMinutes, previewCadence, timezone],
  );

  const resolveCadenceError = (): string | null => {
    if (!daysAreValid) {
      return localize('com_ui_schedule_days_required');
    }
    if (belowFloor && minIntervalMinutes != null) {
      return localize('com_ui_schedule_min_interval', { minutes: minIntervalMinutes });
    }
    return null;
  };
  const cadenceError = resolveCadenceError();
  const canSubmit = cronIsValid && daysAreValid && !belowFloor && !isLoading;

  /** The offset disambiguates two similar names, which matters now that the zone is
   *  something the user picks rather than the browser's own. Memoized because it
   *  builds an Intl formatter and the dialog re-renders per keystroke. */
  const timezoneOffset = useMemo(() => formatTimezoneOffset(timezone, locale), [timezone, locale]);
  const summary = `${describeCadence(previewCadence, localize, locale, prefersMeridiem, weekStartsOn)} · ${
    timezoneOffset ? `${timezone} (${timezoneOffset})` : timezone
  }`;

  /** Both labels for every pill, in week order, built once per locale and week start:
   *  inline they cost fourteen `Intl.DateTimeFormat` constructions on every keystroke
   *  this form re-renders on. */
  const weekdayOptions = useMemo(
    () =>
      weekdayIndexes.map((day) => ({
        day,
        label: formatScheduleDay(day, locale),
        narrow: formatScheduleDayNarrow(day, locale),
      })),
    [locale, weekdayIndexes],
  );

  /** A CELL in the cadence grid rather than a row of its own, in both modes. */
  const timezoneField = (
    <fieldset className="space-y-2">
      <legend>
        <Label id="schedule-timezone-label" className="text-sm font-medium text-text-primary">
          {localize('com_ui_schedule_timezone')}
        </Label>
      </legend>
      <Controller
        name="timezone"
        control={control}
        render={({ field }) => (
          <ControlCombobox
            selectedValue={field.value}
            displayValue={field.value}
            selectPlaceholder={localize('com_ui_schedule_timezone')}
            searchPlaceholder={localize('com_ui_schedule_timezone_search')}
            setValue={field.onChange}
            items={timezoneItems}
            ariaLabel={localize('com_ui_schedule_timezone')}
            selectId="schedule-timezone"
            isCollapsed={false}
            showCarat={true}
            placement="bottom-start"
            /* Same focus-trap constraint as the agent picker above. */
            portal={false}
            matchTriggerWidth={true}
            variant="field"
          />
        )}
      />
    </fieldset>
  );

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogTemplate
        title={localize(schedule ? 'com_ui_schedule_edit' : 'com_ui_schedule_new')}
        showCloseButton={false}
        className="w-11/12 md:max-w-3xl"
        main={
          <form id={FORM_ID} onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <ScheduleMCPRecovery
              outcomes={mcpRecoveryOutcomes}
              fallbackAgentId={schedule?.agent_id ?? selectedAgentId}
              agentNames={agentNames}
              onOpenAgent={(ownerId) => {
                onOpenChange(false);
                navigate(`/c/new?agent_id=${encodeURIComponent(ownerId)}`);
              }}
            />
            {/* Identity row: what the schedule is, who runs it, where its chats land.
                Its caption is grouped with it rather than left to the form's own 4-unit
                rhythm, which would spend more vertical budget on the gap than the
                caption itself occupies. */}
            <div className="space-y-1.5">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="schedule-name" className="text-sm font-medium text-text-primary">
                    {localize('com_ui_name')}
                  </Label>
                  <Input
                    id="schedule-name"
                    className="w-full"
                    placeholder={localize('com_ui_schedule_name_placeholder')}
                    aria-invalid={errors.name != null}
                    aria-describedby="schedule-name-message"
                    {...register('name', { required: localize('com_ui_field_required') })}
                  />
                  <FieldMessage id="schedule-name-message" message={errors.name?.message} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="schedule-agent" className="text-sm font-medium text-text-primary">
                    {localize('com_ui_agent')}
                  </Label>
                  <Controller
                    name="agent_id"
                    control={control}
                    rules={{ required: localize('com_ui_field_required') }}
                    render={({ field }) => (
                      <ControlCombobox
                        selectedValue={field.value}
                        displayValue={
                          agentItems.find((item) => item.value === field.value)?.label ?? ''
                        }
                        selectPlaceholder={localize('com_ui_select_agent')}
                        searchPlaceholder={localize('com_agents_search_name')}
                        setValue={field.onChange}
                        onBlur={field.onBlur}
                        items={agentItems}
                        ariaLabel={localize('com_ui_agent')}
                        ariaInvalid={errors.agent_id != null}
                        ariaDescribedBy="schedule-agent-message"
                        selectId="schedule-agent"
                        isCollapsed={false}
                        showCarat={true}
                        placement="bottom-start"
                        // Radix traps focus inside the dialog, so a popover portaled to
                        // the body cannot be clicked, tabbed into, or typed in — and the
                        // trap fighting Ariakit for focus locks the page up.
                        portal={false}
                        matchTriggerWidth={true}
                        variant="field"
                      />
                    )}
                  />
                  <FieldMessage id="schedule-agent-message" message={errors.agent_id?.message} />
                </div>
                <div className="space-y-2">
                  <Label
                    htmlFor="schedule-project"
                    className="text-sm font-medium text-text-primary"
                  >
                    {localize('com_ui_project')}
                  </Label>
                  {pinnedProjectId != null ? (
                    /* Pinned by the operator: there is no choice to offer, so show the
                     destination rather than a disabled control the user would keep
                     trying to open. */
                    <div
                      id="schedule-project"
                      data-testid="schedule-project-pinned"
                      className="flex h-10 w-full items-center gap-2 rounded-xl border border-border-light bg-surface-secondary px-3 text-sm text-text-secondary"
                    >
                      <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{projectDisplayName(pinnedProjectId)}</span>
                    </div>
                  ) : (
                    <Controller
                      name="chatProjectId"
                      control={control}
                      // Only for a schedule this submit leaves ENABLED. The server waives
                      // the requirement for a disabled row precisely so one auto-disabled
                      // for `project_required` can still be renamed or tidied up; requiring
                      // it here made that path unreachable, and an owner with no projects
                      // at all could not edit the stopped schedule.
                      rules={
                        requireProject && (schedule == null || schedule.enabled)
                          ? { required: localize('com_ui_field_required') }
                          : undefined
                      }
                      render={({ field }) => (
                        <ControlCombobox
                          selectedValue={field.value}
                          // Never `''` for a real id: that renders the placeholder,
                          // which reads as "No project" on a schedule that has one.
                          displayValue={field.value ? projectDisplayName(field.value) : ''}
                          selectPlaceholder={localize(
                            requireProject
                              ? 'com_ui_select_project'
                              : 'com_ui_schedule_project_none',
                          )}
                          searchPlaceholder={localize('com_ui_search_projects')}
                          setValue={field.onChange}
                          onBlur={field.onBlur}
                          items={projectItems}
                          SelectIcon={
                            <Folder className="h-4 w-4 text-text-secondary" aria-hidden="true" />
                          }
                          ariaLabel={localize('com_ui_project')}
                          ariaInvalid={errors.chatProjectId != null}
                          ariaDescribedBy="schedule-project-message"
                          selectId="schedule-project"
                          isCollapsed={false}
                          showCarat={true}
                          placement="bottom-start"
                          /* Same focus-trap constraint as the agent picker above. */
                          portal={false}
                          matchTriggerWidth={true}
                          variant="field"
                        />
                      )}
                    />
                  )}
                  <FieldMessage
                    id="schedule-project-message"
                    message={errors.chatProjectId?.message}
                  />
                  {pinnedProjectId == null && hasMoreProjects && (
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto justify-start px-0 text-xs"
                      onClick={() => fetchMoreProjects()}
                      disabled={isFetchingMoreProjects}
                    >
                      {localize(isFetchingMoreProjects ? 'com_ui_loading' : 'com_ui_load_more')}
                    </Button>
                  )}
                </div>
              </div>
              {/* Full width, not inside the agent cell: at a third of the dialog this
                sentence wraps an extra line and makes the identity row needlessly tall. */}
              <p className="text-xs text-text-secondary">
                {localize('com_ui_schedule_target_new_chat')}
              </p>
            </div>

            <Controller
              name="prompt"
              control={control}
              rules={{ required: localize('com_ui_field_required') }}
              render={({ field }) => (
                <div className="space-y-2">
                  <VariableEditor
                    id="schedule-prompt"
                    label={localize('com_ui_prompt')}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    inputRef={field.ref}
                    placeholder={localize('com_ui_schedule_prompt_placeholder')}
                    className="min-h-[120px] resize-none bg-transparent"
                    labelClassName="text-sm font-medium text-text-primary"
                    rows={4}
                    required={true}
                    invalid={errors.prompt != null}
                    describedBy="schedule-prompt-message"
                    showVariables={false}
                    portal={false}
                  />
                  <FieldMessage id="schedule-prompt-message" message={errors.prompt?.message} />
                </div>
              )}
            />

            <fieldset className="space-y-2">
              <legend>
                <Label
                  id="schedule-frequency-label"
                  className="text-sm font-medium text-text-primary"
                >
                  {localize('com_ui_schedule_frequency')}
                </Label>
              </legend>
              <Controller
                name="frequency"
                control={control}
                render={({ field }) => (
                  <Radio
                    options={frequencyOptions}
                    value={field.value}
                    onChange={(value) => field.onChange(value as ScheduleFrequency)}
                    fullWidth
                    // Five segments no longer fit one row in a phone-width dialog, and
                    // a translated label can push even a desktop one over.
                    wrap
                    aria-labelledby="schedule-frequency-label"
                  />
                )}
              />
            </fieldset>

            {frequency === 'cron' ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="schedule-cron" className="text-sm font-medium text-text-primary">
                    {localize('com_ui_schedule_cron_expression')}
                  </Label>
                  <Input
                    id="schedule-cron"
                    className="w-full font-mono"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={DEFAULT_CRON}
                    maxLength={SCHEDULE_CRON_MAX_LENGTH}
                    aria-invalid={!cronIsValid || belowFloor}
                    aria-describedby={
                      // The floor message renders under the summary as
                      // `schedule-cadence-message`; a floor-violating expression must
                      // still mark THIS input invalid and point at that message, or a
                      // screen reader finds a disabled Create with no stated reason.
                      belowFloor
                        ? 'schedule-cron-hint schedule-cron-message schedule-cadence-message'
                        : 'schedule-cron-hint schedule-cron-message'
                    }
                    data-testid="schedule-cron-input"
                    {...register('expression')}
                  />
                  <p id="schedule-cron-hint" className="text-xs text-text-secondary">
                    {localize('com_ui_schedule_cron_hint')}
                  </p>
                  <FieldMessage
                    id="schedule-cron-message"
                    message={cronIsValid ? undefined : localize('com_ui_schedule_cron_invalid')}
                  />
                </div>
                {timezoneField}
              </div>
            ) : (
              <div
                className={cn(
                  'grid gap-4',
                  // Three cells in weekly (day, time, zone) share one row at md.
                  frequency === 'weekly' ? 'md:grid-cols-3' : 'md:grid-cols-2',
                )}
              >
                {frequency === 'weekly' && (
                  <fieldset className="space-y-2">
                    <legend>
                      <Label
                        id="schedule-days-label"
                        className="text-sm font-medium text-text-primary"
                      >
                        {localize('com_ui_schedule_days')}
                      </Label>
                    </legend>
                    {/* The fieldset and its legend already name this group, so the
                        button row carries no second role="group": that would announce
                        the same set twice. Each pill is a toggle button rather than a
                        checkbox because it renders as one, and aria-pressed says so
                        without claiming a form control that is not there. */}
                    <Controller
                      name="daysOfWeek"
                      control={control}
                      render={({ field }) => (
                        // No wrap, and every pill shares the row's width equally: at
                        // `md` this cell is a third of the dialog.
                        <div className="flex gap-1">
                          {weekdayOptions.map(({ day, label, narrow }) => {
                            const selected = field.value.includes(day);
                            return (
                              <Button
                                key={day}
                                variant="outline"
                                size="sm"
                                aria-pressed={selected}
                                aria-label={label}
                                // The narrow labels repeat within a week ("T", "T");
                                // position disambiguates at a glance and the title
                                // names the day outright on hover.
                                title={label}
                                data-testid={`schedule-day-${day}`}
                                onClick={() =>
                                  field.onChange(
                                    selected
                                      ? field.value.filter((value: number) => value !== day)
                                      : [...field.value, day].sort((a, b) => a - b),
                                  )
                                }
                                className={cn(
                                  'min-w-0 flex-1 px-0 font-normal',
                                  selected
                                    ? 'border-border-medium bg-surface-active text-text-primary hover:bg-surface-active'
                                    : 'text-text-secondary',
                                )}
                              >
                                {narrow}
                              </Button>
                            );
                          })}
                        </div>
                      )}
                    />
                  </fieldset>
                )}
                <fieldset className="space-y-2">
                  <legend>
                    <Label
                      id="schedule-time-label"
                      className="text-sm font-medium text-text-primary"
                    >
                      {localize(
                        frequency === 'hourly'
                          ? 'com_ui_schedule_minutes_past_hour'
                          : 'com_ui_schedule_time',
                      )}
                    </Label>
                  </legend>
                  {frequency === 'hourly' ? (
                    <Controller
                      name="minute"
                      control={control}
                      render={({ field }) => (
                        <MinutePicker
                          minute={field.value}
                          onChange={field.onChange}
                          label={localize('com_ui_schedule_minute')}
                          labelledBy="schedule-time-label"
                          className="max-w-[8rem]"
                        />
                      )}
                    />
                  ) : (
                    <TimePicker
                      hour={hour}
                      minute={minute}
                      /* One control, so one change: setting hour and minute through
                         separate fields let a half-applied edit submit a time the user
                         never picked. */
                      onChange={(next) => {
                        setValue('hour', next.hour, { shouldDirty: true });
                        setValue('minute', next.minute, { shouldDirty: true });
                      }}
                      labels={timeLabels}
                      labelledBy="schedule-time-label"
                      locale={locale}
                      hour12={prefersMeridiem}
                      className="max-w-[16rem]"
                    />
                  )}
                </fieldset>
                {timezoneField}
              </div>
            )}

            <div className="space-y-2">
              {/* With no day selected, `buildCadence` substitutes Monday so the maths
                  downstream stays defined — but describing that substitution would
                  contradict the "pick at least one day" message right below it. */}
              {daysAreValid && (
                <p
                  className="break-words rounded-lg bg-surface-secondary px-3 py-2 text-sm text-text-secondary"
                  data-testid="schedule-summary"
                >
                  {summary}
                </p>
              )}
              <FieldMessage id="schedule-cadence-message" message={cadenceError ?? undefined} />
              {previewRuns.length > 0 && (
                <div className="space-y-1" data-testid="schedule-preview">
                  <p className="text-xs font-medium text-text-primary">
                    {localize('com_ui_schedule_next_runs')}
                  </p>
                  <ul className="space-y-0.5 text-xs text-text-secondary">
                    {previewRuns.map((run) => (
                      <li key={run.getTime()}>
                        {formatRunInstant(run, timezone, locale, prefersMeridiem)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </form>
        }
        buttons={
          <Button
            type="submit"
            form={FORM_ID}
            variant="submit"
            disabled={!canSubmit}
            aria-label={localize(schedule ? 'com_ui_save' : 'com_ui_create')}
          >
            {isLoading ? (
              <Spinner className="size-4" />
            ) : (
              localize(schedule ? 'com_ui_save' : 'com_ui_create')
            )}
          </Button>
        }
      />
    </OGDialog>
  );
}
