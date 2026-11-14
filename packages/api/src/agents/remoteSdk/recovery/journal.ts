/** Durable wire frames, independent of SDK objects, sockets, and browser rendering. */
export interface RuntimeJournalLease {
  owner: string;
  epoch: number;
}
export interface RuntimeJournalSession {
  sessionId: string;
  /** Hash of verified runtime/agent/run/caller/tenant/thread/generation identity, never a request-body authority. */
  scope: string;
}
export type RuntimeJournalFailure =
  | 'missing'
  | 'scope_mismatch'
  | 'fenced'
  | 'closed'
  | 'limit'
  | 'cursor_ahead'
  | 'batch_conflict'
  | 'already_exists';
export type RuntimeJournalResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: RuntimeJournalFailure } };
export type RuntimeJournalState = 'open' | 'completed' | 'failed' | 'cancelled' | 'paused';
export interface RuntimeJournalPage {
  state: RuntimeJournalState;
  started: boolean;
  head: number;
  acknowledged: number;
  frames: Array<{ sequence: number; payload: string }>;
}
/**
 * Acknowledgements never evict frames: a replacement connection may need the full prefix.
 * Expiration/limits bound retention. A claimed session with started=true MUST NOT start a
 * second SDK Run; execution adoption needs a separate, explicit recovery protocol.
 * Session IDs are single-use. A missing/expired replay session must fail, not silently
 * create another execution. Store durability depends on the deployment persistence policy.
 */
export interface RuntimeJournal {
  /** Privileged lifecycle cleanup; callers must authenticate deletion authority before storage access. */
  purge(session: RuntimeJournalSession): Promise<RuntimeJournalResult<null>>;
  create(
    session: RuntimeJournalSession,
    owner: string,
  ): Promise<RuntimeJournalResult<RuntimeJournalLease>>;
  claim(
    session: RuntimeJournalSession,
    owner: string,
  ): Promise<RuntimeJournalResult<RuntimeJournalLease & { started: boolean }>>;
  renew(
    session: RuntimeJournalSession,
    lease: RuntimeJournalLease,
  ): Promise<RuntimeJournalResult<null>>;
  markStarted(
    session: RuntimeJournalSession,
    lease: RuntimeJournalLease,
  ): Promise<RuntimeJournalResult<{ first: boolean }>>;
  append(
    session: RuntimeJournalSession,
    lease: RuntimeJournalLease,
    batchId: string,
    payloads: readonly string[],
  ): Promise<RuntimeJournalResult<{ first: number; last: number }>>;
  acknowledge(
    session: RuntimeJournalSession,
    lease: RuntimeJournalLease,
    sequence: number,
  ): Promise<RuntimeJournalResult<{ acknowledged: number }>>;
  read(
    session: RuntimeJournalSession,
    after: number,
    limit: number,
  ): Promise<RuntimeJournalResult<RuntimeJournalPage>>;
  finish(
    session: RuntimeJournalSession,
    lease: RuntimeJournalLease,
    state: Exclude<RuntimeJournalState, 'open'>,
    head: number,
  ): Promise<RuntimeJournalResult<null>>;
}
