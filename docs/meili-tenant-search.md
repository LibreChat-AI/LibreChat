# Meili tenant-scoped search — ops note

## What changed

Conversation and message Meili documents now index `tenantId` (schema version `2`).
Sidebar, shared-link, and messages search build filters through `buildMeiliUserTenantFilter`,
which uses `resolveTenantScope` and **fails closed** under `TENANT_ISOLATION_STRICT=true`.

## Legacy tenantless documents

Active-tenant Meili queries require an exact `tenantId` match. Documents indexed before
tenancy (no `tenantId` in the Meili projection) are **excluded** from scoped search until
they are:

1. Assigned to a tenant in MongoDB, and
2. Reindexed after the v2 projection (startup `indexSync` / `syncWithMeili`, or a forced
   settings-driven resync).

This matches Mongo listing behavior for tenant-scoped sidebars.

## Rolling deploys

Projection reconciliation is monotonic: binaries never downgrade a newer `_meiliIndexSchemaVersion`,
and reset-flag paths still respect the version ceiling. Prefer draining older replicas before
relying exclusively on tenant-filtered search after upgrade.

## Config

```yaml
search:
  meiliSettingsTimeoutMs: 600000  # default; wait for filterable-attribute tasks
```
