import mongoose from 'mongoose';
import type { IndexDefinition, IndexOptions, Schema } from 'mongoose';
import { SUPERSEDED_INDEXES } from '../migrations/tenantIndexes';
import { createModels } from '../models';

/** An index that holds an entry for every document and answers simple-collation reads. */
const holdsEveryDocument = (options: IndexOptions) =>
  !options.sparse &&
  !options.hidden &&
  options.partialFilterExpression == null &&
  options.collation == null;

/** An index that only costs writes once another index serves its reads. */
const isPlain = (options: IndexOptions) =>
  !options.unique && options.expireAfterSeconds == null && holdsEveryDocument(options);

/** The B-tree direction of a key; text, 2dsphere, hashed and wildcard keys serve other reads. */
const direction = (value: unknown): 1 | -1 | undefined => {
  const dir = Number(value);
  return dir === 1 || dir === -1 ? dir : undefined;
};

/** The name MongoDB gives an index declared without one. */
const indexName = (keys: IndexDefinition) =>
  Object.entries(keys)
    .map(([field, dir]) => `${field}_${dir}`)
    .join('_');

/** True when `field`, or any parent of it, is an array, which makes an index on it multikey. */
const isArrayPath = (schema: Schema, field: string) =>
  field
    .split('.')
    .some((_, i, parts) => schema.path(parts.slice(0, i + 1).join('.'))?.instance === 'Array');

/**
 * True when `long` serves every read `short` does: `short`'s keys lead `long` in order, all in
 * the same or all in the opposite direction (a scan runs either way), every key of `long` is a
 * B-tree key, and no trailing key is multikey, which would repeat each document once per array
 * element in a scan over the prefix.
 */
function covers(schema: Schema, long: IndexDefinition, short: IndexDefinition): boolean {
  const shortKeys = Object.entries(short);
  const longKeys = Object.entries(long);
  const first = direction(shortKeys[0]?.[1]);
  const lead = direction(longKeys[0]?.[1]);
  if (first === undefined || lead === undefined || shortKeys.length > longKeys.length) {
    return false;
  }
  const sign = first * lead;
  return (
    longKeys.every(([, dir]) => direction(dir) !== undefined) &&
    shortKeys.every(([field, dir], i) => {
      const expected = direction(dir);
      return (
        expected !== undefined &&
        longKeys[i][0] === field &&
        direction(longKeys[i][1]) === expected * sign
      );
    }) &&
    !longKeys.slice(shortKeys.length).some(([field]) => isArrayPath(schema, field))
  );
}

/** Every schema's declared indexes with their declaration order, keyed by collection. */
const declaredIndexes = () =>
  Object.values(createModels(mongoose)).map(({ schema, collection }) => ({
    schema,
    collection: collection.collectionName,
    legacy: SUPERSEDED_INDEXES[collection.collectionName] ?? [],
    entries: schema.indexes().map(([keys, options], at) => ({ keys, options, at })),
  }));

/**
 * A plain index whose keys lead another index that holds every document costs a write on each
 * insert and update for reads the wider index already serves; the wider keys make a scan over
 * the prefix alone touch more pages, which is the trade this test accepts. A field-level index
 * that shares its name with a legacy unique index stays: colliding with that index on startup
 * is what surfaces the tenant-index migration hint.
 */
describe('schema indexes', () => {
  it('declares no plain index that another index already serves', () => {
    const redundant = declaredIndexes().flatMap(({ schema, collection, legacy, entries }) =>
      entries
        .filter(({ keys, options }) => isPlain(options) && !legacy.includes(indexName(keys)))
        .filter(({ keys, at }) =>
          entries.some(
            (other) =>
              other.at !== at &&
              holdsEveryDocument(other.options) &&
              covers(schema, other.keys, keys) &&
              /** Of two identical declarations, only the later one is redundant. */
              (Object.keys(other.keys).length > Object.keys(keys).length || other.at < at),
          ),
        )
        .map(({ keys }) => `${collection}: ${JSON.stringify(keys)}`),
    );
    expect(redundant).toEqual([]);
  });

  it('keeps the field-level indexes whose name a legacy unique index shares', () => {
    const tripwires = declaredIndexes().flatMap(({ collection, legacy, entries }) =>
      entries
        .filter(({ keys, options }) => isPlain(options) && legacy.includes(indexName(keys)))
        .map(({ keys }) => `${collection}.${indexName(keys)}`),
    );
    expect(tripwires.sort()).toEqual([
      'accessroles.accessRoleId_1',
      'agentcategories.value_1',
      'conversations.conversationId_1',
      'mcpservers.serverName_1',
      'messages.messageId_1',
      'presets.presetId_1',
      'roles.name_1',
      'users.email_1',
    ]);
  });
});
