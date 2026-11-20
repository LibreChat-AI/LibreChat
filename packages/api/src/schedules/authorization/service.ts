import { createHash, randomUUID } from 'node:crypto';
import { Constants, grantLifetime, scheduledMCPTargetSchema } from 'librechat-data-provider';
import type {
  MCPGrantConsent,
  MCPGrantIdentity,
  MCPGrantEnrollment,
  ScheduledMCPIdentity,
  ScheduledMCPResource,
  ScheduledMCPTarget,
  ScheduleMCPConsentView,
  ScheduleAuthorization,
  ScheduledMCPToolSelection,
  ConfirmScheduleMCPConsent,
} from 'librechat-data-provider';
import type { MCPConsentStorage } from '@librechat/data-schemas';
import type { ScheduledMCPAuthority, ScheduledMCPFailureReason } from './contract';
import { getScheduledMCPPolicyRevision } from './policy';
import { failureFixtures } from './failures';

export interface ScheduleMCPConsentLimits {
  enabled: boolean;
  maxLifetimeHours: number;
  /** From then on a schedule with no grant can no longer use MCP tools. */
  requireAfterMs?: number;
}

/**
 * A schedule its owner never authorized keeps using MCP tools unrestricted, until the owner
 * edits it or the operator's deadline passes. Nothing is required where consent is off.
 */
function requiresGrant(
  limits: ScheduleMCPConsentLimits,
  snapshot: { required?: boolean },
  nowMs: number,
): boolean {
  return (
    limits.enabled &&
    (snapshot.required === true ||
      (limits.requireAfterMs != null && nowMs >= limits.requireAfterMs))
  );
}
export type ScheduleMCPEnrollmentResolver<
  Identity extends MCPGrantIdentity = ScheduledMCPIdentity,
> = (
  identity: Identity,
  options: { signal?: AbortSignal },
) => Promise<readonly ScheduledMCPTarget[]>;

/** The agents' tools that are not MCP tools, each of which the owner may allow or leave out. */
export type ScheduleToolsResolver<Identity extends MCPGrantIdentity = ScheduledMCPIdentity> = (
  identity: Identity,
  options: { signal?: AbortSignal },
) => Promise<readonly ScheduledMCPToolSelection[]>;

/** The name of every MCP server the agents select a tool on, whether or not it can be offered. */
export type ScheduleServersResolver<Identity extends MCPGrantIdentity = ScheduledMCPIdentity> = (
  identity: Identity,
  options: { signal?: AbortSignal },
) => Promise<readonly string[]>;

/** The grant's subject is a schedule unless said otherwise: an API key and agent is the other. */
export interface ScheduleMCPConsentDeps<Identity extends MCPGrantIdentity = ScheduledMCPIdentity> {
  storage: MCPConsentStorage<Identity>;
  getLimits: (identity: Identity) => Promise<ScheduleMCPConsentLimits>;
  /** Loads current user/tenant/role and schedule/agent/resource access; no role snapshot. */
  canUse: (identity: Identity, options: { signal?: AbortSignal }) => Promise<boolean>;
  /**
   * Whether the owner may use MCP servers now, asked before an MCP call is let through.
   * Absent, `canUse` answers for it. Authorizing the other tools does not depend on it.
   */
  canUseMCP?: (identity: Identity, options: { signal?: AbortSignal }) => Promise<boolean>;
  /** What the owner can be offered now: reachable agents' selected tools, per declared server. */
  resolveEnrollment?: ScheduleMCPEnrollmentResolver<Identity>;
  /** The agents' other tools on offer. Absent, a grant covers MCP tools only. */
  resolveTools?: ScheduleToolsResolver<Identity>;
  /** The servers in use, for telling a server that lost its declaration from one that is gone. */
  resolveServers?: ScheduleServersResolver<Identity>;
  /** Whether a run of this subject can pause for the owner's approval here. Absent, it cannot. */
  canPause?: (identity: Identity) => Promise<boolean>;
  now?: () => number;
}

export class ScheduleMCPConsentError extends Error {
  constructor(
    readonly code:
      | 'consent_unavailable'
      | 'consent_forbidden'
      | 'consent_not_found'
      | 'consent_changed'
      | 'consent_invalid',
  ) {
    super(code);
    this.name = 'ScheduleMCPConsentError';
  }
}

function canonicalTargets(
  targets: readonly ScheduledMCPTarget[],
  /** A grant for other tools only names no MCP server. */
  options: { empty?: boolean } = {},
): ScheduledMCPTarget[] {
  if ((!targets.length && options.empty !== true) || targets.length > 32)
    throw new ScheduleMCPConsentError('consent_unavailable');
  const servers = new Set<string>();
  return targets
    .map((target) => {
      const parsed = scheduledMCPTargetSchema.parse(target);
      if (
        servers.has(parsed.resource.serverName) ||
        parsed.resource.credentialMode === 'browser_bearer'
      )
        throw new ScheduleMCPConsentError('consent_invalid');
      servers.add(parsed.resource.serverName);
      const agents = new Set<string>();
      const permittedTools = parsed.permittedTools
        .map((selection) => {
          if (agents.has(selection.agentId)) throw new ScheduleMCPConsentError('consent_invalid');
          agents.add(selection.agentId);
          return { agentId: selection.agentId, tools: [...new Set(selection.tools)].sort() };
        })
        .sort((a, b) => a.agentId.localeCompare(b.agentId));
      return {
        ...parsed,
        permittedTools,
        resource: { ...parsed.resource, scopes: [...new Set(parsed.resource.scopes)].sort() },
      };
    })
    .sort((a, b) => a.resource.serverName.localeCompare(b.resource.serverName));
}

function sameResource(left: ScheduledMCPResource, right: ScheduledMCPResource): boolean {
  const binding = (resource: ScheduledMCPResource) => [
    resource.serverName,
    resource.url,
    resource.configurationRevision,
    resource.credentialMode,
    resource.issuer,
    resource.audience,
    [...new Set(resource.scopes)].sort(),
  ];
  return JSON.stringify(binding(left)) === JSON.stringify(binding(right));
}

/** The tools a grant allows on each server, across every agent that selected them. */
function allowedTools(targets: readonly ScheduledMCPTarget[]): Record<string, string[]> {
  return Object.fromEntries(
    targets.map((target) => [
      target.resource.serverName,
      [...new Set(target.permittedTools.flatMap((selection) => selection.tools))].sort(),
    ]),
  );
}

/**
 * Narrows the offer to what the owner chose. Every chosen server and tool must be on offer,
 * and a server with nothing chosen is left out of the grant altogether.
 */
function selectAllowed(
  offered: readonly ScheduledMCPTarget[],
  allow: ConfirmScheduleMCPConsent['allow'],
): ScheduledMCPTarget[] {
  const chosen: ScheduledMCPTarget[] = [];
  for (const [serverName, tools] of Object.entries(allow)) {
    const target = offered.find((item) => item.resource.serverName === serverName);
    const selected = new Set(tools);
    // Built once per server: a selection can run to thousands of tools across many agents.
    const onOffer = new Set(target?.permittedTools.flatMap((selection) => selection.tools));
    if (!target || tools.some((tool) => !onOffer.has(tool)))
      throw new ScheduleMCPConsentError('consent_invalid');
    const permittedTools = target.permittedTools
      .map(({ agentId, tools: offeredTools }) => ({
        agentId,
        tools: offeredTools.filter((tool) => selected.has(tool)),
      }))
      .filter((selection) => selection.tools.length > 0);
    if (permittedTools.length === 0) continue;
    chosen.push({
      resource: target.resource,
      permittedTools,
      policyRevision: getScheduledMCPPolicyRevision(permittedTools),
    });
  }
  // No MCP tool chosen: the grant may still allow the agents' other tools.
  return canonicalTargets(chosen, { empty: true });
}

/**
 * Of the allowed tools, the ones the owner approves call by call. Each must be allowed on a
 * server that made it into the grant. A confirmation that says nothing about asking keeps
 * what the stored grant asks about, for the tools still allowed: only an explicit choice
 * turns a tool the owner approves each time into one that runs unattended.
 *
 * A grant of the whole agent (`whole`) allows every tool on its servers, named there or not,
 * so a question about any tool on one of them holds: the agents may have come to select the
 * server as a whole, which names none.
 */
function selectAsking(
  chosen: readonly ScheduledMCPTarget[],
  ask: ConfirmScheduleMCPConsent['ask'],
  stored: Record<string, string[]>,
  whole = false,
): Record<string, string[]> {
  const allowed = allowedTools(chosen);
  // The whole server is not something to ask about: it names no tool to pause for. A tool it
  // covers is: allowed there by name, or through a grant of the whole server to some agent.
  const askable = (serverName: string, tool: string): boolean => {
    const tools = allowed[serverName];
    if (tool === Constants.mcp_all || tools == null) return false;
    return whole || tools.includes(tool) || tools.includes(Constants.mcp_all);
  };
  if (ask == null)
    return Object.fromEntries(
      Object.entries(stored)
        .map(([serverName, tools]): [string, string[]] => [
          serverName,
          tools.filter((tool) => askable(serverName, tool)),
        ])
        .filter(([, tools]) => tools.length > 0),
    );
  return Object.fromEntries(
    Object.entries(ask)
      .filter(([, tools]) => tools.length > 0)
      .map(([serverName, tools]) => {
        if (tools.some((tool) => !askable(serverName, tool)))
          throw new ScheduleMCPConsentError('consent_invalid');
        return [serverName, [...new Set(tools)].sort()];
      }),
  );
}

/** Whether the grant still fits what is on offer: same recipients, and every allowed tool still selected. */
function coversGrant(
  offered: readonly ScheduledMCPTarget[],
  granted: readonly ScheduledMCPTarget[],
): boolean {
  return granted.every((grant) => {
    const target = offered.find((item) => item.resource.serverName === grant.resource.serverName);
    return (
      target != null &&
      sameResource(target.resource, grant.resource) &&
      grant.permittedTools.every(({ agentId, tools }) => {
        const current = target.permittedTools.find((selection) => selection.agentId === agentId);
        // A grant of the whole server fits whatever the agent selects there now.
        return (
          current != null &&
          tools.every((tool) => tool === Constants.mcp_all || covers(current, tool))
        );
      })
    );
  });
}

/**
 * Whether a per-agent selection covers a tool: it names the tool, or it is of the whole
 * server (`mcp_all`), which stands for every tool there, named or not, now or later.
 */
function covers(selection: ScheduledMCPToolSelection | undefined, tool: string): boolean {
  return (
    selection != null &&
    (selection.tools.includes(tool) || selection.tools.includes(Constants.mcp_all))
  );
}

/**
 * For a grant of the whole agent: its servers still on offer are the ones it was made for.
 * What the agents select there may have changed since, and a server may be gone. One that
 * is still `used` but no longer on offer has lost its declaration, or is declared for another
 * URL: its calls are refused, so the grant no longer fits.
 */
function keepsResources(
  offered: readonly ScheduledMCPTarget[],
  granted: readonly ScheduledMCPTarget[],
  used: readonly string[] = [],
): boolean {
  return granted.every((grant) => {
    const { serverName } = grant.resource;
    const target = offered.find((item) => item.resource.serverName === serverName);
    return target ? sameResource(target.resource, grant.resource) : !used.includes(serverName);
  });
}

/** Every tool named in a set of per-agent selections, once. */
function toolNames(selections: readonly ScheduledMCPToolSelection[]): string[] {
  return [...new Set(selections.flatMap((selection) => selection.tools))].sort();
}

/**
 * Of the agents' tools that are not MCP tools, the ones the owner allows, per agent that has
 * them. Each must be on offer. A confirmation that does not say keeps what the stored grant
 * allows, for the tools still on offer.
 */
function selectTools(
  offered: readonly ScheduledMCPToolSelection[],
  chosen: readonly string[] | undefined,
  stored: readonly ScheduledMCPToolSelection[] = [],
): ScheduledMCPToolSelection[] {
  const onOffer = new Set(toolNames(offered));
  const names = new Set(chosen ?? toolNames(stored).filter((tool) => onOffer.has(tool)));
  if ([...names].some((tool) => !onOffer.has(tool)))
    throw new ScheduleMCPConsentError('consent_invalid');
  return offered
    .map(({ agentId, tools }) => ({ agentId, tools: tools.filter((tool) => names.has(tool)) }))
    .filter((selection) => selection.tools.length > 0);
}

/** Allowed tools the grant asks the owner about before each use, by server. */
function askingTools(
  consents: readonly MCPGrantConsent<MCPGrantIdentity>[],
): Record<string, string[]> {
  return Object.fromEntries(
    consents
      .filter((consent) => consent.askTools?.length)
      .map((consent) => [consent.resource.serverName, [...consent.askTools!].sort()]),
  );
}

/** Allowed tools a run saw with a definition other than their pin, by server. */
function changedTools(
  consents: readonly MCPGrantConsent<MCPGrantIdentity>[],
): Record<string, string[]> {
  return Object.fromEntries(
    consents
      .filter((consent) => consent.changedTools?.length)
      .map((consent) => [consent.resource.serverName, [...consent.changedTools!].sort()]),
  );
}

/**
 * Pins survive a renewal so confirming again cannot quietly accept a definition nobody has
 * looked at. A tool marked as changed loses its pin: confirming it is the owner's decision
 * to accept what the server offers now, and its next use is pinned afresh.
 */
function carriedPins(
  target: ScheduledMCPTarget,
  prior?: MCPGrantConsent<MCPGrantIdentity>,
): Pick<MCPGrantConsent<MCPGrantIdentity>, 'definitions'> {
  if (!prior?.definitions || !sameResource(prior.resource, target.resource)) return {};
  const allowed = new Set(target.permittedTools.flatMap((selection) => selection.tools));
  const marked = new Set(prior.changedTools);
  // A grant of the whole server keeps the pin of every tool used under it: the tool is not
  // named, but it is still allowed, and its pin is what refuses it once it changes. A tool
  // marked as changed loses its pin either way: confirming again is allowing the new one.
  const every = allowed.has(Constants.mcp_all);
  const definitions = prior.definitions.filter(
    (pin) => (every || allowed.has(pin.tool)) && !marked.has(pin.tool),
  );
  return definitions.length ? { definitions } : {};
}

/**
 * Names what the owner was shown: the subject, its configuration, what is on offer, and which
 * allowed tools were marked as changed. A dialog opened before a tool was marked cannot
 * confirm past the mark; it is told the offer changed and reads it again.
 */
function offerDigest(
  /** The subject, or for a schedule that is not stored yet, its owner and agent. */
  identity: object,
  configRevision: number,
  targets: readonly ScheduledMCPTarget[],
  changed: Record<string, string[]>,
  tools: readonly ScheduledMCPToolSelection[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        identity,
        configRevision,
        targets,
        // Left out while nothing is marked, so an offer made before marks existed still holds.
        ...(Object.keys(changed).length > 0 && { changed }),
        // Likewise for an offer with no other tools to choose from.
        ...(tools.length > 0 && { tools }),
      }),
    )
    .digest('hex');
}

export interface ScheduleMCPConsentService<
  Identity extends MCPGrantIdentity = ScheduledMCPIdentity,
> {
  view: (identity: Identity, options?: { signal?: AbortSignal }) => Promise<ScheduleMCPConsentView>;
  /** The offer for a subject that is not stored yet. */
  draft: (
    identity: Identity,
    options?: { signal?: AbortSignal },
  ) => Promise<ScheduleMCPConsentView>;
  /**
   * The grant for a subject about to be created, or for a stored one that an edit is moving
   * to another agent: either way it is chosen from the offer for the agent alone. Stores
   * nothing. `revision` is the subject's configuration generation the grant is made for:
   * zero for a new subject, the one the edit makes for a stored one.
   */
  grant: (
    identity: Identity,
    input: ScheduleAuthorization,
    options?: { signal?: AbortSignal; revision?: number },
  ) => Promise<MCPGrantEnrollment<Identity>>;
  /**
   * The grant an edit of a stored subject carries, chosen from the subject's own offer like
   * a confirmation and checked the same way. Stores nothing: the caller writes it with the
   * edit, for the configuration generation (`revision`) that edit makes.
   */
  renew: (
    identity: Identity,
    input: ConfirmScheduleMCPConsent,
    revision: number,
    options?: { signal?: AbortSignal },
  ) => Promise<{
    enrollment: MCPGrantEnrollment<Identity>;
    /**
     * The stored grant the new one was decided against, `null` where there was none. The
     * caller's write must be refused unless that is still what is stored, untouched: a
     * revocation, another confirmation, or a pin or mark a run added since would be lost.
     */
    basis: MCPGrantEnrollment<Identity> | null;
  }>;
  confirm: (
    identity: Identity,
    input: ConfirmScheduleMCPConsent,
    options?: { signal?: AbortSignal },
  ) => Promise<ScheduleMCPConsentView>;
  revoke: (identity: Identity, revision: string) => Promise<void>;
  /** Whether this schedule has no grant and its MCP tools are refused until it gets one. */
  requiresGrant: (identity: Identity) => Promise<boolean>;
  authority: ScheduledMCPAuthority<Identity>;
}

export function createScheduleMCPConsentService<
  Identity extends MCPGrantIdentity = ScheduledMCPIdentity,
>(deps: ScheduleMCPConsentDeps<Identity>): ScheduleMCPConsentService<Identity> {
  const now = deps.now ?? Date.now;
  const denial = (reason: ScheduledMCPFailureReason) => ({
    state: 'denied' as const,
    failure: failureFixtures[reason],
  });
  /** Field by field, whatever the subject: its id, owner, tenant and agent must all agree. */
  const fields = (identity: Identity): string =>
    JSON.stringify(Object.entries(identity).sort(([a], [b]) => (a < b ? -1 : Number(a > b))));
  const identityMatches = (a: Identity, b: Identity): boolean =>
    a.invocationMode === 'delegated' && fields(a) === fields(b);

  /**
   * A grant that covers the agents' other tools covers the whole run, so it can be made for
   * the whole agent. One that limits MCP tools only lists them.
   */
  const standing = deps.resolveTools != null;

  /**
   * What each view offered beyond the MCP targets it lists, for the confirmation of it: the
   * agents' other tools, and every declared server the agents use. `servers` includes one
   * selected as a whole, which is not listed to tick but is part of the whole agent: a grant
   * of the whole agent holds a consent for it like any other, for its credentials.
   */
  const offers = new WeakMap<
    ScheduleMCPConsentView,
    { others: readonly ScheduledMCPToolSelection[]; servers: readonly ScheduledMCPTarget[] }
  >();

  async function view(
    identity: Identity,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduleMCPConsentView> {
    options.signal?.throwIfAborted();
    const [snapshot, limits, allowed, approval] = await Promise.all([
      deps.storage.readScheduleMCPConsent(identity),
      deps.getLimits(identity),
      deps.canUse(identity, options),
      deps.canPause?.(identity) ?? false,
    ]);
    if (!snapshot) throw new ScheduleMCPConsentError('consent_not_found');
    if (snapshot.agentId !== identity.agentId) throw new ScheduleMCPConsentError('consent_changed');
    const enrollment = snapshot.enrollment;
    const whole = enrollment?.everything === true;
    const lifetime = enrollment ? grantLifetime(enrollment) : null;
    const expiresAtMs = lifetime ? lifetime.expiresAtMs : null;
    let state: ScheduleMCPConsentView['state'] = 'active';
    if (!enrollment) state = 'missing';
    else if (lifetime!.revoked) state = 'revoked';
    else if (expiresAtMs! <= now()) state = 'expired';
    else if (
      enrollment.scheduleRevision !== snapshot.configRevision ||
      enrollment.consents.some((c) => !identityMatches(c.identity, identity))
    )
      state = 'changed';
    const granted: ScheduledMCPTarget[] =
      enrollment?.consents.map(({ resource, permittedTools, policyRevision }) => ({
        resource,
        permittedTools,
        policyRevision,
      })) ?? [];
    const allowedByServer = allowedTools(granted);
    const changedByServer = changedTools(enrollment?.consents ?? []);
    const askingByServer = askingTools(enrollment?.consents ?? []);
    const allowedOther = toolNames(enrollment?.tools ?? []);
    let offeredOther: readonly ScheduledMCPToolSelection[] = [];
    let servers: readonly ScheduledMCPTarget[] = [];
    let used: readonly string[] = [];
    const required = !enrollment && requiresGrant(limits, snapshot, now());
    const requireAfterMs =
      !enrollment && limits.enabled && !required ? (limits.requireAfterMs ?? null) : null;
    // The whole agent is allowed as it becomes: a changed definition is not held back.
    if (state === 'active' && !whole && Object.keys(changedByServer).length > 0) state = 'changed';
    let targets = granted;
    let offer: ScheduleMCPConsentView['offer'] = null;
    if (snapshot.compatible === false) {
      return {
        state: 'unsupported',
        revision: null,
        expiresAtMs: null,
        targets: [],
        allowed: {},
        changed: {},
        asking: {},
        tools: { offered: [], allowed: [] },
        everything: false,
        approval,
        required: false,
        requireAfterMs: null,
        offer: null,
      };
    }
    if (allowed && limits.enabled && deps.resolveEnrollment) {
      let resolved: readonly ScheduledMCPTarget[];
      try {
        [servers, offeredOther, used] = await Promise.all([
          deps.resolveEnrollment(identity, options),
          deps.resolveTools?.(identity, options) ?? [],
          deps.resolveServers?.(identity, options) ?? [],
        ]);
        resolved = servers;
      } catch (error) {
        if (!(error instanceof ScheduleMCPConsentError) || !enrollment) throw error;
        return {
          state: 'changed',
          revision: enrollment.revision,
          expiresAtMs,
          targets,
          allowed: allowedByServer,
          changed: changedByServer,
          asking: askingByServer,
          tools: { offered: [], allowed: allowedOther },
          everything: whole,
          approval,
          required,
          requireAfterMs,
          offer: null,
        };
      }
      // Nothing the owner could allow: no MCP tool on a declared server, no other tool, and
      // not a grant that can be made for the whole agent whatever it has.
      if (resolved.length === 0 && offeredOther.length === 0 && !standing)
        return {
          state: enrollment ? 'changed' : 'unsupported',
          revision: enrollment?.revision ?? null,
          expiresAtMs,
          targets,
          allowed: allowedByServer,
          changed: changedByServer,
          asking: askingByServer,
          tools: { offered: [], allowed: allowedOther },
          everything: whole,
          approval,
          required,
          requireAfterMs,
          offer: null,
        };
      targets = canonicalTargets(resolved, { empty: true });
      const digest = offerDigest(
        identity,
        snapshot.configRevision,
        targets,
        changedByServer,
        offeredOther,
      );
      offer = {
        digest,
        maxLifetimeHours: limits.maxLifetimeHours,
        ...(standing && { everything: true as const }),
      };
      // A whole-agent grant holds consents for servers that are not listed to tick, so its
      // recipients are compared with every server in use, not only the listed ones.
      const covered = whole
        ? keepsResources(canonicalTargets(servers, { empty: true }), granted, used)
        : coversGrant(targets, granted);
      if (state === 'active' && !covered) state = 'changed';
    } else if (!enrollment) state = 'unsupported';
    options.signal?.throwIfAborted();
    const result: ScheduleMCPConsentView = {
      state,
      revision: enrollment?.revision ?? null,
      expiresAtMs,
      targets,
      allowed: allowedByServer,
      changed: changedByServer,
      asking: askingByServer,
      tools: {
        offered: toolNames(offeredOther),
        allowed: allowedOther,
        ...(used.length > 0 && { servers: [...used] }),
      },
      everything: whole,
      approval,
      required,
      requireAfterMs,
      offer,
    };
    offers.set(result, {
      others: offeredOther,
      servers: canonicalTargets(servers, { empty: true }),
    });
    return result;
  }

  /** A grant for what the owner chose, from now for the lifetime they chose. */
  function build(input: {
    identity: Identity;
    configRevision: number;
    lifetimeHours: number;
    chosen: readonly ScheduledMCPTarget[];
    others: readonly ScheduledMCPToolSelection[];
    asking: Record<string, string[]>;
    prior?: readonly MCPGrantConsent<Identity>[];
    /** The whole agent: `chosen` is every server on offer, and nothing else is listed. */
    everything?: boolean;
  }): MCPGrantEnrollment<Identity> {
    const grantedAtMs = now();
    const absoluteExpiresAtMs = grantedAtMs + input.lifetimeHours * 3_600_000;
    const revision = randomUUID();
    return {
      version: 1,
      revision,
      scheduleRevision: input.configRevision,
      consents: input.chosen.map((target) => ({
        ...target,
        // The whole agent is allowed as it becomes, so it holds no pin or mark to refuse by.
        ...(input.everything !== true &&
          carriedPins(
            target,
            input.prior?.find((prior) => prior.resource.serverName === target.resource.serverName),
          )),
        identity: input.identity,
        id: randomUUID(),
        revision,
        grantedAtMs,
        absoluteExpiresAtMs,
        revokedAtMs: null,
        ...(input.asking[target.resource.serverName] && {
          askTools: input.asking[target.resource.serverName],
        }),
      })),
      ...(input.others.length > 0 && { tools: [...input.others] }),
      ...(input.everything === true && { everything: true as const }),
      // The grant's own lifetime: one that allows no MCP server has no consent to carry it.
      grantedAtMs,
      absoluteExpiresAtMs,
      revokedAtMs: null,
    };
  }

  /** Within what the operator allows a grant to last. */
  const validLifetime = (hours: number, maxLifetimeHours: number): boolean =>
    Number.isInteger(hours) && hours >= 1 && hours <= maxLifetimeHours;

  /**
   * What the owner could allow a schedule that is not stored yet. There is no grant, edit or
   * mark to read, so the offer is bound to the owner and the agent alone.
   */
  async function draft(
    identity: Identity,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduleMCPConsentView> {
    options.signal?.throwIfAborted();
    const [limits, allowed, approval] = await Promise.all([
      deps.getLimits(identity),
      deps.canUse(identity, options),
      deps.canPause?.(identity) ?? false,
    ]);
    if (!allowed) throw new ScheduleMCPConsentError('consent_forbidden');
    const none: ScheduleMCPConsentView = {
      state: 'unsupported',
      revision: null,
      expiresAtMs: null,
      targets: [],
      allowed: {},
      changed: {},
      asking: {},
      tools: { offered: [], allowed: [] },
      everything: false,
      approval,
      required: false,
      requireAfterMs: null,
      offer: null,
    };
    if (!limits.enabled || !deps.resolveEnrollment) return none;
    const [servers, others, used] = await Promise.all([
      deps.resolveEnrollment(identity, options),
      deps.resolveTools?.(identity, options) ?? [],
      deps.resolveServers?.(identity, options) ?? [],
    ]);
    const resolved = servers;
    if (resolved.length === 0 && others.length === 0 && !standing) return none;
    const targets = canonicalTargets(resolved, { empty: true });
    const subject = {
      ownerId: identity.ownerId,
      tenantId: identity.tenantId,
      agentId: identity.agentId,
    };
    const result: ScheduleMCPConsentView = {
      ...none,
      state: 'missing',
      targets,
      tools: {
        offered: toolNames(others),
        allowed: [],
        ...(used.length > 0 && { servers: [...used] }),
      },
      offer: {
        digest: offerDigest(subject, 0, targets, {}, others),
        maxLifetimeHours: limits.maxLifetimeHours,
        ...(standing && { everything: true as const }),
      },
    };
    offers.set(result, { others, servers: canonicalTargets(servers, { empty: true }) });
    return result;
  }

  /**
   * The grant for a schedule about to be created, from the owner's choice of its draft offer.
   * Nothing is stored: the caller writes it in the same insert as the schedule.
   */
  async function grant(
    identity: Identity,
    input: ScheduleAuthorization,
    options: { signal?: AbortSignal; revision?: number } = {},
  ): Promise<MCPGrantEnrollment<Identity>> {
    const current = await draft(identity, options);
    if (!current.offer) throw new ScheduleMCPConsentError('consent_unavailable');
    if (input.offerDigest !== current.offer.digest)
      throw new ScheduleMCPConsentError('consent_changed');
    if (!validLifetime(input.lifetimeHours, current.offer.maxLifetimeHours))
      throw new ScheduleMCPConsentError('consent_invalid');
    const everything = input.everything === true;
    if (everything && current.offer.everything !== true)
      throw new ScheduleMCPConsentError('consent_invalid');
    const offered = offers.get(current);
    const chosen = everything
      ? (offered?.servers ?? [])
      : selectAllowed(current.targets, input.allow);
    const others = everything ? [] : selectTools(offered?.others ?? [], input.tools ?? []);
    const asking = selectAsking(chosen, input.ask ?? {}, {}, everything);
    // Something must be allowed, and a tool nobody can approve would only ever be refused.
    if (
      (!everything && chosen.length === 0 && others.length === 0) ||
      (!current.approval && Object.keys(asking).length > 0)
    )
      throw new ScheduleMCPConsentError('consent_invalid');
    options.signal?.throwIfAborted();
    return build({
      identity,
      configRevision: options.revision ?? 0,
      lifetimeHours: input.lifetimeHours,
      chosen,
      others,
      asking,
      everything,
    });
  }

  /** The grant a confirmation asks for, checked against the stored subject. Stores nothing. */
  async function decide(
    identity: Identity,
    input: ConfirmScheduleMCPConsent,
    options: { signal?: AbortSignal } = {},
  ): Promise<{
    enrollment: MCPGrantEnrollment<Identity>;
    snapshot: NonNullable<
      Awaited<ReturnType<MCPConsentStorage<Identity>['readScheduleMCPConsent']>>
    >;
  }> {
    if (!(await deps.canUse(identity, options)))
      throw new ScheduleMCPConsentError('consent_forbidden');
    const current = await view(identity, options);
    if (!current.offer) throw new ScheduleMCPConsentError('consent_unavailable');
    if (input.offerDigest !== current.offer.digest || input.expectedRevision !== current.revision)
      throw new ScheduleMCPConsentError('consent_changed');
    if (!validLifetime(input.lifetimeHours, current.offer.maxLifetimeHours))
      throw new ScheduleMCPConsentError('consent_invalid');
    const snapshot = await deps.storage.readScheduleMCPConsent(identity);
    if (!snapshot) throw new ScheduleMCPConsentError('consent_not_found');
    // The grant the owner saw is checked on this read too. The digest does not name it, so a
    // revocation or another confirmation landing since the view would otherwise pass here
    // and become what the new grant is taken to replace.
    if ((snapshot.enrollment?.revision ?? null) !== input.expectedRevision)
      throw new ScheduleMCPConsentError('consent_changed');
    const { others: offered = [], servers = [] } = offers.get(current) ?? {};
    // Recompute the digest with the final observed row so an edit cannot reuse an old offer.
    const digest = offerDigest(
      identity,
      snapshot.configRevision,
      current.targets,
      changedTools(snapshot.enrollment?.consents ?? []),
      offered,
    );
    if (digest !== input.offerDigest) throw new ScheduleMCPConsentError('consent_changed');
    const everything = input.everything === true;
    if (everything && current.offer.everything !== true)
      throw new ScheduleMCPConsentError('consent_invalid');
    const chosen = everything ? servers : selectAllowed(current.targets, input.allow);
    const others = everything ? [] : selectTools(offered, input.tools, snapshot.enrollment?.tools);
    // A grant allows something: the whole agent, an MCP tool, or one of the other tools.
    if (!everything && chosen.length === 0 && others.length === 0)
      throw new ScheduleMCPConsentError('consent_invalid');
    const stored = askingTools(snapshot.enrollment?.consents ?? []);
    const asking = selectAsking(chosen, input.ask, stored, everything);
    // A tool nobody can approve would only ever be refused. Say so now, not at 3 a.m. One the
    // grant already asks about may stay: it is refused until pausing works again, and making
    // it run unattended instead is for the owner to choose.
    if (
      !current.approval &&
      Object.entries(asking).some(([serverName, tools]) =>
        tools.some((tool) => !stored[serverName]?.includes(tool)),
      )
    )
      throw new ScheduleMCPConsentError('consent_invalid');
    options.signal?.throwIfAborted();
    const enrollment = build({
      identity,
      configRevision: snapshot.configRevision,
      lifetimeHours: input.lifetimeHours,
      chosen,
      others,
      asking,
      prior: snapshot.enrollment?.consents,
      everything,
    });
    return { enrollment, snapshot };
  }

  async function confirm(
    identity: Identity,
    input: ConfirmScheduleMCPConsent,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduleMCPConsentView> {
    const { enrollment, snapshot } = await decide(identity, input, options);
    const committed = await deps.storage.confirmScheduleMCPConsent({
      identity,
      expectedRevision: input.expectedRevision,
      expectedConfigRevision: snapshot.configRevision,
      enrollment,
      // A pin or mark a run adds after this read is neither carried nor shown to the owner.
      basis: snapshot.enrollment,
    });
    if (!committed) throw new ScheduleMCPConsentError('consent_changed');
    return view(identity, options);
  }

  async function renew(
    identity: Identity,
    input: ConfirmScheduleMCPConsent,
    revision: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<{
    enrollment: MCPGrantEnrollment<Identity>;
    basis: MCPGrantEnrollment<Identity> | null;
  }> {
    const { enrollment, snapshot } = await decide(identity, input, options);
    return {
      enrollment: { ...enrollment, scheduleRevision: revision },
      basis: snapshot.enrollment ?? null,
    };
  }

  async function revoke(identity: Identity, revision: string): Promise<void> {
    // Revocation remains available after access, resource configuration or agent changes.
    if (!(await deps.storage.revokeScheduleMCPConsent(identity, revision)))
      throw new ScheduleMCPConsentError('consent_changed');
  }

  async function requiresGrantFor(identity: Identity): Promise<boolean> {
    const [snapshot, limits] = await Promise.all([
      deps.storage.readScheduleMCPConsent(identity),
      deps.getLimits(identity),
    ]);
    return (
      snapshot != null &&
      snapshot.compatible !== false &&
      snapshot.enrollment == null &&
      requiresGrant(limits, snapshot, now())
    );
  }

  /**
   * The server a call names, as the operator declares it and the agents use it now. A denial
   * when it is no longer either, or is declared for another recipient than the call names.
   */
  const liveTarget = async (
    request: Parameters<ScheduledMCPAuthority<Identity>['authorize']>[0],
    options: { signal?: AbortSignal },
  ): Promise<ScheduledMCPTarget | ReturnType<typeof denial>> => {
    let targets: ScheduledMCPTarget[];
    try {
      targets = canonicalTargets(await deps.resolveEnrollment!(request.identity, options));
    } catch (error) {
      if (error instanceof ScheduleMCPConsentError)
        return denial(error.code === 'consent_forbidden' ? 'rbac_denied' : 'binding_mismatch');
      throw error;
    }
    const target = targets.find((t) => t.resource.serverName === request.resource.serverName);
    return target && sameResource(target.resource, request.resource)
      ? target
      : denial('binding_mismatch');
  };

  const authority: ScheduledMCPAuthority<Identity> = {
    async lookupConsent(identity, resource, options) {
      options.signal?.throwIfAborted();
      const row = await deps.storage.readScheduleMCPConsent(identity);
      const consent = row?.enrollment?.consents.find(
        (c) => c.resource.serverName === resource.serverName,
      );
      if (!consent) return { state: 'missing' };
      return {
        state: 'found',
        consent,
        ...(row!.enrollment!.everything === true && { everything: true as const }),
      };
    },
    async standing(request, options) {
      if (options.signal?.aborted) return { state: 'cancelled' };
      const [snapshot, allowed, mcp, limits] = await Promise.all([
        deps.storage.readScheduleMCPConsent(request.identity),
        deps.canUse(request.identity, options),
        deps.canUseMCP?.(request.identity, options) ?? true,
        deps.getLimits(request.identity),
      ]);
      if (options.signal?.aborted) return { state: 'cancelled' };
      if (!limits.enabled) return denial('provider_missing');
      if (!allowed || !mcp) return denial('rbac_denied');
      const enrollment = snapshot?.enrollment;
      if (!enrollment || snapshot!.compatible === false) return denial('consent_missing');
      const lifetime = grantLifetime(enrollment);
      if (lifetime.revoked) return denial('consent_revoked');
      if (now() >= lifetime.expiresAtMs) return denial('consent_expired');
      /** The whole agent, or the tool listed for the agent among its other tools. */
      const covered =
        enrollment.everything === true ||
        (request.listed != null &&
          enrollment.tools?.some(
            ({ agentId, tools }) =>
              agentId === request.listed!.agentId &&
              request.listed!.keys.some((key) => tools.includes(key)),
          ) === true);
      if (!covered) return denial('tool_policy_denied');
      if (
        enrollment.revision !== request.revision ||
        (!snapshot!.enabled && request.stage !== 'activation' && request.manual !== true) ||
        snapshot!.agentId !== request.identity.agentId ||
        enrollment.scheduleRevision !== snapshot!.configRevision
      )
        return denial('binding_mismatch');
      return { state: 'authorized' };
    },
    async authorize(request, options) {
      if (options.signal?.aborted) return { state: 'cancelled' };
      const [snapshot, allowed, mcp, limits] = await Promise.all([
        deps.storage.readScheduleMCPConsent(request.identity),
        deps.canUse(request.identity, options),
        deps.canUseMCP?.(request.identity, options) ?? true,
        deps.getLimits(request.identity),
      ]);
      if (options.signal?.aborted) return { state: 'cancelled' };
      if (!limits.enabled || !deps.resolveEnrollment) return denial('provider_missing');
      if (!allowed || !mcp) return denial('rbac_denied');
      const enrollment = snapshot?.enrollment;
      const consent = enrollment?.consents.find(
        (c) => c.resource.serverName === request.resource.serverName,
      );
      if (!consent) {
        // A declared server the agents took up after a grant of the whole agent was made has
        // no consent stored. The grant covers it all the same: its recipient is the one the
        // operator declares now, and the grant's own lifetime and binding are what is checked.
        if (enrollment?.everything !== true) return denial('consent_missing');
        const lifetime = grantLifetime(enrollment);
        if (lifetime.revoked) return denial('consent_revoked');
        if (request.resource.credentialMode === 'browser_bearer') return denial('unsupported_mode');
        if (now() >= lifetime.expiresAtMs) return denial('consent_expired');
        if (
          (!snapshot!.enabled && request.stage !== 'activation' && request.manual !== true) ||
          snapshot!.agentId !== request.identity.agentId ||
          enrollment.scheduleRevision !== snapshot!.configRevision
        )
          return denial('binding_mismatch');
        if (!request.selection.tools.length) return denial('tool_policy_denied');
        const target = await liveTarget(request, options);
        if ('state' in target) return target;
        if (options.signal?.aborted) return { state: 'cancelled' };
        return {
          state: 'authorized',
          consentId: enrollment.revision,
          consentRevision: enrollment.revision,
          policyRevision: target.policyRevision,
          validUntilMs: lifetime.expiresAtMs,
        };
      }
      if (consent.revokedAtMs != null) return denial('consent_revoked');
      if (request.resource.credentialMode === 'browser_bearer') return denial('unsupported_mode');
      if (now() >= consent.absoluteExpiresAtMs) return denial('consent_expired');
      if (
        (!snapshot!.enabled && request.stage !== 'activation' && request.manual !== true) ||
        snapshot!.agentId !== request.identity.agentId ||
        enrollment!.scheduleRevision !== snapshot!.configRevision ||
        !identityMatches(consent.identity, request.identity) ||
        !sameResource(consent.resource, request.resource)
      )
        return denial('binding_mismatch');
      const target = await liveTarget(request, options);
      if ('state' in target) return target;
      if (!sameResource(target.resource, consent.resource)) return denial('binding_mismatch');
      /**
       * A grant of the whole agent allows whatever its agents have on the servers it was made
       * for: a tool or an agent added since, or a selection of every tool on the server, which
       * no list names. A definition that changed is not held back: such a grant is stored
       * with no pin or mark, and none is added to it.
       */
      const whole = enrollment!.everything === true;
      const selection = consent.permittedTools.find((s) => s.agentId === request.selection.agentId);
      const currentSelection = target.permittedTools.find(
        (s) => s.agentId === request.selection.agentId,
      );
      if (!request.selection.tools.length) return denial('tool_policy_denied');
      // Granted and still selected, each by name or through a selection of the whole server.
      if (
        !whole &&
        request.selection.tools.some(
          (tool) => !covers(selection, tool) || !covers(currentSelection, tool),
        )
      )
        return denial('tool_policy_denied');
      const live = Object.entries(request.definitions ?? {}).filter(([tool]) =>
        request.selection.tools.includes(tool),
      );
      const pinned = (source: MCPGrantConsent<Identity>, tool: string, digest: string) =>
        !source.changedTools?.includes(tool) &&
        source.definitions?.find((pin) => pin.tool === tool)?.digest === digest;
      const grant = { identity: request.identity, revision: enrollment!.revision };
      /** Marks every tool `source` pins to a definition other than the one this request saw. */
      const markDisagreements = async (source: MCPGrantConsent<Identity>): Promise<boolean> => {
        const tools = live
          .filter(([tool, digest]) =>
            source.definitions?.some((pin) => pin.tool === tool && pin.digest !== digest),
          )
          .map(([tool]) => tool);
        await Promise.all(
          tools.map((tool) =>
            deps.storage.flagScheduleMCPToolChange({ ...grant, consentId: consent.id, tool }),
          ),
        );
        return tools.length > 0;
      };
      if (live.some(([tool]) => consent.changedTools?.includes(tool)))
        return denial('binding_mismatch');
      if (await markDisagreements(consent)) return denial('binding_mismatch');
      if (options.signal?.aborted) return { state: 'cancelled' };
      // The grant was read a moment ago. Admission checks the marks and pins again in the same
      // write, so a mark or a first pin stored since then refuses this use as well.
      const admitted = await deps.storage.admitScheduleMCPConsent({
        identity: request.identity,
        expectedConfigRevision: snapshot!.configRevision,
        revision: enrollment!.revision,
        consentId: consent.id,
        requireEnabled: request.stage !== 'activation' && request.manual !== true,
        ...(live.length > 0 && !whole && { definitions: Object.fromEntries(live) }),
      });
      if (!admitted) {
        const latest = await authority.lookupConsent(request.identity, request.resource, options);
        if (latest.state !== 'found') return denial('consent_missing');
        if (latest.consent.revokedAtMs != null) return denial('consent_revoked');
        if (now() >= latest.consent.absoluteExpiresAtMs) return denial('consent_expired');
        if (latest.consent.id === consent.id) await markDisagreements(latest.consent);
        return denial('binding_mismatch');
      }
      // First use: remember what the tool looked like. Another replica may have got there first.
      const unpinned = whole
        ? []
        : live.filter(([tool]) => !consent.definitions?.some((pin) => pin.tool === tool));
      const stored = await Promise.all(
        unpinned.map(([tool, digest]) =>
          deps.storage.pinScheduleMCPToolDefinition({
            ...grant,
            consentId: consent.id,
            tool,
            digest,
          }),
        ),
      );
      if (stored.includes(false)) {
        const latest = await authority.lookupConsent(request.identity, request.resource, options);
        const current =
          latest.state === 'found' && latest.consent.id === consent.id ? latest.consent : undefined;
        if (!current || unpinned.some(([tool, digest]) => !pinned(current, tool, digest))) {
          // Two first uses saw two definitions. The one that lost leaves the same mark a later
          // mismatch would, so the tool is refused and the owner is told, whichever won.
          if (current) await markDisagreements(current);
          return denial('binding_mismatch');
        }
      }
      if (options.signal?.aborted) return { state: 'cancelled' };
      if (now() >= consent.absoluteExpiresAtMs) return denial('consent_expired');
      return {
        state: 'authorized',
        consentId: consent.id,
        consentRevision: consent.revision,
        policyRevision: consent.policyRevision,
        validUntilMs: consent.absoluteExpiresAtMs,
        ...(live.some(([tool]) => consent.askTools?.includes(tool)) && {
          approvalRequired: true as const,
        }),
      };
    },
  };
  return {
    view,
    draft,
    grant,
    renew,
    confirm,
    revoke,
    requiresGrant: requiresGrantFor,
    authority,
  };
}
