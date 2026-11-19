import { useState, useId } from 'react';
import { Tools } from 'librechat-data-provider';
import {
  Button,
  Input,
  Label,
  Spinner,
  Checkbox,
  OGDialog,
  OGDialogTemplate,
} from '@librechat/client';
import type {
  ScheduledMCPTarget,
  ScheduleMCPConsentView,
  ConfirmScheduleMCPConsent,
} from 'librechat-data-provider';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type { MutableRefObject, ReactNode } from 'react';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

/** Where a grant is read and written: a schedule's, or an API key's for one agent. */
export interface GrantSource {
  query: UseQueryResult<ScheduleMCPConsentView>;
  confirm: UseMutationResult<ScheduleMCPConsentView, unknown, ConfirmScheduleMCPConsent>;
  revoke: UseMutationResult<void, unknown, string>;
}

/** The words that depend on what holds the grant. Everything else reads the same. */
export interface GrantCopy {
  title: TranslationKeys;
  boundary: TranslationKeys;
  /** Replaces the status line for a state, where the default speaks of schedules. */
  status?: Partial<Record<ScheduleMCPConsentView['state'], TranslationKeys>>;
  confirmed?: TranslationKeys;
}

const statusKeys = {
  missing: 'com_ui_schedule_consent_missing',
  active: 'com_ui_schedule_consent_active',
  expired: 'com_ui_schedule_consent_expired',
  revoked: 'com_ui_schedule_consent_revoked',
  changed: 'com_ui_schedule_consent_changed',
  unsupported: 'com_ui_schedule_consent_unsupported',
} as const;

/** Built-in tools the owner knows by name. Any other, such as an action, is shown by its key. */
const toolKeys = new Map<string, TranslationKeys>([
  [Tools.execute_code, 'com_ui_schedule_consent_tool_code'],
  [Tools.web_search, 'com_ui_schedule_consent_tool_web'],
  [Tools.file_search, 'com_ui_schedule_consent_tool_files'],
]);

const messageKeys = {
  error: 'com_ui_schedule_consent_error',
  revoked: 'com_ui_schedule_consent_revoked',
  success: 'com_ui_schedule_consent_confirmed',
} as const;

/** Every tool on offer for a server, whichever agents selected it. */
function offeredTools(target: ScheduledMCPTarget): string[] {
  return [...new Set(target.permittedTools.flatMap((selection) => selection.tools))].sort();
}

/**
 * The owner's starting point: what the stored grant already allows and is still on offer.
 * A tool whose definition changed starts unticked, so allowing the new one is a decision.
 */
function initialChoice(data: ScheduleMCPConsentView): Record<string, string[]> {
  return Object.fromEntries(
    data.targets.map((target) => {
      const offered = offeredTools(target);
      const allowed = data.allowed[target.resource.serverName] ?? [];
      const changed = data.changed[target.resource.serverName] ?? [];
      return [
        target.resource.serverName,
        offered.filter((tool) => allowed.includes(tool) && !changed.includes(tool)),
      ];
    }),
  );
}

/**
 * The owner's ticks, with the grant they were made against and the tools it marked as
 * changed at the time. A mark belongs to one grant: the same tool marked again under a later
 * grant is a different change, which the owner has not looked at.
 */
interface Edited {
  choice: Record<string, string[]>;
  revision: string | null;
  changed: Record<string, string[]>;
}

/**
 * The owner's ticks, kept to what is on offer now. The offer is read again while the dialog
 * is open: a server or tool the agents dropped has no box left to untick, and a tool marked
 * as changed since the owner last ticked anything, or marked under another grant, loses its
 * tick, so allowing the new definition is something the owner does with the warning in view.
 */
function currentChoice(
  data: ScheduleMCPConsentView,
  edited: Edited | null,
): Record<string, string[]> {
  const initial = initialChoice(data);
  if (!edited) return initial;
  return Object.fromEntries(
    data.targets.map((target) => {
      const { serverName } = target.resource;
      const offered = offeredTools(target);
      const marked = data.changed[serverName] ?? [];
      const seen = edited.revision === data.revision ? (edited.changed[serverName] ?? []) : [];
      return [
        serverName,
        (edited.choice[serverName] ?? initial[serverName]).filter(
          (tool) => offered.includes(tool) && (!marked.includes(tool) || seen.includes(tool)),
        ),
      ];
    }),
  );
}

/**
 * The owner's view of one grant: which MCP servers and tools a run may use while nobody is
 * watching. `children` sits above the grant, for whatever picks its subject; `subjectKey`
 * names that subject, so choices made for one are never carried to the next.
 */
export default function GrantDialog({
  canConfirm = true,
  source,
  copy,
  name,
  children,
  subjectKey,
  onOpenChange,
  triggerRef,
}: {
  canConfirm?: boolean;
  source: GrantSource;
  copy: GrantCopy;
  name: string;
  children?: ReactNode;
  subjectKey?: string;
  onOpenChange: (open: boolean) => void;
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
}) {
  const localize = useLocalize();
  return (
    <OGDialog open onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogTemplate
        title={localize(copy.title)}
        className="w-11/12 max-w-lg"
        main={
          <div className="space-y-4">
            <p className="text-text-primary text-sm">{name}</p>
            <p className="text-text-secondary text-sm">{localize(copy.boundary)}</p>
            {children}
            <Grant key={subjectKey} canConfirm={canConfirm} source={source} copy={copy} />
          </div>
        }
      />
    </OGDialog>
  );
}

/** One subject's grant and the owner's choices for it. */
function Grant({
  canConfirm,
  source,
  copy,
}: {
  canConfirm: boolean;
  source: GrantSource;
  copy: GrantCopy;
}) {
  const localize = useLocalize();
  const inputId = useId();
  const { query, confirm, revoke } = source;
  /** Nothing has been asked for yet: the subject is still being chosen. */
  const idle = query.fetchStatus === 'idle' && query.data == null && !query.isError;
  const [hours, setHours] = useState(1);
  const [message, setMessage] = useState<'success' | 'revoked' | 'error' | null>(null);
  /** Null until the owner changes a box, so a refetch cannot overwrite a choice in progress. */
  const [edited, setEdited] = useState<Edited | null>(null);
  const busy = confirm.isLoading || revoke.isLoading || query.isFetching;
  const data: ScheduleMCPConsentView | undefined = query.data;
  const choosing = canConfirm && data?.offer != null;
  const choice = data ? currentChoice(data, edited) : {};
  /** Null until the owner changes an "ask me first" box, with the grant it was changed against. */
  const [editedAsking, setEditedAsking] = useState<{
    revision: string | null;
    tools: Record<string, string[]>;
  } | null>(null);
  const canAsk = data?.approval === true;
  /**
   * Kept apart from the ticks. Starts from the stored grant, even where a run cannot pause
   * and for a tool that is not ticked right now: one that changed starts unticked, and
   * ticking it again must not turn a tool the owner approves each time into an unattended one.
   * The owner's edits hold only for the grant they were made against: a question added to a
   * grant confirmed elsewhere is not theirs to drop unseen.
   */
  const asking =
    (editedAsking?.revision === data?.revision ? editedAsking?.tools : undefined) ??
    data?.asking ??
    {};
  const noteId = useId();
  const otherId = useId();
  /** Null until the owner changes one of the other tools, with the grant it was changed against. */
  const [editedOther, setEditedOther] = useState<{
    revision: string | null;
    tools: string[];
  } | null>(null);
  /** The agents' tools that are not MCP tools: each one allowed or left out, like an MCP tool. */
  const offeredOther = data?.tools.offered ?? [];
  const other = (
    (editedOther?.revision === data?.revision ? editedOther?.tools : undefined) ??
    data?.tools.allowed ??
    []
  ).filter((tool) => offeredOther.includes(tool));
  /** A grant allows something: an MCP tool, or one of the other tools. */
  const chosenCount =
    Object.values(choice).reduce((count, tools) => count + tools.length, 0) + other.length;
  const setOther = (tools: string[]) => setEditedOther({ revision: data?.revision ?? null, tools });
  /** One click for an owner who trusts the agent as it is: every server, every tool. */
  const allowEverything = () => {
    if (!data) return;
    setEdited({
      choice: Object.fromEntries(
        data.targets.map((target) => [target.resource.serverName, offeredTools(target)]),
      ),
      revision: data.revision,
      changed: data.changed,
    });
    setOther(offeredOther);
  };
  const toolLabel = (tool: string) => {
    const key = toolKeys.get(tool);
    return key ? localize(key) : tool;
  };
  const setTools = (serverName: string, tools: string[]) =>
    setEdited({
      choice: { ...choice, [serverName]: tools },
      revision: data?.revision ?? null,
      changed: data?.changed ?? {},
    });
  const setAsking = (serverName: string, tools: string[]) =>
    setEditedAsking({
      revision: data?.revision ?? null,
      tools: { ...asking, [serverName]: tools },
    });
  /** Sent with the confirmation: of the tools ticked now, the ones the owner asks about. */
  const ask = Object.fromEntries(
    Object.entries(asking)
      .map(([serverName, tools]): [string, string[]] => [
        serverName,
        tools.filter((tool) => (choice[serverName] ?? []).includes(tool)),
      ])
      .filter(([, tools]) => tools.length > 0),
  );
  const commit = () => {
    if (!data?.offer || chosenCount === 0) return;
    setMessage(null);
    confirm.mutate(
      {
        offerDigest: data.offer.digest,
        expectedRevision: data.revision,
        lifetimeHours: hours,
        allow: choice,
        // Always sent: left out, the server keeps what the stored grant asks about.
        ask,
        // Likewise: left out, the server keeps the other tools the stored grant allows.
        tools: other,
      },
      {
        onSuccess: () => {
          setEdited(null);
          setEditedAsking(null);
          setEditedOther(null);
          setMessage('success');
        },
        onError: () => setMessage('error'),
      },
    );
  };
  const withdraw = () => {
    if (!data?.revision) return;
    setMessage(null);
    revoke.mutate(data.revision, {
      onSuccess: () => setMessage('revoked'),
      onError: () => setMessage('error'),
    });
  };
  return (
    <>
      {!idle && query.isLoading && <Spinner />}
      {!query.isLoading && query.isError && (
        <div role="alert">
          <p>{localize('com_ui_schedule_consent_error')}</p>
          <Button variant="outline" onClick={() => query.refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      {!query.isLoading && !query.isError && data && (
        <>
          <p role="status">{localize(copy.status?.[data.state] ?? statusKeys[data.state])}</p>
          {data.required && (
            <p className="text-status-warning text-sm">
              {localize('com_ui_schedule_consent_required')}
            </p>
          )}
          {data.requireAfterMs != null && (
            <p className="text-text-secondary text-sm">
              {localize('com_ui_schedule_consent_required_after', {
                time: new Date(data.requireAfterMs).toLocaleString(),
              })}
            </p>
          )}
          {data.expiresAtMs != null && (
            <p className="text-text-secondary text-sm">
              {localize('com_ui_schedule_consent_deadline', {
                time: new Date(data.expiresAtMs).toLocaleString(),
              })}
            </p>
          )}
          {choosing && !canAsk && Object.keys(ask).length > 0 && (
            <p id={noteId} className="text-status-warning text-sm">
              {localize('com_ui_schedule_consent_ask_unavailable')}
            </p>
          )}
          {choosing && (
            <Button variant="outline" disabled={busy} onClick={allowEverything}>
              {localize('com_ui_schedule_consent_allow_all')}
            </Button>
          )}
          <ul className="space-y-2">
            {data.targets.map((target) => (
              <li key={target.resource.serverName}>
                <p className="text-sm font-medium">{target.resource.serverName}</p>
                <p className="text-text-secondary text-xs break-all">{target.resource.url}</p>
                <p className="text-text-secondary text-xs">{target.resource.credentialMode}</p>
                {target.resource.issuer && (
                  <p className="text-text-secondary text-xs wrap-anywhere">
                    {localize('com_ui_schedule_consent_issuer', {
                      issuer: target.resource.issuer,
                    })}
                  </p>
                )}
                {target.resource.audience && (
                  <p className="text-text-secondary text-xs">
                    {localize('com_ui_schedule_consent_audience', {
                      audience: target.resource.audience,
                    })}
                  </p>
                )}
                {target.resource.scopes.length > 0 && (
                  <p className="text-text-secondary text-xs">
                    {localize('com_ui_schedule_consent_scopes', {
                      scopes: target.resource.scopes.join(', '),
                    })}
                  </p>
                )}
                {choosing ? (
                  <ToolChoice
                    serverName={target.resource.serverName}
                    offered={offeredTools(target)}
                    chosen={choice[target.resource.serverName] ?? []}
                    changed={data.changed[target.resource.serverName] ?? []}
                    asking={asking[target.resource.serverName] ?? []}
                    askable={
                      canAsk
                        ? offeredTools(target)
                        : (data.asking[target.resource.serverName] ?? [])
                    }
                    askNoteId={canAsk ? undefined : noteId}
                    disabled={busy}
                    onChange={(tools) => setTools(target.resource.serverName, tools)}
                    onAskingChange={(tools) => setAsking(target.resource.serverName, tools)}
                  />
                ) : (
                  <>
                    <p className="text-text-secondary text-xs">
                      {localize('com_ui_schedule_consent_allowed', {
                        tools: (data.allowed[target.resource.serverName] ?? []).join(', '),
                      })}
                    </p>
                    {(data.asking[target.resource.serverName] ?? []).length > 0 && (
                      <p className="text-text-secondary text-xs">
                        {localize('com_ui_schedule_consent_asking', {
                          tools: data.asking[target.resource.serverName].join(', '),
                        })}
                      </p>
                    )}
                    {(data.changed[target.resource.serverName] ?? []).length > 0 && (
                      <p className="text-status-warning text-xs">
                        {localize('com_ui_schedule_consent_changed_tools', {
                          tools: data.changed[target.resource.serverName].join(', '),
                        })}
                      </p>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
          {choosing && offeredOther.length > 0 && (
            <fieldset className="space-y-1" disabled={busy}>
              <legend className="text-sm font-medium">
                {localize('com_ui_schedule_consent_other_tools')}
              </legend>
              <ul className="space-y-1 pl-6">
                {offeredOther.map((tool) => (
                  <li key={tool} className="flex items-center gap-2">
                    <Checkbox
                      id={`${otherId}-${tool}`}
                      checked={other.includes(tool)}
                      disabled={busy}
                      aria-labelledby={`${otherId}-${tool}-label`}
                      onCheckedChange={(checked) =>
                        setOther(
                          checked === true
                            ? offeredOther.filter((name) => name === tool || other.includes(name))
                            : other.filter((name) => name !== tool),
                        )
                      }
                    />
                    <Label
                      id={`${otherId}-${tool}-label`}
                      htmlFor={`${otherId}-${tool}`}
                      className="text-xs break-all"
                    >
                      {toolLabel(tool)}
                    </Label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          {!choosing && data.tools.allowed.length > 0 && (
            <p className="text-text-secondary text-xs">
              {localize('com_ui_schedule_consent_other_allowed', {
                tools: data.tools.allowed.map(toolLabel).join(', '),
              })}
            </p>
          )}
          {canConfirm && data.offer && (
            <>
              <Label htmlFor={inputId}>{localize('com_ui_schedule_consent_hours')}</Label>
              <Input
                id={inputId}
                type="number"
                min={1}
                max={data.offer.maxLifetimeHours}
                value={hours}
                disabled={busy}
                onChange={(event) => setHours(Number(event.target.value))}
              />
              <Button
                onClick={commit}
                disabled={
                  busy ||
                  chosenCount === 0 ||
                  !Number.isInteger(hours) ||
                  hours < 1 ||
                  hours > data.offer.maxLifetimeHours
                }
              >
                {localize('com_ui_schedule_consent_confirm')}
              </Button>
              {chosenCount === 0 && (
                <p className="text-text-secondary text-xs">
                  {localize('com_ui_schedule_consent_none_selected')}
                </p>
              )}
            </>
          )}
          {data.revision && data.state !== 'revoked' && (
            <Button variant="outline" disabled={busy} onClick={withdraw}>
              {localize('com_ui_schedule_consent_revoke')}
            </Button>
          )}
        </>
      )}
      {message && (
        <p role={message === 'error' ? 'alert' : 'status'}>
          {localize(
            message === 'success' && copy.confirmed ? copy.confirmed : messageKeys[message],
          )}
        </p>
      )}
    </>
  );
}

/** One server's tools: a box for the whole server and one per tool. Unchecked means refused. */
function ToolChoice({
  serverName,
  offered,
  chosen,
  changed,
  asking,
  askable,
  askNoteId,
  disabled,
  onChange,
  onAskingChange,
}: {
  serverName: string;
  offered: string[];
  chosen: string[];
  /** Tools the server changed since they were allowed. Refused until confirmed again. */
  changed: string[];
  /** Allowed tools the owner approves call by call. */
  asking: string[];
  /**
   * Tools that get an "ask me first" box. Where a scheduled run cannot pause, only the ones
   * the stored grant already asks about, so the owner can keep or drop them but add none.
   */
  askable: string[];
  /** The note explaining that a run cannot pause here, when it is shown. */
  askNoteId?: string;
  disabled: boolean;
  onChange: (tools: string[]) => void;
  onAskingChange: (tools: string[]) => void;
}) {
  const localize = useLocalize();
  const groupId = useId();
  /** Checked only when every tool is: the shared box has no partly-selected appearance. */
  const all = offered.length > 0 && offered.every((tool) => chosen.includes(tool));
  return (
    <fieldset className="mt-2 space-y-1" disabled={disabled}>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${groupId}-all`}
          checked={all}
          disabled={disabled}
          aria-label={localize('com_ui_schedule_consent_allow_server', { server: serverName })}
          onCheckedChange={(checked) => onChange(checked === true ? offered : [])}
        />
        <Label htmlFor={`${groupId}-all`} className="text-xs">
          {localize('com_ui_schedule_consent_allow_server', { server: serverName })}
        </Label>
      </div>
      <ul className="space-y-1 pl-6">
        {offered.map((tool) => (
          <li key={tool}>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${groupId}-${tool}`}
                checked={chosen.includes(tool)}
                disabled={disabled}
                aria-labelledby={`${groupId}-${tool}-label`}
                aria-describedby={changed.includes(tool) ? `${groupId}-${tool}-changed` : undefined}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? offered.filter((name) => name === tool || chosen.includes(name))
                      : chosen.filter((name) => name !== tool),
                  )
                }
              />
              <Label
                id={`${groupId}-${tool}-label`}
                htmlFor={`${groupId}-${tool}`}
                className="text-xs break-all"
              >
                {tool}
              </Label>
              {askable.includes(tool) && chosen.includes(tool) && (
                <span className="ml-auto flex shrink-0 items-center gap-2">
                  <Checkbox
                    id={`${groupId}-${tool}-ask`}
                    checked={asking.includes(tool)}
                    disabled={disabled}
                    aria-label={localize('com_ui_schedule_consent_ask_tool', { tool })}
                    aria-describedby={askNoteId}
                    onCheckedChange={(checked) =>
                      onAskingChange(
                        checked === true
                          ? [...asking, tool]
                          : asking.filter((name) => name !== tool),
                      )
                    }
                  />
                  <Label htmlFor={`${groupId}-${tool}-ask`} variant="secondary" className="text-xs">
                    {localize('com_ui_schedule_consent_ask_first')}
                  </Label>
                </span>
              )}
            </div>
            {changed.includes(tool) && (
              <p id={`${groupId}-${tool}-changed`} className="text-status-warning pl-6 text-xs">
                {localize('com_ui_schedule_consent_tool_changed')}
              </p>
            )}
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
