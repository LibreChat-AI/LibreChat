import type { ScheduleMCPOutcome } from 'librechat-data-provider';
import type { ScheduledTokenContext } from '../context';

export type ScheduledMCPCredentialMode =
  | 'stored_oauth'
  | 'browser_bearer'
  | 'renewable_obo'
  | 'resource_bearer'
  | 'static'
  | 'anonymous';

/** agentId remains the enrolled root, including during child execution. */
export interface ScheduledMCPIdentity extends Omit<ScheduledTokenContext, 'tenantId'> {
  readonly tenantId: string | null;
}

/** Resolved by trusted configuration, never by model arguments or token scopes. */
export interface ScheduledMCPResource {
  readonly serverName: string;
  readonly url: string;
  readonly configurationRevision: string;
  readonly credentialMode: ScheduledMCPCredentialMode;
  readonly issuer: string | null;
  readonly audience: string | null;
  readonly scopes: readonly string[];
}

export interface ScheduledMCPToolSelection {
  readonly agentId: string;
  readonly tools: readonly string[];
}

export interface ScheduledMCPConsent {
  readonly id: string;
  readonly revision: string;
  readonly identity: ScheduledMCPIdentity;
  readonly resource: ScheduledMCPResource;
  readonly permittedTools: readonly ScheduledMCPToolSelection[];
  readonly policyRevision: string;
  readonly grantedAtMs: number;
  /** Fixed consent deadline; credential renewal cannot extend it. */
  readonly absoluteExpiresAtMs: number;
  readonly revokedAtMs: number | null;
}

export type ScheduledMCPFailureReason =
  | 'consent_missing'
  | 'consent_expired'
  | 'consent_revoked'
  | 'binding_mismatch'
  | 'rbac_denied'
  | 'tool_policy_denied'
  | 'approval_required'
  | 'credential_missing'
  | 'credential_rejected'
  | 'resource_permission_denied'
  | 'provider_missing'
  | 'resource_unverified'
  | 'unsupported_mode'
  | 'dependency_unavailable';

/** Safe diagnosis projected onto existing schedule statuses. */
export interface ScheduledMCPFailure {
  readonly reason: ScheduledMCPFailureReason;
  readonly status: Exclude<ScheduleMCPOutcome['status'], 'ready'>;
  readonly recovery: 'authorize' | 'configure' | 'restore_permission' | 'retry_later';
  readonly automaticReplay: false;
}

export type ScheduledMCPConsentLookupResult =
  | { readonly state: 'found'; readonly consent: ScheduledMCPConsent }
  | { readonly state: 'missing' }
  | { readonly state: 'unavailable' };

export interface ScheduledMCPAuthorizationRequest {
  readonly identity: ScheduledMCPIdentity;
  readonly resource: ScheduledMCPResource;
  readonly stage: 'activation' | 'mint' | 'invoke' | 'resume';
  readonly selection: ScheduledMCPToolSelection;
}

/** Ephemeral observation, not a transferable grant or permission to cache an allow decision. */
export type ScheduledMCPAuthorizationResult =
  | {
      readonly state: 'authorized';
      readonly consentId: string;
      readonly consentRevision: string;
      readonly policyRevision: string;
      readonly validUntilMs: number;
    }
  | { readonly state: 'denied'; readonly failure: ScheduledMCPFailure }
  | { readonly state: 'cancelled' };

export interface ScheduledMCPAuthority {
  readonly lookupConsent: (
    identity: ScheduledMCPIdentity,
    resource: ScheduledMCPResource,
    options: { signal?: AbortSignal },
  ) => Promise<ScheduledMCPConsentLookupResult>;
  /** Rechecks live consent, RBAC, schedule/graph binding and trusted tool policy at each stage. */
  readonly authorize: (
    request: ScheduledMCPAuthorizationRequest,
    options: { signal?: AbortSignal },
  ) => Promise<ScheduledMCPAuthorizationResult>;
}

export type ScheduledMCPBearerResult =
  | {
      readonly state: 'ready';
      readonly accessToken: string;
      readonly expiresAtMs: number;
      readonly issuer: string;
      readonly audience: string;
      readonly resourceUrl: string;
    }
  | { readonly state: 'denied'; readonly failure: ScheduledMCPFailure }
  | { readonly state: 'cancelled' };

/** Resolves a resource-bound bearer after live authorization; use must reauthorize. */
export type ScheduledMCPResourceBearerResolver = (
  request: ScheduledMCPAuthorizationRequest & {
    readonly resource: ScheduledMCPResource & { readonly credentialMode: 'resource_bearer' };
  },
  options: { signal?: AbortSignal },
) => Promise<ScheduledMCPBearerResult>;
