import { useId, useMemo, useState } from 'react';
import { AGENT_EVENT_TYPES, subscriptionActors } from 'librechat-data-provider';
import {
  Alert,
  Input,
  Label,
  Radio,
  Button,
  Spinner,
  Checkbox,
  Textarea,
  OGDialog,
  ControlCombobox,
  OGDialogTemplate,
} from '@librechat/client';
import type {
  SubscriptionFilters,
  SubscriptionActors,
  ConnectionChoice,
  AgentEventType,
  Subscription,
} from 'librechat-data-provider';
import type { MutableRefObject } from 'react';
import { useEventSubscriptionMutations } from '~/data-provider/Events';
import { actorLabels, eventErrorLabel, eventLabels } from './labels';
import { useLocalize } from '~/hooks';

type FilterKey = keyof SubscriptionFilters;
const filterKeys: FilterKey[] = ['repositories', 'branches', 'labels'];
const filterLabels = {
  repositories: 'com_ui_events_filter_repositories',
  branches: 'com_ui_events_filter_branches',
  labels: 'com_ui_events_filter_labels',
} as const;

/** A comma-separated field as the list it stands for. */
const list = (text: string): string[] =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

/** A stored list as its field shows it. */
const shown = (values?: string[]) => values?.join(', ') ?? '';

/**
 * The filters the fields stand for. A field the owner left as it was keeps the stored list
 * unchanged, so a value that holds a comma is not split by a save that never touched it.
 */
export function filtersFrom(
  text: Record<FilterKey, string>,
  stored?: SubscriptionFilters,
): SubscriptionFilters | null {
  const filters: SubscriptionFilters = {};
  for (const key of filterKeys) {
    const kept = stored?.[key];
    const values = kept && text[key] === shown(kept) ? kept : list(text[key]);
    if (values.length) filters[key] = values;
  }
  return Object.keys(filters).length ? filters : null;
}

type Fields = Pick<Subscription, 'events' | 'prompt' | 'actors' | 'bots'> & {
  filters: SubscriptionFilters | null;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields an edit changes, or `null` when it changes none. */
export function changes(current: Subscription, next: Fields): Partial<Fields> | null {
  const patch: Partial<Fields> = {};
  if (!same([...current.events].sort(), [...next.events].sort())) patch.events = next.events;
  if (current.prompt !== next.prompt) patch.prompt = next.prompt;
  if (current.actors !== next.actors) patch.actors = next.actors;
  if (current.bots !== next.bots) patch.bots = next.bots;
  if (!same(current.filters, next.filters)) patch.filters = next.filters;
  return Object.keys(patch).length ? patch : null;
}

/** Creates a subscription on the agent, or edits one: what it listens for and what it asks. */
export default function EventDialog({
  agentId,
  subscription,
  connections,
  onOpenChange,
  triggerRef,
}: {
  agentId: string;
  /** Absent, a new one is made. */
  subscription?: Subscription;
  connections: ConnectionChoice[];
  onOpenChange: (open: boolean) => void;
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
}) {
  const localize = useLocalize();
  const id = useId();
  const { create, update } = useEventSubscriptionMutations(agentId);
  const mutation = subscription ? update : create;
  const [connection, setConnection] = useState(
    subscription?.connection ?? (connections.length === 1 ? connections[0].id : ''),
  );
  const [events, setEvents] = useState<string[]>(subscription?.events ?? []);
  const [prompt, setPrompt] = useState(subscription?.prompt ?? '');
  const [actors, setActors] = useState<SubscriptionActors>(subscription?.actors ?? 'write');
  const [bots, setBots] = useState(subscription?.bots ?? false);
  const [filters, setFilters] = useState<Record<FilterKey, string>>(() => ({
    repositories: shown(subscription?.filters?.repositories),
    branches: shown(subscription?.filters?.branches),
    labels: shown(subscription?.filters?.labels),
  }));

  const provider = connections.find((choice) => choice.id === connection)?.provider ?? 'github';
  const offered = useMemo(
    () => AGENT_EVENT_TYPES.filter((type) => type.startsWith(`${provider}.`)),
    [provider],
  );
  const items = useMemo(
    () => connections.map((choice) => ({ label: choice.account, value: choice.id })),
    [connections],
  );
  const ready = connection !== '' && events.length > 0 && prompt.trim() !== '';

  const save = () => {
    if (!ready || mutation.isLoading) return;
    const fields = {
      events,
      prompt: prompt.trim(),
      actors,
      bots,
    };
    const onSuccess = () => onOpenChange(false);
    if (subscription) {
      // Only what changed is sent: any edit but turning it off or on leaves the grant behind.
      const patch = changes(subscription, {
        ...fields,
        filters: filtersFrom(filters, subscription.filters),
      });
      if (!patch) {
        onSuccess();
        return;
      }
      update.mutate(
        { id: subscription.id, payload: { ...patch, expectedRevision: subscription.revision } },
        { onSuccess },
      );
      return;
    }
    const chosen = filtersFrom(filters);
    create.mutate(
      { ...fields, connection, agentId, ...(chosen && { filters: chosen }) },
      { onSuccess },
    );
  };

  const toggle = (type: AgentEventType, on: boolean) =>
    setEvents((current) =>
      on ? [...current.filter((value) => value !== type), type] : current.filter((v) => v !== type),
    );

  return (
    <OGDialog open onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogTemplate
        title={localize(subscription ? 'com_ui_events_edit' : 'com_ui_events_add')}
        className="w-11/12 max-w-lg"
        main={
          <form
            id={`${id}-form`}
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              // React carries a submit through the portal to the agent form around the panel.
              event.stopPropagation();
              save();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor={`${id}-connection`}>{localize('com_ui_events_connection')}</Label>
              {subscription ? (
                <p id={`${id}-connection`} className="text-text-primary text-sm">
                  {items.find((item) => item.value === connection)?.label ??
                    localize('com_ui_events_connection_gone')}
                </p>
              ) : (
                <ControlCombobox
                  selectedValue={connection}
                  displayValue={items.find((item) => item.value === connection)?.label ?? ''}
                  selectPlaceholder={localize('com_ui_events_connection_pick')}
                  searchPlaceholder={localize('com_ui_events_connection_pick')}
                  setValue={setConnection}
                  items={items}
                  ariaLabel={localize('com_ui_events_connection')}
                  selectId={`${id}-connection`}
                  isCollapsed={false}
                  showCarat={true}
                  placement="bottom-start"
                  // The dialog traps focus, so a popover portaled to the body could not be used.
                  portal={false}
                  matchTriggerWidth={true}
                  variant="field"
                />
              )}
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{localize('com_ui_events_listen')}</legend>
              {offered.map((type) => (
                <div key={type} className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-${type}`}
                    checked={events.includes(type)}
                    aria-labelledby={`${id}-${type}-label`}
                    onCheckedChange={(checked) => toggle(type, checked === true)}
                  />
                  <Label id={`${id}-${type}-label`} htmlFor={`${id}-${type}`} className="text-sm">
                    {localize(eventLabels[type])}
                  </Label>
                </div>
              ))}
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor={`${id}-prompt`}>{localize('com_ui_events_prompt')}</Label>
              <Textarea
                id={`${id}-prompt`}
                value={prompt}
                rows={4}
                onChange={(event) => setPrompt(event.target.value)}
                aria-describedby={`${id}-prompt-note`}
              />
              <p id={`${id}-prompt-note`} className="text-text-secondary text-xs">
                {localize('com_ui_events_prompt_note')}
              </p>
            </div>
            <div className="space-y-2">
              <span id={`${id}-actors`} className="text-sm font-medium">
                {localize('com_ui_events_actors')}
              </span>
              <Radio
                aria-labelledby={`${id}-actors`}
                value={actors}
                onChange={(value) => setActors(value as SubscriptionActors)}
                options={subscriptionActors.map((value) => ({
                  value,
                  label: localize(actorLabels[value]),
                }))}
                wrap
              />
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-bots`}
                  checked={bots}
                  aria-labelledby={`${id}-bots-label`}
                  onCheckedChange={(checked) => setBots(checked === true)}
                />
                <Label id={`${id}-bots-label`} htmlFor={`${id}-bots`} className="text-sm">
                  {localize('com_ui_events_bots')}
                </Label>
              </div>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{localize('com_ui_events_filters')}</legend>
              {filterKeys.map((key) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`${id}-${key}`} className="text-xs">
                    {localize(filterLabels[key])}
                  </Label>
                  <Input
                    id={`${id}-${key}`}
                    value={filters[key]}
                    onChange={(event) =>
                      setFilters((current) => ({ ...current, [key]: event.target.value }))
                    }
                  />
                </div>
              ))}
              <p className="text-text-secondary text-xs">
                {localize('com_ui_events_filters_note')}
              </p>
            </fieldset>
            {subscription && (
              <p className="text-text-secondary text-xs">{localize('com_ui_events_edit_note')}</p>
            )}
            {mutation.isError && (
              <Alert variant="error">{localize(eventErrorLabel(mutation.error))}</Alert>
            )}
          </form>
        }
        buttons={
          <Button type="submit" form={`${id}-form`} disabled={!ready || mutation.isLoading}>
            {mutation.isLoading ? <Spinner className="size-4" /> : localize('com_ui_save')}
          </Button>
        }
      />
    </OGDialog>
  );
}
