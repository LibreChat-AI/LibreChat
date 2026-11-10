import type { ProviderSessionRef } from 'librechat-data-provider';
import type { RefreshTokenBridgeDeps } from './bridge';
import { createRefreshTokenBridgeService } from './bridge';

/**
 * A minimal in-memory `db` that mirrors the real Mongo collection's semantics closely enough to
 * exercise the service's version handling: one row per `(oldRefreshTokenHash, userId, tenantId)`,
 * `upsertRefreshTokenBridge` overwrites that row's `version` in place (never appends a second
 * row), and `deleteRefreshTokenBridges` only removes a row whose current `version` still matches
 * the one the caller asks to delete — the same optimistic-concurrency guard
 * `packages/data-schemas/src/methods/refreshTokenBridge.ts` applies.
 */
function createFakeBridgeDb(): RefreshTokenBridgeDeps['db'] {
  type Row = {
    oldRefreshTokenHash: string;
    userId: string;
    tenantId?: string;
    encryptedNewRefreshToken: string;
    version?: string;
    openidIssuer?: string;
    providerSession?: ProviderSessionRef;
    createdAt: Date;
  };
  const rows = new Map<string, Row>();
  const key = (oldRefreshTokenHash: string, userId: string, tenantId?: string) =>
    `${oldRefreshTokenHash}|${userId}|${tenantId ?? ''}`;

  return {
    async upsertRefreshTokenBridge(data) {
      const k = key(data.oldRefreshTokenHash as string, data.userId, data.tenantId);
      const existing = rows.get(k);
      const row: Row = {
        oldRefreshTokenHash: data.oldRefreshTokenHash as string,
        userId: data.userId,
        tenantId: data.tenantId,
        encryptedNewRefreshToken: data.encryptedNewRefreshToken as string,
        version: data.version,
        openidIssuer: data.openidIssuer,
        providerSession: data.providerSession ?? existing?.providerSession,
        createdAt: existing?.createdAt ?? new Date(),
      };
      rows.set(k, row);
      return row;
    },
    async findRefreshTokenBridge(data) {
      const k = key(data.oldRefreshTokenHash as string, data.userId, data.tenantId);
      return rows.get(k) ?? null;
    },
    async deleteRefreshTokenBridges(data) {
      let deletedCount = 0;
      for (const [k, row] of rows) {
        if (row.userId !== data.userId) continue;
        if ((row.tenantId ?? undefined) !== (data.tenantId ?? undefined)) continue;
        if (
          data.oldRefreshTokenHashes &&
          !data.oldRefreshTokenHashes.includes(row.oldRefreshTokenHash)
        ) {
          continue;
        }
        if (data.version && row.version !== data.version) continue;
        rows.delete(k);
        deletedCount += 1;
      }
      return { deletedCount };
    },
  };
}

function makeService() {
  return createRefreshTokenBridgeService({
    db: createFakeBridgeDb(),
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
    encrypt: async (value: string) => value,
    decrypt: async (value: string) => value,
    math: (_value: string | undefined, fallback: number) => fallback,
    defaultRefreshTokenExpiry: 1000 * 60 * 60 * 24 * 7,
    createIdentity: ({ userId, tenantId, openidIssuer }) =>
      userId ? { userId, tenantId, openidIssuer } : null,
  });
}

describe('RefreshTokenBridgeService version handling', () => {
  it('returns the stored version from getRefreshTokenBridge', async () => {
    const service = makeService();
    const version = await service.storeRefreshTokenBridge({
      oldRefreshToken: 'old-token',
      newRefreshToken: 'new-token',
      userId: 'user-1',
    });

    const bridge = await service.getRefreshTokenBridge({
      oldRefreshToken: 'old-token',
      userId: 'user-1',
    });

    expect(bridge?.version).toBe(version);
  });

  it('a newer bridge (different version) for the same old token survives a stale versioned delete', async () => {
    const service = makeService();
    const staleVersion = await service.storeRefreshTokenBridge({
      oldRefreshToken: 'old-token',
      newRefreshToken: 'rotated-once',
      userId: 'user-1',
    });
    const read = await service.getRefreshTokenBridge({
      oldRefreshToken: 'old-token',
      userId: 'user-1',
    });
    expect(read?.version).toBe(staleVersion);

    // Concurrently, another attempt re-bridges the same old token to a newer version before this
    // caller's delete (holding the stale version it read above) runs.
    const newerVersion = await service.storeRefreshTokenBridge({
      oldRefreshToken: 'old-token',
      newRefreshToken: 'rotated-twice',
      userId: 'user-1',
    });
    expect(newerVersion).not.toBe(staleVersion);

    await service.deleteRefreshTokenBridges({
      refreshTokens: ['old-token'],
      userId: 'user-1',
      version: staleVersion as string,
    });

    const survivor = await service.getRefreshTokenBridge({
      oldRefreshToken: 'old-token',
      userId: 'user-1',
    });
    expect(survivor?.refreshToken).toBe('rotated-twice');
    expect(survivor?.version).toBe(newerVersion);
  });

  it('removes the bridge when the versioned delete targets its current version', async () => {
    const service = makeService();
    const version = await service.storeRefreshTokenBridge({
      oldRefreshToken: 'old-token',
      newRefreshToken: 'rotated-once',
      userId: 'user-1',
    });

    await service.deleteRefreshTokenBridges({
      refreshTokens: ['old-token'],
      userId: 'user-1',
      version: version as string,
    });

    const result = await service.getRefreshTokenBridge({
      oldRefreshToken: 'old-token',
      userId: 'user-1',
    });
    expect(result).toBeNull();
  });
});
