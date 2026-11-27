# Skills management API

The machine-authenticated Skills surface uses the same `endpoints.agents.managementApi.auth`
configuration and client-to-principal bindings as Agent management. It is mounted before the
execution router and does not accept browser sessions or execution API keys as fallback.

| Method | Path                                            | Operation                                     |
| ------ | ----------------------------------------------- | --------------------------------------------- |
| GET    | `/api/agents/v1/skills`                         | List accessible Skills (`limit` and `cursor`) |
| POST   | `/api/agents/v1/skills`                         | Create an inline Skill                        |
| GET    | `/api/agents/v1/skills/:id`                     | Read Skill metadata, body, and frontmatter    |
| PATCH  | `/api/agents/v1/skills/:id`                     | Update an inline Skill                        |
| DELETE | `/api/agents/v1/skills/:id`                     | Delete an inline Skill                        |
| GET    | `/api/agents/v1/skills/:id/files`               | List file metadata                            |
| GET    | `/api/agents/v1/skills/:id/files/*relativePath` | Read a file as JSON                           |
| PUT    | `/api/agents/v1/skills/:id/files/*relativePath` | Create or replace a text file                 |
| DELETE | `/api/agents/v1/skills/:id/files/*relativePath` | Delete a file                                 |

Skill results expose `id`, configuration fields, `version`, `fileCount`, and ISO timestamps.
Ownership, tenant, source metadata, and storage locations are excluded. Skill lists use the Agent
management envelope: `object`, `data`, `first_id`, `last_id`, `has_more`, and `after`.
Pass returned Skill IDs in the Agent management `skills` field to assign them to an Agent.

Create an inline Skill with its required identity and instruction fields:

```json
{
  "name": "query-review",
  "description": "Review a query and recommend improvements.",
  "body": "Review the supplied query for correctness and efficiency."
}
```

Creation also accepts the editable optional fields described below. The authenticated principal is
recorded as the owner; callers cannot set ownership, tenant, source, or permissions.

Updates require the version returned by the latest read:

```json
{
  "expectedVersion": 1,
  "body": "Updated instructions",
  "description": "Use this skill when analyzing a new dataset."
}
```

Editable fields are `name`, `displayTitle`, `description`, `body`, `frontmatter`, `category`, and
`alwaysApply`. Existing Skills validation and content policies apply. Unknown fields are rejected.
A stale version returns HTTP 409 with `error.code: "conflict"`; retrieve the current Skill before
retrying. Skill reads require VIEW access; updates require EDIT and the Skills USE/CREATE role
permissions. Inaccessible and cross-tenant IDs return the same 404 envelope.

Whole-Skill deletion requires DELETE access and the same Skills USE/CREATE role permissions as
other mutations. It returns `{ "id": "...", "deleted": true, "cleanupComplete": true }` on
complete cleanup. If cleanup is still pending, it returns `cleanupComplete: false`. The Skill is
hidden immediately, and the background sweeper retries durable cleanup after transient failures.
Physical finalization requires `skillDeletion.finalizationEnabled: true` after older Skill writers
have drained; without it, deletion stays pending.
Cleanup reads file metadata and upload intents in cursor batches bounded by
`skillDeletion.batchSize` (default 100), settling each batch before fetching the next.
File content is not loaded, and failed provider deletions retain their persisted references for retry.

Text-file writes accept `{ "content": "replacement text" }`, capped at 1 MiB of UTF-8 data.
Use a relative path such as `references/guide.md`. Absolute paths, traversal, and NUL bytes are
rejected. Delete the same path to remove the file. Update `SKILL.md` through the Skill's `body`
field with `expectedVersion`, not the file endpoint. File writes use replacement semantics without
a version precondition; serialize writers to the same path. After a file write, read the Skill again
before a versioned metadata/body update: file writes also increment the parent version. Storage selection stays server-controlled. File JSON reads omit content for
binary or oversized files; raw download mode is not supported on this surface. File deletion completes
storage cleanup before returning success and reports a conflict if another writer replaced the path.
Replacing a file queues the previous blob for durable background cleanup. If the replacement fails,
the sweeper retains any blob still referenced by the current file row.

Git-synced and deployment-provided Skills are readable but cannot be changed through this API.
Change their upstream source instead. Browser routes keep their existing behavior.
