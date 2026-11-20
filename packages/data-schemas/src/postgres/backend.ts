import type { ToolFavoriteMethods } from '~/types/favorite';
import type { PostgresOptions } from './pool';
import { createPostgresFavoriteMethods } from './favorite';
import { assertPostgresReady } from './migrations';
import { createPostgresDatabase } from './pool';

export interface PostgresFavoriteBackend {
  methods: ToolFavoriteMethods;
  initialize(): Promise<void>;
  close(): Promise<void>;
}

export function createPostgresFavoriteBackend(options: PostgresOptions): PostgresFavoriteBackend {
  const db = createPostgresDatabase(options);
  return {
    methods: createPostgresFavoriteMethods(db),
    initialize: () => assertPostgresReady(db),
    close: () => db.close(),
  };
}
