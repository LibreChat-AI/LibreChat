import { DEFAULT_HOOK_TIMEOUT_MS } from '@librechat/agents';
import {
  Constants,
  grantLifetime,
  splitMCPToolKey,
  normalizeServerName,
  stripServerNamePrefix,
  buildServerNameAliases,
} from 'librechat-data-provider';
import type { RunGrantIdentity, ScheduledMCPIdentity } from 'librechat-data-provider';
import type { RunGrantStorage } from '@librechat/data-schemas';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ParsedServerConfig, RequestScopedMCPConnectionStore } from '~/mcp/types';
import type { ResolvedToolApprovalHook } from '~/agents/hitl/hooks';
import type { MCPToolsSnapshot } from '~/mcp/connection';
import type { RunGrantAuthority } from './contract';
import {
  isRunGrantToolItem,
  RunGrantPolicyError,
  getRunGrantToolDefinitionDigest,
  listedMCPKeys,
} from './policy';
import { getRunGrantConfigurationRevision } from './configuration';
import { ScheduledMCPBearerError } from '~/mcp/errors';
import { findMCPRequestContext } from '~/mcp/request';
import { isOwnedAbortError } from '~/utils/errors';
import { waitUntilDeadline } from '~/mcp/utils';
import { RunGrantError } from './service';

export interface RunGrantInvocation<Identity extends RunGrantIdentity = ScheduledMCPIdentity> {
  readonly identity: Identity;
  /** False only for a monitored legacy occurrence. */
  readonly enrolled?: boolean;
  readonly agentId?: string;
  readonly authorize: (input: {
    user?: { id: string; tenantId?: string };
    serverName: string;
    serverConfig: ParsedServerConfig;
    toolName: string;
    loadTools: () => Promise<MCPToolsSnapshot>;
    signal?: AbortSignal;
    /** The call being made, as the approval layer knows it. Absent when nothing can approve. */
    toolCallId?: string;
    /** A readiness check, which calls nothing. Anything else must hold the owner's approval. */
    readiness?: true;
  }) => Promise<void>;
}

export interface RunGrantExecution<Identity extends RunGrantIdentity = ScheduledMCPIdentity> {
  readonly identity: Identity;
  readonly stage: 'activation' | 'invoke' | 'resume';
  /** Trusted admission provenance retained through credential/session preparation. */
  readonly manual?: boolean;
  readonly enrolled: boolean;
  /**
   * Whether work this run sends to the background can be finished under the same grant: the
   * turn that picks it up resolves the subject's grant again. True for a schedule. False for
   * a subject whose completion turn has no way to find its grant, which keeps a run under a
   * grant in the foreground.
   */
  readonly detaches: boolean;
  /**
   * This is the completion turn of work a run sent to the background. The host addresses it
   * to the agent that started the work, which may be a descendant the schedule's root handed
   * off to: its graph need not contain the root. Each of its tools is still checked against
   * what the grant holds for the agent that calls it.
   */
  readonly completion: boolean;
  /** Legacy admits only while enrollment is still absent; it never acquires a later grant. */
  /** `deadline` is when the wait gives up; by default, well inside a tool hook's timeout. */
  readonly checkEnrollment: (deadline?: number) => Promise<void>;
  /**
   * Whether this run has no grant and may use none of its tools until it gets one. Asked at the
   * first tool call, so a run that calls nothing pays nothing, and kept for the run. Always
   * false where a grant limits MCP tools only: there the MCP call asks for itself.
   */
  readonly needsGrant: (deadline?: number) => Promise<boolean>;
  /**
   * Whether the grant, as read when this run was admitted, lists the tool for the agent.
   * For a readiness check, which looks only at what the owner allowed; a call is checked live.
   */
  readonly grants: (agentId: string, serverName: string, selectionName: string) => boolean;
  /**
   * The agent's tool keys the run may load: the MCP tools the grant lists for the agent, and,
   * where the grant covers the agent's other tools, the ones it lists of those. A run that has
   * no grant keeps them all.
   */
  readonly narrow: (agentId: string, toolKeys: readonly string[]) => string[];
  /**
   * Whether the grant lists this tool, one that is not an MCP tool, for the agent. Always
   * false where the grant does not cover the agents' other tools.
   */
  readonly grantsTool: (agentId: string, toolKey: string) => boolean;
  /**
   * Whether the grant decides the agents' other tools too. False where it limits MCP tools
   * only: no other tool is the grant's to allow or refuse, and each MCP call is checked
   * where it is made.
   */
  readonly coversTools: boolean;
  /** What a run under this subject says in the subject's words. Absent, in plain ones. */
  readonly wording?: PolicyWording;
  /** Whether the grant asks the owner about any tool, so this run may pause. */
  readonly mayAsk: boolean;
  /** Whether the owner approves each use of this tool, by the name the run calls it. */
  readonly asksAbout: (agentId: string, toolKey: string) => boolean;
  /** Whether the owner approves each use of any of these names, whichever agent calls it. */
  readonly asksAboutAny: (toolKeys: readonly string[]) => boolean;
  readonly bind: (
    agentId: string | undefined,
    selectionName: string,
  ) => RunGrantInvocation<Identity>;
}

/** The two things a run says in its subject's words. */
export interface PolicyWording {
  /** What the model is told when it calls a tool the owner left out of the grant. */
  leftOut: string;
  /** The reason a run gives when it stops to ask its owner, which the client has copy for. */
  ask: string;
}

/**
 * What one delivery runs without: MCP servers that were not ready when it started (`skip`),
 * and every server that check covered (`servers`), which a tool key is resolved against.
 */
export interface Without {
  readonly skip: readonly string[];
  readonly servers: readonly string[];
}

const executions = new WeakMap<
  RequestScopedMCPConnectionStore,
  RunGrantExecution<RunGrantIdentity>
>();
/** Kept beside the execution, not on it: a run with no stored grant goes without them too. */
const omissions = new WeakMap<RequestScopedMCPConnectionStore, Without>();

/**
 * Captured at tool construction. Runnable config cannot remove or replace this guard.
 * Whatever the grant's subject, a schedule or an API key, the tool is checked the same way.
 */
export function bindRunGrantInvocation(
  context: RequestScopedMCPConnectionStore | undefined,
  agentId: string | undefined,
  selectionName: string,
): RunGrantInvocation<RunGrantIdentity> | undefined {
  return context && executions.get(context)?.bind(agentId, selectionName);
}

/**
 * Tool keys without those on an MCP server the delivery runs without. The server was not
 * ready when the delivery started and its owner did not ask for every server to be ready:
 * left in, the run would stop to ask for a sign-in nobody is there to give.
 *
 * A key is resolved to its server among every server the check covered, longest name first,
 * as tool loading resolves it: skipping `bar` leaves a tool on `foo_mcp_bar` alone. Returns
 * the same list when nothing is left out.
 */
export function withoutServers(toolKeys: string[], without: Without | undefined): string[] {
  if (!without?.skip.length) return toolKeys;
  const known = [...new Set([...without.servers, ...without.skip])];
  const aliases = buildServerNameAliases(known);
  const candidates = [...known, ...aliases.keys()];
  const out = new Set(without.skip);
  const kept = toolKeys.filter((key) => {
    if (!key.includes(Constants.mcp_delimiter)) return true;
    const [, alias] = splitMCPToolKey(key, candidates);
    const server = alias && (known.includes(alias) ? alias : aliases.get(alias));
    return !(server && out.has(server));
  });
  return kept.length === toolKeys.length ? toolKeys : kept;
}

/**
 * What a run loads for an agent. Under a grant that is only what the owner allowed: a tool
 * left out is never defined for the model, and a server with nothing allowed is never
 * connected to. A run also loads nothing on a server its delivery was started without
 * (`Without`), with a grant or with none. Any other request loads the agent's tools as they
 * are.
 */
export function narrowGrantedTools(
  req: object | undefined,
  agentId: string,
  toolKeys: string[],
): string[] {
  const context = findMCPRequestContext(req);
  if (!context) return toolKeys;
  const granted = executions.get(context)?.narrow(agentId, toolKeys) ?? toolKeys;
  return withoutServers(granted, omissions.get(context));
}

/**
 * For "Always allow" on an approval card. A tool the grant's owner approves on each use is
 * asked about again at its next use whatever the conversation remembers, so it is neither
 * offered nor stored. Reads the grant when asked: on a resume it is attached after this is
 * built. False for a request that runs under no grant.
 */
export function asksEveryUse(req: object | undefined): (toolNames: readonly string[]) => boolean {
  return (toolNames) => {
    const context = findMCPRequestContext(req);
    return (context && executions.get(context)?.asksAboutAny(toolNames)) ?? false;
  };
}

/** The grant the request's run is under, whatever kind of subject holds it. */
export function grantExecution(
  context?: RequestScopedMCPConnectionStore,
): RunGrantExecution<RunGrantIdentity> | undefined {
  return context && executions.get(context);
}

export interface RunGrantExecutionDeps<Identity extends RunGrantIdentity = ScheduledMCPIdentity> {
  storage: RunGrantStorage<Identity>;
  /** Fresh for each call; only this attempt may reuse its principal/configuration. */
  loadAuthorization: (identity: Identity) => Promise<{
    authority: RunGrantAuthority<Identity>;
  }>;
  /** Whether a subject with no grant may not use MCP tools. Absent, it always may. */
  requiresGrant?: (identity: Identity) => Promise<boolean>;
  /**
   * Whether a grant also decides which of the agents' other tools a run loads, so that one
   * it does not list is left out. Absent, a grant limits MCP tools only.
   */
  coversTools?: boolean;
  /**
   * Whether a subject with no grant loads only what a grant that lists nothing would: none of
   * its agents' MCP tools and, where the grant covers the other tools, none of those. Absent,
   * such a run loads every tool and is refused at the call once a grant is required.
   */
  scoped?: boolean;
  /**
   * Whether a completion turn for work a run sent to the background resolves this subject's
   * grant again. Absent, it does not, and a run under a grant starts nothing there.
   */
  detaches?: boolean;
  /** What a run under this subject says in the subject's words. */
  wording?: PolicyWording;
  now?: () => number;
}

export interface RunGrantExecutionOptions {
  manual?: boolean;
  legacy?: boolean;
  /** Tool calls the owner approved in the request that resumed this run. */
  approvedToolCalls?: readonly string[];
  /** Attached for the completion turn of work a run sent to the background. */
  completion?: boolean;
  /**
   * What this delivery runs without. Read by `attach` alone, which keeps it for the request
   * whether or not the subject holds a grant.
   */
  without?: Without;
}

export interface RunGrantExecutionFactory<
  Identity extends RunGrantIdentity = ScheduledMCPIdentity,
> {
  resolve(
    identity: Identity,
    stage: RunGrantExecution['stage'],
    options?: RunGrantExecutionOptions,
  ): Promise<RunGrantExecution<Identity> | undefined>;
  attach(
    context: RequestScopedMCPConnectionStore,
    identity: Identity,
    stage: RunGrantExecution['stage'],
    requireEnrollment?: boolean,
    options?: RunGrantExecutionOptions,
  ): Promise<boolean>;
}

export function createRunGrantExecution<Identity extends RunGrantIdentity = ScheduledMCPIdentity>(
  deps: RunGrantExecutionDeps<Identity>,
): RunGrantExecutionFactory<Identity> {
  async function resolve(
    identity: Identity,
    stage: RunGrantExecution['stage'],
    options: RunGrantExecutionOptions = {},
  ): Promise<RunGrantExecution<Identity> | undefined> {
    const snapshot = await deps.storage.readRunGrant(identity);
    if (snapshot?.compatible === false) throw new RunGrantPolicyError('binding_mismatch', '');
    if (!snapshot) return;
    const enrolled = snapshot.enrollment != null;
    if (enrolled && options.legacy === true) throw new RunGrantPolicyError('binding_mismatch', '');
    const capturedIdentity = Object.freeze({ ...identity });
    const manual = options.manual === true;
    const resources = new Map(
      (snapshot.enrollment?.consents ?? []).map(({ resource }) => [
        resource.serverName,
        structuredClone(resource),
      ]),
    );
    const granted = new Map<string, Map<string, ReadonlySet<string>>>(
      (snapshot.enrollment?.consents ?? []).map(({ resource, permittedTools }) => [
        resource.serverName,
        new Map(permittedTools.map(({ agentId, tools }) => [agentId, new Set(tools)])),
      ]),
    );
    /**
     * Until when the grant read for this run allows anything: its earliest deadline, or not at
     * all once any part of it was revoked. An MCP call is checked against the stored grant when
     * it is made; the agents' other tools have no such call, so they are held to this.
     */
    /**
     * A grant of the whole agent leaves nothing out: every tool loads and is allowed while the
     * grant lasts, whatever the agents had when it was made.
     */
    const whole = snapshot.enrollment?.everything === true;
    const lifetime = snapshot.enrollment ? grantLifetime(snapshot.enrollment) : undefined;
    const liveUntil = lifetime && !lifetime.revoked ? lifetime.expiresAtMs : 0;
    const now = deps.now ?? Date.now;
    /** The agents' tools that are not MCP tools, as the owner allowed them. */
    const others = new Map<string, ReadonlySet<string>>(
      deps.coversTools === true
        ? (snapshot.enrollment?.tools ?? []).map(({ agentId, tools }) => [agentId, new Set(tools)])
        : [],
    );
    const grantedServers = [...granted.keys()];
    const serverAliases = buildServerNameAliases(grantedServers);
    const serverSpellings = [...grantedServers, ...serverAliases.keys()];
    /**
     * Whether a run under the grant loads this MCP key for the agent. A key for one tool needs
     * that tool granted, by name or through a grant of the whole server. A key for every tool
     * on a server needs the whole server granted. A key for the server alone is kept where
     * the grant holds anything on that server for the agent.
     */
    const isGrantedKey = (agentId: string, toolKey: string): boolean => {
      const [selectionName, spelling] = splitMCPToolKey(toolKey, serverSpellings);
      const serverName =
        spelling != null && granted.has(spelling) ? spelling : serverAliases.get(spelling ?? '');
      const tools = serverName == null ? undefined : granted.get(serverName)?.get(agentId);
      if (!tools) return false;
      if (selectionName === Constants.mcp_server) return tools.size > 0;
      return tools.has(selectionName) || tools.has(Constants.mcp_all);
    };
    const approved = new Set(options.approvedToolCalls ?? []);
    /** Every spelling a run may call an ask tool by, per agent. A miss is refused, not run. */
    const asking = new Map<string, Set<string>>();
    /**
     * Under a grant of the whole agent a question holds for any agent, and for a tool the
     * consent does not name: one an agent has through a selection of the whole server, or an
     * agent added since. Nothing there is listed per agent, so these are asked whoever calls.
     */
    const askingAny = new Set<string>();
    for (const consent of snapshot.enrollment?.consents ?? []) {
      const { serverName } = consent.resource;
      const spellings = (tool: string): string[] => [
        `${tool}${Constants.mcp_delimiter}${serverName}`,
        `${tool}${Constants.mcp_delimiter}${normalizeServerName(serverName)}`,
      ];
      if (whole)
        for (const tool of consent.askTools ?? [])
          spellings(tool).forEach((key) => askingAny.add(key));
      for (const { agentId, tools } of consent.permittedTools) {
        const keys = asking.get(agentId) ?? new Set<string>();
        // An agent granted the whole server has every tool there, so every tool the consent
        // asks about is asked about for it too, named for it or not.
        const asked = tools.includes(Constants.mcp_all)
          ? (consent.askTools ?? [])
          : tools.filter((tool) => consent.askTools?.includes(tool));
        for (const tool of asked) for (const key of spellings(tool)) keys.add(key);
        if (keys.size > 0) asking.set(agentId, keys);
      }
    }
    const allows = (agentId: string, toolKey: string): boolean =>
      (whole || others.get(agentId)?.has(toolKey) === true) && now() < liveUntil;
    /** An MCP tool the grant names for the agent among its other tools. */
    const names = (agentId: string, serverName: string, selectionName: string): boolean =>
      listedMCPKeys(serverName, selectionName).some(
        (key) => others.get(agentId)?.has(key) === true,
      );
    /** The same, while the grant lasts: what a run loads and is made ready for. */
    const lists = (agentId: string, serverName: string, selectionName: string): boolean =>
      names(agentId, serverName, selectionName) && now() < liveUntil;
    /**
     * Whether a run under the grant loads this key of the agent's. An MCP key loads when a
     * consent grants it, or when it is itself listed among the other tools. A key for a server
     * alone loads where anything on that server is listed.
     */
    const loads = (agentId: string, toolKey: string): boolean => {
      if (!toolKey.includes(Constants.mcp_delimiter))
        return (
          deps.coversTools !== true || !isRunGrantToolItem(toolKey) || allows(agentId, toolKey)
        );
      if (whole || isGrantedKey(agentId, toolKey) || allows(agentId, toolKey)) return true;
      const marker = `${Constants.mcp_server}${Constants.mcp_delimiter}`;
      if (!toolKey.startsWith(marker) || now() >= liveUntil) return false;
      const suffix = `${Constants.mcp_delimiter}${toolKey.slice(marker.length)}`;
      return [...(others.get(agentId) ?? [])].some((key) => key.endsWith(suffix));
    };
    let fenced = false;
    /** Asked at the first MCP call, so a run that uses none pays nothing. Kept for the run. */
    let required: Promise<boolean> | undefined;
    const requiresGrant = (): Promise<boolean> => {
      required ??= (deps.requiresGrant?.(capturedIdentity) ?? Promise.resolve(false)).catch(
        (error: unknown) => {
          required = undefined;
          throw error;
        },
      );
      return required;
    };
    // Finish before the SDK discards a timed-out hook's contribution.
    const settleBy = (): number => Date.now() + DEFAULT_HOOK_TIMEOUT_MS / 2;
    const checkEnrollment = async (deadline = settleBy()): Promise<void> => {
      if (enrolled) return;
      if (fenced) throw new RunGrantPolicyError('binding_mismatch', '');
      // No allow decision cached.
      const observed = await waitUntilDeadline(
        deps.storage.readRunGrant(capturedIdentity),
        deadline,
      );
      if (!observed.settled) throw new RunGrantPolicyError('dependency_unavailable', '');
      if (
        !observed.value ||
        observed.value.compatible === false ||
        observed.value.enrollment != null
      ) {
        fenced = true;
        throw new RunGrantPolicyError('binding_mismatch', '');
      }
    };
    return Object.freeze({
      identity: capturedIdentity,
      stage,
      ...(manual && { manual: true }),
      enrolled,
      detaches: deps.detaches === true,
      completion: options.completion === true,
      checkEnrollment,
      needsGrant: async (deadline = settleBy()) => {
        if (enrolled || deps.coversTools !== true) return false;
        const observed = await waitUntilDeadline(requiresGrant(), deadline);
        if (!observed.settled) throw new RunGrantPolicyError('dependency_unavailable', '');
        return observed.value;
      },
      grants: (agentId: string, serverName: string, selectionName: string) => {
        const tools = granted.get(serverName)?.get(agentId);
        return (
          whole ||
          tools?.has(selectionName) === true ||
          tools?.has(Constants.mcp_all) === true ||
          lists(agentId, serverName, selectionName)
        );
      },
      narrow: (agentId: string, toolKeys: readonly string[]) =>
        enrolled || deps.scoped === true
          ? toolKeys.filter((key) => loads(agentId, key))
          : [...toolKeys],
      grantsTool: allows,
      coversTools: deps.coversTools === true,
      ...(deps.wording && { wording: deps.wording }),
      mayAsk: asking.size > 0 || askingAny.size > 0,
      asksAbout: (agentId: string, toolKey: string) =>
        asking.get(agentId)?.has(toolKey) === true || askingAny.has(toolKey),
      asksAboutAny: (toolKeys: readonly string[]) =>
        toolKeys.some(
          (key) => askingAny.has(key) || [...asking.values()].some((keys) => keys.has(key)),
        ),
      bind(agentId: string | undefined, selectionName: string): RunGrantInvocation<Identity> {
        return Object.freeze({
          identity: capturedIdentity,
          agentId,
          enrolled,
          async authorize({
            user,
            serverName,
            serverConfig,
            toolName,
            loadTools,
            signal,
            toolCallId,
            readiness,
          }: Parameters<RunGrantInvocation<Identity>['authorize']>[0]): Promise<void> {
            signal?.throwIfAborted();
            const deny = (reason: ConstructorParameters<typeof RunGrantPolicyError>[0]): never => {
              throw new RunGrantPolicyError(reason, serverName, agentId);
            };
            if (
              !agentId ||
              user?.id !== capturedIdentity.ownerId ||
              (user.tenantId ?? null) !== capturedIdentity.tenantId
            )
              deny('binding_mismatch');
            if (!enrolled) {
              try {
                await checkEnrollment();
                if (await requiresGrant()) deny('consent_missing');
              } catch (error) {
                signal?.throwIfAborted();
                deny(
                  error instanceof RunGrantPolicyError
                    ? error.failure.reason
                    : 'dependency_unavailable',
                );
              }
              signal?.throwIfAborted();
              return;
            }
            // Only the recipient is captured. Authority re-resolves live graph/policy below.
            const resource = resources.get(serverName);
            // The grant holds no consent for this server: one the operator did not declare, or,
            // under a grant of the whole agent, one the agents took up since. Where the grant
            // is for the whole agent or lists this tool for the agent, the call goes ahead as
            // the owner's own would, after the same live checks a consented server gets.
            // Whether it is still in force is for those checks to say, with the reason.
            if (!resource && (whole || names(agentId!, serverName, selectionName))) {
              try {
                const { authority } = await deps.loadAuthorization(capturedIdentity);
                const standing = await authority.standing(
                  {
                    identity: capturedIdentity,
                    revision: snapshot.enrollment!.revision,
                    stage,
                    ...(manual && { manual: true }),
                    ...(!whole && {
                      listed: { agentId: agentId!, keys: listedMCPKeys(serverName, selectionName) },
                    }),
                  },
                  { signal },
                );
                signal?.throwIfAborted();
                if (standing.state === 'denied') deny(standing.failure.reason);
                if (standing.state === 'cancelled') deny('dependency_unavailable');
              } catch (error) {
                if (error instanceof RunGrantPolicyError || isOwnedAbortError(error, signal))
                  throw error;
                deny('dependency_unavailable');
              }
              return;
            }
            if (!resource) deny('tool_policy_denied');
            try {
              if (
                getRunGrantConfigurationRevision(serverConfig, resource!) !==
                resource!.configurationRevision
              )
                deny('binding_mismatch');
            } catch (error) {
              if (error instanceof RunGrantError) deny('binding_mismatch');
              throw error;
            }
            // Resolve the actual upstream operation, including legacy and prefix-stripped keys.
            if (
              selectionName !== toolName &&
              selectionName !== stripServerNamePrefix(toolName, normalizeServerName(serverName))
            )
              deny('tool_policy_denied');
            try {
              const [evaluation, catalog] = await Promise.all([
                deps.loadAuthorization(capturedIdentity),
                loadTools(),
              ]);
              signal?.throwIfAborted();
              if (catalog.authenticationError != null) deny('credential_rejected');
              const definitions = catalog.tools.filter((tool: Tool) => tool.name === toolName);
              if (!catalog.complete || definitions.length !== 1) deny('tool_policy_denied');
              const authorization = await evaluation.authority.authorize(
                {
                  identity: capturedIdentity,
                  resource: resource!,
                  stage,
                  ...(manual && { manual: true }),
                  selection: { agentId: agentId!, tools: [selectionName] },
                  definitions: {
                    [selectionName]: getRunGrantToolDefinitionDigest(definitions[0]),
                  },
                },
                { signal },
              );
              if (authorization.state === 'denied') deny(authorization.failure.reason);
              if (authorization.state === 'cancelled') {
                signal?.throwIfAborted();
                deny('dependency_unavailable');
              }
              // The pause is a hook, and a hook that times out says nothing. This is the gate.
              if (
                authorization.state === 'authorized' &&
                authorization.approvalRequired &&
                readiness !== true &&
                !(toolCallId != null && approved.has(toolCallId))
              )
                deny('approval_required');
              signal?.throwIfAborted();
            } catch (error) {
              if (
                error instanceof RunGrantPolicyError ||
                error instanceof ScheduledMCPBearerError ||
                isOwnedAbortError(error, signal)
              )
                throw error;
              deny('dependency_unavailable');
            }
          },
        });
      },
    });
  }
  return {
    resolve,
    async attach(context, identity, stage, requireEnrollment = false, options) {
      const execution = await resolve(identity, stage, options);
      if ((!execution || !execution.enrolled) && requireEnrollment)
        throw new RunGrantPolicyError('consent_missing', '');
      if (execution) executions.set(context, execution);
      if (options?.without?.skip.length) omissions.set(context, options.without);
      return execution != null;
    },
  };
}

/**
 * Tells run admission that the run's grant can pause it, so what a paused run needs is
 * checked before any provider work. Never asked for a decision.
 */
export function approvalHooks(
  execution?: Pick<RunGrantExecution<RunGrantIdentity>, 'mayAsk'>,
): ResolvedToolApprovalHook[] {
  return execution?.mayAsk === true ? [{ hook: async () => ({}) }] : [];
}

/** The tool calls the owner let through, as proposed or edited, in a validated resume value. */
export function collectApprovedToolCalls(resumeValue: unknown): string[] {
  if (resumeValue == null || typeof resumeValue !== 'object' || Array.isArray(resumeValue))
    return [];
  return Object.entries(resumeValue)
    .filter(
      ([, decision]) =>
        decision != null &&
        typeof decision === 'object' &&
        'type' in decision &&
        (decision.type === 'approve' || decision.type === 'edit'),
    )
    .map(([toolCallId]) => toolCallId);
}
