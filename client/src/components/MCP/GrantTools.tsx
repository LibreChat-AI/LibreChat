import { useId, useState } from 'react';
import { Label, Button, Checkbox } from '@librechat/client';
import { Tools, Constants, AgentCapabilities, normalizeServerName } from 'librechat-data-provider';
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

/**
 * The tool and server an MCP key names. Either name may contain the delimiter, so the key is
 * read against the servers the agents use, longest first, by either spelling. Where none
 * fits, a selection of a whole server is still told by its marker, and anything else falls
 * back to the last delimiter.
 */
export function splitToolKey(
  key: string,
  servers: readonly string[],
): { name: string; server: string } | undefined {
  const delimiter = Constants.mcp_delimiter;
  const known = [...servers]
    .sort((a, b) => b.length - a.length)
    .flatMap((server) =>
      [server, normalizeServerName(server)].map((spelling) => ({
        server,
        suffix: `${delimiter}${spelling}`,
      })),
    )
    .find(({ suffix }) => key.endsWith(suffix) && key.length > suffix.length);
  if (known) return { name: key.slice(0, -known.suffix.length), server: known.server };
  const whole = `${Constants.mcp_all}${delimiter}`;
  if (key.startsWith(whole) && key.length > whole.length)
    return { name: `${Constants.mcp_all}`, server: key.slice(whole.length) };
  const at = key.lastIndexOf(delimiter);
  if (at <= 0) return undefined;
  return { name: key.slice(0, at), server: key.slice(at + delimiter.length) };
}

/** Every tool on offer for a server, whichever agents selected it. */
function offeredTools(target: ScheduledMCPTarget): string[] {
  return [...new Set(target.permittedTools.flatMap((selection) => selection.tools))].sort();
}

/**
 * Whether a ticked item survives the marks. A named tool answers for its own. The whole server
 * covers every tool on it, named elsewhere or not, so it answers for all of them: left ticked
 * over a change it would allow the new definition with nobody having looked at it.
 */
function unmarked(tool: string, marked: readonly string[], seen: readonly string[] = []): boolean {
  const every: string = Constants.mcp_all;
  if (tool !== every) return !marked.includes(tool) || seen.includes(tool);
  return marked.every((name) => seen.includes(name));
}

/**
 * The whole server ticked is every tool on it ticked. One agent may select the server as a
 * whole while another names a tool there, and the owner sees one list for the server: a named
 * tool left out beside a ticked whole server would be allowed for the first agent and refused
 * for the second, with nothing on screen to tell them apart.
 */
function spread(offered: readonly string[], ticked: string[]): string[] {
  return ticked.includes(Constants.mcp_all) ? [...offered] : ticked;
}

/**
 * The owner's starting point: what the stored grant already allows and is still on offer.
 * A tool whose definition changed starts unticked, so allowing the new one is a decision.
 *
 * A grant of the whole server allows every tool there. When the agents come to name tools the
 * grant never named, those start ticked too: they are authorized now, and confirming as shown
 * must not take them away.
 */
function initialChoice(data: ScheduleMCPConsentView): Record<string, string[]> {
  return Object.fromEntries(
    data.targets.map((target) => {
      const offered = offeredTools(target);
      const allowed = data.allowed[target.resource.serverName] ?? [];
      const changed = data.changed[target.resource.serverName] ?? [];
      return [
        target.resource.serverName,
        spread(
          offered,
          offered.filter(
            (tool) =>
              (allowed.includes(tool) || allowed.includes(Constants.mcp_all)) &&
              unmarked(tool, changed),
          ),
        ),
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
        spread(
          offered,
          (edited.choice[serverName] ?? initial[serverName]).filter(
            (tool) => offered.includes(tool) && unmarked(tool, marked, seen),
          ),
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
  /**
   * Sent with the confirmation: of the tools allowed now, the ones the owner asks about. A
   * tool is allowed when it is ticked, or when the whole of its server is: a question about a
   * tool the whole-server item still covers is not dropped because its own box went away.
   */
  const ask = Object.fromEntries(
    Object.entries(asking)
      .map(([serverName, tools]): [string, string[]] => {
        const ticked = choice[serverName] ?? [];
        const every = ticked.includes(Constants.mcp_all);
        return [serverName, tools.filter((tool) => every || ticked.includes(tool))];
      })
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
  /**
   * An MCP tool listed among the other tools is on a server the operator declared nothing
   * for, and comes as the key the agent has it by: its name and server, or every tool there.
   */
  const toolLabel = (tool: string) => {
    const key = toolKeys.get(tool);
    if (key) return localize(key);
    const part = splitToolKey(tool, data.tools.servers ?? []);
    if (!part) return tool;
    return part.name === Constants.mcp_all
      ? localize('com_ui_schedule_consent_tools_on_server', { server: part.server })
      : localize('com_ui_schedule_consent_tool_on_server', {
          tool: part.name,
          server: part.server,
        });
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
                        tools: (data.allowed[target.resource.serverName] ?? [])
                          .map((tool) =>
                            tool === Constants.mcp_all
                              ? localize('com_ui_schedule_consent_server_every', {
                                  server: target.resource.serverName,
                                })
                              : tool,
                          )
                          .join(', '),
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
  /**
   * A selection of the whole server is one item of its own, listed first: every tool there,
   * including ones the server gains later. While it is ticked each named tool is ticked with
   * it and cannot be unticked on its own; unticked, the named tools stay as they are.
   */
  const every: string = Constants.mcp_all;
  const named = offered.filter((tool) => tool !== every);
  const whole = offered.includes(every);
  const covered = chosen.includes(every);
  /**
   * Questions the grant holds about tools that have no row here: reached only through the
   * whole server. Each gets a row under that item while it is ticked, so the owner can keep
   * asking or stop.
   */
  const retained = covered ? asking.filter((tool) => tool !== every && !named.includes(tool)) : [];
  /** Checked only when every tool is: the shared box has no partly-selected appearance. */
  const all = named.length > 0 && named.every((tool) => chosen.includes(tool));
  const everyId = `${groupId}-every`;
  return (
    <fieldset className="mt-2 space-y-1" disabled={disabled}>
      {whole && (
        <div>
          <div className="flex items-start gap-2">
            <Checkbox
              id={everyId}
              checked={covered}
              disabled={disabled}
              className="mt-0.5"
              aria-labelledby={`${everyId}-label`}
              aria-describedby={changed.length > 0 ? `${everyId}-changed` : undefined}
              onCheckedChange={(checked) =>
                onChange(
                  checked === true ? [...chosen, every] : chosen.filter((name) => name !== every),
                )
              }
            />
            <Label id={`${everyId}-label`} htmlFor={everyId} className="text-xs wrap-anywhere">
              {localize('com_ui_schedule_consent_server_every', { server: serverName })}
            </Label>
          </div>
          {changed.length > 0 && (
            <p id={`${everyId}-changed`} className="text-status-warning pl-6 text-xs wrap-anywhere">
              {localize('com_ui_schedule_consent_server_changed', { tools: changed.join(', ') })}
            </p>
          )}
          {retained.length > 0 && (
            <ul className="space-y-1 pl-6">
              {retained.map((asked) => (
                <li key={asked} className="flex items-start gap-2">
                  <Checkbox
                    id={`${groupId}-${asked}-retained`}
                    checked
                    disabled={disabled}
                    className="mt-0.5"
                    aria-label={localize('com_ui_schedule_consent_ask_tool', { tool: asked })}
                    aria-describedby={askNoteId}
                    onCheckedChange={(checked) => {
                      if (checked !== true) onAskingChange(asking.filter((name) => name !== asked));
                    }}
                  />
                  <Label htmlFor={`${groupId}-${asked}-retained`} className="text-xs wrap-anywhere">
                    {localize('com_ui_schedule_consent_ask_tool', { tool: asked })}
                  </Label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {named.length > 0 && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${groupId}-all`}
            checked={all}
            disabled={disabled || covered}
            aria-label={localize('com_ui_schedule_consent_allow_server', { server: serverName })}
            aria-describedby={covered ? `${everyId}-label` : undefined}
            onCheckedChange={(checked) => onChange(checked === true ? named : [])}
          />
          <Label htmlFor={`${groupId}-all`} className="text-xs">
            {localize('com_ui_schedule_consent_allow_server', { server: serverName })}
          </Label>
        </div>
      )}
      <ul className="space-y-1 pl-6">
        {named.map((tool) => {
          const warned = changed.includes(tool);
          const described = [
            covered ? `${everyId}-label` : undefined,
            warned ? `${groupId}-${tool}-changed` : undefined,
          ].filter(Boolean);
          return (
            <li key={tool}>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`${groupId}-${tool}`}
                  checked={chosen.includes(tool)}
                  disabled={disabled || covered}
                  aria-labelledby={`${groupId}-${tool}-label`}
                  aria-describedby={described.length > 0 ? described.join(' ') : undefined}
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
                    <Label
                      htmlFor={`${groupId}-${tool}-ask`}
                      variant="secondary"
                      className="text-xs"
                    >
                      {localize('com_ui_schedule_consent_ask_first')}
                    </Label>
                  </span>
                )}
              </div>
              {warned && (
                <p id={`${groupId}-${tool}-changed`} className="text-status-warning pl-6 text-xs">
                  {localize('com_ui_schedule_consent_tool_changed')}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
