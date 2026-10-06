import type { PRAutomationTrustLevel } from 'librechat-data-provider';
import type { PRAutomationStopCode } from 'librechat-data-provider';
import type { PRAutomationState } from 'librechat-data-provider';
import type { Document } from 'mongoose';

/** A bot the user approved for one repository, matched by its numeric account id. */
export interface IPRAutomationBot {
  id: number;
  /** Display only. Logins can be renamed, so identity checks never read it. */
  login?: string;
}

export interface IPRAutomation {
  user: string;
  tenantId?: string;
  conversationId: string;
  /** `owner/name` of the repository the pull request belongs to. */
  repository?: string;
  pullNumber?: number;
  state: PRAutomationState;
  stopCode?: PRAutomationStopCode;
  trust: PRAutomationTrustLevel;
  /** Approved bots for this repository only. */
  trustedBots: IPRAutomationBot[];
  /** Fix rounds started so far. Persisted so a new turn cannot reset it. */
  round: number;
  /** First automated round, the start of the wall-clock window. */
  startedAt?: Date;
  /** The head the latest round works on. */
  lastHeadSha?: string;
  /**
   * Identifies the round that is running. Only that round may settle the record, so a
   * completion from a run that was stopped, restarted or rebound to another pull request
   * cannot move the run that replaced it.
   */
  runId?: string;
  /**
   * Every head a round has been claimed for since the last restart. A delayed
   * delivery of an earlier head is rejected against this list. It holds at most
   * one entry per round, so the round cap bounds it.
   */
  claimedHeads: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPRAutomationDocument extends IPRAutomation, Document {}

export interface PRAutomationKey {
  userId: string;
  conversationId: string;
}

/** The pull request a conversation works on. The pair is always written together. */
export interface PRAutomationBinding {
  repository: string;
  pullNumber: number;
}

export interface EnablePRAutomationParams extends PRAutomationKey {
  trust?: PRAutomationTrustLevel;
  binding?: PRAutomationBinding;
}

export interface SettlePRAutomationRoundParams extends PRAutomationKey {
  /** The round that is reporting. A completion for any other round is ignored. */
  round: number;
  /** The `runId` the claim returned. A completion for any other run is ignored. */
  runId: string;
  state: 'waiting' | 'needs_user';
}

export interface ClaimPRAutomationRoundParams extends PRAutomationKey {
  /**
   * The pull request the delivery is for. A delivery for a pull request the record is no
   * longer bound to cannot claim a round, so an event that arrives after a rebind is rejected
   * instead of spending the new pull request's budget.
   */
  binding: PRAutomationBinding;
  maxRounds: number;
  maxMinutes: number;
  /** The head the round will work on; recorded so a stale event can be recognized. */
  headSha: string;
  now?: Date;
}

export type PRAutomationClaimErrorCode =
  | 'not_found'
  | 'not_active'
  | 'binding_mismatch'
  | 'round_cap'
  | 'time_cap'
  | 'stale_head';

export type ClaimPRAutomationRoundResult =
  | { ok: true; value: IPRAutomation & { runId: string } }
  | { ok: false; error: { code: PRAutomationClaimErrorCode } };

export type PRAutomationBotResult =
  | { ok: true; value: IPRAutomation }
  | { ok: false; error: { code: 'not_found' | 'bot_limit' } };
