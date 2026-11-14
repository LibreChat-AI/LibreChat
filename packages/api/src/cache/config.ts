import {
  DEFAULT_CONFIG_CACHE_MAX_BYTES,
  DEFAULT_CONFIG_CACHE_MAX_ENTRIES,
} from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';

interface Entry {
  value: string;
  bytes: number;
  expires?: number;
}

/** Size-bounded serialized APP_CONFIG entries with proactive expiry. */
export class ConfigMemoryStore {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private maxBytes = DEFAULT_CONFIG_CACHE_MAX_BYTES;
  private maxEntries = DEFAULT_CONFIG_CACHE_MAX_ENTRIES;
  private timer?: ReturnType<typeof setTimeout>;
  private sweepAt = Infinity;

  configure(limits?: TCustomConfig['configCache']): void {
    this.maxBytes = limits?.maxBytes ?? DEFAULT_CONFIG_CACHE_MAX_BYTES;
    this.maxEntries = limits?.maxEntries ?? DEFAULT_CONFIG_CACHE_MAX_ENTRIES;
    this.evict();
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires !== undefined && entry.expires <= Date.now()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string, ttl?: number): boolean {
    this.delete(key);
    if (ttl !== undefined && ttl < 0) return true;
    // Account conservatively for UTF-16 strings; the entry count bounds Map/object overhead.
    const bytes = 2 * (key.length + value.length);
    if (bytes > this.maxBytes) return true;
    const expires = ttl !== undefined && ttl > 0 ? Date.now() + ttl : undefined;
    this.entries.set(key, { value, bytes, expires });
    this.bytes += bytes;
    this.evict();
    if (expires !== undefined) this.schedule(expires);
    return true;
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
    if (this.entries.size === 0) this.cancel();
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
    this.cancel();
  }

  private evict(): void {
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  private cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.sweepAt = Infinity;
  }

  private schedule(expires: number): void {
    if (expires >= this.sweepAt) return;
    this.cancel();
    this.sweepAt = expires;
    this.timer = setTimeout(
      () => this.sweep(),
      Math.min(2_147_483_647, Math.max(1, expires - Date.now())),
    );
    this.timer.unref();
  }

  private sweep(): void {
    this.cancel();
    const now = Date.now();
    let next = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.expires === undefined) continue;
      if (entry.expires <= now) this.delete(key);
      else next = Math.min(next, entry.expires);
    }
    if (next !== Infinity) this.schedule(next);
  }
}
