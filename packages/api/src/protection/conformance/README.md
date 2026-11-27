# A1: PII policy and conformance contract

Scope: [AI-2212](https://linear.app/clickhouse/issue/AI-2212), under the board's **PII: redaction & trace-isolation verification** gate. MCP OAuth and per-agent secret lifecycle remain separate tracks. This PR supplies a reviewable contract and synthetic corpus, not output enforcement, certification or activation. Contract acceptance is a merge gate for B1/C1 and their consumers.

## Evidence snapshot

- LibreChat `dev@565976be52d72deab020276415aa489e6c0d8b1b`. Graph and fetched branch heads agree.
- Agents `main@5b58294aad1c8cb74f2c9d9494b305f208eb4b33`. Graph and remote heads agree. LibreChat still locks `@librechat/agents@4.0.1`; SDK-main source is navigation evidence, not proof of the published package's behavior.
- Landed foundations: [#15508](https://github.com/LibreChat-AI/LibreChat/pull/15508), [#16295](https://github.com/LibreChat-AI/LibreChat/pull/16295), [#16311](https://github.com/LibreChat-AI/LibreChat/pull/16311). Existing source-aware `block`/`audit` and bounded transformation are distinct from required output-release protection.

Static edges cannot establish release ordering, dynamic callbacks or serialized sink payloads. The source inventory below is not a passing end-to-end test. `conformance.spec.ts` checks the current detector/transformer and audit baseline only. Downstream slices must test the real owning boundary.

## Current source/field/destination matrix

**D**: delivered bounded user-text mechanism. **P**: existing partial inspection/projection, not general output redaction. **M**: required guarantee missing. **U**: intentionally unsupported in the next output slices, not blocked by today's default configuration. **N**: no destination in this contract. D/P apply only when the relevant current policy is configured.

| Source / field | Model reuse | UI / SSE / Redis replay | Storage | Share / export | Logs | Central / tenant traces | Indexes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Interactive user `message.text`, eligible new Agent turn | D | D canonical; separate authenticated owner view | D canonical + encrypted owner sidecar | D canonical, no owner original | P | P | P |
| Other user text / edits / quotes / API / schedule / resume input | P block/audit | P | P | P | P | P | P |
| Assistant ordinary prose `message.text`, model provenance | M | M | M | M | P | P | M |
| Assistant reasoning / control / structured JSON / code / SQL / signatures / IDs | U | U | U | U | P | P | U |
| Synchronous tool success text `tool_argument.output` | P selected app handlers | P selected app handlers | P | P | P | P selected output shaping | M |
| Synchronous tool error text `tool_argument.output`, error outcome | P selected app handlers | P selected app handlers | P | P | P | P | M |
| Tool artifacts / raw aliases / files / media / background results | U; existing selected blockers remain | U | U | U | P | P | U |
| Title `conversation_title.title` | P | P safe fallback | P | P | P | P | P |
| Memory `memory.key/value/summary` | P | P current-policy projection | P | N | P | P | N |
| Generated / stored message summary | P assembled-context inspection | P | P | P | P | P | N |
| Owner original / ciphertext / private token provenance | D excluded | D owner-only original, never ordinary events/cache | D hidden unindexed sidecar/provenance | D excluded | P no general sink certification | M independent sink proof | D sidecar excluded; emitter proof remains |

User D is narrower than a role label: `createPrivateTextIngress` excludes edits, regenerate/continue, compact, trigger/resume, quotes and file-bearing submissions. Root-native admission, protected persistence, Stop and derived-model admission are implemented; protected pre-admission automatic summarization remains fail-closed. Reusing a canonical placeholder requires exact server-row provenance, never a client-supplied role or marker. Native copies retain only hidden token provenance, not owner originals; imports do not acquire trust.

Tool P is real coverage, not an empty cell: `filteredToolOutputResult` protects selected application success/error paths; `assertDirectToolOutputAllowed` protects the direct HTTP controller. It does not establish a universal SDK gate. SDK `PostToolUse.updatedOutput` can replace output, but post/failure hook exceptions are caught; `runTool` can already register pre-hook bytes, and eager completion has separate publication. C1 must own ordering before any of these effects.

## Owners and measurable destination gates

Owners are code boundaries and delivery issues, not newly assigned people. Each required test must include a non-sensitive control that actually arrives, so dropping every payload cannot pass privacy verification.

| Boundary / slice | Current source anchors | Required evidence before enabling |
| --- | --- | --- |
| Policy / A1 | `types.ts`, `runtime.ts`, `transform.ts`, `audit.ts`; data-provider `filters.ts` | Source/field/provenance and action agreed; corpus parses; real current transformer/audit baseline passes. |
| Provider release / B1 + B2 | SDK `src/stream.ts`: `ChatModelStreamHandler`, `createContentAggregator`; app `agents/run.ts`, legacy AgentClient | Await required protection before aggregate/run state, model reuse and any event. Every split of a planted canary, primary/fallback/parallel attempts and cancellation pass. |
| Tool release / C1 + C2 | SDK `src/tools/ToolNode.ts`, `dispatchEagerToolCompletions`; app `agents/handlers.ts`, `tools/protection.ts` | Ordinary/local/direct/eager success and error cannot populate events, output-reference registry or model state before the decision. Artifact aliases cannot reintroduce unchecked content. |
| Display / replay / B2 + C2 | AgentClient, SDK aggregator, `stream/GenerationJobManager.ts`, `stream/implementations/RedisJobStore.ts` | Inspect live SSE and serialized Redis events plus late subscriber/restore. Approved prose and tool identity/status survive; canaries and failed-attempt chunks do not. |
| Persistence / E1 | data-schemas `methods/message.ts`, `schema/message.ts`; AgentClient writers | Canonical text/content only across success, Stop, error recovery, edit/copy/import and TTL/delete. Failed protection cannot save or revive an unchecked attempt. No output-original archive. |
| Share / export / E1 | `shared-links/protection.ts`, data-schemas `methods/share.ts`; client `useExportConversation.ts`, `PrivateText.tsx` | Check actual authenticated/public DTOs, native copies and JSON/CSV/text/screenshots. Owner originals/ciphertext never enter ordinary queries or exports; tenant/owner mismatch denies raw access. |
| Search / E1 | data-schemas `models/plugins/mongoMeili.ts`, `schema/message.ts`; hydrated search methods | Inspect emitted index documents and hydrated reads with authorization. Only approved canonical fields; no sidecar, stale overwritten text or raw artifact. Schema flags alone are not emitter proof. |
| Logs / AI-527 affected evidence | data-schemas `config/parsers.ts`, `config/winston.ts`; API `utils/errors.ts`, `protection/diagnostics.ts` | Capture actual normal/error/overflow/timeout logs. Metadata allowlist only, no raw value, ciphertext, prompt, exception message/stack or payload aliases. Pattern logging redaction is not universal PII detection. |
| Trace exports / D1 | SDK `prepareLangfuseSpanForExport`; app `langfuse/config.ts`; `otel/langfuse-fanout/otelcol.yaml` and gateway | Inspect serialized central/tenant payloads independently, including automatic spans, metadata, events, errors, titles/memory/summaries and tool aliases. Cross-tenant/outage cases cannot export or reroute raw values. Routing-attribute removal is not content redaction. Preserve completed AI-1421/SEC-4336 work; reuse AI-1306 fanout fixtures. |
| Execution / F1; release join / V1 | Existing interactive/API/schedule/child/resume adapters | Record exact SDK/app/sink heads and supported cells. Each path passes or stays explicitly gated; activation approval is separate from merge. |

## Minimal shared vocabulary

The type-only data-provider contract is `types/protection.ts`. It reuses `FilterPiiAction`, pattern selection, category names and existing character/match limits. It does not alter `configSchema`, install callbacks, accept new YAML settings or change defaults. Consumers add strict parsing and enforcement together, not a parsed no-op switch.

Reserved root name: `outputProtection`. Shape: `{ version: 1, assistantText?: policy, toolText?: policy }`. Each policy reuses source PII pattern/action/limit keys, omits `fields` because the selected source is fixed, and requires a finite positive integer `timeoutMs`. Absent root/source preserves current behavior. Once a source exists, omitted action means `block`, omitted starters mean the existing starter catalog and `starterPatterns: []` disables that catalog; email/phone/name detection is not implied without configured rules. Existing `maxCharacters`/`maxMatches` defaults and ceilings remain the vocabulary, not performance claims. A timeout default is not invented here; the integrating consumer must validate explicit deadlines and aggregate concurrency/memory bounds before activation.

Supported targets are ordinary model prose (`message/text/model`) and selected synchronous tool text (`tool_argument/output/tool`, success or error). Trusted adapters establish eligibility and provenance. A text block containing code, structured payloads or control is not automatically ordinary prose. Unknown/ambiguous required targets return `unsupported`, not pass-through. Never mutate args, SQL/code, JSON protocol, signatures, IDs, status, approvals or authority. An opaque artifact/reference that could bypass a required text rule blocks the containing release or suppresses that destination until its own adapter is certified.

| Action / condition | Runtime canonical content | Secondary destinations |
| --- | --- | --- |
| `block`, no match | Release unchanged after successful inspection | Each destination still applies its own contract. |
| `block`, match | Typed `blocked` failure, no content | Raw-free failure status only; no unchecked persistence/index/replay. |
| `redact`, replaceable match | One approved canonical value with typed placeholders and category/count metadata | Every ordinary consumer uses that value; no parallel raw alias. |
| `redact`, non-replaceable match | `unsupported` failure, never silent protocol rewrite | No raw fallback. |
| `audit` | Successful inspection permits content unchanged, including matches | Audit is not redaction and cannot certify canary absence. Independent log/trace/index rules still apply. |
| Missing/failing handler, timeout, overflow, incompatible policy | Typed failure; no unchecked content | Export failure suppresses that export and emits allowlisted metadata. Disabled optional tracing does not block otherwise authorized chat. |

For configured block/redact sources, model/display/replay/storage/share/export/index consume only the approved canonical content. Logs consume metadata only. Central and tenant traces independently inspect their content/metadata/events/errors, even if runtime content was already approved. `audit` permits matched canonical content where that content policy allows it; it does not bypass stricter destination rules. Trace IDs and tenant routing are control fields: if they carry forbidden content, suppress the export rather than rewrite identity or reroute it. Unselected sources retain current behavior and remain uncertified.

Result: `{ version: 1, ok: true, value: { content, replacements, categories } }` or `{ version: 1, ok: false, error: { code } }`. Error codes: `blocked`, `unavailable`, `timeout`, `overflow`, `cancelled`, `unsupported`, `incompatible`. No error branch carries raw content or exception detail. Unexpected operational errors reach the owning boundary and are translated there without disclosing the original error. Runtime emitters must construct the audit allowlist; TypeScript types cannot remove extra object properties.

Audit: version, closed target/destination/action, category/count, elapsed milliseconds and optional stable error code. No samples, matches, offsets, arbitrary labels, paths, hashes of raw values, ciphertext or exception messages. Authorized correlation IDs remain a separate caller-owned logging context. A success result contains canonical text and therefore is not an audit record; never log the whole result.

## Ordering, retention and lifecycle

- Candidate B1/B2 baseline: bounded full **per-attempt** buffering for eligible prose. Inspect the joined candidate before SDK state/publication/reuse, not each transport chunk independently. Incremental release requires equivalent cross-chunk proof. Do not buffer the entire run or delay authority/control decisions behind prose.
- Character/match/deadline exhaustion rejects the attempt. Bound concurrent buffers at the run owner; max per attempt alone is not a run memory bound. No latency or memory budget is claimed until measured against a recorded baseline.
- Required handler absence, throw or rejected promise fails closed. An optional observational hook cannot stand in for that handler. Validate capability/policy version before a protected producer starts.
- Cancellation is terminal for the affected attempt. Check it before commit/publication; late protection completion cannot release or persist cancelled bytes. Previously approved content may follow existing Stop durability. Retry/fallback gets a fresh attempt, budget and placeholder scope; never publish failed-attempt prefixes.
- Keep canonical content's existing retention. Raw model/tool output and replacement maps are bounded ephemeral processing data, not stored archives. Trace/log/index retention contains only its approved projection, subject to its existing destination retention. Do not copy owner-user sidecars onto outputs.
- Owner-user originals keep PR2's encrypted, owner/tenant/conversation/message/revision/canonical binding, TTL/delete and isolated cache lifecycle. Key loss/rotation makes older originals unavailable; canonical history still works. No old-key ring or lifecycle migration is implied.
- Mixed versions in **both directions**: required-policy producer to old consumer and old producer to required-policy consumer must be rejected/gated unless the exact boundary is certified. Unknown versions/actions/targets cannot degrade to disabled/audit. A placeholder alone is not evidence of protection; preserve server-owned attempt/policy provenance through reuse and copies.
- Rollback is code rollback with protected paths disabled/gated until every participating SDK/app/destination supports the policy. Stop or drain in-flight protected attempts before rollback; do not retry them raw. Previously canonical rows stay canonical. Rolling back must not expose sidecars or resurrect overwritten/indexed values. No historical rewrite or default-on activation in A1.

## Corpus and downstream proof

`cases.json` is portable synthetic data, not production PII or real credentials. Its custom patterns deliberately identify only planted values. The 18 cases cover split email/credential text, tool success/error, Unicode, repeated/independent identities, mixed categories, literal placeholder collisions, allowed text/markdown/control, inspect-only JSON/code/SQL/URI and character/match exhaustion. `expected.transformError` names the existing transformer's reason, not the future output-result error code.

Run the API's `conformance.spec.ts` together with `transform.spec.ts`, `runtime.spec.ts` and `audit.spec.ts`. It applies the existing whole-text transformer and inspector, verifies raw-free audit metadata, and demonstrates why independently transforming chunks cannot implement a release gate. It does **not** run the SDK, Redis, database, browser, index emitter or exporter.

B1/C1 consume the same canaries at their real pre-release boundaries. B2/C2/E1/D1/F1/V1 plant them into events, references, artifacts, metadata/errors and recovery paths. At each required block/redact sink: assert planted values are absent from serialized payloads; for audit, assert matched content is permitted only where the destination policy allows it. Owner originals/ciphertext are forbidden in every ordinary sink regardless of action; assert an approved control reaches that sink, IDs/status remain exact, and tenant A never observes tenant B. Add required-handler throw/rejection/absence, timeout/overflow, Stop-before-decision, late completion, fallback/retry, version mismatch and destination outage tests at the owner. Do not substitute a mocked policy call for observing ordering or a schema flag for observing an emitted payload.

## Decision and limits

Use small awaited **owning runtime gates plus independent destination defenses**. App/SSE-only filtering misses SDK state, registry/model reuse and automatic telemetry. A universal-hook redesign changes unrelated phases without proving a smaller seam is insufficient. Existing selective blockers and destination shaping remain useful defenses; do not replace them with a type contract. Reconsider the choice only if B1/C1 source and real dispatch tests show no bounded mandatory seam can cover their producers.

Not included: output runtime implementation; detector vendor; rollout/default-on; historical migration; broad ingress-redaction expansion; files/media/background enforcement; bound-secret lifecycle/matching; MCP authority changes; relaxing protected pre-admission summarization. Unsupported cells remain open. Source inspection, contract acceptance, runtime implementation, exact-head certification and activation are separate gates.
