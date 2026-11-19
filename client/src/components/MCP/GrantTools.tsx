import { useId, useState } from 'react';
import { Label, Button, Checkbox } from '@librechat/client';
import { Tools, AgentCapabilities } from 'librechat-data-provider';
import type {
  ScheduledMCPTarget,
  ScheduleMCPConsentView,
  ConfirmScheduleMCPConsent,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

/** Built-in tools the owner knows by name. Any other, such as an action, is shown by its key. */
const toolKeys = new Map<string, TranslationKeys>([
  [Tools.execute_code, 'com_ui_schedule_consent_tool_code'],
  [Tools.web_search, 'com_ui_schedule_consent_tool_web'],
  [Tools.file_search, 'com_ui_schedule_consent_tool_files'],
  // One item for every skill the agent can use, now or later.
  [AgentCapabilities.skills, 'com_ui_schedule_consent_tool_skills'],
]);

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

/** The owner's choice from one offer, and the ways to change it. */
export interface GrantChoice {
  /** The MCP tools ticked, by server. */
  choice: Record<string, string[]>;
  /** The ticked MCP tools the owner approves call by call, by server: what a confirmation sends. */
  ask: Record<string, string[]>;
  asking: Record<string, string[]>;
  /** The other tools ticked. */
  other: string[];
  offeredOther: string[];
  canAsk: boolean;
  /** How many tools of either kind are ticked. A grant allows at least one. */
  count: number;
  /** Whether the offer can be taken for the whole agent, not only tool by tool. */
  standing: boolean;
  /** The whole agent is chosen: nothing is ticked one by one, and nothing added later is left out. */
  everything: boolean;
  /**
   * Under the whole agent: the tools the stored grant asks about stay asked about. Unticked,
   * the confirmation says so, and they run unattended.
   */
  keepsAsking: boolean;
  /** Something is allowed, so there is a grant to confirm. */
  some: boolean;
  /** What a confirmation sends for this choice. */
  request: Pick<ConfirmScheduleMCPConsent, 'allow' | 'ask' | 'tools' | 'everything'>;
  setEverything: (everything: boolean) => void;
  setKeepsAsking: (keeps: boolean) => void;
  setTools: (serverName: string, tools: string[]) => void;
  setAsking: (serverName: string, tools: string[]) => void;
  setOther: (tools: string[]) => void;
  allowEverything: () => void;
  /** Back to what the offer starts from, once a choice has been stored. */
  reset: () => void;
}

/** The owner's choice from an offer: what is ticked now, starting from what the offer says. */
export function useGrantChoice(data: ScheduleMCPConsentView | undefined): GrantChoice {
  /** Null until the owner changes a box, so a refetch cannot overwrite a choice in progress. */
  const [edited, setEdited] = useState<Edited | null>(null);
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
  /** Null until the owner ticks or unticks the whole agent, with the grant it was changed against. */
  const [editedWhole, setEditedWhole] = useState<{
    revision: string | null;
    value: boolean;
  } | null>(null);
  const standing = data?.offer?.everything === true;
  /**
   * The whole agent is where a new grant starts, so a schedule runs with everything its agent
   * has unless its owner says otherwise. A stored grant starts from what it is.
   */
  const everything =
    standing &&
    ((editedWhole?.revision === data?.revision ? editedWhole?.value : undefined) ??
      (data?.revision == null ? true : data.everything));
  /** Null until the owner changes it, with the grant it was changed against. */
  const [editedKeeps, setEditedKeeps] = useState<{
    revision: string | null;
    value: boolean;
  } | null>(null);
  const keepsAsking =
    (editedKeeps?.revision === data?.revision ? editedKeeps?.value : undefined) ?? true;
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
  return {
    choice,
    ask,
    asking,
    other,
    offeredOther,
    canAsk,
    count: chosenCount,
    standing,
    everything,
    keepsAsking,
    some: everything || chosenCount > 0,
    // The whole agent names nothing, and says nothing about asking unless the owner stops it:
    // left out, the server keeps what the stored grant asks about. Otherwise `ask` and `tools`
    // are always sent, since left out the server would keep the stored grant's choice of both.
    request: everything
      ? { allow: {}, everything: true, ...(!keepsAsking && { ask: {} }) }
      : { allow: choice, ask, tools: other },
    setEverything: (value: boolean) => setEditedWhole({ revision: data?.revision ?? null, value }),
    setKeepsAsking: (value: boolean) => setEditedKeeps({ revision: data?.revision ?? null, value }),
    setTools,
    setAsking,
    setOther,
    allowEverything,
    reset: () => {
      setEditedWhole(null);
      setEditedKeeps(null);
      setEdited(null);
      setEditedAsking(null);
      setEditedOther(null);
    },
  };
}

/**
 * The servers and tools of one offer. While the owner is choosing, each is a box to tick;
 * otherwise what the stored grant allows is listed.
 */
export default function GrantTools({
  data,
  choosing,
  state,
  busy,
}: {
  data: ScheduleMCPConsentView;
  choosing: boolean;
  state: GrantChoice;
  busy: boolean;
}) {
  const localize = useLocalize();
  const noteId = useId();
  const otherId = useId();
  const wholeId = useId();
  const keepId = useId();
  const {
    standing,
    everything,
    setEverything,
    keepsAsking,
    setKeepsAsking,
    choice,
    ask,
    asking,
    other,
    offeredOther,
    canAsk,
    setTools,
    setAsking,
    setOther,
    allowEverything,
  } = state;
  /** What the stored grant asks about, which a whole-agent confirmation keeps. */
  const kept = [...new Set(Object.values(data.asking).flat())].sort();
  const toolLabel = (tool: string) => {
    const key = toolKeys.get(tool);
    return key ? localize(key) : tool;
  };
  return (
    <>
      {choosing && !canAsk && Object.keys(ask).length > 0 && (
        <p id={noteId} className="text-status-warning text-sm">
          {localize('com_ui_schedule_consent_ask_unavailable')}
        </p>
      )}
      {choosing && standing && (
        <div className="flex items-start gap-2">
          <Checkbox
            id={wholeId}
            checked={everything}
            disabled={busy}
            aria-labelledby={`${wholeId}-label`}
            aria-describedby={`${wholeId}-note`}
            onCheckedChange={(checked) => setEverything(checked === true)}
          />
          <div className="space-y-1">
            <Label id={`${wholeId}-label`} htmlFor={wholeId} className="text-sm font-medium">
              {localize('com_ui_schedule_consent_everything')}
            </Label>
            <p id={`${wholeId}-note`} className="text-text-secondary text-xs">
              {localize('com_ui_schedule_consent_everything_note')}
            </p>
            {everything && kept.length > 0 && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={keepId}
                  checked={keepsAsking}
                  disabled={busy}
                  aria-labelledby={`${keepId}-label`}
                  onCheckedChange={(checked) => setKeepsAsking(checked === true)}
                />
                <Label id={`${keepId}-label`} htmlFor={keepId} className="text-xs break-all">
                  {localize('com_ui_schedule_consent_everything_asking', {
                    tools: kept.join(', '),
                  })}
                </Label>
              </div>
            )}
          </div>
        </div>
      )}
      {choosing && !standing && (
        <Button variant="outline" disabled={busy} onClick={allowEverything}>
          {localize('com_ui_schedule_consent_allow_all')}
        </Button>
      )}
      {!choosing && data.everything && (
        <p className="text-text-secondary text-sm">
          {localize('com_ui_schedule_consent_everything_allowed')}
        </p>
      )}
      {!(choosing && everything) && (
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
                    canAsk ? offeredTools(target) : (data.asking[target.resource.serverName] ?? [])
                  }
                  askNoteId={canAsk ? undefined : noteId}
                  disabled={busy}
                  onChange={(tools) => setTools(target.resource.serverName, tools)}
                  onAskingChange={(tools) => setAsking(target.resource.serverName, tools)}
                />
              ) : (
                <>
                  {!data.everything && (
                    <p className="text-text-secondary text-xs">
                      {localize('com_ui_schedule_consent_allowed', {
                        tools: (data.allowed[target.resource.serverName] ?? []).join(', '),
                      })}
                    </p>
                  )}
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
      )}
      {choosing && !everything && offeredOther.length > 0 && (
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
