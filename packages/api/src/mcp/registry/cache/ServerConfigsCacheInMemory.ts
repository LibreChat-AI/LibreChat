import { ParsedServerConfig, AddServerResult } from '~/mcp/types';

/**
 * In-memory implementation of MCP server configurations cache for single-instance deployments.
 * Uses a native JavaScript Map for fast, local storage without Redis dependencies.
 * Suitable for development environments or single-server production deployments.
 * Does not require leader checks or distributed coordination since data is instance-local.
 * Data is lost on server restart and not shared across multiple server instances.
 */
export class ServerConfigsCacheInMemory {
  private readonly cache: Map<string, ParsedServerConfig> = new Map();

  public async add(serverName: string, config: ParsedServerConfig): Promise<AddServerResult> {
    if (this.cache.has(serverName))
      throw new Error(
        `Server "${serverName}" already exists in cache. Use update() to modify existing configs.`,
      );
    const storedConfig = { ...config, updatedAt: Date.now() };
    this.cache.set(serverName, storedConfig);
    return { serverName, config: storedConfig };
  }

  public async update(serverName: string, config: ParsedServerConfig): Promise<void> {
    if (!this.cache.has(serverName))
      throw new Error(
        `Server "${serverName}" does not exist in cache. Use add() to create new configs.`,
      );
    this.cache.set(serverName, { ...config, updatedAt: Date.now() });
  }

  public async upsert(serverName: string, config: ParsedServerConfig): Promise<void> {
    this.cache.set(serverName, { ...config, updatedAt: Date.now() });
  }

  /** Merges derived fields into an existing entry without bumping `updatedAt` —
   * see the interface doc: a bump would mark live connections stale. */
  public async patch(
    serverName: string,
    fields: Partial<ParsedServerConfig>,
    expectedUpdatedAt?: number,
  ): Promise<boolean> {
    const existing = this.cache.get(serverName);
    if (!existing) {
      return false;
    }
    if (expectedUpdatedAt != null && existing.updatedAt !== expectedUpdatedAt) {
      return false;
    }
    if (fields.resolvedInstructions != null && existing.resolvedInstructions != null) {
      return false;
    }
    /** Spreading a Partial over the transport-discriminated union widens it past the
     * discriminant; the merge only touches shared inspector-derived fields. */
    this.cache.set(serverName, { ...existing, ...fields } as ParsedServerConfig);
    return true;
  }

  /** Replaces a failed-inspection stub only while it is still that stub — see the interface doc. */
  public async replaceStub(
    serverName: string,
    config: ParsedServerConfig,
    stubUpdatedAt: number | undefined,
  ): Promise<ParsedServerConfig | undefined> {
    const existing = this.cache.get(serverName);
    if (existing?.inspectionFailed !== true || existing.updatedAt !== stubUpdatedAt) {
      return undefined;
    }
    const storedConfig = { ...config, updatedAt: Date.now() };
    this.cache.set(serverName, storedConfig);
    return storedConfig;
  }

  public async remove(serverName: string): Promise<void> {
    if (!this.cache.delete(serverName)) {
      throw new Error(`Failed to remove server "${serverName}" in cache.`);
    }
  }

  public async get(serverName: string): Promise<ParsedServerConfig | undefined> {
    return this.cache.get(serverName);
  }

  public async getAll(): Promise<Record<string, ParsedServerConfig>> {
    return Object.fromEntries(this.cache);
  }

  public async reset(): Promise<void> {
    this.cache.clear();
  }
}
