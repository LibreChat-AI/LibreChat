import { createHash } from 'node:crypto';
import type { MCPToolsSnapshot } from '~/mcp/connection';

/** Entries one process keeps at most; the oldest is dropped past it. */
const MAX_ENTRIES = 10_000;

/** Who a reused check was for: the owner, and the server as its settings stood. */
export interface ReadyKey {
  tenantId?: string;
  ownerId: string;
  server: string;
  /** The server's resolved settings and the owner's own values for it. Hashed, never kept. */
  settings: unknown;
}

/**
 * The tool listing of a check that found an MCP server ready, kept for one owner and server
 * so the next delivery does not connect again. Per process: another replica keeps its own and
 * checks for itself. Nothing but a ready listing is kept, and only for its lifetime.
 */
export interface ReadyCache {
  /** How long a listing is reused, read once per check. 0 reuses nothing. */
  ttlMs: () => Promise<number>;
  get: (key: ReadyKey) => MCPToolsSnapshot | undefined;
  set: (key: ReadyKey, snapshot: MCPToolsSnapshot, ttlMs: number) => void;
  delete: (key: ReadyKey) => void;
  /**
   * Stops reusing every listing kept for this owner and server, whatever their settings. A check
   * of that server already under way keeps nothing and hands nothing on: those waiting on it,
   * and every check after this, ask the server themselves.
   */
  forget: (ownerId: string, server: string) => void;
  /**
   * A check of this server under way for the same owner, which settles with its listing if it
   * found the server ready and with nothing otherwise. Absent when none is under way.
   */
  pending: (key: ReadyKey) => Promise<MCPToolsSnapshot | undefined> | undefined;
  /**
   * Marks a check under way. Call what it returns once, with the listing if the server was
   * ready: the listing is then kept for `ttlMs` and handed to those waiting, unless the owner's
   * server was forgotten since the check began.
   */
  begin: (key: ReadyKey, ttlMs: number) => (snapshot?: MCPToolsSnapshot) => void;
}

/** Same value, same text: object keys in order, so equal settings hash alike. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && typeof item !== 'function')
      .sort(([a], [b]) => (a < b ? -1 : Number(a > b)));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function id({ tenantId, ownerId, server, settings }: ReadyKey): string {
  const digest = createHash('sha256').update(stable(settings)).digest('hex');
  return JSON.stringify([tenantId ?? null, ownerId, server, digest]);
}

export function createReadyCache(options: {
  ttlMs: () => Promise<number>;
  max?: number;
  now?: () => number;
}): ReadyCache {
  const now = options.now ?? Date.now;
  const max = options.max ?? MAX_ENTRIES;
  const entries = new Map<
    string,
    { ownerId: string; server: string; snapshot: MCPToolsSnapshot; expiresAt: number }
  >();
  /** Checks under way, one per owner and server, so a burst of deliveries connects once. */
  const flights = new Map<
    string,
    {
      ownerId: string;
      server: string;
      listing: Promise<MCPToolsSnapshot | undefined>;
      /** Forgotten while under way: what it finds was found before the owner was refused. */
      stale: boolean;
    }
  >();
  const keep = (key: ReadyKey, snapshot: MCPToolsSnapshot, ttlMs: number): void => {
    if (ttlMs <= 0) return;
    const name = id(key);
    entries.delete(name);
    entries.set(name, {
      ownerId: key.ownerId,
      server: key.server,
      snapshot,
      expiresAt: now() + ttlMs,
    });
    while (entries.size > max) entries.delete(entries.keys().next().value as string);
  };
  return {
    ttlMs: options.ttlMs,
    get(key) {
      const name = id(key);
      const entry = entries.get(name);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(name);
        return undefined;
      }
      return entry.snapshot;
    },
    set: keep,
    delete(key) {
      entries.delete(id(key));
    },
    forget(ownerId, server) {
      for (const [name, entry] of entries)
        if (entry.ownerId === ownerId && entry.server === server) entries.delete(name);
      for (const [name, flight] of flights) {
        if (flight.ownerId !== ownerId || flight.server !== server) continue;
        flight.stale = true;
        flights.delete(name);
      }
    },
    pending(key) {
      return flights.get(id(key))?.listing;
    },
    begin(key, ttlMs) {
      const name = id(key);
      let settle!: (snapshot?: MCPToolsSnapshot) => void;
      const flight = {
        ownerId: key.ownerId,
        server: key.server,
        listing: new Promise<MCPToolsSnapshot | undefined>((resolve) => {
          settle = resolve;
        }),
        stale: false,
      };
      flights.set(name, flight);
      let done = false;
      return (snapshot) => {
        if (done) return;
        done = true;
        if (flights.get(name) === flight) flights.delete(name);
        if (!snapshot || flight.stale) return settle(undefined);
        keep(key, snapshot, ttlMs);
        settle(snapshot);
      };
    },
  };
}
