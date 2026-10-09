# Skills management API

The machine-authenticated Skills surface uses the same `endpoints.agents.managementApi.auth`
configuration and client-to-principal bindings as Agent management. It is mounted before the
execution router and does not accept browser sessions or execution API keys as fallback.

| Method | Path                                            | Operation                                     |
| ------ | ----------------------------------------------- | --------------------------------------------- |
| GET    | `/api/agents/v1/skills`                         | List accessible Skills (`limit` and `cursor`) |
| GET    | `/api/agents/v1/skills/:id`                     | Read Skill metadata, body, and frontmatter    |
| PATCH  | `/api/agents/v1/skills/:id`                     | Update an inline Skill                        |
| GET    | `/api/agents/v1/skills/:id/files`               | List file metadata                            |
| GET    | `/api/agents/v1/skills/:id/files/*relativePath` | Read a file as JSON                           |
| PUT    | `/api/agents/v1/skills/:id/files/*relativePath` | Create or replace a text file                 |

Skill results expose `id`, configuration fields, `version`, `fileCount`, and ISO timestamps.
Ownership, tenant, source metadata, and storage locations are excluded. Skill lists use the Agent
management envelope: `object`, `data`, `first_id`, `last_id`, `has_more`, and `after`.
Pass returned Skill IDs in the Agent management `skills` field to assign them to an Agent.

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

Text-file writes accept `{ "content": "replacement text" }`, capped at 1 MiB of UTF-8 data.
Use a relative path such as `references/guide.md`. Absolute paths, traversal, and NUL bytes are
rejected. Update `SKILL.md` through the Skill's `body` field with `expectedVersion`, not the file
endpoint. File writes use replacement semantics without a version precondition; serialize writers
to the same path. After a file write, read the Skill again before a versioned metadata/body update: file writes also
increment the parent version. Storage selection stays server-controlled. File JSON reads omit content for
binary or oversized files; raw download mode is not supported on this surface.

Git-synced and deployment-provided Skills are readable but cannot be changed through this API.
Change their upstream source instead. Browser routes keep their existing behavior.
