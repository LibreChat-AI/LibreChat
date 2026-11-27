import { Types } from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';

/**
 * Normalizes a principalId to the correct type for MongoDB queries and storage.
 * USER and GROUP principals are stored as ObjectIds; ROLE principals are strings.
 * Ensures a string caller ID is cast to ObjectId so it matches documents written
 * by `grantCapability` — which always stores user/group IDs as ObjectIds to match
 * what `getUserPrincipals` returns.
 */
export const normalizePrincipalId = (
  principalId: string | Types.ObjectId,
  principalType: PrincipalType,
): string | Types.ObjectId => {
  if (typeof principalId === 'string' && principalType !== PrincipalType.ROLE) {
    if (!Types.ObjectId.isValid(principalId)) {
      throw new TypeError(`Invalid ObjectId string for ${principalType}: "${principalId}"`);
    }
    return new Types.ObjectId(principalId);
  }
  return principalId;
};

type PrincipalId = string | Types.ObjectId;

/** One `$or` clause of {@link principalClauses}: a principal type and the ids it matches. */
export interface PrincipalClause {
  principalType: string;
  principalId?: PrincipalId | { $in: Array<PrincipalId | undefined> };
}

/**
 * The `$or` clauses that match any of `principals`, one per principal type: a type's ids fold
 * into a single `$in`, and the public principal matches by type alone. A user in hundreds of
 * groups would otherwise send one clause per group, and the database plans every clause as its
 * own index scan, although only the few groups that some ACL entry, grant or config names can
 * match. The result matches exactly the documents the per-principal clauses match.
 */
export function principalClauses(
  principals: ReadonlyArray<{ principalType: string; principalId?: PrincipalId }>,
): PrincipalClause[] {
  const ids = new Map<string, Array<PrincipalId | undefined>>();
  for (const { principalType, principalId } of principals) {
    const list = ids.get(principalType);
    if (list) {
      list.push(principalId);
    } else {
      ids.set(principalType, [principalId]);
    }
  }
  const clauses: PrincipalClause[] = [];
  for (const [principalType, list] of ids) {
    if (principalType === PrincipalType.PUBLIC) {
      clauses.push({ principalType });
    } else {
      clauses.push({
        principalType,
        principalId: list.length === 1 ? list[0] : { $in: list },
      });
    }
  }
  return clauses;
}
