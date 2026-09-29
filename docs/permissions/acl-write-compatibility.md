# ACL write compatibility

Role-only sharing preserves independently administered permission bits while updating role bits,
roleId, grantedBy and grantedAt in one conditional document update. The persistence layer also uses
that same mutation operation for add/remove bit requests. Removing a bit wins if it appears in both
masks. Neither path uses MongoDB bit-update operators.

## Deployment configuration

```yaml
permissions:
  maxWriteAttempts: 3
```

The sharing endpoint passes this setting to the persistence operation. The value must be an integer
from 1 through 100, including the initial attempt. Internal callers can override the same validated
budget per call. A session alone does not imply a transaction: comparison reads use primary unless
an active transaction owns the read preference.

## Concurrency and failures

Each observed ACL document is its own unit of completion. A conditional write checks the snapshot's
bits and role/audit metadata. Only a definite no-match retries that document. Already completed
documents are never replayed because a different document conflicts. Duplicate ACL documents are
processed individually and keep their own independent bits; this change does not deduplicate them
or add a uniqueness constraint.

If an observed ACL is deleted during mutation, the request fails rather than recreating that grant.
A missing principal at the initial read can still be granted access. If another writer inserts it
first, the operation reads and updates that entry instead of treating a no-op upsert as success.
Concurrent inserts can still create duplicate identities without a unique index; each completed
write is atomic, but the entire resource is not serialized.

Standalone deployments do not get batch atomicity. If a later document fails, earlier writes can
remain committed. Errors include completedEntries (acknowledged writes before failure) and whether
an active transaction was present. This count does not settle ambiguous network failures or prove a
transaction committed. MongoDB error labels are retained for the transaction owner's handling.
No automatic retry is performed for ambiguous write errors or transaction write-conflict errors.

## Upgrading

No data migration, collection reset, or permission reset is required. Missing legacy permBits
fields are interpreted as zero. Nonnegative 31-bit integers preserve bits outside the known enum.
Null, fractional, negative, or larger values fail explicitly instead of being truncated. Investigate
those rows against authoritative role and audit records; do not blanket-reset grants.

Old binaries do not gain these safeguards during a rolling upgrade. Drain old writers before relying
on the new behavior. Storage remains unchanged, but rolling back also restores the old implementation's
limitations. A separate Insights field and any associated migration are not part of these PRs.

MongoDB-backed tests cover the update contract. Live DocumentDB and Cosmos DB compatibility has not
been certified by this change; the original reported engine/version restriction remains unverified.
