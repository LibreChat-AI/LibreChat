import type { ClientSession, Model, Types } from 'mongoose';
import { getTransactionSupport } from '~/utils/transactions';
import { runAfterTransaction } from '~/utils/postCommit';

export interface PermissionPrincipalRecord {
  id: string;
  source?: 'local' | 'entra';
  idOnTheSource?: string;
  email?: string;
  description?: string;
}

export interface PermissionPrincipalData {
  name?: string;
  email?: string;
  source?: 'local' | 'entra';
  idOnTheSource?: string;
  description?: string;
  memberIds?: string[];
  provider?: 'openid';
  emailVerified?: false;
}

export interface PermissionPrincipalChange {
  kind: 'user' | 'group';
  id?: string;
  data: PermissionPrincipalData;
}

export interface PermissionPrincipalQuery {
  id?: string;
  email?: string;
  idOnTheSource?: string;
  source?: 'local' | 'entra';
}

export interface PermissionPrincipalStorage {
  findPermissionUser: (
    query: PermissionPrincipalQuery,
  ) => Promise<PermissionPrincipalRecord | null>;
  findPermissionGroup: (
    query: PermissionPrincipalQuery,
  ) => Promise<PermissionPrincipalRecord | null>;
  persistPermissionPrincipals: (changes: PermissionPrincipalChange[]) => Promise<string[]>;
}

interface StoredPrincipal extends PermissionPrincipalData {
  _id: Types.ObjectId;
  updatedAt?: Date;
  createdAt?: Date;
}

/** Storage-only batch boundary. Never performs directory I/O inside a transaction. */
export function createPermissionPrincipalMethods(
  mongoose: typeof import('mongoose'),
  invalidate: (memberIds: string[]) => Promise<void>,
): PermissionPrincipalStorage {
  let transactionSupport: boolean | null = null;
  const queryFor = ({ id, ...query }: PermissionPrincipalQuery) => ({
    ...query,
    ...(id ? { _id: id } : {}),
  });
  const record = (value: StoredPrincipal | null): PermissionPrincipalRecord | null =>
    value
      ? {
          id: value._id.toString(),
          email: value.email,
          idOnTheSource: value.idOnTheSource,
          ...('source' in value && { source: value.source, description: value.description }),
        }
      : null;

  async function findPermissionUser(query: PermissionPrincipalQuery) {
    return record(
      await (mongoose.models.User as Model<StoredPrincipal>)
        .findOne(queryFor(query))
        .lean<StoredPrincipal>(),
    );
  }

  async function findPermissionGroup(query: PermissionPrincipalQuery) {
    return record(
      await (mongoose.models.Group as Model<StoredPrincipal>)
        .findOne(queryFor(query))
        .lean<StoredPrincipal>(),
    );
  }

  async function persistPermissionPrincipals(
    changes: PermissionPrincipalChange[],
  ): Promise<string[]> {
    if (changes.length === 0) return [];
    transactionSupport = await getTransactionSupport(mongoose, transactionSupport);
    const session: ClientSession | undefined = transactionSupport
      ? await mongoose.startSession()
      : undefined;
    const undo: Array<() => Promise<void>> = [];
    const ids: string[] = [];
    const changedMembers = new Set<string>();
    try {
      session?.startTransaction();
      for (const change of changes) {
        const model = mongoose.models[
          change.kind === 'user' ? 'User' : 'Group'
        ] as Model<StoredPrincipal>;
        for (const id of change.data.memberIds ?? []) changedMembers.add(id);
        if (change.id) {
          const previous = await model
            .findById(change.id)
            .session(session ?? null)
            .lean<StoredPrincipal>();
          if (!previous) throw new Error('Principal changed during preparation');
          for (const id of previous.memberIds ?? []) changedMembers.add(id);
          const fields = Object.keys(change.data) as Array<keyof PermissionPrincipalData>;
          const writtenAt = new Date();
          const guard = {
            _id: change.id,
            updatedAt: previous.updatedAt ?? { $exists: false },
            ...Object.fromEntries(
              fields.map((key) => [
                key,
                previous[key] === undefined ? { $exists: false } : previous[key],
              ]),
            ),
          };
          undo.push(async () => {
            const restoreFields = [...fields, 'updatedAt'] as const;
            const set = Object.fromEntries(
              restoreFields
                .filter((key) => previous[key] !== undefined)
                .map((key) => [key, previous[key]]),
            );
            const unset = Object.fromEntries(
              restoreFields.filter((key) => previous[key] === undefined).map((key) => [key, 1]),
            );
            // A concurrent write owns its new state, even if its membership happens to match.
            const result = await model.updateOne(
              { _id: change.id, ...change.data, updatedAt: writtenAt },
              {
                ...(Object.keys(set).length && { $set: set }),
                ...(Object.keys(unset).length && { $unset: unset }),
              },
              { timestamps: false },
            );
            if (result.matchedCount === 0 && !(await model.exists(guard)))
              throw new Error('Principal rollback conflicted');
          });
          const result = await model.updateOne(
            guard,
            { $set: { ...change.data, updatedAt: writtenAt } },
            { session, timestamps: false },
          );
          if (result.matchedCount !== 1) throw new Error('Principal changed during preparation');
          ids.push(change.id);
        } else {
          const id = new mongoose.Types.ObjectId();
          const createdAt = new Date();
          // Register before the write so an acknowledged-late insert is compensated too.
          undo.push(async () => {
            await model.deleteOne({ _id: id, ...change.data, createdAt, updatedAt: createdAt });
          });
          await model.create([{ _id: id, ...change.data, createdAt, updatedAt: createdAt }], {
            session,
            timestamps: false,
          });
          ids.push(id.toString());
        }
      }
      if (changedMembers.size)
        await runAfterTransaction(session, () => invalidate([...changedMembers]));
      await session?.commitTransaction();
      return ids;
    } catch (error) {
      if (session?.inTransaction()) {
        await session.abortTransaction();
      } else if (!session) {
        const failures: unknown[] = [];
        for (const rollback of undo.reverse()) {
          try {
            await rollback();
          } catch (failure) {
            failures.push(failure);
          }
        }
        if (changedMembers.size) await invalidate([...changedMembers]);
        if (failures.length) throw new Error('Principal rollback failed');
      }
      throw error;
    } finally {
      await session?.endSession();
    }
  }
  return { findPermissionUser, findPermissionGroup, persistPermissionPrincipals };
}
