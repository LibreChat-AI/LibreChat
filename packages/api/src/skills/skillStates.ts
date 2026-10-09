import { isValidObjectIdString } from '@librechat/data-schemas';
import type { Types } from 'mongoose';

/** Hard cap on explicit override entries stored on a user document. */
export const MAX_SKILL_STATES = 200;
/** Max length of a skill-ID map key (matches ObjectId hex length with slack). */
export const MAX_KEY_LENGTH = 64;
/**
 * Generous upper bound on raw payload size to reject abusive inputs before
 * we spend cycles validating or querying the DB for orphan cleanup.
 */
export const MAX_RAW_PAYLOAD: number = MAX_SKILL_STATES * 2;

/** Map of skillId → explicit active state override. */
export type SkillStatesRecord = Record<string, boolean>;

/**
 * Converts a Mongoose Map (non-lean) or plain object (lean) into a
 * `SkillStatesRecord`. Returns `{}` for any other shape.
 */
export function toSkillStatesRecord(
  raw: Map<string, boolean> | Record<string, boolean> | null | undefined,
): SkillStatesRecord {
  if (raw instanceof Map) {
    return Object.fromEntries(raw);
  }
  if (raw && typeof raw === 'object') {
    return raw as SkillStatesRecord;
  }
  return {};
}

/**
 * Reads `defaultActiveOnShare` out of the `interface.skills` config shape.
 * The shape is a Zod union (boolean | object) so we handle both gracefully.
 */
export function resolveDefaultActiveOnShare(skillsConfig: unknown): boolean {
  if (skillsConfig && typeof skillsConfig === 'object') {
    return (skillsConfig as { defaultActiveOnShare?: unknown }).defaultActiveOnShare === true;
  }
  return false;
}

/** Return shape from `loadSkillStates`. */
export interface LoadedSkillStates {
  skillStates: SkillStatesRecord;
  defaultActiveOnShare: boolean;
}

export interface LoadSkillStatesParams {
  userId: string;
  appConfig?: { interfaceConfig?: { skills?: unknown } } | null;
  getUserById: (
    id: string,
    select: string,
  ) => Promise<{ skillStates?: Map<string, boolean> | Record<string, boolean> } | null | undefined>;
  /**
   * When provided and empty, the helper short-circuits to defaults without
   * issuing the user query. Lets every agent entry point skip the DB round
   * trip when no skills are accessible, without re-implementing the guard.
   */
  accessibleSkillIds?: ArrayLike<unknown>;
}

/**
 * Loads a user's `skillStates` overrides and the admin-configured
 * `defaultActiveOnShare` in one call. Used by every agent entry point so the
 * same loading block is not duplicated across controllers.
 */
export async function loadSkillStates(params: LoadSkillStatesParams): Promise<LoadedSkillStates> {
  const { userId, appConfig, getUserById, accessibleSkillIds } = params;
  if (accessibleSkillIds !== undefined && accessibleSkillIds.length === 0) {
    return { skillStates: {}, defaultActiveOnShare: false };
  }
  const user = await getUserById(userId, 'skillStates');
  return {
    skillStates: toSkillStatesRecord(user?.skillStates),
    defaultActiveOnShare: resolveDefaultActiveOnShare(appConfig?.interfaceConfig?.skills),
  };
}

export interface SkillStatesValidationError {
  code?: string;
  message: string;
  limit?: number;
}

/**
 * Validates a raw skill-states update payload. Returns `null` on success or
 * a structured `SkillStatesValidationError` describing the first rejection
 * reason. Caller maps the error to an HTTP 400 response.
 *
 * Rejects: non-object payloads, oversize payloads (sanity bound for abuse),
 * non-string/empty/oversize keys, keys that are not valid ObjectIds, and
 * non-boolean values. The strict 200-entry cap is enforced *after* orphan
 * pruning, not here, so stale-client payloads near the cap do not get a
 * false-positive rejection.
 */
export function validateSkillStatesPayload(payload: unknown): SkillStatesValidationError | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { message: 'skillStates must be a plain object' };
  }
  const entries = Object.entries(payload as Record<string, unknown>);
  if (entries.length > MAX_RAW_PAYLOAD) {
    return {
      code: 'SKILL_STATES_PAYLOAD_TOO_LARGE',
      message: `Payload exceeds ${MAX_RAW_PAYLOAD} entries`,
      limit: MAX_RAW_PAYLOAD,
    };
  }
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      return {
        message: `Each skill ID must be a non-empty string (max ${MAX_KEY_LENGTH} chars)`,
      };
    }
    if (!isValidObjectIdString(key)) {
      return { message: 'Each skill ID must be a valid ObjectId' };
    }
    if (typeof value !== 'boolean') {
      return { message: 'Each skill state value must be a boolean' };
    }
  }
  return null;
}

export interface PruneOrphansDeps {
  /** Returns the subset of the given IDs that exist as Skill documents. */
  findExistingSkillIds: (validIds: string[]) => Promise<string[]>;
  /** Returns IDs the current user has VIEW access to via ACL. */
  findAccessibleSkillIds: () => Promise<Array<Types.ObjectId | string>>;
}

/**
 * Returns a copy of `skillStates` containing only entries that: are valid
 * ObjectIds, point to a Skill that currently exists, AND the user still has
 * VIEW access to. Self-heals three classes of orphan without cascade logic:
 * malformed keys, deleted skills, and revoked shares.
 *
 * Deps are injected so the pure logic can be tested without Mongoose or ACL
 * wiring. Callers in `/api` adapt their live model + permission service.
 */
export async function pruneOrphanSkillStates(
  skillStates: SkillStatesRecord,
  deps: PruneOrphansDeps,
): Promise<SkillStatesRecord> {
  const validIds = Object.keys(skillStates).filter((id) => isValidObjectIdString(id));
  if (validIds.length === 0) {
    return {};
  }
  const [existing, accessible] = await Promise.all([
    deps.findExistingSkillIds(validIds),
    deps.findAccessibleSkillIds(),
  ]);
  const existingSet = new Set(existing);
  const accessibleSet = new Set(accessible.map((id) => id.toString()));
  const pruned: SkillStatesRecord = {};
  for (const id of validIds) {
    if (existingSet.has(id) && accessibleSet.has(id)) {
      pruned[id] = skillStates[id];
    }
  }
  return pruned;
}
