import crypto from 'node:crypto';
import type {
  RefreshTokenBridgeDeleteInput,
  RefreshTokenBridgeIdentity,
  RefreshTokenBridgeInput,
  OpenIDLogger,
} from './types';

interface StoredRefreshTokenBridge {
  encryptedNewRefreshToken: string;
  userId: string;
  tenantId?: string;
  openidIssuer?: string;
  version?: string;
  createdAt: Date | string;
}

interface BridgeQuery {
  oldRefreshTokenHash?: string;
  oldRefreshTokenHashes?: string[];
  encryptedNewRefreshToken?: string;
  userId: string;
  tenantId?: string;
  openidIssuer?: string;
  version?: string;
  expiresAt?: Date;
}

type IdentityInput = Partial<RefreshTokenBridgeIdentity>;

export interface RefreshTokenBridgeService {
  OPENID_REFRESH_BRIDGE_GRACE_MS: number;
  createRefreshTokenBridgeFlightKey: (args: {
    oldRefreshToken?: string;
    userId?: string;
    tenantId?: string;
    openidIssuer?: string;
  }) => string | null;
  deleteAllRefreshTokenBridges: (args: {
    userId?: string;
    tenantId?: string;
  }) => Promise<object | null>;
  deleteRefreshTokenBridges: (args: RefreshTokenBridgeDeleteInput) => Promise<object | null>;
  storeRefreshTokenBridge: (args: RefreshTokenBridgeInput) => Promise<string | null>;
  getRefreshTokenBridge: (args: {
    oldRefreshToken?: string;
    userId?: string;
    tenantId?: string;
    openidIssuer?: string;
  }) => Promise<string | null>;
  __internals: {
    hashRefreshToken: (refreshToken: string) => string;
    getBridgeTtlMs: () => number;
    resolveBridgeIdentity: (input: IdentityInput) => RefreshTokenBridgeIdentity | null;
  };
}

export interface RefreshTokenBridgeDeps {
  db: {
    upsertRefreshTokenBridge: (data: BridgeQuery) => Promise<StoredRefreshTokenBridge | null>;
    findRefreshTokenBridge: (data: BridgeQuery) => Promise<StoredRefreshTokenBridge | null>;
    deleteRefreshTokenBridges: (data: BridgeQuery) => Promise<object>;
  };
  logger: Pick<OpenIDLogger, 'warn' | 'debug' | 'info'>;
  encrypt: (value: string) => Promise<string>;
  decrypt: (value: string) => Promise<string>;
  math: (value: string | undefined, fallback: number) => number;
  defaultRefreshTokenExpiry: number;
  createIdentity: (data: IdentityInput) => RefreshTokenBridgeIdentity | null;
}

export function createRefreshTokenBridgeService(
  deps: RefreshTokenBridgeDeps,
): RefreshTokenBridgeService {
  const { db, logger, encrypt, decrypt, math, defaultRefreshTokenExpiry, createIdentity } = deps;
  const OPENID_REFRESH_BRIDGE_GRACE_MS = math(
    process.env.OPENID_REFRESH_BRIDGE_GRACE_MS,
    60 * 1000,
  );
  const getBridgeTtlMs = () => math(process.env.REFRESH_TOKEN_EXPIRY, defaultRefreshTokenExpiry);
  const resolveBridgeIdentity = ({ userId, tenantId, openidIssuer }: IdentityInput) =>
    createIdentity({ userId, tenantId, openidIssuer });
  const hashRefreshToken = (refreshToken: string) =>
    crypto.createHash('sha256').update(refreshToken).digest('hex');

  function createRefreshTokenBridgeFlightKey({
    oldRefreshToken,
    userId,
    tenantId,
    openidIssuer,
  }: {
    oldRefreshToken?: string;
    userId?: string;
    tenantId?: string;
    openidIssuer?: string;
  }) {
    const identity = resolveBridgeIdentity({ userId, tenantId, openidIssuer });
    if (!oldRefreshToken || !identity) return null;
    return hashRefreshToken(
      [
        'bridge-recovery',
        identity.userId,
        identity.tenantId ?? '',
        identity.openidIssuer ?? '',
        hashRefreshToken(oldRefreshToken),
      ].join('\x1f'),
    );
  }

  async function storeRefreshTokenBridge({
    oldRefreshToken,
    newRefreshToken,
    userId,
    tenantId,
    openidIssuer,
    ttl,
  }: RefreshTokenBridgeInput): Promise<string | null> {
    const identity = resolveBridgeIdentity({ userId, tenantId, openidIssuer });
    if (!oldRefreshToken || !newRefreshToken || !identity) {
      logger.warn('[RefreshTokenBridge] Attempted to store bridge with missing required fields');
      return null;
    }
    const oldRefreshTokenHash = hashRefreshToken(oldRefreshToken);
    const bridgeTtl = ttl ?? getBridgeTtlMs();
    const version = crypto.randomUUID();
    await db.upsertRefreshTokenBridge({
      oldRefreshTokenHash,
      encryptedNewRefreshToken: await encrypt(newRefreshToken),
      userId: identity.userId,
      tenantId: identity.tenantId,
      openidIssuer: identity.openidIssuer,
      version,
      expiresAt: new Date(Date.now() + bridgeTtl),
    });
    logger.debug('[RefreshTokenBridge] Stored recovery bridge', {
      tokenHash: oldRefreshTokenHash,
      userId: identity.userId,
      ttl: bridgeTtl,
    });
    return version;
  }

  async function getRefreshTokenBridge({
    oldRefreshToken,
    userId,
    tenantId,
    openidIssuer,
  }: {
    oldRefreshToken?: string;
    userId?: string;
    tenantId?: string;
    openidIssuer?: string;
  }): Promise<string | null> {
    const identity = resolveBridgeIdentity({ userId, tenantId, openidIssuer });
    if (!oldRefreshToken || !identity) return null;
    const oldRefreshTokenHash = hashRefreshToken(oldRefreshToken);
    const bridge = await db.findRefreshTokenBridge({
      oldRefreshTokenHash,
      userId: identity.userId,
      tenantId: identity.tenantId,
    });
    if (!bridge) return null;
    const bridgeIdentity = resolveBridgeIdentity({
      userId: bridge.userId,
      tenantId: bridge.tenantId,
      openidIssuer: bridge.openidIssuer,
    });
    if (!bridgeIdentity || bridgeIdentity.openidIssuer !== identity.openidIssuer) {
      logger.warn('[RefreshTokenBridge] Bridge lookup failed: issuer mismatch', {
        tokenHash: oldRefreshTokenHash,
      });
      return null;
    }
    logger.info('[RefreshTokenBridge] Successfully resolved recovery bridge', {
      tokenHash: oldRefreshTokenHash,
      userId: identity.userId,
      age: Date.now() - new Date(bridge.createdAt).getTime(),
    });
    return decrypt(bridge.encryptedNewRefreshToken);
  }

  async function deleteRefreshTokenBridges({
    refreshTokens,
    userId,
    tenantId,
    version,
  }: RefreshTokenBridgeDeleteInput): Promise<object | null> {
    const identity = resolveBridgeIdentity({ userId, tenantId });
    const tokens = [...new Set<string>((refreshTokens ?? []).filter(Boolean))];
    if (!identity || tokens.length === 0) return null;
    return db.deleteRefreshTokenBridges({
      oldRefreshTokenHashes: tokens.map(hashRefreshToken),
      userId: identity.userId,
      tenantId: identity.tenantId,
      version,
    });
  }

  async function deleteAllRefreshTokenBridges({
    userId,
    tenantId,
  }: {
    userId?: string;
    tenantId?: string;
  }): Promise<object | null> {
    const identity = resolveBridgeIdentity({ userId, tenantId });
    if (!identity) return null;
    return db.deleteRefreshTokenBridges({ userId: identity.userId, tenantId: identity.tenantId });
  }

  return {
    OPENID_REFRESH_BRIDGE_GRACE_MS,
    createRefreshTokenBridgeFlightKey,
    deleteAllRefreshTokenBridges,
    deleteRefreshTokenBridges,
    storeRefreshTokenBridge,
    getRefreshTokenBridge,
    __internals: { hashRefreshToken, getBridgeTtlMs, resolveBridgeIdentity },
  };
}
