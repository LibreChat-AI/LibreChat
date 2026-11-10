import { persistenceConfigSchema } from 'librechat-data-provider';
import {
  createPostgresDatabase,
  createPostgresFavoriteMethods,
  assertPostgresReady,
} from '@librechat/data-schemas';
import type { ToolFavoriteMethods, PostgresDatabase } from '@librechat/data-schemas';

export interface FavoriteRuntime {
  methods: ToolFavoriteMethods;
  initialize(config: unknown): Promise<void>;
  close(): Promise<void>;
}

/** Captured route references never change, and no request chooses its storage engine. */
export function createFavoriteRuntime(
  mongo: ToolFavoriteMethods,
  env: NodeJS.ProcessEnv,
): FavoriteRuntime {
  let selected: ToolFavoriteMethods | undefined;
  let db: PostgresDatabase | undefined;
  let initialization: Promise<void> | undefined;
  let closed = false;
  let shutdown: Promise<void> | undefined;
  function methods(): ToolFavoriteMethods {
    if (!selected || closed) {
      throw new Error('Favorites persistence is not initialized');
    }
    return selected;
  }
  return {
    methods: {
      getToolFavorites: async (userId) => methods().getToolFavorites(userId),
      addToolFavorite: async (params) => methods().addToolFavorite(params),
      removeToolFavorite: async (params) => methods().removeToolFavorite(params),
      deleteUserToolFavorites: async (userId) => methods().deleteUserToolFavorites(userId),
    },
    initialize(config) {
      if (closed) {
        return Promise.reject(new Error('Favorites persistence is closed'));
      }
      initialization ??= (async () => {
        if (closed) {
          throw new Error('Favorites persistence is closed');
        }
        const parsed = persistenceConfigSchema.safeParse(config);
        if (!parsed.success) {
          throw new Error('Invalid persistence configuration');
        }
        if (parsed.data.favorites === 'mongo') {
          selected = mongo;
          return;
        }
        const options = parsed.data.postgres;
        const connectionString = options && env[options.connectionStringEnv];
        if (!options || !connectionString) {
          throw new Error('PostgreSQL connection environment variable is missing');
        }
        db = createPostgresDatabase({ ...options, connectionString });
        try {
          await assertPostgresReady(db);
          if (closed) {
            throw new Error('Favorites persistence is closed');
          }
          selected = createPostgresFavoriteMethods(db);
        } catch {
          await db.close().catch(() => undefined);
          throw new Error('PostgreSQL favorites initialization failed');
        }
      })();
      return initialization;
    },
    close() {
      closed = true;
      shutdown ??= (async () => {
        await initialization?.catch(() => undefined);
        await db?.close();
      })();
      return shutdown;
    },
  };
}

/** Storage selection is deployment-only, never a tenant config override. */
export function getPersistenceConfig(config: unknown): unknown {
  if (config == null) {
    return undefined;
  }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid deployment configuration');
  }
  return 'persistence' in config ? config.persistence : undefined;
}
