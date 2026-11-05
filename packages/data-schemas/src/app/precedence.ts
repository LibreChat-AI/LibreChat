import { PrincipalType } from 'librechat-data-provider';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';

/**
 * The order config overrides merge in, lowest precedence first, so the last layer wins:
 *
 * 1. Base (`role` / `__base__`) always merges first, whatever its stored priority.
 * 2. Then ascending `priority`.
 * 3. On equal priority, by principal type: role, then group, then user.
 * 4. Then by document identity (`_id`), ascending.
 *
 * Every step is total, so a set of documents merges the same way however the store returned
 * them. Identity order roughly follows creation order but is only promised to be stable.
 */

/** The fields of a config document that decide where it merges. */
export interface ConfigPrecedenceKey {
  principalType: string;
  principalId: { toString(): string };
  priority: number;
  _id?: { toString(): string } | null;
}

/** Tie-break rank on equal priority: a narrower principal merges later and wins. */
const PRINCIPAL_TYPE_RANK: Readonly<Record<string, number>> = {
  [PrincipalType.ROLE]: 0,
  [PrincipalType.GROUP]: 1,
  [PrincipalType.USER]: 2,
};

const UNRANKED_PRINCIPAL_TYPE = 3;

/** Priority a role's document gets when a write creates it without one. */
export const DEFAULT_CONFIG_PRIORITY = 10;

/**
 * Priority a principal's document gets when a write creates it without one. A narrower
 * principal defaults higher, so a group profile outranks a role profile and a user profile
 * outranks both unless an admin says otherwise. Base sits at 0; it merges first regardless.
 */
export const DEFAULT_CONFIG_PRIORITIES: Readonly<Record<string, number>> = {
  [PrincipalType.ROLE]: DEFAULT_CONFIG_PRIORITY,
  [PrincipalType.GROUP]: 20,
  [PrincipalType.USER]: 100,
};

export const BASE_CONFIG_PRIORITY = 0;

/** Whether a document belongs to the tenant-wide Base principal (`role` / `__base__`). */
export function isBaseConfigPrincipal(principal: {
  principalType: string;
  principalId?: { toString(): string } | null;
}): boolean {
  return (
    principal.principalType === PrincipalType.ROLE &&
    principal.principalId?.toString() === BASE_CONFIG_PRINCIPAL_ID
  );
}

export function getDefaultConfigPriority(principal: {
  principalType: string;
  principalId?: { toString(): string } | null;
}): number {
  if (isBaseConfigPrincipal(principal)) {
    return BASE_CONFIG_PRIORITY;
  }
  return DEFAULT_CONFIG_PRIORITIES[principal.principalType] ?? DEFAULT_CONFIG_PRIORITY;
}

function rankOf(principalType: string): number {
  return PRINCIPAL_TYPE_RANK[principalType] ?? UNRANKED_PRINCIPAL_TYPE;
}

/** Orders documents by merge precedence (see the module comment); sort with it ascending. */
export function compareConfigPrecedence(
  left: ConfigPrecedenceKey,
  right: ConfigPrecedenceKey,
): number {
  const leftBase = isBaseConfigPrincipal(left);
  if (leftBase !== isBaseConfigPrincipal(right)) {
    return leftBase ? -1 : 1;
  }
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }
  const rank = rankOf(left.principalType) - rankOf(right.principalType);
  if (rank !== 0) {
    return rank;
  }
  const leftId = left._id?.toString() ?? '';
  const rightId = right._id?.toString() ?? '';
  if (leftId === rightId) {
    return 0;
  }
  return leftId < rightId ? -1 : 1;
}

/** A copy of `configs` in merge order. */
export function sortByConfigPrecedence<T extends ConfigPrecedenceKey>(configs: readonly T[]): T[] {
  return [...configs].sort(compareConfigPrecedence);
}
