import { createHash, randomUUID } from 'node:crypto';
import { scheduledMCPTargetSchema } from 'librechat-data-provider';
import type {
  ScheduledMCPIdentity,
  ScheduledMCPResource,
  ScheduledMCPTarget,
  ScheduleMCPConsentView,
  ConfirmScheduleMCPConsent,
  ScheduledMCPEnrollment,
} from 'librechat-data-provider';
import type { ScheduleMCPConsentStorage } from '@librechat/data-schemas';
import type {
  ScheduledMCPAuthority,
  ScheduledMCPAuthorizationRequest,
  ScheduledMCPFailureReason,
} from './contract';
import { failureFixtures } from './failures';

export interface ScheduleMCPConsentLimits {
  enabled: boolean;
  maxLifetimeHours: number;
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
  resolveEnrollment?: ScheduleMCPEnrollmentResolver;
  /** Trusted tool classification and current graph reachability, never MCP annotations. */
  checkToolPolicy?: (
    request: ScheduledMCPAuthorizationRequest,
    options: { signal?: AbortSignal },
  ) => Promise<boolean>;
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
    const [snapshot, limits, allowed] = await Promise.all([
      deps.storage.readScheduleMCPConsent(identity),
      deps.getLimits(identity),
      deps.canUse(identity, options),
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
    let targets: ScheduledMCPTarget[] =
      enrollment?.consents.map(({ resource, permittedTools, policyRevision }) => ({
        resource,
        permittedTools,
        policyRevision,
      })) ?? [];
    let offer: ScheduleMCPConsentView['offer'] = null;
    if (snapshot.compatible === false) {
      return { state: 'unsupported', revision: null, expiresAtMs: null, targets: [], offer: null };
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
          offer: null,
        };
      }
      if (resolved.length === 0)
        return {
          state: enrollment ? 'changed' : 'unsupported',
          revision: enrollment?.revision ?? null,
          expiresAtMs,
          targets,
          offer: null,
        };
      targets = canonicalTargets(resolved);
      const digest = createHash('sha256')
        .update(JSON.stringify({ identity, configRevision: snapshot.configRevision, targets }))
        .digest('hex');
      offer = { digest, maxLifetimeHours: limits.maxLifetimeHours };
      if (
        state === 'active' &&
        JSON.stringify(targets) !==
          JSON.stringify(
            canonicalTargets(
              enrollment!.consents.map(({ resource, permittedTools, policyRevision }) => ({
                resource,
                permittedTools,
                policyRevision,
              })),
            ),
          )
      )
        state = 'changed';
    } else if (!enrollment) state = 'unsupported';
    options.signal?.throwIfAborted();
    return { state, revision: enrollment?.revision ?? null, expiresAtMs, targets, offer };
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
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          identity,
          configRevision: snapshot.configRevision,
          targets: current.targets,
        }),
      )
      .digest('hex');
    if (digest !== input.offerDigest) throw new ScheduleMCPConsentError('consent_changed');
    options.signal?.throwIfAborted();
    const grantedAtMs = now();
    const revision = randomUUID();
    const enrollment: ScheduledMCPEnrollment = {
      version: 1,
      revision,
      scheduleRevision: snapshot.configRevision,
      consents: current.targets.map((target) => ({
        ...target,
        identity,
        id: randomUUID(),
        revision,
        grantedAtMs,
        absoluteExpiresAtMs: grantedAtMs + input.lifetimeHours * 3_600_000,
        revokedAtMs: null,
      })),
    };
    const committed = await deps.storage.confirmScheduleMCPConsent({
      identity,
      expectedRevision: input.expectedRevision,
      expectedConfigRevision: snapshot.configRevision,
      enrollment,
    });
    if (!committed) throw new ScheduleMCPConsentError('consent_changed');
    return view(identity, options);
  }

  async function revoke(identity: ScheduledMCPIdentity, revision: string): Promise<void> {
    // Revocation remains available after access, resource configuration or agent changes.
    if (!(await deps.storage.revokeScheduleMCPConsent(identity, revision)))
      throw new ScheduleMCPConsentError('consent_changed');
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
      if (
        !target ||
        !sameResource(target.resource, consent.resource) ||
        target.policyRevision !== consent.policyRevision
      )
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
      if (!deps.checkToolPolicy || !(await deps.checkToolPolicy(request, options)))
        return denial('tool_policy_denied');
      if (options.signal?.aborted) return { state: 'cancelled' };
      const admitted = await deps.storage.admitScheduleMCPConsent({
        identity: request.identity,
        expectedConfigRevision: snapshot!.configRevision,
        revision: enrollment!.revision,
        consentId: consent.id,
        requireEnabled: request.stage !== 'activation' && request.manual !== true,
      });
      if (!admitted) {
        const latest = await authority.lookupConsent(request.identity, request.resource, options);
        if (latest.state !== 'found') return denial('consent_missing');
        if (latest.consent.revokedAtMs != null) return denial('consent_revoked');
        if (now() >= latest.consent.absoluteExpiresAtMs) return denial('consent_expired');
        return denial('binding_mismatch');
      }
      if (options.signal?.aborted) return { state: 'cancelled' };
      if (now() >= consent.absoluteExpiresAtMs) return denial('consent_expired');
      return {
        state: 'authorized',
        consentId: consent.id,
        consentRevision: consent.revision,
        policyRevision: consent.policyRevision,
        validUntilMs: consent.absoluteExpiresAtMs,
      };
    },
  };
  return { view, confirm, revoke, authority };
}
