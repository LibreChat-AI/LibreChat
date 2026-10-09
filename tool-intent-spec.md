# Feature Spec: Tool Intent & Outcome Labels

**Status:** proposal, ready for implementation by someone with no prior context
**Repos:** `danny-avila/agents` (published as `@librechat/agents`, local path `~/agentus`), `danny-avila/LibreChat`

**Verified dependency landscape (2026-07-28):**

| Dependency | State | What it means for this spec |
|---|---|---|
| Background capability core (`packages/api/src/agents/background.ts` + `background.spec.ts`) | **merged in LibreChat main** | the reference implementation exists today; clone it freely |
| [#14407](https://github.com/danny-avila/LibreChat/pull/14407) — Background Execution Toggles for Actions & Plugin Tools | **open** | this is the "bg tools open PR"; only slice 5 (builder toggles) sequences after it |
| Activity labels, SDK side (`Run.generateActivityLabel`, `src/prompts/activityLabel.ts`, `src/types/activityLabel.ts`, `ACTIVITY_LABEL_PROMPT`) | **merged & published** in `@librechat/agents@3.3.0` ([danny-avila/agents#327](https://github.com/danny-avila/agents/pull/327)) | treat as existing API, build on it directly |
| [#14391](https://github.com/danny-avila/LibreChat/pull/14391) — Activity Groups With Fast-Model Headers (LibreChat host side) | **open, near merge** | reshapes `ToolCallGroup` grouping and header precedence; §5.2, §9.2, and §10.10 assume it lands first and specify the composition explicitly |

---

## 1. Intent of the feature

Tool calls currently render with mechanical, provider-derived labels. The card tells you which tool ran and where. It never tells you why. Two `search_code` calls in a single turn are indistinguishable: the group header reads `Used 2 tools — github` and both rows read `Ran search_code in github`. The user cannot tell that one call searched for MCP wiring and the other searched for OAuth handling. The information exists, buried in the args behind a disclosure triangle, and the chrome throws it away.

The fix: let the model declare, as the **first argument of every tool call**, a short natural-language statement of what that specific call is attempting. That string becomes the label for that call's card, streaming into place as the provider streams the tool input. When the call settles, the label is edited in place into an outcome form.

Before and after, using the two-`search_code` case as the reference:

```
BEFORE
  ⌄ Used 2 tools  — github
      Ran search_code in github        ⌄
      Ran search_code in github        ⌄

AFTER  (streaming, second call in flight)
  ⌄ Searching for OAuth handling                    (shimmering)
      Searched for MCP wiring         ⌄
      Searching for OAuth handling    ⌄             (shimmering)

AFTER  (settled)
  ⌄ Searched for OAuth handling  — github
      Searched for MCP wiring         ⌄
      Searched for OAuth handling     ⌄
```

Four design commitments that shape everything below:

1. **This is a tool capability, not a feature.** It is the fourth member of an existing family (`defer_loading`, `allowed_callers`, `run_in_background`) and must be built to that family's established shape, so the pattern becomes a documented convention rather than four one-offs. Future capabilities should be able to point at this one and copy it.
2. **Flexibility over prescription.** The field is a free-form sentence and the outcome is an in-place edit of any span of that sentence. We deliberately do not enumerate verbs or categories. We want to see what people and models produce, then tighten later.
3. **Native tools opt in by default.** The convention only becomes a convention if our own tools model it: web search, the entire coding suite across every engine, subagents, memory, and file authoring.
4. **It must compose.** A tool can be deferred, programmatic, backgroundable, and intent-describing simultaneously, and the whole system must layer cleanly under the activity-group headers landing in #14391. Section 10 specifies every one of those interactions.

The relationship to activity labels, stated up front because it frames the design: **intents are the live, per-call, zero-cost layer; activity labels are the settled, per-block, fast-model layer.** A block's header progressively enriches — streaming intent while a call runs, the tool-authored outcome the instant it settles, fast-model narrative summary a moment later. The same two-layer idea extends to Langfuse traces (§11): intents name spans, activity labels name batches, and a session trace becomes readable as a narrative without opening a single payload.

---

## 2. Existing conventions to mirror

Read these before writing any code. The new capability is a structural sibling of the third row.

| Capability | `tool_options` key | Where it lands | Admin gate | Mechanism |
|---|---|---|---|---|
| Deferred tools | `defer_loading` | `LCTool.defer_loading` | `AgentCapabilities.deferred_tools` | tool withheld from context, discovered via `tool_search` BM25 |
| Programmatic (PTC) | `allowed_callers` | `LCTool.allowed_callers` | `AgentCapabilities.programmatic_tools` | callable only from `run_tools_with_code` / `run_tools_with_bash` |
| Background tools | `run_in_background` | **injected schema param** | `AgentCapabilities.run_in_background` | `packages/api/src/agents/background.ts` injects a boolean, `handlers.ts` intercepts and strips, `check_background_task` polls |

`packages/api/src/agents/background.ts` is the reference implementation. It is roughly 200 lines containing exactly the machinery this feature needs: a frozen property constant, non-mutating injection, an injectability guard, registry parity, self-spawn stripping, and ephemeral/model-spec synthesis. **Read it first and follow its structure function for function.** The new host module should be recognizable as its sibling at a glance.

Not per-tool capabilities, so out of scope for the family: `stateful_code_sessions`, `skills`, `subagents`, HITL approval, tool output references, eager event execution, activity labels (run-scoped, config-gated per endpoint via `librechat.yaml`, not per-tool). Those are agent- or run-scoped.

---

## 3. Naming

| Thing | Name |
|---|---|
| Injected arg | `intent` |
| Result field | `outcome` (plus `outcome_patch`) |
| Per-tool flag | `describe_intent` |
| Admin capability | `AgentCapabilities.tool_intents` |
| Host module | `packages/api/src/agents/intent.ts` |
| SDK module | `src/tools/intentArg.ts` |

**Do not use `description` as the arg name.** Two blocking reasons:

- It collides with real third-party params. MCP servers and OpenAPI actions routinely expose a `description` field (create-issue, create-page, create-card, update-record). The injectability guard would refuse those tools silently, and they are precisely where an intent label has the most value.
- It is ambiguous in every type, log line, and error message, because `LCTool.description` already means "the tool's own description".

Runner-up: `activity` / `activity_label`, which would unify vocabulary with the SDK's `activity_label` content type, `Run.generateActivityLabel`, and `src/prompts/activityLabel.ts`. Rejected precisely *because* of #14391: activity labels are now a shipping sibling system (per-block, fast-model-authored, a content part), and reusing the word for a per-call, calling-model-authored, args-resident string would make every conversation about either feature ambiguous. `intent` keeps the two layers nameable. This spec uses `intent`.

---

## 4. Wire shape

### 4.1 The injected schema property

Injected as the **first** key of `properties`:

```ts
/** Opening words double as the discriminator — see below. Exported. */
export const INTENT_LABEL_MARKER = 'ALWAYS write this field FIRST';

export const INTENT_DESCRIPTION =
  `${INTENT_LABEL_MARKER}, before any other argument. One present-progressive ` +
  'sentence saying what THIS call is about to do: "Searching for OAuth handling ' +
  'in the callback router". Shown to the user as this call\'s live status. ' +
  'Never name the tool. Sibling calls to one tool must differ.';

const INTENT_PROPERTY: JsonSchemaType = Object.freeze<JsonSchemaType>({
  type: 'string',
  description: INTENT_DESCRIPTION,
});
```

**Keep it terse.** This text rides every opted-in schema on every request, so each sentence is paid for many times over — measured at ~72 tokens, or roughly 1.1k per request across a full coding bundle. An earlier 502-char draft cost ~126 tokens per tool; trimming it in 3.3.7 returned ~800 tokens per request. Every remaining clause is load-bearing: first-position placement (the entire streaming mechanism), the one-sentence present-progressive form, who reads it, and the sibling rule without which models emit identical labels for parallel calls and defeat the headline case.

**The first five words are an API.** `INTENT_LABEL_MARKER` is how every strip/sanitize path tells the injected label apart from a tool's own business parameter named `intent` — the two are structurally identical (`{type: 'string'}` under the same key) and only the description distinguishes them. It is prose rather than a schema extension (`x-intent-label`) because unknown JSON-Schema keywords are dropped by zod↔JSON-Schema conversion and actively rejected by OpenAI strict function schemas; `description` is the one field that survives to the wire intact. Import the constant, never re-declare the literal: two copies that drift make the host silently stop recognizing SDK-native labels, failing **open** with no error.

`{ [INTENT_ARG]: INTENT_PROPERTY, ...existingProps }` gives first-key placement, because JS object literal key order is insertion order and every provider serializer preserves it. First key in the schema means first key in the streamed input, which is the entire reason the label can appear before the rest of the args exist.

The "distinguish siblings" clause is load-bearing for the reference case. Without it, models emit identical intents for parallel calls to the same tool.

### 4.2 Outcome, and who authors it

The model cannot know the outcome at call time, so `outcome` is never a model-authored arg. Two sources, in precedence order:

1. **Tool-supplied replacement.** Native tools may return `outcome: string`. Full replacement. `web_search` returns `Found 12 results for OAuth handling`.
2. **Tool-supplied in-place patch.** `outcome_patch: { from: string; to: string }` edits one span of the intent, first occurrence only, case-sensitive. `{ from: 'Searching', to: 'Searched' }` turns `Searching for OAuth handling` into `Searched for OAuth handling`, preserving whatever the model wrote after the verb. This is the flexible mechanism: any part of the sentence, edited in place.

Absent either, **the intent is displayed unchanged.** There is deliberately no mechanical tense rewrite.

An earlier draft of this spec specified a present-progressive→past-tense map over the leading verb (Searching→Searched, Reading→Read, …). It shipped in `@librechat/agents` 3.3.6 and was removed in 3.3.7, because such a map can only ever be a closed list of English verbs and is therefore wrong three ways at once:

- **It never fires for non-English labels.** §9.6 expects the model to write in the user's language, so intents arrive as "Buscando…", "検索中…". An English verb map is permanently dead for those users — the settled label already behaved differently per locale.
- **It fires for some siblings and not others.** The first real-provider run produced *"Recording the location of the OAuth callback router"*; "Recording" was not in the 22-entry map. Beside a mapped "Searched…" in the same group, one card reads past tense and the other present, for no reason a user can perceive. Never transforming is more coherent than transforming sometimes.
- **It enumerates a vocabulary** in a feature whose stated premise (§1, commitment 2) is a free-form sentence.

Completion is conveyed by **UI state** — the shimmer stopping, the icon settling — which is language-neutral and always consistent. A tool that wants past tense says so explicitly through `outcome` / `outcome_patch`.

Error and cancellation get their own framing (prefix or restyle), never past tense. Final fallback with no intent at all: today's `Ran search_code in github` per card, `Used N tools` per group. Nothing regresses for tools without the capability.

### 4.3 Type additions

In `@librechat/agents`:

```ts
// ToolExecuteResult
outcome?: string;
outcome_patch?: { from: string; to: string };

// LCTool (optional, advertises SDK-native self-description)
intent?: boolean;
```

---

## 5. Label propagation semantics

### 5.1 Per-call card

Each card's label is that call's own, resolved as:

```
not a label-bearing tool           -> existing default label   (see gate below)
streaming, partial intent parsed   -> partial intent text, shimmering
streaming, nothing parsable yet    -> existing default label
settled, outcome present           -> outcome
settled, outcome_patch present     -> patch applied to intent
settled, intent only               -> the intent, unchanged
settled, no intent                 -> existing default label
error / cancelled                  -> error-framed intent, or existing default
```

Cards are independent. One call's label never affects another's.

**The label-bearing gate is mandatory, and it is a server-sent signal — never the presence of an `intent` key.** A tool may declare its own business parameter named `intent` (an MCP CRM tool with an intent category, say). Injection is skipped for those tools, and every strip path is marker-guarded, so nothing breaks server-side. But the marker lives in the schema *description*, which never reaches the browser: the client sees only `{"intent": "..."}` in the args and cannot tell a status label from a business value. Rendering on key presence alone would display `billing_inquiry` as a status label.

So the server must tell the client which calls carry a label. `intentToolNames` is the natural channel — it already exists, is already threaded through the run configurable for the PTC strip, and already names exactly the host-injected set. Two requirements follow:

- SDK-native tools must be marked too. They are deliberately **excluded** from `intentToolNames` (their schema is their own, so the host never counts them as host-injected), which means the existing list is necessary but not sufficient — extend it, or send a parallel set.
- The gate belongs in the shared resolver, not in each card, so the group header (§5.2) inherits it automatically.

This is latent today — nothing renders the label yet — and becomes real the moment the UI slice lands. It is a design constraint on slice 4a, not a defect to patch now.

### 5.2 Group header — a three-phase lifecycle

The group header shows the label of the **most recent call to change state**, where "change state" means either newly received (first parsable intent arrived) or newly finished (settled with a label). With #14391's activity labels in the picture, the header of a block moves through three phases:

1. **In flight.** If any call is in flight, the header shows the **latest in-flight** call's intent, live and shimmering. That is the live edge of the turn. (During this phase #14391's activity-label part for the block is an empty pending reservation that renders nothing, so there is no conflict.)
2. **Settled.** When all calls are settled, the header shows the **latest settled** call's outcome. It does not revert to an earlier call's label and does not revert to `Used N tools`.
3. **Summarized.** When the block's fast-model activity label resolves (asynchronously, off the critical path — #14391 generates it at the batch boundary via the `PostToolBatch` hook), the activity label **takes over as the durable header**. It is richer than any single call's outcome: it summarizes the whole block, in past tense, outcome-first. If activity labels are disabled, pending, or blank, the header simply stays at phase 2 forever.

Precedence in one line: **settled activity label > latest in-flight intent > latest settled outcome > existing subagent / ask-question tense-aware counts > `Used N tools`.** The phases are strictly ordered in time within one block (#14391's batch boundary means a new in-flight call starts a new block), so this chain never fights itself.

**Ordering caveat:** parallel batches settle out of order. Track a monotonic sequence at update time rather than trusting array order, so a slow first call settling after a fast second call cannot rewind the header.

### 5.3 Interaction with existing homogeneous-group labels

`ToolCallGroup.tsx` already special-cases two categories with tense-aware verbs: subagents (`Running/Ran N agents`, `Users` glyph) and `ask_user_question` (`Asking/Asked N questions`, question glyph).

- **Intent labels win over both.** A specific sentence beats a generic count.
- **Keep the category glyphs.** `Users` for an all-subagent group is information the sentence does not carry.
- Preserve the count in `aria-label` so screen readers still get `2 tools`.
- Keep the `— toolNameSummary` suffix (`— github`). It is orthogonal and still useful.

### 5.4 Collapsed and historical messages

Labels persist because they live in `tool_call.args` and the tool result, both already saved with the message. A reloaded conversation renders identical labels with no new persistence and no migration. This is a deliberate structural choice worth naming: intents ride `tool_call.args`, **not** a content part — so they are immune by construction to the run-step index-space and edit-offset hazards #14391 spends its hardest engineering on. Introduce no new content type and no new SSE event for the request side.

---

## 6. Verified native tool inventory

### 6.1 Canonical source of truth

`danny-avila/agents` already defines every coding tool name as a `Constants` member and groups them into exported arrays — `src/common/enum.ts` for the local groupings, `src/types/tools.ts` for the cloudflare groupings. Do not hand-maintain a parallel list; key off these.

| Export | Where | Members |
|---|---|---|
| `LOCAL_CODING_TOOL_NAMES` | `src/common/enum.ts` | `read_file`, `write_file`, `edit_file`, `grep_search`, `glob_search`, `list_directory`, `compile_check` |
| `LOCAL_CODING_BUNDLE_NAMES` | `src/common/enum.ts` | the above plus `bash_tool`, `execute_code`, `run_tools_with_code`, `run_tools_with_bash` |
| `CODE_EXECUTION_TOOLS` | `src/common/enum.ts` | `execute_code`, `bash_tool`, `run_tools_with_code`, `run_tools_with_bash` |
| `CLOUDFLARE_CODING_TOOL_NAMES` | `src/types/tools.ts` | the same 11 names |
| `CLOUDFLARE_BASH_CODING_TOOL_NAMES` | `src/types/tools.ts` | the 9-name bash-only subset (no `execute_code`, no `run_tools_with_code`) |

The SDK already pins `LOCAL_CODING_BUNDLE_NAMES` in a test so bundle changes are deliberate. **Add an equivalent pin for intent coverage:** assert every name in `LOCAL_CODING_BUNDLE_NAMES` and `CLOUDFLARE_CODING_TOOL_NAMES` emits `intent` as its first schema property. That turns "did we get them all" from a review question into a failing test.

### 6.2 Injection strategy: schemas, not factories

The key finding, which collapses most of the work: **Cloudflare has no file tools of its own.** `src/tools/cloudflare/CloudflareSandboxTools.ts` imports the local factories directly (`createLocalReadFileTool`, `createLocalWriteFileTool`, `createLocalEditFileTool`, `createLocalGrepSearchTool`, `createLocalGlobSearchTool`, `createLocalListDirectoryTool`, `createCompileCheckTool`) and reuses the shared `BashExecutionToolSchema` and `CodeExecutionToolSchema`.

So inject at the **schema definition**, never at the factory:

| Inject here | Automatically covers |
|---|---|
| the 7 local coding schemas (`src/tools/local/LocalCodingTools.ts`, `src/tools/local/CompileCheckTool.ts`) | local **and** cloudflare-sandbox engines |
| `BashExecutionToolSchema` (`src/tools/BashExecutor.ts`) | remote sandbox, local, cloudflare `bash_tool` |
| `CodeExecutionToolSchema` (`src/tools/CodeExecutor.ts`) | remote sandbox, local, cloudflare `execute_code` |
| `ProgrammaticToolCallingSchema` (`src/tools/ProgrammaticToolCalling.ts`) | `run_tools_with_code`, all engines |
| the bash PTC schema (`src/tools/BashProgrammaticToolCalling.ts`) | `run_tools_with_bash`, all engines |
| `src/tools/ReadFile.ts` | the remote engine's parallel `read_file` implementation |

Six to eight edit sites cover three engines and all file CRUD. Still verify per engine with a test: `src/tools/local/resolveLocalExecutionTools.ts` and `createCloudflareExecutionTool` (plus `CloudflareProgrammaticToolCalling.ts`) switch on names and could swap in an engine-specific schema later.

### 6.3 Full opt-in-by-default list

**SDK (`danny-avila/agents`)**

| Tool | Constant | Notes |
|---|---|---|
| `read_file` | `READ_FILE` | two implementations (remote + local) share the name |
| `write_file` | `WRITE_FILE` | |
| `edit_file` | `EDIT_FILE` | |
| `grep_search` | `GREP_SEARCH` | |
| `glob_search` | `GLOB_SEARCH` | |
| `list_directory` | `LIST_DIRECTORY` | |
| `compile_check` | `COMPILE_CHECK` | |
| `bash_tool` | `BASH_TOOL` | shared schema, all engines |
| `execute_code` | `EXECUTE_CODE` | shared schema, all engines |
| `run_tools_with_code` | `PROGRAMMATIC_TOOL_CALLING` | intent describes the whole program |
| `run_tools_with_bash` | `BASH_PROGRAMMATIC_TOOL_CALLING` | same |
| `subagent` | `SUBAGENT` | intent is the card header; `ON_SUBAGENT_UPDATE.label` stays the ticker |
| `skill` | `SKILL_TOOL` | |
| `tool_search` | `TOOL_SEARCH` | "Looking for a tool that can convert PDFs" |
| `web_search` | `WEB_SEARCH` | SDK constant; LibreChat's implementation is host-side |

**Host (`danny-avila/LibreChat`)**

| Tool | Where | Notes |
|---|---|---|
| `web_search` | host implementation | explicit priority |
| `create_file` | `CREATE_FILE_TOOL_NAME` in `agents/tools` | skill-aware file authoring |
| `edit_file` | `EDIT_FILE_TOOL_NAME` | **name collides with the SDK's**, see 6.5 |
| `set_memory` / `delete_memory` | `agents/memory` | the least legible calls in the UI today, high value |
| `ask_user_question` | `hitl/askUserQuestionTool` | strong synergy, see 10.4 |
| `file_search` | host | phase 2 |

**Deliberately excluded**

| Tool | Reason |
|---|---|
| any tool with `allowed_callers: ['code_execution']` only | no UI card exists, pure token cost |
| `lc_transfer_to_*` | prefix-excluded, direct-path dispatch, already labeled by `agent_update` |
| `check_background_task` | host machinery (optional if "Checking on the background search" proves useful) |
| image generation tools | artifact-first, the artifact is the label |

### 6.4 Each tool body must strip

Every injected tool must call `stripIntent` before validating or using its args, so no tool receives a parameter it did not declare.

### 6.5 The `edit_file` collision

`edit_file` exists in both surfaces: the SDK coding suite (`Constants.EDIT_FILE`) and LibreChat's skill-authoring tool (`EDIT_FILE_TOOL_NAME`, matched by `FILE_AUTHORING_TOOLS` in `useStepHandler.ts` alongside `create_file`). Consequences:

- Host injection must be idempotent against an SDK-injected schema (`if (INTENT_ARG in existingProps) return def;`). Add an explicit test for this pair, because double injection would move `intent` out of first position.
- Icon and label resolution in `client/src/utils` keys on the shared name, so both render identically. That should stay true.

---

## 7. Implementation: `@librechat/agents`

### 7.1 New module `src/tools/intentArg.ts`

- `INTENT_ARG = 'intent'`
- `INTENT_DESCRIPTION` (§4.1)
- `withIntent(schema)`: prepends the field. Provide both a zod variant (`z.object({ intent: ..., ...rest })`, since zod key order drives JSON schema property order) and a raw-JSON-schema variant, because tool factories use both.
- `readIntent(args)`: tolerant read handling object args and stringified-JSON args (mirror `coerceArgsObject` in `background.ts`).
- `stripIntent(args)`: returns args without the key.
- `applyOutcome(intent, { outcome, outcome_patch })`: the §4.2 precedence chain — outcome, then patch, then the intent UNCHANGED. Pure, dependency-free, exported, unit tested in isolation. The client needs identical logic, so keep it importable or mirror it exactly.
- `withoutIntent(schema)`: the embedder opt-out. Native schemas apply `withIntent` at module scope, so a consumer that renders no status label otherwise has no lever and pays the tokens unconditionally. Marker-guarded.

### 7.2 Wiring

Apply per §6.2 at the schema sites, then confirm coverage per engine. Skip tools whose `allowed_callers` is `['code_execution']` only.

### 7.3 Result threading

Carry `outcome` / `outcome_patch` from the tool return through `ToolExecuteResult` to the `ON_RUN_STEP_COMPLETED` completion event, so the host sees it without a new channel.

### 7.4 Release

Everything here ships as a minor `@librechat/agents` release (3.4.x), mirroring how #327 shipped the activity-label SDK surface ahead of its host PR. LibreChat's host slice pins the bump; older SDK versions simply never emit intents, so there is no fallback path to write.

---

## 8. Implementation: LibreChat host

### 8.1 New module `packages/api/src/agents/intent.ts`

A structural clone of `background.ts`:

| `background.ts` | `intent.ts` |
|---|---|
| `RUN_IN_BACKGROUND_ARG` | `INTENT_ARG` |
| `RUN_IN_BACKGROUND_PROPERTY` | `INTENT_PROPERTY` (frozen) |
| `injectRunInBackgroundParam` | `injectIntentParam` (**prepends**, never mutates input) |
| `canInjectRunInBackgroundParam` | `canInjectIntentParam` |
| `stripRunInBackgroundArg` | `stripIntentArg` |
| `isBackgroundRequested` | `readIntentArg` |
| `applyBackgroundToolCalls` | `applyIntentLabels` |
| `stripBackgroundFromToolDefinitions` | `stripIntentFromToolDefinitions` |
| `stripBackgroundFromToolRegistry` | `stripIntentFromToolRegistry` |
| `synthesizeBackgroundToolOptions` | `synthesizeIntentToolOptions` |
| `EXCLUDED_BACKGROUND_TOOL_NAMES` | `EXCLUDED_INTENT_TOOL_NAMES` |

Capability-specific notes:

- `canInjectIntentParam` returns false for non-object schemas (rewriting a DynamicTool string input breaks its contract) and for tools already declaring `intent`. Log a warning on skip, as background does.
- The exclusion set is much smaller than background's. Background excludes for correctness (artifact continuity, direct-path dispatch). Intent labels are inert, so exclude only `check_background_task`, `lc_transfer_to_*` by prefix, and code-execution-only tools.
- Registry parity is mandatory: deferred tools are injected at discovery time as well as load time, and `stripIntentFromToolRegistry` exists for the same reason its background sibling does.

### 8.2 Strip and capture

In `packages/api/src/agents/handlers.ts`, at the same seam that calls `stripRunInBackgroundArg` (two call sites today; match both). Read the intent for the event payload, strip before invoking. The label rides `tool_call.args` to the client, so no new request-side event field is needed; `outcome` rides the completion result.

**Do not strip intent from the args that feed activity-label batch entries.** The strip is for tool bodies; `ActivityLabelToolEntry.toolInput` should keep the intent — it is the most valuable field in that prompt (§10.10).

### 8.3 Capability plumbing

Background's flag threads through exactly four call sites. Follow all four, or agents that opted in silently lose the capability on one route:

- `api/server/services/Endpoints/agents/initialize.js`
- `api/server/controllers/agents/openai.js`
- `api/server/controllers/agents/responses.js`
- `packages/api/src/agents/openai/service.ts`

Each reads `enabledCapabilities.has(AgentCapabilities.tool_intents)` and passes `toolIntentsAvailable` into `initializeAgent`.

### 8.4 Schema and config surface

- `toolOptionsSchema` and `agentToolOptionsSchema` in `packages/api/src/agents/validation.ts`: add `describe_intent: z.boolean().optional()`. These have fully written-out Zod type annotations, so update the annotation and the runtime object together.
- `AgentToolOptions` in `packages/data-provider/src/types/assistants.ts`
- `AgentCapabilities` enum in `packages/data-provider/src/config.ts` (`tool_intents = 'tool_intents'`, alongside `deferred_tools`, `programmatic_tools`, `run_in_background`)
- `librechat.example.yaml` capability list plus a comment
- `packages/data-schemas/src/schema/agent.ts` and `types/agent.ts` doc comments (`tool_options` is `Mixed`, so no migration)

---

## 9. Implementation: UI

**Base assumption:** #14391 lands first. It extends `groupSequentialToolCalls` so THINK parts absorb into blocks terminated and labeled by an `ACTIVITY_LABEL` part, renders that label as the `ToolCallGroup` header, and auto-collapses labeled single-tool groups. Build the intent header logic on top of that shape, slotting into the §5.2 precedence chain. If the ordering flips and intent UI lands first, the precedence chain is unchanged — #14391 rebases onto it by adding its highest-precedence branch.

### 9.1 Partial-JSON intent parser

New `client/src/utils/toolIntent.ts`, heavily unit tested. This is the trickiest piece.

`useStepHandler.ts` already accumulates streamed args as a raw string:

```ts
let args = finalUpdate || typeof existingToolCall?.args === 'object'
  ? contentPart.tool_call.args
  : (existingToolCall?.args ?? '') + (toolCallArgs ?? '');
```

So mid-stream the client holds fragments like `{"intent":"Searching for OAuth han`. Required behavior for `readStreamingIntent(args): { text: string; complete: boolean } | null`:

- Handle object args (already parsed) and string args (partial).
- Handle unterminated string values, escaped quotes (`\"`), escaped backslashes, `\n`, and partial `\u` sequences (never render a half-decoded escape).
- Handle whitespace variance (`{ "intent" : "..."`).
- Return `null` cleanly when the key has not arrived, or when the leading key is not `intent` because the provider reordered.
- Never throw. Malformed fragments degrade to the default label.

### 9.2 `ToolCallGroup.tsx`

- Extend `getToolMeta` to also return the resolved label and a state marker (`streaming` / `settled` / `error`).
- Add the §5.2 branches to `resolveGroupLabel()`: settled activity label first (this is #14391's branch, already highest), then latest in-flight intent, then latest settled outcome, then the existing subagent / ask-question / `Used N tools` chain.
- Keep #14391's auto-collapse behavior for labeled groups; an intent header alone does not trigger auto-collapse (only a resolved activity label does).
- Keep `CategoryIcon` selection and `StackedToolIcons` behavior unchanged.
- Keep `toolNameSummary`.
- Move the count into `aria-label`.

### 9.3 Per-card label

Same precedence in the single-card path (`ToolCall.tsx`, `getToolDisplayLabel`). A group only exists at count ≥ 2, so a solo call must not regress. Note #14391's labeled single-tool groups: a solo call inside a labeled block keeps its own intent/outcome as the card label beneath the activity header.

### 9.4 Streaming effect

No synthetic typewriter needed. The text genuinely arrives token by token because providers stream tool inputs.

- Render the accumulating string directly.
- Trailing shimmer via a CSS gradient mask on the last few characters, plus the existing `animate-pulse` on the icon while `!allCompleted && isSubmitting`.
- **Single line, `truncate`, fixed height.** A growing label must not reflow the message. Do not call `scheduleMessageContentLayoutReconcile` per token; it exists for expand/collapse.
- Crossfade or brief highlight when the label flips from intent to outcome (and again when the activity label takes over), so each in-place edit reads as an edit rather than a flicker.
- Respect `prefers-reduced-motion`: no shimmer, just text.
- Consider a 150 to 250ms minimum display time per header label so a fast burst does not make the header unreadable, without delaying underlying state.

### 9.5 Sanitization

These strings are model-authored and now render in application chrome. Treat as untrusted:

- Strip newlines and control characters.
- Cap at ~120 characters with ellipsis (the model is instructed to be brief; enforce anyway).
- Plain text only, no markdown, no HTML.
- Full text in a `title` attribute or the expanded view.
- Sanitize at render, not at ingest, so persisted data stays faithful.

### 9.6 i18n

New keys only for fallback and error framings. The model-authored sentence is unlocalized, which is acceptable because the model already replies in the user's language. If insufficient, add a locale hint to the arg description in a follow-up rather than post-translating.

---

## 10. Interaction with the other tool capabilities

Each subsection is a decision, not a discussion.

### 10.1 With `defer_loading`

- Inject at **both** the initial load path and the discovery-promotion path in `packages/api/src/agents/run.ts`. A tool discovered mid-conversation must arrive with `intent` already first, or its first call renders with the legacy label while later calls do not.
- The idempotent guard is mandatory, since a promoted tool passes through injection twice.
- **Token accounting must run after injection.** `AgentContext` tracks `toolTokenCounts` and `deferredToolNames`, consumed by the pruner's calibration. Injecting 40 to 60 tokens per tool after counting understates the schema budget. Verify ordering and add a test that a counted deferred tool's count reflects the injected property.
- `stripIntentFromToolRegistry` prevents a self-spawned child using tool search from rediscovering a host-injected schema it cannot honor.

### 10.2 With `allowed_callers` (PTC)

| Tool's `allowed_callers` | Inject? | Required? |
|---|---|---|
| `['direct']` or omitted | yes | may be required for SDK natives |
| `['direct', 'code_execution']` | yes | **never required** |
| `['code_execution']` | no | n/a |

The dual-caller rule is load-bearing. PTC generates callable signatures from tool schemas for the in-sandbox bridge (`normalizeToPythonIdentifier`, `filterToolsByUsage`). A required `intent` would force every model-written `await write_file(...)` to pass a label no UI displays. Keep it optional there; the bridge must tolerate absence.

The PTC runners themselves carry intent, describing the program as a whole. Inner calls stay unlabeled: the sandbox is one card.

Confirm intent is stripped before the sandbox bridge serializes inner-call inputs, so a stray `intent` never reaches a tool body through the programmatic path.

### 10.3 With `run_in_background`

The most intertwined pairing, since both inject into the same schema.

**Ordering.** Run `applyIntentLabels` **before** `applyBackgroundToolCalls`, and confirm `injectRunInBackgroundParam` appends (`{ ...existingProps, [RUN_IN_BACKGROUND_ARG]: ... }`) rather than prepends. It currently appends, so the order holds; pin it with a test asserting `Object.keys(properties)[0] === 'intent'` on a tool with both capabilities.

**Label lifecycle.**

- A backgrounded call returns a synthetic handle immediately. That instant "completion" is not a real outcome, so it must **not** settle the label. Keep the intent, reframed (`Searching for OAuth handling · in background`), and treat the call as in-flight for the §5.2 header rule. Otherwise a fire-and-forget dispatch hijacks the header with a fake outcome while real work continues.
- The real outcome arrives at harvest. `background.ts` already patches the dispatch turn's tool-call output and attaches files via `attachHarvest` / `getBackgroundCodeDelivery`, signalling the client with `BACKGROUND_STATUS_ATTACHMENT_TYPE`. **Patch the label at that same seam.** The existing idempotent re-emission on every poll works in our favor.
- A task reaped as timed out (`RUNNING_TASK_TTL_MS`) must resolve to an error-framed label, not shimmer forever. The `harvestStarted` marker set at dispatch exists so never-settling tasks still take the heal path.

**Self-spawn stripping.** `stripBackgroundFromToolDefinitions` and `stripBackgroundFromToolRegistry` need intent siblings, called from the same place.

**Cost.** A tool with both carries two injected properties. Include that combination in the token measurement.

### 10.4 With HITL and `ask_user_question`

The strongest synergy in the feature, and nearly free.

`PreToolUse` `ask` decisions raise a LangGraph `interrupt()` carrying a `HumanInterruptPayload`, rendered by the approval UI, which today leads with a tool name and a JSON args blob. **Thread `intent` into the payload and lead with it.** "Approve: Deleting the staging database migrations" is a materially better consent prompt, and this is exactly where a bad approval is expensive.

- **Resume re-execution:** `HumanInTheLoopConfig` documents that an approved batch is re-executed on resume. Intent lives in args, so it survives unchanged. No work, but assert it.
- **`updatedInput`:** a `PreToolUse` hook can rewrite args, leaving the intent stale. Decision: **hooks may also rewrite `intent`**, documented in the hook docs. The alternative (marking the label as modified) is worse UX.

`ask_user_question` itself gets intent; the existing `Asking/Asked N questions` group label yields per §5.3 while keeping the question glyph.

### 10.5 With subagents

- The `subagent` tool's intent is the parent-side card header. The existing `ON_SUBAGENT_UPDATE` `label` (`Subagent "x" started`) remains the ticker line beneath it. Do not merge them.
- Child tool calls carry their own intents, aggregated into `subagent_content` by `foldSubagentEvent`. Worthwhile enrichment: surface the child's **latest** intent in the parent's collapsed ticker, so a running subagent reads `Delegating the OAuth audit · Reading callback router` without expanding. `tickerState` and `latestLabel` already exist in the Recoil atom.
- Self-spawned children must have intent stripped from inherited definitions and registry.
- Note #14391 skips subagent scopes for activity labels (their content belongs to the spawning tool call), so inside a subagent the intent layer is the *only* labeling layer. That makes SDK-native injection (§6.3) matter doubly there.

### 10.6 With tool output references

`{{tool<i>turn<n>}}` placeholders are substituted into **any string arg** immediately before invocation, and the registry stores raw untruncated output up to ~400KB per entry.

**`intent` must be excluded from placeholder substitution.** Otherwise a model writing `{{tool0turn0}}` inside its intent dumps hundreds of kilobytes into a single-line label. Add the exclusion in the substitution pass, not just a render-time cap, so the oversized string never reaches persistence. This is a real bug the feature would introduce if built naively.

Positive side: a follow-up can label each `tool<i>turn<n>` key with its intent, so both the model and a debugging human can see which reference holds what.

### 10.7 With eager event tool execution

- Because `intent` is the first key, it is present in every partial and cannot delay the eager completeness gate.
- If args are revised after an eager start, the intent may change. The label must accept revision without flicker; the existing arg-accumulation logic handles it.
- No change to `excludeToolNames`. Intent does not affect whether a tool is safe to speculate on.

### 10.8 With compaction, pruning, and tracing

- **Compaction:** when the pruner drops tool bodies, retain `intent` and `outcome`. That is the anchor ledger in §11 and the cheapest way for a summarized session to retain a record of its own actions.
- **Langfuse:** covered in full in §11.3 — intent as span-level anchor, following #14391's tracing conventions and redaction-policy selection.

### 10.9 Composition test matrix

| Combination | Assertion |
|---|---|
| intent + `run_in_background` | `intent` first key, `run_in_background` present, order stable |
| intent + backgrounded dispatch | dispatch does not settle the label; harvest patches it |
| intent + background timeout | reaped task resolves to an error label |
| intent + `defer_loading` | discovered tool arrives injected; token count includes it |
| intent + `allowed_callers: ['code_execution']` | not injected |
| intent + `['direct','code_execution']` | injected, not required; PTC bridge tolerates absence |
| intent + PTC inner call | inner tool body receives no `intent` key |
| intent + HITL `ask` | interrupt payload carries the intent |
| intent + HITL `updatedInput` | hook-rewritten intent is honored |
| intent + self-spawn subagent | stripped from both definitions and registry |
| intent + tool output references | `{{...}}` in `intent` is not substituted |
| intent + activity label | header phases in order; resolved activity label wins; batch entries keep intent |
| intent + all three other caps | one tool, all enabled, schema valid, `intent` first |

### 10.10 With activity groups (PR #14391)

Not a capability, but the most consequential composition in the feature, so it gets the same decision treatment.

- **Layering, restated as the rule:** intents are per-call, model-authored, free, and live; activity labels are per-block, fast-model-authored, paid, and settled. The §5.2 three-phase header is the entire UI contract between them. Neither system replaces the other, and neither is configured by the other: activity labels stay per-endpoint `librechat.yaml` config (`activityLabel`, `activityModel`, …), intents stay a per-tool capability.
- **Intents make activity labels better and cheaper.** `ActivityLabelToolEntry.toolInput` carries the call args, and #14391's header prompt explicitly forbids restating tool names, counts, and argument echoes — it wants exactly the human-readable material intents provide. With intents present, the labeling model reads `"Searching for OAuth handling in the callback router"` instead of raw JSON. Per §8.2, the handler strip must not remove intent from the batch entries; add a test pinning that the entry serialization keeps it.
- **No shared plumbing to build.** Intents ride `tool_call.args`; activity labels ride an `ACTIVITY_LABEL` content part with its own `on_activity_label` SSE event, epoch-scoped fills, and index-space reconciliation. Do not couple the transports. In particular, intents must not add content parts — that immunity to #14391's index-space hazards (§5.4) is a feature, not an accident.
- **Auto-collapse:** #14391 auto-collapses labeled single-tool groups. Keep that keyed on the activity label only. An intent-labeled but activity-unlabeled group stays expanded per current behavior.
- **Landing order:** the UI slice (slice 4) rebases on #14391's `ToolCallGroup` / `groupSequentialToolCalls` shape. Coordinate before merge — #14391 is still moving.

---

## 11. Activity labels, Langfuse anchors, and session snapshots

### 11.1 Current state, precisely

The SDK layer is **shipped**: `Run.generateActivityLabel`, `RunActivityLabelOptions`, `ActivityLabelToolEntry`, `ACTIVITY_LABEL_PROMPT` in `src/prompts/activityLabel.ts`, and the UI-only `activity_label` content type are all published in `@librechat/agents@3.3.0` (danny-avila/agents#327). The host layer that consumes it is [#14391](https://github.com/danny-avila/LibreChat/pull/14391), open and near merge. This spec builds on both; §10.10 covers the UI composition. What remains here is the trace story and the anchor ledger.

### 11.2 The two-layer anchor model

- **Intent labels are per-call and free.** Written inline by the model, zero extra inference. They answer "what is this span doing" at the finest grain.
- **Activity labels are per-block and cost a fast-model call.** They answer "what did this stretch of the run accomplish," past-tense and outcome-first.
- Together they make a session skimmable at two zoom levels — in the chat UI (§5.2) and, below, in traces.

### 11.3 Langfuse: intents as span-level anchors

Borrow #14391's tracing decisions wholesale; they are the template for how a labeling layer reaches Langfuse correctly.

What #14391 established:

- Label generations are traced through `run.generateActivityLabel` with the **conversation as the Langfuse session** and a per-batch trace seed, so they group under their conversation (trace name `LibreChat Activity Label`, tags `["librechat", "activity-label"]`) instead of appearing as orphans.
- The executing agent is forwarded (`RunActivityLabelOptions.agentId`), which selects that agent's trace metadata **and its tool-output redaction policy** — a stricter per-agent overlay cannot leak through the label path.

What intents add — with **no new model call and no new trace**:

- **Name or annotate the existing tool spans with the intent.** The SDK's trace shaping (`src/langfuseTraceShaping.ts`, `src/langfuseToolOutputTracing.ts`) already builds the tool span; attach `intent` at span start and patch in `outcome` at settle. A session trace then reads as a narrative — `Searching for OAuth handling → Found 12 results` — without opening a single span payload. This is the "what has the agent been up to" view, answered from the trace list alone.
- **Redaction stance:** intent is a model-authored *argument*, not tool output. It follows the args-tracing policy, not the output-redaction policy (`shouldRedactTool` guards outputs). But when a tool's args are redacted for an agent, its intent must be too — the intent is a distillation of the args and would otherwise be a side channel. Decide this in the same config object, not ad hoc per call site.
- **Tagging:** mirror the convention — tag intent-annotated spans `["librechat", "tool-intent"]` so both label layers are queryable as families in Langfuse.

This lands as part of slice 6, in `~/agentus`, since the trace shaping lives there.

### 11.4 Anchor ledger

Persist a compact per-turn array derived from settled calls:

```ts
type IntentAnchor = {
  toolCallId: string;
  toolName: string;
  intent: string;
  outcome?: string;
  status: 'success' | 'error' | 'cancelled';
  ts: number;
  agentId?: string;
};
```

This unlocks four things that are otherwise hard:

1. **Turn timelines.** A scrubbable "what happened in this turn" list with jump-to-anchor, and meaningful collapsed headers for long agentic turns.
2. **Compaction survival.** Keep the ledger when the pruner drops tool bodies. Feed it to the summarizer prompt or inject as a `source: 'system'` meta message.
3. **Named checkpoints.** `Run.rewindFiles()` and `checkpointForkSeq` exist but have no human-readable labels. "Rewind to *Rewriting the zod schema*" is what makes rewind usable by a person rather than a debugger.
4. **Analytics.** Intent text is queryable: which intents precede failures, which tools get vague intents, how often the model makes redundant sibling calls.

Treat the ledger as a follow-up slice, but design label resolution so it is a trivial derivation rather than a rewrite.

---

## 12. Builder toggles

Mirror #14407's shared-switch approach. One `client/src/components/SidePanel/Agents/Intent.tsx` writing `tool_options[toolId].describe_intent`, reused by:

- `MCPToolItem.tsx` via `OptionToggle` (distinct glyph and `activeClass`; `defer_loading` uses `Clock` / amber)
- `ToolSection` for plugin tools
- the Code card
- the action dialog, carrying over the same `---` vs `_` encoded-domain aliasing #14407 documents. That bug (opt-ins silently no-oping for short hostnames like `slack.com`, `openai.com`) will recur verbatim if the aliasing is not brought along.

Add a "Describe all tools" bulk affordance alongside the existing `com_ui_mcp_defer_all`, since per-tool toggling across a large MCP server is tedious. New locale keys follow the `com_ui_mcp_*` naming pattern, written for a non-technical admin.

---

## 13. Risks and open decisions

1. **Token cost.** Roughly 40 to 60 schema tokens per opted-in tool, plus 10 to 25 output tokens per call. With a large MCP server opted in wholesale this is material, and "native tools on by default" means the default agent pays. **Measure a representative coding turn before and after and put the number in the PR.**
2. **OpenAI strict function calling** requires every property in `required`. An optional injected property is a problem under strict mode. `run_in_background` has identical exposure, so first confirm whether strict is in play on any path; if so, either add `intent` to `required` for those providers or skip injection there.
3. **Provider arg ordering is convention, not contract.** Some providers may reorder keys or deliver args in one chunk. The UI must degrade silently to "no label until parsable". Never assert on ordering at runtime.
4. **Required vs optional on native tools.** Optional is safer and non-breaking; required measurably improves compliance. Recommendation: required for SDK natives (we control every caller), optional for host-injected third-party tools. Cost: any code constructing native tool inputs by hand, including tests and PTC-generated inner calls, must supply `intent`.
5. **Sibling-call collision.** Models tend to emit identical intents for parallel calls to one tool, which defeats the reference case entirely. Mitigated by the description clause in §4.1. Verify empirically across Anthropic, OpenAI, and Google; if compliance is poor, consider a client-side disambiguating suffix.
6. **Header churn.** Fast parallel bursts make the header flicker. Minimum display time per §9.4.
7. **Untrusted display text.** First time model-authored free text renders in collapsed chrome. §9.5 applies.
8. **Deferred double-injection.** Discovery-time and load-time paths both inject; guard idempotently.
9. **In-flight base for the UI slice.** #14391 is open and still moving (its PR notes flag follow-ups around run-step index math and parallel-column lanes). Slice 4 must rebase on its final `ToolCallGroup` shape; coordinate the merge order rather than racing it. Intents themselves are insulated (§5.4 — args, not content parts), so only the header-precedence branch is exposed to churn.

---

## 14. Test plan

**SDK**
- `applyOutcome` precedence: outcome, outcome_patch, then the intent UNCHANGED. Assert no tense rewrite across English, non-English, lowercase and single-word labels — a regression here reintroduces the locale split (§4.2).
- `outcome_patch` replaces first occurrence only, case-sensitive, no-op when `from` is absent.
- `withIntent` places `intent` first in the emitted JSON schema, both zod and raw variants.
- Coverage pin: every name in `LOCAL_CODING_BUNDLE_NAMES` and `CLOUDFLARE_CODING_TOOL_NAMES` emits `intent` first.
- Every native tool body receives args without `intent`.
- `allowed_callers: ['code_execution']` tools are not injected.
- Trace shaping attaches intent at span start and outcome at settle; redacted-args agents get neither.

**Host** (clone `background.spec.ts` structure)
- Injection is first-key and non-mutating; frozen input defs survive.
- Idempotent when the property already exists (including the SDK/host `edit_file` pair).
- Non-object schema skipped with a warning.
- Tool declaring its own `intent` skipped with a warning.
- Registry parameters updated alongside definitions.
- `stripIntentFrom{ToolDefinitions,ToolRegistry}` remove it for self-spawn.
- `synthesizeIntentToolOptions` covers ephemeral and model-spec agents.
- Capability off means no injection, on all four routes.
- `---` vs `_` action-name aliasing resolves (#14407's lesson).
- Deferred discovery path injects.
- Activity-label batch entries retain `intent` after the handler strip.
- Plus the full §10.9 composition matrix.

**Client**
- `readStreamingIntent` against a fragment table: empty, `{`, `{"in`, `{"intent"`, `{"intent":"`, `{"intent":"Sea`, escaped quote mid-value, escaped backslash, `\n`, partial `\uD83D`, complete value, complete object, reordered keys, malformed garbage. None throw.
- Header shows latest in-flight intent while any call is in flight.
- Header shows latest settled outcome when all settled, and does not revert to `Used N tools`.
- A resolved activity label takes over the header and is not displaced by earlier outcomes (§5.2 phase 3).
- An intent-labeled group without an activity label does not auto-collapse.
- Out-of-order settlement does not rewind the header.
- Two sibling `search_code` calls render two distinct card labels (assert the reference case directly).
- Subagent and ask-question groups keep glyphs while showing intent text.
- No intent anywhere falls back to current labels exactly.
- Error and cancelled states render their own framing.
- Labels survive a reload from persisted args.
- Long label truncates without changing group height.
- Backgrounded dispatch keeps the in-flight framing.

**Builder**
- Toggle writes and clears `tool_options[id].describe_intent` without disturbing sibling keys.
- Capability off hides the switch.
- Bulk toggle applies across a server.

**Manual verification for the PR**
Enable `tool_intents`, attach a GitHub MCP server, ask the agent to search the repo for two different things in one turn. Confirm: two distinct streaming labels, header tracking the live call, header settling on the last outcome, reload preserving labels, capability off restoring `Used 2 tools — github`. Then repeat with `run_in_background` also enabled on the same tool and confirm the dispatch keeps its in-flight framing until harvest. Finally, repeat with `activityLabel: true` on the endpoint and confirm the three-phase header: live intent while streaming, outcome at settle, fast-model header taking over when it resolves.

---

## 15. Slicing

Six PRs, each independently reviewable and shippable. Dependencies are explicit because three of them sequence against in-flight work:

1. **SDK core** (`danny-avila/agents`). `intentArg.ts`, `applyOutcome`, `outcome` / `outcome_patch` on results, `ToolNode` threading, unit tests. No behavior change until a tool opts in.
2. **SDK native tools** (`danny-avila/agents`). Schema-level injection per §6.2, coverage pin test, all three engines. Slices 1–2 can ship as one minor release (3.4.x), mirroring how #327 shipped ahead of its host PR.
3. **Host** (LibreChat, requires the published SDK bump). `intent.ts`, `handlers.ts` strip, capability plumbing through all four routes, schema and config surface, `web_search`, `create_file` / `edit_file`, memory tools, tests cloned from `background.spec.ts`.
4. **UI** (LibreChat, **rebases on #14391's `ToolCallGroup` shape — land after it**). Partial-JSON parser, per-card label, three-phase group header, shimmer, sanitization, i18n fallbacks.
5. **Builder toggles** (LibreChat, **after #14407** so the switches extend its shared component rather than forking it). Including encoded-domain aliasing and the bulk toggle.
6. **Anchors, traces, and activity-label integration** (both repos, **after #14391 merges**). Langfuse span annotation per §11.3, batch-entry enrichment per §10.10, ledger derivation, compaction survival, HITL payload threading, named checkpoints.

**Documentation** in `librechat.ai`: a single **"Tool capability conventions"** page documenting `defer_loading`, `allowed_callers`, `run_in_background`, and `describe_intent` as one family, with the shared shape spelled out (per-tool `tool_options` key, admin capability gate, injection or metadata mechanism, self-spawn stripping obligation, token cost). Plus a `librechat.example.yaml` entry, and a cross-reference from the activity-labels docs explaining the two-layer labeling model (§11.2) so admins understand they compose rather than compete. This page is the deliverable that turns four features into a convention, so it is not optional.
