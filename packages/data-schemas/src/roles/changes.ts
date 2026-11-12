/** Opaque database resume token; consumers never inspect its contents. */
export type RoleChangeToken = unknown;

export interface RoleChangeCursor {
  tryNext(): Promise<{ token: RoleChangeToken } | null>;
  close(): Promise<void>;
}

export type RoleChangeSource = (options: {
  resumeAfter?: RoleChangeToken;
  maxAwaitTimeMs: number;
}) => RoleChangeCursor;

/** Watch only the roles collection on the authoritative connection, without reading role data. */
export function createRoleChangeSource(mongoose: typeof import('mongoose')): RoleChangeSource {
  return ({ resumeAfter, maxAwaitTimeMs }) => {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Role change source requires a connected database');
    }
    // This invalidates a deployment-wide namespace, including deletions and renames.
    // It intentionally carries neither tenant context nor full role documents.
    // eslint-disable-next-line no-restricted-syntax -- System-wide coherence consumer, never a tenant API: projection retains only resume token/type. A tenant match would miss deletes; every tenant's cache must be invalidated.
    const stream = db.collection('roles').watch([{ $project: { _id: 1, operationType: 1 } }], {
      readPreference: 'primary',
      maxAwaitTimeMS: maxAwaitTimeMs,
      ...(resumeAfter ? { resumeAfter } : {}),
    });
    return {
      tryNext: async () => {
        const event = await stream.tryNext();
        return event ? { token: event._id } : null;
      },
      close: () => stream.close(),
    };
  };
}
