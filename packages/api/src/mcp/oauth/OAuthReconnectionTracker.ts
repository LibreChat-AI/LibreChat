interface FailedMeta {
  attempts: number;
  lastFailedAt: number;
}

const COOLDOWN_SCHEDULE_MS = [5 * 60 * 1000, 10 * 60 * 1000, 20 * 60 * 1000, 30 * 60 * 1000];

/** Failed entries untouched this long are dropped so pairs that never retry do not accumulate. */
export const DEFAULT_FAILED_RETENTION_MS: number = 24 * 60 * 60 * 1000;
const FAILED_PRUNE_INTERVAL_MS = 60 * 1000;

/** Builds the tracker with the `mcpSettings.oauthFailureRetentionMs` budget, else the default. */
export function createOAuthReconnectionTracker(
  appConfig?: { mcpSettings?: { oauthFailureRetentionMs?: number } | null } | null,
): OAuthReconnectionTracker {
  return new OAuthReconnectionTracker(appConfig?.mcpSettings?.oauthFailureRetentionMs);
}

export class OAuthReconnectionTracker {
  constructor(private readonly failedRetentionMs: number = DEFAULT_FAILED_RETENTION_MS) {}

  private lastFailedPrune = 0;
  private failedMeta: Map<string, Map<string, FailedMeta>> = new Map();
  /** Map of userId -> Set of serverNames that are actively reconnecting */
  private active: Map<string, Set<string>> = new Map();
  /** Map of userId:serverName -> timestamp when reconnection started */
  private activeTimestamps: Map<string, number> = new Map();
  /** Maximum time (ms) a server can be in reconnecting state before auto-cleanup */
  private readonly RECONNECTION_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

  public isFailed(userId: string, serverName: string): boolean {
    const meta = this.failedMeta.get(userId)?.get(serverName);
    if (!meta) {
      return false;
    }
    const idx = Math.min(meta.attempts - 1, COOLDOWN_SCHEDULE_MS.length - 1);
    const cooldown = COOLDOWN_SCHEDULE_MS[idx];
    const elapsed = Date.now() - meta.lastFailedAt;
    if (elapsed >= cooldown) {
      return false;
    }
    return true;
  }

  /** Check if server is in the active set (original simple check) */
  public isActive(userId: string, serverName: string): boolean {
    return this.active.get(userId)?.has(serverName) ?? false;
  }

  /** Check if server is still reconnecting (considers timeout) */
  public isStillReconnecting(userId: string, serverName: string): boolean {
    if (!this.isActive(userId, serverName)) {
      return false;
    }

    const key = `${userId}:${serverName}`;
    const startTime = this.activeTimestamps.get(key);

    // If there's a timestamp and it has timed out, it's not still reconnecting
    if (startTime && Date.now() - startTime > this.RECONNECTION_TIMEOUT_MS) {
      return false;
    }

    return true;
  }

  /** Clean up server if it has timed out - returns true if cleanup was performed */
  public cleanupIfTimedOut(userId: string, serverName: string): boolean {
    const key = `${userId}:${serverName}`;
    const startTime = this.activeTimestamps.get(key);

    if (startTime && Date.now() - startTime > this.RECONNECTION_TIMEOUT_MS) {
      this.removeActive(userId, serverName);
      return true;
    }

    return false;
  }

  private pruneFailed(now: number): void {
    if (now - this.lastFailedPrune < Math.min(FAILED_PRUNE_INTERVAL_MS, this.failedRetentionMs)) {
      return;
    }
    this.lastFailedPrune = now;
    for (const [userId, userMap] of this.failedMeta) {
      for (const [serverName, meta] of userMap) {
        if (now - meta.lastFailedAt >= this.failedRetentionMs) {
          userMap.delete(serverName);
        }
      }
      if (userMap.size === 0) {
        this.failedMeta.delete(userId);
      }
    }
  }

  public setFailed(userId: string, serverName: string): void {
    this.pruneFailed(Date.now());
    if (!this.failedMeta.has(userId)) {
      this.failedMeta.set(userId, new Map());
    }
    const userMap = this.failedMeta.get(userId)!;
    const existing = userMap.get(serverName);
    userMap.set(serverName, {
      attempts: (existing?.attempts ?? 0) + 1,
      lastFailedAt: Date.now(),
    });
  }

  public setActive(userId: string, serverName: string): void {
    if (!this.active.has(userId)) {
      this.active.set(userId, new Set());
    }

    this.active.get(userId)?.add(serverName);

    /** Track when reconnection started */
    const key = `${userId}:${serverName}`;
    this.activeTimestamps.set(key, Date.now());
  }

  public removeFailed(userId: string, serverName: string): void {
    const userMap = this.failedMeta.get(userId);
    userMap?.delete(serverName);
    if (userMap?.size === 0) {
      this.failedMeta.delete(userId);
    }
  }

  public removeActive(userId: string, serverName: string): void {
    const userServers = this.active.get(userId);
    userServers?.delete(serverName);
    if (userServers?.size === 0) {
      this.active.delete(userId);
    }

    /** Clear timestamp tracking */
    const key = `${userId}:${serverName}`;
    this.activeTimestamps.delete(key);
  }

  /** Returns map sizes for diagnostics */
  public getStats(): {
    usersWithFailedServers: number;
    usersWithActiveReconnections: number;
    activeTimestamps: number;
  } {
    return {
      usersWithFailedServers: this.failedMeta.size,
      usersWithActiveReconnections: this.active.size,
      activeTimestamps: this.activeTimestamps.size,
    };
  }
}
