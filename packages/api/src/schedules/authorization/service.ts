import { createHash, randomUUID } from 'node:crypto';
import { scheduledMCPTargetSchema } from 'librechat-data-provider';
import type {
  ScheduledMCPIdentity,
  ScheduledMCPResource,
  ScheduledMCPTarget,
  ScheduledMCPConsent,
  ScheduleMCPConsentView,
  ConfirmScheduleMCPConsent,
  ScheduledMCPEnrollment,
} from 'librechat-data-provider';
import type { ScheduleMCPConsentStorage } from '@librechat/data-schemas';
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
export type ScheduleMCPEnrollmentResolver = (
  identity: ScheduledMCPIdentity,
  options: { signal?: AbortSignal },
) => Promise<readonly ScheduledMCPTarget[]>;

export interface ScheduleMCPConsentDeps {
  storage: ScheduleMCPConsentStorage;
  getLimits: (identity: ScheduledMCPIdentity) => Promise<ScheduleMCPConsentLimits>;
  /** Loads current user/tenant/role and schedule/agent/resource access; no role snapshot. */
  canUse: (identity: ScheduledMCPIdentity, options: { signal?: AbortSignal }) => Promise<boolean>;
  /** What the owner can be offered now: reachable agents' selected tools, per declared server. */
  resolveEnrollment?: ScheduleMCPEnrollmentResolver;
  /** Whether a scheduled run can pause for the owner's approval here. Absent, it cannot. */
  canPause?: (identity: ScheduledMCPIdentity) => Promise<boolean>;
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

function canonicalTargets(targets: readonly ScheduledMCPTarget[]): ScheduledMCPTarget[] {
  if (!targets.length || targets.length > 32)
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
  if (chosen.length === 0) throw new ScheduleMCPConsentError('consent_invalid');
  return canonicalTargets(chosen);
}

/**
 * Of the allowed tools, the ones the owner approves call by call. Each must be allowed on a
 * server that made it into the grant.
 */
function selectAsking(
  chosen: readonly ScheduledMCPTarget[],
  ask: ConfirmScheduleMCPConsent['ask'] = {},
): Record<string, string[]> {
  const allowed = allowedTools(chosen);
  return Object.fromEntries(
    Object.entries(ask)
      .filter(([, tools]) => tools.length > 0)
      .map(([serverName, tools]) => {
        if (tools.some((tool) => !allowed[serverName]?.includes(tool)))
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
        return current != null && tools.every((tool) => current.tools.includes(tool));
      })
    );
  });
}

/** Allowed tools the grant asks the owner about before each use, by server. */
function askingTools(consents: readonly ScheduledMCPConsent[]): Record<string, string[]> {
  return Object.fromEntries(
    consents
      .filter((consent) => consent.askTools?.length)
      .map((consent) => [consent.resource.serverName, [...consent.askTools!].sort()]),
  );
}

/** Allowed tools a run saw with a definition other than their pin, by server. */
function changedTools(consents: readonly ScheduledMCPConsent[]): Record<string, string[]> {
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
  prior?: ScheduledMCPConsent,
): Pick<ScheduledMCPConsent, 'definitions'> {
  if (!prior?.definitions || !sameResource(prior.resource, target.resource)) return {};
  const allowed = new Set(target.permittedTools.flatMap((selection) => selection.tools));
  const marked = new Set(prior.changedTools);
  const definitions = prior.definitions.filter(
    (pin) => allowed.has(pin.tool) && !marked.has(pin.tool),
  );
  return definitions.length ? { definitions } : {};
}

/**
 * Names what the owner was shown: the subject, its configuration, what is on offer, and which
 * allowed tools were marked as changed. A dialog opened before a tool was marked cannot
 * confirm past the mark; it is told the offer changed and reads it again.
 */
function offerDigest(
  identity: ScheduledMCPIdentity,
  configRevision: number,
  targets: readonly ScheduledMCPTarget[],
  changed: Record<string, string[]>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        identity,
        configRevision,
        targets,
        // Left out while nothing is marked, so an offer made before marks existed still holds.
        ...(Object.keys(changed).length > 0 && { changed }),
      }),
    )
    .digest('hex');
}

export interface ScheduleMCPConsentService {
  view: (
    identity: ScheduledMCPIdentity,
    options?: { signal?: AbortSignal },
  ) => Promise<ScheduleMCPConsentView>;
  confirm: (
    identity: ScheduledMCPIdentity,
    input: ConfirmScheduleMCPConsent,
    options?: { signal?: AbortSignal },
  ) => Promise<ScheduleMCPConsentView>;
  revoke: (identity: ScheduledMCPIdentity, revision: string) => Promise<void>;
  /** Whether this schedule has no grant and its MCP tools are refused until it gets one. */
  requiresGrant: (identity: ScheduledMCPIdentity) => Promise<boolean>;
  authority: ScheduledMCPAuthority;
}

export function createScheduleMCPConsentService(
  deps: ScheduleMCPConsentDeps,
): ScheduleMCPConsentService {
  const now = deps.now ?? Date.now;
  const denial = (reason: ScheduledMCPFailureReason) => ({
    state: 'denied' as const,
    failure: failureFixtures[reason],
  });
  const identityMatches = (a: ScheduledMCPIdentity, b: ScheduledMCPIdentity): boolean =>
    a.scheduleId === b.scheduleId &&
    a.ownerId === b.ownerId &&
    a.tenantId === b.tenantId &&
    a.agentId === b.agentId &&
    a.invocationMode === 'delegated' &&
    b.invocationMode === 'delegated';

  async function view(
    identity: ScheduledMCPIdentity,
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
    const expiresAtMs = enrollment
      ? Math.min(...enrollment.consents.map((c) => c.absoluteExpiresAtMs))
      : null;
    let state: ScheduleMCPConsentView['state'] = 'active';
    if (!enrollment) state = 'missing';
    else if (enrollment.consents.some((c) => c.revokedAtMs != null)) state = 'revoked';
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
    const required = !enrollment && requiresGrant(limits, snapshot, now());
    const requireAfterMs =
      !enrollment && limits.enabled && !required ? (limits.requireAfterMs ?? null) : null;
    if (state === 'active' && Object.keys(changedByServer).length > 0) state = 'changed';
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
        approval,
        required: false,
        requireAfterMs: null,
        offer: null,
      };
    }
    if (allowed && limits.enabled && deps.resolveEnrollment) {
      let resolved: readonly ScheduledMCPTarget[];
      try {
        resolved = await deps.resolveEnrollment(identity, options);
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
          approval,
          required,
          requireAfterMs,
          offer: null,
        };
      }
      if (resolved.length === 0)
        return {
          state: enrollment ? 'changed' : 'unsupported',
          revision: enrollment?.revision ?? null,
          expiresAtMs,
          targets,
          allowed: allowedByServer,
          changed: changedByServer,
          asking: askingByServer,
          approval,
          required,
          requireAfterMs,
          offer: null,
        };
      targets = canonicalTargets(resolved);
      const digest = offerDigest(identity, snapshot.configRevision, targets, changedByServer);
      offer = { digest, maxLifetimeHours: limits.maxLifetimeHours };
      if (state === 'active' && !coversGrant(targets, granted)) state = 'changed';
    } else if (!enrollment) state = 'unsupported';
    options.signal?.throwIfAborted();
    return {
      state,
      revision: enrollment?.revision ?? null,
      expiresAtMs,
      targets,
      allowed: allowedByServer,
      changed: changedByServer,
      asking: askingByServer,
      approval,
      required,
      requireAfterMs,
      offer,
    };
  }

  async function confirm(
    identity: ScheduledMCPIdentity,
    input: ConfirmScheduleMCPConsent,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduleMCPConsentView> {
    if (!(await deps.canUse(identity, options)))
      throw new ScheduleMCPConsentError('consent_forbidden');
    const current = await view(identity, options);
    if (!current.offer) throw new ScheduleMCPConsentError('consent_unavailable');
    if (input.offerDigest !== current.offer.digest || input.expectedRevision !== current.revision)
      throw new ScheduleMCPConsentError('consent_changed');
    if (
      !Number.isInteger(input.lifetimeHours) ||
      input.lifetimeHours < 1 ||
      input.lifetimeHours > current.offer.maxLifetimeHours
    )
      throw new ScheduleMCPConsentError('consent_invalid');
    const snapshot = await deps.storage.readScheduleMCPConsent(identity);
    if (!snapshot) throw new ScheduleMCPConsentError('consent_not_found');
    // Recompute the digest with the final observed row so an edit cannot reuse an old offer.
    const digest = offerDigest(
      identity,
      snapshot.configRevision,
      current.targets,
      changedTools(snapshot.enrollment?.consents ?? []),
    );
    if (digest !== input.offerDigest) throw new ScheduleMCPConsentError('consent_changed');
    const chosen = selectAllowed(current.targets, input.allow);
    const asking = selectAsking(chosen, input.ask);
    // A tool nobody can approve would only ever be refused. Say so now, not at 3 a.m.
    if (Object.keys(asking).length > 0 && !current.approval)
      throw new ScheduleMCPConsentError('consent_invalid');
    options.signal?.throwIfAborted();
    const grantedAtMs = now();
    const revision = randomUUID();
    const enrollment: ScheduledMCPEnrollment = {
      version: 1,
      revision,
      scheduleRevision: snapshot.configRevision,
      consents: chosen.map((target) => ({
        ...target,
        ...carriedPins(
          target,
          snapshot.enrollment?.consents.find(
            (prior) => prior.resource.serverName === target.resource.serverName,
          ),
        ),
        identity,
        id: randomUUID(),
        revision,
        grantedAtMs,
        absoluteExpiresAtMs: grantedAtMs + input.lifetimeHours * 3_600_000,
        revokedAtMs: null,
        ...(asking[target.resource.serverName] && {
          askTools: asking[target.resource.serverName],
        }),
      })),
    };
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

  async function revoke(identity: ScheduledMCPIdentity, revision: string): Promise<void> {
    // Revocation remains available after access, resource configuration or agent changes.
    if (!(await deps.storage.revokeScheduleMCPConsent(identity, revision)))
      throw new ScheduleMCPConsentError('consent_changed');
  }

  async function requiresGrantFor(identity: ScheduledMCPIdentity): Promise<boolean> {
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

  const authority: ScheduledMCPAuthority = {
    async lookupConsent(identity, resource, options) {
      options.signal?.throwIfAborted();
      const row = await deps.storage.readScheduleMCPConsent(identity);
      const consent = row?.enrollment?.consents.find(
        (c) => c.resource.serverName === resource.serverName,
      );
      return consent ? { state: 'found', consent } : { state: 'missing' };
    },
    async authorize(request, options) {
      if (options.signal?.aborted) return { state: 'cancelled' };
      const [snapshot, allowed, limits] = await Promise.all([
        deps.storage.readScheduleMCPConsent(request.identity),
        deps.canUse(request.identity, options),
        deps.getLimits(request.identity),
      ]);
      if (options.signal?.aborted) return { state: 'cancelled' };
      if (!limits.enabled || !deps.resolveEnrollment) return denial('provider_missing');
      if (!allowed) return denial('rbac_denied');
      const enrollment = snapshot?.enrollment;
      const consent = enrollment?.consents.find(
        (c) => c.resource.serverName === request.resource.serverName,
      );
      if (!consent) return denial('consent_missing');
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
      let targets: ScheduledMCPTarget[];
      try {
        targets = canonicalTargets(await deps.resolveEnrollment(request.identity, options));
      } catch (error) {
        if (error instanceof ScheduleMCPConsentError)
          return denial(error.code === 'consent_forbidden' ? 'rbac_denied' : 'binding_mismatch');
        throw error;
      }
      const target = targets.find((t) => t.resource.serverName === request.resource.serverName);
      if (!target || !sameResource(target.resource, consent.resource))
        return denial('binding_mismatch');
      const selection = consent.permittedTools.find((s) => s.agentId === request.selection.agentId);
      const currentSelection = target.permittedTools.find(
        (s) => s.agentId === request.selection.agentId,
      );
      if (
        !selection ||
        !currentSelection ||
        !request.selection.tools.length ||
        request.selection.tools.some(
          (tool) => !selection.tools.includes(tool) || !currentSelection.tools.includes(tool),
        )
      )
        return denial('tool_policy_denied');
      const live = Object.entries(request.definitions ?? {}).filter(([tool]) =>
        request.selection.tools.includes(tool),
      );
      const pinned = (source: ScheduledMCPConsent, tool: string, digest: string) =>
        !source.changedTools?.includes(tool) &&
        source.definitions?.find((pin) => pin.tool === tool)?.digest === digest;
      const grant = { identity: request.identity, revision: enrollment!.revision };
      /** Marks every tool `source` pins to a definition other than the one this request saw. */
      const markDisagreements = async (source: ScheduledMCPConsent): Promise<boolean> => {
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
        ...(live.length > 0 && { definitions: Object.fromEntries(live) }),
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
      const unpinned = live.filter(
        ([tool]) => !consent.definitions?.some((pin) => pin.tool === tool),
      );
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
  return { view, confirm, revoke, requiresGrant: requiresGrantFor, authority };
}
