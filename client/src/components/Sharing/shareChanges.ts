import type { TPrincipal } from 'librechat-data-provider';

/**
 * Key a principal by its stable local `id` when present, falling back to
 * `idOnTheSource` for principals not yet synced locally (e.g. Entra groups/users
 * that only carry an external oid).
 *
 * Keying by `idOnTheSource` alone is unsafe: the same user can be represented with a
 * different `idOnTheSource` across sources. `getResourcePermissions` returns
 * `userInfo.idOnTheSource || _id` (the external oid for OpenID/Entra users), while the
 * people-picker returns the local `_id`. That mismatch places the same principal in
 * both the `updated` and `removed` sets — and because the server applies grants before
 * revocations, the resource owner's own grant is silently revoked when they share.
 */
export const principalKey = (share: TPrincipal): string =>
  `${share.type}-${share.id ?? share.idOnTheSource}`;

/**
 * Filter people-picker results down to principals not already present in the working
 * list, keyed by the same stable identity `computeShareChanges` diffs on.
 *
 * Comparing raw `idOnTheSource` here is not enough: loaded ACL rows carry the external
 * oid for OpenID/Entra-linked users while search results carry the local `_id`, so the
 * same principal would be appended twice — and the duplicate (collapsing to the same
 * key in the diff) would silently shadow a pending role edit.
 */
export function dedupeNewShares(
  existingShares: TPrincipal[],
  newShares: TPrincipal[],
): TPrincipal[] {
  const existingKeys = new Set(existingShares.map(principalKey));
  return newShares.filter((share) => !existingKeys.has(principalKey(share)));
}

/**
 * Diff the currently-persisted shares (`currentShares`) against the working list
 * (`allShares`) to derive which principals to grant/update and which to revoke.
 */
export function computeShareChanges(
  currentShares: TPrincipal[],
  allShares: TPrincipal[],
): { updated: TPrincipal[]; removed: TPrincipal[] } {
  const originalSharesMap = new Map(currentShares.map((share) => [principalKey(share), share]));
  const allSharesMap = new Map(allShares.map((share) => [principalKey(share), share]));

  // Diff over the de-duplicated map values so a principal that appears more than once
  // in the input (possible while the add/dedupe path still keys on idOnTheSource) is
  // never emitted multiple times.
  const updated = [...allSharesMap.values()].flatMap((share) => {
    const original = originalSharesMap.get(principalKey(share));
    if (!original) {
      return [share];
    }

    const roleChanged = original.accessRoleId !== share.accessRoleId;
    const insightsChanged = original.viewInsights !== share.viewInsights;
    if (!roleChanged && !insightsChanged) {
      return [];
    }
    if (insightsChanged) {
      return [share];
    }

    const { viewInsights: _preserved, ...roleUpdate } = share;
    return [roleUpdate];
  });

  const removed = [...originalSharesMap.values()].filter(
    (share) => !allSharesMap.has(principalKey(share)),
  );

  return { updated, removed };
}
