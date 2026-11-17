import type {
  MCPGrantConsent,
  MCPGrantIdentity,
  ScheduleMCPOutcome,
  ScheduledMCPFailureReason,
  ScheduledMCPIdentity,
  ScheduledMCPResource,
  ScheduledMCPToolSelection,
} from 'librechat-data-provider';
export type {
  ScheduledMCPCredentialMode,
  ScheduledMCPIdentity,
  ScheduledMCPResource,
  ScheduledMCPConsent,
  ScheduledMCPToolSelection,
} from 'librechat-data-provider';

export type { ScheduledMCPFailureReason } from 'librechat-data-provider';

/** Safe diagnosis projected onto existing schedule statuses. */
export interface ScheduledMCPFailure {
  readonly reason: ScheduledMCPFailureReason;
  readonly status: Exclude<ScheduleMCPOutcome['status'], 'ready'>;
  readonly recovery: 'authorize' | 'configure' | 'restore_permission' | 'retry_later';
  readonly automaticReplay: false;
}

export type ScheduledMCPConsentLookupResult<
  Identity extends MCPGrantIdentity = ScheduledMCPIdentity,
> =
  | { readonly state: 'found'; readonly consent: MCPGrantConsent<Identity> }
  | { readonly state: 'missing' }
  | { readonly state: 'unavailable' };

export interface ScheduledMCPAuthorizationRequest<
  Identity extends MCPGrantIdentity = ScheduledMCPIdentity,
> {
  readonly identity: Identity;
  readonly resource: ScheduledMCPResource;
  readonly stage: 'activation' | 'mint' | 'invoke' | 'resume';
  /** Set only by the owner-authorized manual trigger or its verified resume metadata. */
  readonly manual?: boolean;
  readonly selection: ScheduledMCPToolSelection;
  /**
   * Digest of each selected tool's live definition, by tool. A tool is pinned to the first
   * one seen and refused once it differs. Absent at mint, where no catalog is read.
   */
  readonly definitions?: Readonly<Record<string, string>>;
}

/** Ephemeral observation, not a transferable grant or permission to cache an allow decision. */
export type ScheduledMCPAuthorizationResult =
  | {
      readonly state: 'authorized';
      readonly consentId: string;
      readonly consentRevision: string;
      readonly policyRevision: string;
      readonly validUntilMs: number;
      /** The owner approves each use of this tool. The caller must hold that approval. */
      readonly approvalRequired?: true;
    }
  | { readonly state: 'denied'; readonly failure: ScheduledMCPFailure }
  | { readonly state: 'cancelled' };

export interface ScheduledMCPAuthority<Identity extends MCPGrantIdentity = ScheduledMCPIdentity> {
  readonly lookupConsent: (
    identity: Identity,
    resource: ScheduledMCPResource,
    options: { signal?: AbortSignal },
  ) => Promise<ScheduledMCPConsentLookupResult<Identity>>;
  /** Rechecks live consent, RBAC, schedule/graph binding and trusted tool policy at each stage. */
  readonly authorize: (
    request: ScheduledMCPAuthorizationRequest<Identity>,
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
