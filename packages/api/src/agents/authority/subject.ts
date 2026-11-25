import type { RunGrantIdentity } from 'librechat-data-provider';
import type {
  RunGrantExecutionFactory,
  RunGrantExecutionOptions,
  RunGrantExecution,
  Without,
} from './execution';
import type { RequestScopedMCPConnectionStore } from '~/mcp/types';
import type { ExecutionContext } from './context';
import type { Subject } from './trigger';

/** A request a run is being initialized for, with what its host knows of it. */
export interface SubjectInput {
  req: { _isAgentTrigger?: boolean; body?: Record<string, unknown> };
  signal?: AbortSignal;
  /** Where the request's MCP tools are built, and so where its grant is held. */
  context?: RequestScopedMCPConnectionStore;
  executionContext?: ExecutionContext;
  /** What the saved job of a resumed run carries. Read by its subject alone. */
  restoredJob?: object;
  /** Tool calls the owner approved in the request that resumes this run. */
  approvedToolCalls?: readonly string[];
}

/** What a subject makes of one request: who the run acts for, and how it is held to that. */
export interface Resolved<Identity extends RunGrantIdentity = RunGrantIdentity> {
  identity: Identity;
  context: RequestScopedMCPConnectionStore;
  stage: RunGrantExecution['stage'];
  /**
   * What the run may not start without. `grant`: the subject's own grant. `run`: a place under
   * the subject at all, with a grant or as a subject that needs none.
   */
  require?: 'grant' | 'run';
  /** The agent a refusal for want of a place names. */
  agentId?: string;
  options?: Omit<RunGrantExecutionOptions, 'without'>;
}

/** A status a run's turn ends in, as the chat route reports it to the run's subject. */
export type SettleStatus =
  | 'success'
  | 'error'
  | 'interrupted'
  | 'requires_action'
  | 'skipped_balance';

/** How one turn of a run ended, for its subject to record. */
export interface Settle {
  executionContext?: ExecutionContext;
  status: SettleStatus;
  /** A code or short reason safe to store where the owner reads it. */
  error?: string;
  conversationId?: string;
  /** For a run that paused, where its checkpoint is kept. */
  checkpointNamespace?: string;
  /** The run's conversation was never created; its row should not keep the id it reserved. */
  clearConversationId?: boolean;
  /** The request the turn ran in. A subject settles only a run that request started. */
  request?: object;
}

/**
 * One kind of subject a run can act for: a schedule, an API key. The run host asks each the
 * same questions and reads nothing of the subject itself, so another kind is another adapter.
 *
 * Signatures are methods so that an adapter for one identity is usable wherever the host
 * holds adapters of any.
 */
export interface SubjectAdapter<
  Identity extends RunGrantIdentity = RunGrantIdentity,
  Input extends SubjectInput = SubjectInput,
> {
  readonly kind: Subject['kind'];
  /**
   * Whether the request is this subject's. Asked of every request before anything is built
   * or read for it, so it decides from the request alone.
   */
  claims(input: Input): boolean;
  /** Who the run acts for. Nothing, where this request runs as its user with no subject. */
  resolve(input: Input): Promise<Resolved<Identity> | undefined>;
  /** What this delivery goes without, read back for a request that does not carry it. */
  restore?(input: Input, found: Resolved<Identity>): Promise<Without | undefined>;
  readonly execution: RunGrantExecutionFactory<Identity>;
  /** Keeps what a later turn of the run needs to find the subject again. */
  retain?(identity: Identity, input: Input): Promise<void>;
  /**
   * An unexpected failure while the run is put under the subject is reported as the grant
   * being unavailable, with nothing of what failed. For a subject whose failures are stored
   * where its owner reads them. Absent, the failure reaches the caller as it is.
   */
  readonly opaque?: boolean;
  /**
   * Records how a turn of the run ended, on the run's record and in the subject's own state.
   * `false` when nothing could be recorded, so a caller that must not go on without it can
   * stop. Absent for a subject whose runs are recorded elsewhere.
   */
  settle?(run: Settle): Promise<boolean>;
}
