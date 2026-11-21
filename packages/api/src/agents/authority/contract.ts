import type {
  RunGrantConsent,
  RunGrantIdentity,
  ScheduleMCPOutcome,
  RunGrantFailureReason,
  ScheduledMCPIdentity,
  RunGrantResource,
  RunGrantToolSelection,
} from 'librechat-data-provider';
export type {
  RunGrantCredentialMode,
  ScheduledMCPIdentity,
  RunGrantResource,
  ScheduledMCPConsent,
  RunGrantToolSelection,
} from 'librechat-data-provider';

export type { RunGrantFailureReason } from 'librechat-data-provider';

/** Safe diagnosis projected onto existing schedule statuses. */
export interface RunGrantFailure {
  readonly reason: RunGrantFailureReason;
  readonly status: Exclude<ScheduleMCPOutcome['status'], 'ready'>;
  readonly recovery: 'authorize' | 'configure' | 'restore_permission' | 'retry_later';
  readonly automaticReplay: false;
}

export type RunGrantLookupResult<Identity extends RunGrantIdentity = ScheduledMCPIdentity> =
  | {
      readonly state: 'found';
      readonly consent: RunGrantConsent<Identity>;
      /** The grant is for the whole agent: the consent's list of tools is not a limit. */
      readonly everything?: true;
    }
  | { readonly state: 'missing' }
  | { readonly state: 'unavailable' };

export interface RunGrantAuthorizationRequest<
  Identity extends RunGrantIdentity = ScheduledMCPIdentity,
> {
  readonly identity: Identity;
  readonly resource: RunGrantResource;
  readonly stage: 'activation' | 'mint' | 'invoke' | 'resume';
  /** Set only by the owner-authorized manual trigger or its verified resume metadata. */
  readonly manual?: boolean;
  readonly selection: RunGrantToolSelection;
  /**
   * Digest of each selected tool's live definition, by tool. A tool is pinned to the first
   * one seen and refused once it differs. Absent at mint, where no catalog is read.
   */
  readonly definitions?: Readonly<Record<string, string>>;
}

/** Ephemeral observation, not a transferable grant or permission to cache an allow decision. */
export type RunGrantAuthorizationResult =
  | {
      readonly state: 'authorized';
      readonly consentId: string;
      readonly consentRevision: string;
      readonly policyRevision: string;
      readonly validUntilMs: number;
      /** The owner approves each use of this tool. The caller must hold that approval. */
      readonly approvalRequired?: true;
    }
  | { readonly state: 'denied'; readonly failure: RunGrantFailure }
  | { readonly state: 'cancelled' };

/** A call under a whole-agent grant on a server the grant holds no consent for. */
export interface RunGrantStandingRequest<Identity extends RunGrantIdentity = ScheduledMCPIdentity> {
  readonly identity: Identity;
  /** The grant the run started under. A later one is another decision. */
  readonly revision: string;
  readonly stage: 'activation' | 'invoke' | 'resume';
  readonly manual?: boolean;
  /**
   * For a grant that lists its tools: the agent calling, and every key the tool being called
   * could be listed under (either spelling of its server, and the selection of the whole
   * server). The grant must list one of them for that agent. Left out, only a grant of the
   * whole agent passes.
   */
  readonly listed?: { readonly agentId: string; readonly keys: readonly string[] };
}

export type RunGrantStandingResult =
  | { readonly state: 'authorized' }
  | { readonly state: 'denied'; readonly failure: RunGrantFailure }
  | { readonly state: 'cancelled' };

export interface RunGrantAuthority<Identity extends RunGrantIdentity = ScheduledMCPIdentity> {
  readonly lookupConsent: (
    identity: Identity,
    resource: RunGrantResource,
    options: { signal?: AbortSignal },
  ) => Promise<RunGrantLookupResult<Identity>>;
  /** Rechecks live consent, RBAC, schedule/graph binding and trusted tool policy at each stage. */
  readonly authorize: (
    request: RunGrantAuthorizationRequest<Identity>,
    options: { signal?: AbortSignal },
  ) => Promise<RunGrantAuthorizationResult>;
  /**
   * The live checks of `authorize` with no server to match, for a tool on a server the grant
   * holds no consent for: the stored grant is the one this run started under and still in
   * force, it is for the whole agent or lists that tool, and its owner may still use
   * schedules, MCP servers and the agent on a deployment that still runs them.
   */
  readonly standing: (
    request: RunGrantStandingRequest<Identity>,
    options: { signal?: AbortSignal },
  ) => Promise<RunGrantStandingResult>;
}
