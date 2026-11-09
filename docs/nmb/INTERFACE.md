# NMB Scanner: HTTP/JSON interface

Service: `nmb-scanner` (FastAPI, port 8088, internal network only). Source: `nmb-scanner/`.
Compose: `docker-compose.nmb.yml`. Policy: `nmb-scanner/config/policy.yaml`. Blocklist: `nmb-scanner/config/blocklist.yaml`.

Consumers: the gateway (Agent 2) calls `/scan/*` and `/unmask`; the review screen (Agent 3) calls `/reviews*` and `/blocklist`.
**Only the gateway/backend may call the scanner. Never expose it to browsers.** The scanner trusts the identity
(`user`, `department`, `roles`) that the calling backend passes, so the backend must take these from the authenticated
session, not from client input.

## Conventions
- Auth: header `X-NMB-Service-Key: <NMB_SERVICE_KEY>` on every request (401 if wrong/missing; disabled only if the env var is unset, dev only).
- JSON in/out, UTF-8. Timestamps ISO-8601 UTC (`2026-11-09T10:15:00+00:00`).
- Roles are passed per call. Reviewer-only endpoints need a role in `review.reviewer_roles` (default `reviewer`, `admin`). `/unmask` needs a role in `unmask.allowed_roles`.
- `conversation_id` scopes placeholders: the same value gets the same placeholder (`<ACCOUNT_001>`) throughout one conversation, and a different one in another. Use the LibreChat conversation id.
- The scanner never logs raw values (only keyed hashes) and returns raw values only from `/unmask` and `/reviews/{id}/original`.

## Decision object (returned by `/scan/text`, `/scan/file`, `/reviews/{id}/approve-masked`)
```json
{
  "decision": "allow | mask | review | reject",
  "conversation_id": "conv-1",
  "findings": [
    {
      "entity": "ACCOUNT_NUMBER",
      "type": "financial",
      "location": {"segment": "body.t[1].r[2].c[1]", "start": 9, "end": 22},
      "score": 0.9,
      "action": "MASK",
      "value_hash": "a1b2c3d4e5f6",
      "placeholder": "<ACCOUNT_001>"
    }
  ],
  "sanitized_content": "Pay account <ACCOUNT_001> ...",
  "review_required_reason": null,
  "review_id": null,
  "document": null,
  "sanitized_segments": null,
  "summary": {"ACCOUNT_NUMBER": {"count": 1, "actions": {"MASK": 1}}}
}
```
| field | meaning |
|---|---|
| `decision` | `allow`: nothing to change, forward `sanitized_content` (identical to input). `mask`: forward `sanitized_content` to the LLM. `review`: DO NOT forward; held for a human, see `review_id`. `reject`: DO NOT forward and do not retry; show `review_required_reason`. |
| `findings[].entity` | `ACCOUNT_NUMBER, SWIFT_BIC, IBAN, CREDIT_CARD, ZW_NATIONAL_ID, US_SSN, PHONE, EMAIL, API_KEY_SECRET, PRIVATE_KEY, ORG_KEYWORD` (+ `PERSON, LOCATION` if an NER model is configured; blocklist entries may define other entities). |
| `findings[].type` | policy category: `financial, pci, pii, secret, blocklist, other`. |
| `findings[].location` | `segment` is a content-free path (see below); `start`/`end` are character offsets inside that segment's ORIGINAL text. |
| `findings[].score` | 0..1 recogniser confidence. |
| `findings[].action` | `MASK`, `BLOCK` or `ALLOW` as resolved by policy (including department overrides). |
| `findings[].value_hash` | 12-hex keyed hash of the normalised value. Equal values give equal hashes; use for grouping in the UI. Not reversible. |
| `findings[].placeholder` | set only when `action=MASK` and decision is `mask`/`allow`. Null for `review`/`reject`. |
| `sanitized_content` | `/scan/text`: sanitised text. `/scan/file`: markdown-like rendering (`## Sheet`, `## Page n`, `| a | b |` tables, `## Document properties`). Null for `review`/`reject`. |
| `sanitized_segments` | files only: `[{"location","text"}]` per segment, sanitised. |
| `review_required_reason` | human-readable reason for `review` and `reject`. |
| `review_id` | set when a review item was created (`review`) or logged (`reject`, status `rejected`). |
| `document` | files only: `{filename_ext, bytes, type, ...}`; docx `tables, sections`; xlsx `sheets, hidden_sheets`; pdf `pages, pages_without_text`. |

Segment locations (never contain document content):
`text`; docx `body.p[3]`, `body.t[1].r[2].c[0]`, `header.s0.p[0]`, `footer.s0...`, `props.author`;
xlsx `sheet[1].name`, `sheet[1]!B7`, `sheet[1]!B7.comment` (sheet index is 1-based, hidden sheets included);
pdf `page[2]`, `props.author`.

Decision rules: any `BLOCK` finding gives `review`, unless that entity has `block_outcome: reject` (e.g. `PRIVATE_KEY`) which gives `reject` and the original is never stored. A PDF page without a text layer (scanned) gives `review` (or `reject` if `files.scanned_pdf_action: reject`). Otherwise any `MASK` gives `mask`, else `allow`. Unsupported/oversize/corrupt files give `reject` with no findings.

## Endpoints

### `POST /scan/text`
Request:
```json
{"text": "...", "conversation_id": "conv-1", "user": "jdoe", "department": "Risk", "roles": ["user"]}
```
`department` and `roles` optional. Response: decision object.

### `POST /scan/file`  (multipart/form-data)
Fields: `file` (.docx, .pdf, .xlsx; max 25 MB by policy), `conversation_id`, `user`, `department` (optional), `roles` (comma-separated string). Response: decision object.

### `POST /unmask`
Restores placeholders in the LLM answer for authorised users.
Request: `{"conversation_id": "conv-1", "text": "Move <ACCOUNT_001> to ...", "roles": ["user"]}`
Response 200: `{"text": "Move 1234...", "restored": 1, "unresolved": ["<CARD_001>"]}`
`unresolved` placeholders (unknown, other conversation, or non-reversible like cards) are left as-is. 403 if no role is in `unmask.allowed_roles`.

### `DELETE /conversations/{conversation_id}`
Purges that conversation's mappings (call when a chat is deleted). Response `{"deleted_mappings": n}`.

### Reviews
| method | path | notes |
|---|---|---|
| GET | `/reviews?status=&department=&user=` | `{"items":[ReviewItem...]}` newest first. Contains no raw values. |
| GET | `/reviews/{id}` | one ReviewItem; 404 if unknown. |
| GET | `/reviews/{id}/original` | header `X-NMB-Roles: reviewer`. Returns raw `{"id","source","segments":[{"location","text"}]}` for the reviewer to inspect. 403 without reviewer role; 404 if none (e.g. `reject` decisions retain nothing). |
| POST | `/reviews/{id}/approve-masked` | body `ReviewAction`. Re-runs the scan with every BLOCK finding downgraded to MASK, stores the result, sets status `approved-masked`. Returns a decision object (`decision: mask`). 409 if not pending. |
| POST | `/reviews/{id}/reject` | body `ReviewAction`. Status `rejected`. Returns ReviewItem. 409 if not pending. |
| GET | `/reviews/{id}/result` | for the gateway to poll: `{"id","status","sanitized_content","sanitized_segments"}`; content non-null only when `approved-masked`. |

`ReviewAction` body: `{"reviewer": "asmith", "roles": ["reviewer"], "note": "free text", "blocklist_additions": ["Zebra Initiative"]}`. 403 without a reviewer role.

### Blocklist
- `GET /blocklist` -> `{"entries":[{"term"|"regex", "entity"?, "source":"base|runtime"}]}`
- `POST /blocklist` (header `X-NMB-Roles` with reviewer role) body `{"terms":["..."]}` -> `{"added":["..."]}`. Takes effect immediately for all later scans. Runtime additions persist in the scanner data volume; base terms come from `blocklist.yaml`.

### Misc
`GET /health` -> `{"status":"ok",...}`. `GET /policy` -> effective policy summary (entity actions, departments, file limits).

## Review item data model (`ReviewItem`)
```json
{
  "id": "rev_3f9a1c20d4be",
  "user": "jdoe",
  "department": "Risk",
  "conversation_id": "conv-1",
  "source": "text | file",
  "original_prompt_ref": "blob_9c1e...",
  "decision_at_creation": "review | reject",
  "reason": "Policy requires human review for: secret:API_KEY_SECRET",
  "findings": [ /* same finding objects as above; no raw values */ ],
  "status": "pending | approved-masked | rejected",
  "reviewer": null,
  "reviewer_note": null,
  "blocklist_additions": [],
  "created_at": "2026-11-09T10:15:00+00:00",
  "updated_at": "2026-11-09T10:15:00+00:00",
  "resolved_at": null,
  "result_ref": null
}
```
- `original_prompt_ref` is an opaque pointer to the Fernet-encrypted original held only inside the scanner. Resolve it only through `GET /reviews/{id}/original` (reviewer role). It is null for `reject` decisions.
- `status` transitions: `pending` -> `approved-masked` | `rejected` (terminal). Items auto-logged for `reject` decisions are created directly as `rejected` with `reviewer: "system"`.
- After `approve-masked`, `findings` is replaced by the post-approval findings (BLOCK entries now `MASK` with placeholders), `blocklist_additions` lists terms newly added, `result_ref` points at the stored sanitised result (fetch via `/reviews/{id}/result`).
- Gateway flow for a held prompt: show the user "pending review", poll `GET /reviews/{id}` or `/result` until status leaves `pending`; on `approved-masked` forward `sanitized_content` to the LLM and unmask the answer with `/unmask` using the same `conversation_id`; on `rejected` show the reviewer note.

## Policy and configuration summary
`policy.yaml` per entity: `action` (MASK|BLOCK|ALLOW), `type`, `prefix` (placeholder name), `reversible` (false = never recoverable via `/unmask`, e.g. cards, secrets), `block_outcome` (review|reject), `min_score`; `departments.<Name>.entities` overrides; `files`, `unmask`, `review` sections.
Environment: `NMB_VAULT_KEY` (Fernet key, required in production), `NMB_SERVICE_KEY`, `NMB_DATA_DIR`, `NMB_POLICY_FILE`, `NMB_BLOCKLIST_FILE`, `NMB_SPACY_MODEL` (optional NER), `NMB_LOG_LEVEL`.

## Error format
FastAPI standard: `{"detail": "message"}` with 401 (service key), 403 (role), 404 (unknown id), 409 (review not pending), 422 (bad request body).

## Known limits
Pattern-based detection plus the blocklist; person names/free-text addresses are only detected when an NER model is configured. Docx text boxes, footnotes and comments are not extracted; scanned PDFs are flagged for review, not OCR'd. Unmask only restores placeholders emitted verbatim by the LLM.
