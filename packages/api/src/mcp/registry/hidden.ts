import { isProcessMCPServerConfig } from 'librechat-data-provider';
import { logger, runAsSystem, scopedCacheKey } from '@librechat/data-schemas';
import type * as t from '~/mcp/types';
import { getSafeErrorMetadata } from '~/utils/errors';
import { isPluginSourced } from '~/utils/env';

const NO_SERVER_NAMES: ReadonlySet<string> = new Set();
const MCP_SERVERS_PATH = 'mcpServers';
/** How many stored tombstones the startup report names before summarizing the rest. */
const REPORTED_TOMBSTONES = 20;

/**
 * Reads the server names a principal's merged config keeps. Rejects when that config cannot be
 * read; resolves `undefined` when the reader does not report names, which hides nothing.
 */
export type KeptServerNamesReader = (principal: t.MCPPrincipal) => Promise<string[] | undefined>;

/**
 * librechat.yaml servers a profile can hide: every configured server except process-backed
 * (`stdio`) ones, whose process every user shares, and Agent Plugins servers.
 */
export function getHideableServerNames(
  configs?: Readonly<Record<string, t.ParsedServerConfig>> | null,
): ReadonlySet<string> {
  const hideable = new Set<string>();
  for (const [name, config] of Object.entries(configs ?? {})) {
    if (!isPluginSourced(config) && !isProcessMCPServerConfig(config)) {
      hideable.add(name);
    }
  }
  return hideable.size > 0 ? hideable : NO_SERVER_NAMES;
}

interface HiddenDecision {
  hidden: ReadonlySet<string>;
  expiresAt: number;
}

/**
 * Decides which librechat.yaml MCP servers a principal's config hides: the hideable ones (see
 * {@link getHideableServerNames}) the principal's merged config no longer has.
 *
 * Decisions are memoized in process, per tenant, user and role, for `ttl` ms. The memo is never
 * shared: the decision derives from the merged config, which each process also caches itself, so
 * a shared store could only hand one instance another instance's staler answer. A failed config
 * read hides every hideable server (hiding is an access boundary) and is memoized for the same
 * window, so a database outage costs one strict read per principal per window rather than one
 * per lookup. `clear()` drops every decision and fences resolutions already in flight.
 */
export class HiddenServers {
  private hideable: ReadonlySet<string> = NO_SERVER_NAMES;
  private readonly decisions = new Map<string, HiddenDecision>();
  private readonly pending = new Map<string, Promise<ReadonlySet<string>>>();
  /** Advanced by `clear()`; a resolution that started under an earlier epoch is not memoized. */
  private epoch = 0;
  private lastSweepAt = 0;
  private readonly ttl: number;
  private readonly readKept?: KeptServerNamesReader;

  constructor(ttl: number, readKept?: KeptServerNamesReader) {
    this.ttl = ttl;
    this.readKept = readKept;
  }

  /** Records which librechat.yaml servers a profile can hide, from the configured options. */
  public setYamlServers(configs?: Readonly<Record<string, t.ParsedServerConfig>> | null): void {
    this.hideable = getHideableServerNames(configs);
  }

  public getHideable(): ReadonlySet<string> {
    return this.hideable;
  }

  public isHideable(name: string): boolean {
    return this.hideable.has(name);
  }

  /** Hideable servers missing from a resolved `mcpConfig`; a missing `mcpConfig` hides them all. */
  public hiddenIn(mcpConfig?: Readonly<Record<string, t.MCPOptions>> | null): ReadonlySet<string> {
    if (mcpConfig == null) {
      return this.hideable;
    }
    return this.hiddenUnless((name) => Object.prototype.hasOwnProperty.call(mcpConfig, name));
  }

  /** Hideable servers the principal's config hides; see the class notes for caching. */
  public async forPrincipal(principal: t.MCPPrincipal): Promise<ReadonlySet<string>> {
    if (this.hideable.size === 0 || !this.readKept) {
      return NO_SERVER_NAMES;
    }
    const key = scopedCacheKey(`${principal.userId}::role:${principal.role ?? '__no_role__'}`);
    const decision = this.decisions.get(key);
    if (decision && Date.now() < decision.expiresAt) {
      return decision.hidden;
    }
    const pending = this.pending.get(key);
    if (pending) {
      return pending;
    }
    const resolution = this.resolve(key, principal, this.readKept);
    this.pending.set(key, resolution);
    try {
      return await resolution;
    } finally {
      if (this.pending.get(key) === resolution) {
        this.pending.delete(key);
      }
    }
  }

  /** Drops every decision; resolutions still in flight finish for their callers only. */
  public clear(): void {
    this.epoch += 1;
    this.decisions.clear();
    this.pending.clear();
  }

  private async resolve(
    key: string,
    principal: t.MCPPrincipal,
    readKept: KeptServerNamesReader,
  ): Promise<ReadonlySet<string>> {
    const epoch = this.epoch;
    const hidden = await this.read(principal, readKept);
    if (epoch === this.epoch && this.ttl > 0) {
      this.sweep();
      this.decisions.set(key, { hidden, expiresAt: Date.now() + this.ttl });
    }
    return hidden;
  }

  private async read(
    principal: t.MCPPrincipal,
    readKept: KeptServerNamesReader,
  ): Promise<ReadonlySet<string>> {
    let kept: string[] | undefined;
    try {
      kept = await readKept(principal);
    } catch (error) {
      logger.warn(
        '[MCPServersRegistry] Could not resolve the principal MCP config; withholding hideable librechat.yaml servers',
        getSafeErrorMetadata(error),
      );
      return this.hideable;
    }
    if (kept == null) {
      return NO_SERVER_NAMES;
    }
    const keptNames = new Set(kept);
    return this.hiddenUnless((name) => keptNames.has(name));
  }

  private hiddenUnless(isKept: (name: string) => boolean): ReadonlySet<string> {
    const hidden = new Set<string>();
    for (const name of this.hideable) {
      if (!isKept(name)) {
        hidden.add(name);
      }
    }
    return hidden.size > 0 ? hidden : NO_SERVER_NAMES;
  }

  /** At most one pass per window, so decisions for one-time users cannot accumulate. */
  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweepAt < this.ttl) {
      return;
    }
    this.lastSweepAt = now;
    for (const [key, decision] of this.decisions) {
      if (now >= decision.expiresAt) {
        this.decisions.delete(key);
      }
    }
  }
}

/** The parts of a stored config profile the startup report reads. */
export interface StoredMCPProfile {
  principalType: string;
  principalId: string | { toString(): string };
  tenantId?: string;
  tombstones?: string[];
}

/** A stored tombstone that hides librechat.yaml MCP servers or removes a whole field of one. */
export interface StoredMCPTombstone {
  principal: string;
  fieldPath: string;
}

/** Names a profile's principal, and its tenant when it has one: the report spans every tenant. */
function describeProfile({ principalType, principalId, tenantId }: StoredMCPProfile): string {
  const principal = `${principalType}:${String(principalId)}`;
  return tenantId ? `tenant:${tenantId} ${principal}` : principal;
}

/**
 * Stored tombstones the MCP registry now honours for librechat.yaml servers: the whole
 * `mcpServers` section (every hideable server), `mcpServers.<name>` (one server) and
 * `mcpServers.<name>.<field>` (one field). Record-key tombstones one level deeper are left out,
 * because the registry already honoured them. Tombstones under process-backed servers, which the
 * merge ignores, and under Agent Plugins servers, which librechat.yaml does not define, are left
 * out too.
 */
export function findStoredMCPTombstones(
  profiles: readonly StoredMCPProfile[],
  hideable: ReadonlySet<string>,
): StoredMCPTombstone[] {
  const found: StoredMCPTombstone[] = [];
  for (const profile of profiles) {
    for (const fieldPath of profile.tombstones ?? []) {
      const [section, name, field, key] = fieldPath.split('.');
      const applies =
        section === MCP_SERVERS_PATH &&
        key === undefined &&
        (name === undefined || (hideable.has(name) && field !== ''));
      if (applies) {
        found.push({ principal: describeProfile(profile), fieldPath });
      }
    }
  }
  return found;
}

/**
 * Logs, once at startup, the stored tombstones that now hide librechat.yaml MCP servers or remove
 * their fields. Profiles could store them before the registry honoured them, so an upgrade can
 * withdraw servers from whole roles or groups; this names them so an operator can review them.
 * `listProfiles` receives the `mcpServers` path and returns only the active profiles with a
 * tombstone at or below it, projected to {@link StoredMCPProfile}; it reads through the portable
 * config store, so it filters in application code, once, off the startup path. It runs in the
 * system tenant scope, because the report covers every tenant and startup has no tenant of its
 * own, which strict tenant isolation would reject.
 * Never rejects: a failed read is logged and startup continues.
 */
export async function reportStoredMCPTombstones(
  listProfiles: (fieldPath: string) => Promise<readonly StoredMCPProfile[]>,
  yamlServers?: Readonly<Record<string, t.ParsedServerConfig>> | null,
): Promise<void> {
  const hideable = getHideableServerNames(yamlServers);
  if (hideable.size === 0) {
    return;
  }
  let found: StoredMCPTombstone[];
  try {
    found = findStoredMCPTombstones(
      await runAsSystem(() => listProfiles(MCP_SERVERS_PATH)),
      hideable,
    );
  } catch (error) {
    logger.warn(
      '[MCP] Could not read config profiles to report MCP tombstones',
      getSafeErrorMetadata(error),
    );
    return;
  }
  if (found.length === 0) {
    return;
  }
  const listed = found
    .slice(0, REPORTED_TOMBSTONES)
    .map(({ principal, fieldPath }) => `${principal} ${fieldPath}`)
    .join('; ');
  const more =
    found.length > REPORTED_TOMBSTONES ? ` (and ${found.length - REPORTED_TOMBSTONES} more)` : '';
  logger.warn(
    `[MCP] ${found.length} stored config ${found.length === 1 ? 'tombstone hides' : 'tombstones hide'} librechat.yaml MCP servers or remove their fields for the principals they apply to: ${listed}${more}. Delete a tombstone through the admin config API to restore what it removes.`,
  );
}
