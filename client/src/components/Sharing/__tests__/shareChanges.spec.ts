import { AccessRoleIds, PrincipalType } from 'librechat-data-provider';
import type { TPrincipal } from 'librechat-data-provider';
import { computeShareChanges, dedupeNewShares, principalKey } from '../shareChanges';

const principal = (over: Partial<TPrincipal>): TPrincipal => ({
  type: PrincipalType.USER,
  id: 'id',
  name: 'name',
  accessRoleId: AccessRoleIds.AGENT_VIEWER,
  ...over,
});

describe('computeShareChanges', () => {
  it('does not revoke a principal when the same id appears with a different idOnTheSource', () => {
    // Loaded ACL returns the owner keyed by the external oid...
    const currentShares = [
      principal({
        id: 'owner',
        accessRoleId: AccessRoleIds.AGENT_OWNER,
        idOnTheSource: 'entra-oid-abc',
      }),
    ];
    // ...while the working list (people-picker) carries the local `_id`.
    const allShares = [
      principal({ id: 'owner', accessRoleId: AccessRoleIds.AGENT_OWNER, idOnTheSource: 'owner' }),
      principal({
        id: 'viewer',
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        idOnTheSource: 'viewer',
      }),
    ];

    const { updated, removed } = computeShareChanges(currentShares, allShares);

    expect(removed.some((p) => p.id === 'owner')).toBe(false);
    expect(updated.some((p) => p.id === 'viewer')).toBe(true);
  });

  it('still revokes a principal that is genuinely gone from the working list', () => {
    const currentShares = [
      principal({ id: 'owner', accessRoleId: AccessRoleIds.AGENT_OWNER, idOnTheSource: 'owner' }),
      principal({ id: 'gone', accessRoleId: AccessRoleIds.AGENT_VIEWER, idOnTheSource: 'gone' }),
    ];
    const allShares = [
      principal({ id: 'owner', accessRoleId: AccessRoleIds.AGENT_OWNER, idOnTheSource: 'owner' }),
    ];

    const { removed } = computeShareChanges(currentShares, allShares);
    expect(removed.map((p) => p.id)).toEqual(['gone']);
  });

  it('falls back to idOnTheSource for principals without a local id (unsynced Entra)', () => {
    const currentShares = [
      principal({
        type: PrincipalType.GROUP,
        id: undefined,
        idOnTheSource: 'group-oid',
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
      }),
    ];
    const allShares: TPrincipal[] = [];

    const { removed } = computeShareChanges(currentShares, allShares);
    expect(removed.some((p) => p.idOnTheSource === 'group-oid')).toBe(true);
    expect(principalKey(currentShares[0])).toBe(`${PrincipalType.GROUP}-group-oid`);
  });

  it('emits an update when only Insights access changes', () => {
    const currentShares = [principal({ id: 'viewer', viewInsights: false })];
    const allShares = [principal({ id: 'viewer', viewInsights: true })];

    const { updated, removed } = computeShareChanges(currentShares, allShares);

    expect(updated).toEqual([expect.objectContaining({ id: 'viewer', viewInsights: true })]);
    expect(removed).toEqual([]);
  });

  it('omits Insights access when a role change preserves it', () => {
    const currentShares = [
      principal({ id: 'viewer', accessRoleId: AccessRoleIds.AGENT_VIEWER, viewInsights: true }),
    ];
    const allShares = [
      principal({ id: 'viewer', accessRoleId: AccessRoleIds.AGENT_EDITOR, viewInsights: true }),
    ];

    const { updated } = computeShareChanges(currentShares, allShares);

    expect(updated).toEqual([
      expect.objectContaining({ id: 'viewer', accessRoleId: AccessRoleIds.AGENT_EDITOR }),
    ]);
    expect(updated[0]).not.toHaveProperty('viewInsights');
  });

  it('does not emit a no-op Insights update', () => {
    const currentShares = [principal({ id: 'viewer', viewInsights: true })];
    const allShares = [principal({ id: 'viewer', viewInsights: true })];

    expect(computeShareChanges(currentShares, allShares)).toEqual({ updated: [], removed: [] });
  });
});

describe('dedupeNewShares', () => {
  it('filters out an already-listed principal even when idOnTheSource differs (oid vs local id)', () => {
    // Loaded ACL row carries the external oid; the picker returns the local `_id`.
    const existing = [principal({ id: 'u1', idOnTheSource: 'entra-oid-abc' })];
    const incoming = [principal({ id: 'u1', idOnTheSource: 'u1' })];

    expect(dedupeNewShares(existing, incoming)).toEqual([]);
  });

  it('keeps genuinely new principals', () => {
    const existing = [principal({ id: 'u1', idOnTheSource: 'entra-oid-abc' })];
    const incoming = [principal({ id: 'u2', idOnTheSource: 'u2' })];

    expect(dedupeNewShares(existing, incoming)).toHaveLength(1);
    expect(dedupeNewShares(existing, incoming)[0].id).toBe('u2');
  });

  it('prevents a re-added picker row from clobbering a pending role edit', () => {
    // Persisted: Entra-linked user shared as viewer, ACL row keyed by external oid.
    const currentShares = [
      principal({
        id: 'u1',
        idOnTheSource: 'entra-oid-abc',
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
      }),
    ];
    // Working list: the admin promoted the row to editor...
    const workingRow = principal({
      id: 'u1',
      idOnTheSource: 'entra-oid-abc',
      accessRoleId: AccessRoleIds.AGENT_EDITOR,
    });
    // ...then re-added the same user from the picker (local `_id`, default role).
    const pickerResult = principal({
      id: 'u1',
      idOnTheSource: 'u1',
      accessRoleId: AccessRoleIds.AGENT_VIEWER,
    });

    const allShares = [workingRow, ...dedupeNewShares([workingRow], [pickerResult])];
    const { updated, removed } = computeShareChanges(currentShares, allShares);

    expect(removed).toHaveLength(0);
    expect(updated.map((p) => p.accessRoleId)).toEqual([AccessRoleIds.AGENT_EDITOR]);
  });
});
