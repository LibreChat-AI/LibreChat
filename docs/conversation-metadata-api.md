# Conversation metadata API

An OIDC machine client can read the conversations of its configured LibreChat account. Set
`conversationRead: true` on that client in `endpoints.agents.managementApi.auth.clients` in
`librechat.yaml`. Access is disabled for a binding that omits the field. The configured tenant,
user, issuer, audience or required scopes, and client subject still apply.

`GET /api/agents/v1/conversations` returns the most recently updated conversations first. The
response contains `data`, `has_more`, and the `after` cursor. Pass `after` as the next request's
`cursor` with the same filters. The default limit is 20 and the maximum is 100. Optional filters
are `agent_id`, `isArchived` (`true` or `false`), and `tags` (match any requested tag; repeat the
query parameter for multiple tags). Tag names are matched exactly. With no archive filter the page includes both archived and
active conversations. Concurrent updates can reorder conversations between requests.

`GET /api/agents/v1/conversations/{id}` returns a conversation's title, timestamps, endpoint,
model, agent ID, tags, and archive state. Both reads exclude temporary, expired, and subagent
conversations. The endpoint returns metadata only.
