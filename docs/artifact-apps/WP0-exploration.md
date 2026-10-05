# WP0 — Repository Exploration for Artifact Apps

This document records the concrete code paths that the Artifact Apps feature
builds on. It is the reference file list for the initial implementation.

## 1. Artifact data structure

- `client/src/common/artifacts.ts` — `Artifact` interface (`id`, `identifier`,
  `type`, `content`, `title`, `language`, `messageId`, `lastUpdateTime`,
  `download`). This is the canonical shape of an artifact in the client.
- `client/src/store/artifacts.ts` — Recoil atoms holding artifact state keyed by
  a composite `artifactKey` (`${identifier}_${type}_${title}_${messageId}`).
- `client/src/components/Artifacts/Artifact.tsx` — `artifactPlugin` and the
  construction of the composite key; associates an artifact with its `messageId`.
- Artifact MIME types: `application/vnd.react`, `text/html`,
  `application/vnd.mermaid`, `text/markdown`, `application/vnd.code`.

The Artifact App snapshot normalizes these to the three renderable runtime types
required by PLAN §6.2: `react | html | mermaid`.

## 2. Artifact extraction / parsing

- `client/src/components/Chat/Messages/Content/splitMarkdown.ts` — micromark /
  mdast directive parsing of `:::artifact:::` blocks.
- `client/src/utils/artifacts.ts` — `TOOL_ARTIFACT_TYPES`, template selection
  (`getArtifactType`, Sandpack template mapping), file-type detection.

For catalog registration, a completed generation is passed from the client to
`POST /api/artifact-apps/sync` (already-extracted `content` + `type` + generated
title), together with its source metadata. The endpoint is idempotent: unchanged
content updates metadata without creating another version, while changed content
creates the next immutable version. The backend re-normalizes and snapshots the
content — it never trusts client-supplied identity/tenant fields.

## 3. Renderer / Sandpack integration

- `client/src/components/Artifacts/ArtifactPreview.tsx` — `SandpackProvider` +
  `SandpackPreview` (`@codesandbox/sandpack-react/unstyled`). Props: `files`,
  `fileKey`, `template`, `sharedProps`, `currentCode`, `startupConfig`.
- `client/src/components/Artifacts/ArtifactTabs.tsx` — code/preview tab switch.
- `client/src/components/Artifacts/Artifacts.tsx` — header actions (copy,
  download, refresh, version navigation, and sharing).
- `client/src/utils/artifacts.ts` — `getArtifactFiles` / template helpers used to
  build Sandpack `files` from an artifact.

WP5 reuses these by feeding a snapshot (`sourceSnapshot`, `artifactType`) into a
standalone wrapper (`ArtifactAppViewer`) that constructs the same Sandpack files
without any chat context.

## 4. Automatic catalog registration and sharing

- `client/src/components/ArtifactApps/ArtifactCatalogRegistrar.tsx` observes the
  artifacts produced by a completed generation and synchronizes them into the
  owner's Personal catalog automatically.
- `client/src/components/Artifacts/Artifacts.tsx` exposes the standard resource
  sharing dialog. Shared artifacts appear in the Shared and All catalog scopes.
- Opening an owned catalog entry returns to its source conversation and selects
  the latest matching artifact revision; shared entries open in the standalone
  snapshot viewer.

## 5. Artifact ↔ conversation/message relationship

- An artifact is addressed by `conversationId` + a stable source key, with
  `messageId` and the original artifact ID retained to resolve the exact source.
- These are stored on the App only as **origin metadata** (`sourceMetadata`),
  never as a runtime dependency (PLAN §4). Deleting the source conversation must
  not change the App (enforced by full snapshotting in WP3).

## 6. ACL / permissions system (reused, not reinvented)

- `packages/data-provider/src/accessPermissions.ts` — `ResourceType`,
  `PermissionBits` (VIEW=1, EDIT=2, DELETE=4, SHARE=8), `AccessRoleIds`,
  `PrincipalType`, `accessRoleToPermBits`, zod DTOs for sharing.
- `packages/data-schemas/src/schema/aclEntry.ts` + `.../methods/aclEntry.ts` —
  `grantPermission`, `revokePermission`, `hasPermission`, `findAccessibleResources`,
  `getEffectivePermissions`, `findPublicResourceIds`.
- `packages/data-schemas/src/methods/accessRole.ts` — `seedDefaultRoles`
  (viewer/editor/owner per resource type; `RoleBits`).
- `packages/data-schemas/src/common/permissions.ts` — `RoleBits`
  (VIEWER=1, EDITOR=3, MANAGER=7, OWNER=15), `MAX_PERM_BITS`.
- `packages/api/src/acl/accessControlService.ts` — `AccessControlService`
  (`grantPermission`, `checkPermission`, `findAccessibleResources`,
  `hasPublicAccess`, `getUserPrincipals`). Validates against `ResourceType`.
- `packages/data-schemas/src/admin/capabilities.ts` — `SystemCapabilities`,
  `ResourceCapabilityMap` (`Record<ResourceType, SystemCapability>` — adding a
  new ResourceType requires a capability here) and `CapabilityImplications`.
- `api/server/middleware/accessResources/canAccessResource.js` — generic ACL
  middleware with capability bypass + custom id resolver.
- `api/server/middleware/accessResources/canAccessAgentResource.js` — the
  per-resource wrapper pattern mirrored by `canAccessArtifactAppResource`.
- `api/server/services/PermissionService` — `checkPermission` used by middleware.
- `api/server/controllers/PermissionsController.js` +
  `api/server/routes/accessPermissions.js` — generic resource sharing endpoints
  (People Picker principals). Artifact Apps register `ResourceType.ARTIFACT_APP`
  and reuse these directly.

## 7. Persistence patterns (mirrored for WP1)

- Schema: `packages/data-schemas/src/schema/agent.ts` (+ `schema/index.ts`).
- Model factory: `packages/data-schemas/src/models/agent.ts` applies
  `applyTenantIsolation`; registered in `models/index.ts` `createModels`.
- Types: `packages/data-schemas/src/types/agent.ts` (+ `types/index.ts`).
- Methods: `packages/data-schemas/src/methods/agent.ts` (factory returning
  CRUD); aggregated in `methods/index.ts` `createMethods` and re-exported as
  `AllMethods`. Consumed by `/api` via `api/models/index.js`.
- Tenant isolation: `packages/data-schemas/src/models/plugins/tenantIsolation.ts`
  - `config/tenantContext.ts` (AsyncLocalStorage). All models get automatic
    tenant filtering; DB methods additionally pass `tenantId` explicitly for
    defense-in-depth.
- Migrations: `packages/data-schemas/src/migrations/*` (e.g. `tenantIndexes.ts`)
  exported from `migrations/index.ts`.
- Transactions: `packages/data-schemas/src/utils/transactions.ts`
  (`supportsTransactions`) — used for atomic App+Version creation with graceful
  fallback when the deployment is a standalone (non-replica-set) MongoDB.
- Unit test pattern: `mongodb-memory-server` + `createModels`/`createMethods`
  in `beforeAll` (see `methods/agent.spec.ts`).

## 8. Audit

- `packages/data-schemas/src/types/admin.ts` — `AUDIT_CATEGORIES`,
  `AUDIT_ACTIONS`, `AUDIT_ACTION_CATEGORY`, outcomes/severities/actor types.
- `packages/data-schemas/src/methods/auditLog.ts` — `recordAuditEntry`
  (append-only, hash-chained, tenant-scoped).

WP3/WP4 extend the taxonomy with `artifact_app.*` / `artifact_version.*` /
`artifact_acl.*` actions and write via `recordAuditEntry`. Audit entries never
contain tokens/secrets (PLAN §13).

## 9. MCP / HITL (out of scope for WP0–WP6, referenced for ADR-2)

- `@librechat/agents` MCPManager (external dependency) is the only tool executor.
- Existing MCP server ACL: `ResourceType.MCPSERVER` with viewer/editor/owner.

MCP bridge design is captured in ADR-2; no MCP code is written in WP0–WP6.

## 10. Frontend routing / data-provider (WP5/WP6)

- `packages/data-provider/src/api-endpoints.ts` — endpoint builders.
- `packages/data-provider/src/data-service.ts` — service functions.
- `packages/data-provider/src/keys.ts` — `QueryKeys` / `MutationKeys`.
- `client/src/routes` — SPA routes; `/apps` is the catalog and
  `/apps/:artifactAppId[/version/:versionId]` is the standalone viewer.
- `client/src/locales/en/translation.json` — English localization keys
  (`com_ui_*`, `com_artifact_apps_*`).
  </content>
