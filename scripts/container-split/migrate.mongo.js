/* eslint-disable no-undef */
/**
 * Relocate auth-flow token documents from `tokens` into `authtokens`.
 *
 * Run with mongosh against the LibreChat database:
 *
 *   mongosh "$MONGO_URI" --file scripts/container-split/migrate.mongo.js
 *
 * Dry run — reports what it would copy and writes nothing:
 *
 *   mongosh "$MONGO_URI" --eval 'var DRY_RUN = true' --file scripts/container-split/migrate.mongo.js
 *
 * This script is optional. The relocation is safe without it, because
 * everything it moves is short-lived and re-issuable: skipping it costs only
 * that pending password resets, pending email verifications, and outstanding
 * invites stop resolving and have to be requested again. Run it when you would
 * rather not impose that on users mid-upgrade.
 *
 * Properties worth knowing before running it:
 *
 *   - Idempotent. Documents are matched by `_id` and written only when absent
 *     (`$setOnInsert`), so a re-run or a resumed partial run converges rather
 *     than duplicating, and it never overwrites a document the application has
 *     since written or updated in `authtokens`.
 *   - Non-destructive. Source documents in `tokens` are left in place. They
 *     carry a TTL on `expiresAt` and expire on their own. Deleting them early
 *     is optional; the one reason to consider it is that each retains a
 *     plaintext `email` field until it expires.
 *   - Safe before or after the upgraded containers start. Running it first,
 *     while `authtokens` is still empty, makes the outcome easiest to verify.
 */

const SOURCE = 'tokens';
const TARGET = 'authtokens';
const BATCH_SIZE = 500;

/**
 * Token types that stay in `tokens`: third-party OAuth and MCP material,
 * reversibly encrypted under CREDS_KEY and reachable only by the API container.
 */
const OAUTH_TYPES = ['mcp_oauth', 'mcp_oauth_refresh', 'mcp_oauth_client', 'oauth_refresh'];

/**
 * The selection is an exclusion, deliberately.
 *
 * Listing the auth-flow types to move would silently miss two classes: invite
 * documents carry no `type` field at all, and legacy-shape documents carry
 * `type: null`. `$nin` matches both, since a missing field and an explicit null
 * each satisfy "not in this list". The complement of the OAuth types is
 * therefore the correct filter, and an inclusion filter is not.
 */
const FILTER = { type: { $nin: OAUTH_TYPES } };

const dryRun = typeof DRY_RUN !== 'undefined' && DRY_RUN === true;

const source = db.getCollection(SOURCE);
const target = db.getCollection(TARGET);

print('');
print('Auth token relocation: ' + SOURCE + ' -> ' + TARGET);
print('  database: ' + db.getName());
print('  mode:     ' + (dryRun ? 'DRY RUN (no writes)' : 'apply'));
print('');

const total = source.countDocuments(FILTER);
const staying = source.countDocuments({ type: { $in: OAUTH_TYPES } });

print('Eligible to move:      ' + total);
print('Staying in ' + SOURCE + ':      ' + staying);

if (total === 0) {
  print('');
  print('Nothing to move.');
} else {
  const passwordReset = source.countDocuments({ type: 'password_reset' });
  const emailVerification = source.countDocuments({ type: 'email_verification' });
  /** Invites write no `type` field at all. */
  const invites = source.countDocuments({ type: { $exists: false } });
  /** BSON type 10 is an explicit null, which `{ type: null }` alone cannot isolate. */
  const legacyNull = source.countDocuments({ type: { $type: 10 } });
  const other = total - passwordReset - emailVerification - invites - legacyNull;

  print('');
  print('Breakdown:');
  print('  password_reset:           ' + passwordReset);
  print('  email_verification:       ' + emailVerification);
  print('  invites (no type field):  ' + invites);
  print('  legacy shape (type null): ' + legacyNull);
  if (other !== 0) {
    print('  other / unrecognized:     ' + other);
  }

  if (dryRun) {
    print('');
    print('Dry run complete. No documents were written.');
  } else {
    let ops = [];
    let scanned = 0;
    let inserted = 0;
    let present = 0;

    const flush = function () {
      if (ops.length === 0) {
        return;
      }
      const result = target.bulkWrite(ops, { ordered: false });
      const upserted = result.upsertedCount || 0;
      inserted += upserted;
      present += ops.length - upserted;
      ops = [];
      print(
        '  ' +
          scanned +
          ' / ' +
          total +
          ' processed (inserted ' +
          inserted +
          ', already present ' +
          present +
          ')',
      );
    };

    print('');
    print('Copying...');

    const cursor = source.find(FILTER).batchSize(BATCH_SIZE);
    while (cursor.hasNext()) {
      const doc = cursor.next();
      const id = doc._id;
      /** The filter pins `_id`, and including it in the update payload is rejected. */
      delete doc._id;
      ops.push({
        updateOne: {
          filter: { _id: id },
          update: { $setOnInsert: doc },
          upsert: true,
        },
      });
      scanned++;
      if (ops.length >= BATCH_SIZE) {
        flush();
      }
    }
    flush();

    print('');
    print('Done. Inserted ' + inserted + ', left untouched ' + present + '.');
    print('Source documents in ' + SOURCE + ' were not deleted; they expire by TTL.');
    print('');
    print('Verify with:');
    print('  db.' + TARGET + '.countDocuments({})');
    print('  db.' + TARGET + '.getIndexes()   // expect a TTL index on expiresAt');
  }
}

print('');
