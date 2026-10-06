import type { PRAutomationState } from 'librechat-data-provider';
import type { PRAutomationStopCode } from 'librechat-data-provider';
import type { PRAutomationTrustLevel } from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';

export const MAX_PR_AUTOMATION_BOTS = 20;

/** A bot the user approved for one repository, matched by its numeric account id. */
export interface IPRAutomationBot {
  id: number;
  /** Display only. Logins can be renamed, so identity checks never read it. */
  login?: string;
}

export interface IPRAutomation {
  user: Types.ObjectId;
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
  lastHeadSha?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPRAutomationDocument extends IPRAutomation, Document {}

export interface PRAutomationKey {
  userId: string | Types.ObjectId;
  conversationId: string;
}

export interface EnablePRAutomationParams extends PRAutomationKey {
  trust?: PRAutomationTrustLevel;
  repository?: string;
  pullNumber?: number;
}

export interface ClaimPRAutomationRoundParams extends PRAutomationKey {
  maxRounds: number;
  maxMinutes: number;
  /** The head the round will work on; recorded so a stale event can be recognized. */
  headSha: string;
  now?: Date;
}

export type PRAutomationClaimErrorCode =
  | 'not_found'
  | 'not_active'
  | 'round_cap'
  | 'time_cap'
  | 'stale_head';

export type ClaimPRAutomationRoundResult =
  | { ok: true; value: IPRAutomation }
  | { ok: false; error: { code: PRAutomationClaimErrorCode } };

export type PRAutomationBotResult =
  | { ok: true; value: IPRAutomation }
  | { ok: false; error: { code: 'not_found' | 'bot_limit' } };
