import type { Connection } from 'mongoose';

export type MongoEngine = 'replicaSet' | 'standalone' | 'documentdb';
export type MongoEngineOverride = MongoEngine | 'auto';

export interface AuthorizationReadOptions {
  readPreference: 'primary';
  readConcern?: { level: 'linearizable' | 'local' | 'majority' };
  maxTimeMS: number;
}

export interface AuthorizationWriteOptions {
  writeConcern: { w: 'majority' | 1; wtimeoutMS?: number };
}

export interface AuthorizationQueryOptions {
  read: AuthorizationReadOptions;
  write: AuthorizationWriteOptions;
}

const DOCUMENTDB_HOST_SUFFIXES = ['.docdb.amazonaws.com', '.docdb-elastic.amazonaws.com'];

function hasDocumentDBHost(connection: Connection): boolean {
  const hosts = connection.getClient().options.hosts ?? [];
  return hosts.some((host) => {
    const name = host.host?.toLowerCase();
    return name != null && DOCUMENTDB_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix));
  });
}

async function detectEngineFromHello(connection: Connection): Promise<MongoEngine> {
  const admin = connection.db?.admin();
  if (!admin) {
    throw new Error('detectMongoEngine: connection has no database handle');
  }
  let reply: { setName?: string };
  try {
    reply = (await admin.command({ hello: 1 })) as { setName?: string };
  } catch {
    reply = (await admin.command({ isMaster: 1 })) as { setName?: string };
  }
  return reply.setName ? 'replicaSet' : 'standalone';
}

/** DocumentDB's `hello` reply looks like a real replica set's, so a host-name check settles
 *  it before asking. */
export async function detectMongoEngine(
  connection: Connection,
  override: MongoEngineOverride = 'auto',
): Promise<MongoEngine> {
  if (override !== 'auto') {
    return override;
  }
  if (hasDocumentDBHost(connection)) {
    return 'documentdb';
  }
  return detectEngineFromHello(connection);
}

export function resolveAuthorizationQueryOptions(
  engine: MongoEngine,
  params: { maxTimeMS: number },
): AuthorizationQueryOptions {
  const { maxTimeMS } = params;
  switch (engine) {
    case 'replicaSet':
      return {
        read: { readPreference: 'primary', readConcern: { level: 'linearizable' }, maxTimeMS },
        write: { writeConcern: { w: 'majority', wtimeoutMS: maxTimeMS } },
      };
    case 'standalone':
      return {
        read: { readPreference: 'primary', readConcern: { level: 'local' }, maxTimeMS },
        write: { writeConcern: { w: 1 } },
      };
    case 'documentdb':
      return {
        read: { readPreference: 'primary', maxTimeMS },
        write: { writeConcern: { w: 'majority', wtimeoutMS: maxTimeMS } },
      };
  }
}
