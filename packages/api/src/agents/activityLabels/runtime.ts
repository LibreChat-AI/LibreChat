import { logger } from '@librechat/data-schemas';
import { Constants } from 'librechat-data-provider';
import { initializeModel } from '@librechat/agents';
import type { ClientOptions, HookCallback, HookInputByEvent, Providers } from '@librechat/agents';

type PostToolBatchInput = HookInputByEvent['PostToolBatch'];
type BatchEntry = PostToolBatchInput['entries'][number];

/** Resolved provider + client options for the label model call. */
export interface ActivityLabelLLM {
  provider: Providers;
  clientOptions: ClientOptions;
  /**
   * Token config of the endpoint the LABEL runs on, which differs from the
   * agent's whenever `activityEndpoint` is set. Pricing must use this or a
   * cross-endpoint label is costed at the wrong rates.
   */
  endpointTokenConfig?: unknown;
  /**
   * True when the label resolved to the agent's OWN endpoint. Callers need
   * this to read an undefined `endpointTokenConfig` correctly: for a built-in
   * label endpoint undefined means "price from the shared table", so
   * inheriting the agent's custom rates there would misprice the label.
   */
  sameEndpoint?: boolean;
}

/**
 * Batch metadata handed to the host at slot-claim time (all deterministic).
 *
 * Deliberately carries no tool-type tally. A tally can only restate the tool
 * cards rendered directly beneath the header ("ran 1 command"), so it has no
 * place in either the prompt or the UI; the header earns its row solely by
 * saying something the cards cannot.
 */
export interface ActivityLabelBatchMeta {
  toolCallIds: string[];
  /** ok = all succeeded, failed = all failed, partial = mixed. */
  status: 'ok' | 'partial' | 'failed';
  /** Owning agent in multi-agent graphs — lets the host stamp the part for lane grouping. */
  executingAgentId?: string;
}

/**
 * Block context captured host-side at claim time (before more parts stream
 * in): reasoning excerpts from the block and the assistant's preceding text.
 * Never contains human messages.
 */
export interface ActivityLabelBlockContext {
  thinkingExcerpts?: string[];
  lastAssistantText?: string;
  lastAssistantPhase?: 'commentary' | 'final_answer';
}

/**
 * A content slot claimed synchronously at the batch boundary. `fill` is
 * called later (or with `null` on failure) once the label resolves.
 */
export interface ActivityLabelSlot {
  index: number;
  /**
   * Resolves `true` when the fill COMMITTED (mutated content + emitted) and
   * `false` when the host dropped it because the response already finalized.
   * Usage accounting keys on this: a dropped label must not be billed.
   */
  fill: (text: string | null) => boolean | Promise<boolean>;
  /** Snapshot of block context, captured synchronously at claim time. */
  context?: ActivityLabelBlockContext;
}

/** Payload handed to the host's `generateLabel` (SDK-backed) implementation. */
export interface GenerateLabelPayload {
  entries: BatchEntry[];
  context: ActivityLabelBlockContext;
  /**
   * Committed headers from earlier batches in this run (run order, most
   * recent last, max {@link MAX_PREVIOUS_LABELS}) — continuity context so
   * consecutive same-activity batches extend the story instead of restating
   * it. Present only when at least one earlier label committed. An SDK
   * without the field ignores it harmlessly; the fallback path renders it
   * regardless.
   */
  previousLabels?: string[];
  /** Deterministic Langfuse trace seed, unique per slot. */
  traceSeed: string;
  signal: AbortSignal;
  /** Effective per-entry truncation, forwarded so host and SDK prompts agree. */
  charLimit: number;
  /**
   * Instruction for the label model. Always sent: left unset, the SDK falls
   * back to its own generic past-tense prompt and the register defined here
   * never reaches the preferred path.
   */
  prompt?: string;
  /**
   * Owning agent of the batch. Selects that agent's tracing metadata AND its
   * tool-output redaction policy on the SDK path, so a handoff is not traced
   * or redacted under the default agent's configuration.
   */
  executingAgentId?: string;
  /**
   * Defers usage accounting until AFTER the slot commits. A generator that
   * bills inline consumes the settlement window with its balance write, so
   * the deadline can expire mid-write — the charge lands but the fill is
   * then dropped as out-of-scope: billed, never shown. Registering the
   * accounting here instead lets the hook commit the visible label first and
   * only then run it, and only for a committed fill. The hook passes a lazy
   * {@link LabelUsageEstimate} on the success path so the biller can fall
   * back to title-style estimated billing when the provider omits usage.
   */
  deferUsage: (collect: (estimate?: () => LabelUsageEstimate) => void | Promise<void>) => void;
}

/**
 * Text the biller can count locally when the provider omits usage metadata,
 * following the title convention of estimate-based billing. Produced lazily —
 * tokenizing costs CPU, so the thunk runs only when real usage is absent.
 */
export interface LabelUsageEstimate {
  promptText: string;
  completionText: string;
}

/** Per-generation LLM callbacks for usage accounting on the fallback path. */
export interface ActivityLabelInvokeCallbacks {
  callbacks: Array<Record<string, unknown>>;
  collect: (estimate?: () => LabelUsageEstimate) => void | Promise<void>;
}

export interface ActivityLabelHookOptions {
  /**
   * Synchronously claims the next live content index on the host (push
   * placeholder part + bump the shared index offset, exactly like steering's
   * `applySteerPart`). Receives deterministic batch metadata so the
   * placeholder is informative before the LLM label lands. Must be cheap
   * — it runs inside the awaited hook.
   */
  claimSlot: (meta: ActivityLabelBatchMeta) => ActivityLabelSlot;
  /**
   * Preferred generation path: host bridges to the SDK's
   * `run.generateActivityLabel()` (session-grouped Langfuse tracing).
   *
   * Resolve `undefined` to decline — the SDK lacks the API — and the hook
   * falls back to a direct, untraced model call via `resolveLLM`. `null`
   * means the opposite: this path ran and produced no label, so the slot
   * fills empty. Hosts wire this bridge unconditionally (the run does not
   * exist yet at construction time), which is why declining has to be
   * expressible at call time rather than by omitting the option.
   */
  generateLabel?: (payload: GenerateLabelPayload) => Promise<string | null | undefined>;
  /**
   * Fallback model resolution for the direct-call path. Memoized here so
   * hosts can pass a fresh thunk without caching concerns.
   */
  resolveLLM: () => Promise<ActivityLabelLLM>;
  /** Run abort signal; in-flight label calls are also bounded by a timeout. */
  signal?: AbortSignal;
  /**
   * Factory for per-generation LLM callbacks (fallback path only): fresh
   * aggregator per call, `collect()` invoked after a successful response so
   * label calls participate in usage accounting like titles do.
   */
  getInvokeCallbacks?: () => ActivityLabelInvokeCallbacks;
  /** Cap on labels per run (cost guard). Default 20. */
  maxPerRun?: number;
  /** Per-entry output truncation for the prompt. Default 600 chars. */
  charLimit?: number;
  /**
   * `activityPrompt` override. Applies to BOTH paths: the SDK bridge passes
   * it through, and the direct fallback seeds `buildPrompt` with it instead
   * of the built-in instruction.
   */
  prompt?: string;
  /**
   * Labels already present on the response (HITL resume rebuilds the hook
   * with pre-pause content), so the per-response cap counts them instead of
   * restarting at zero after every approval.
   */
  initialGeneratedCount?: number;
  /**
   * Committed label texts already on the response, keyed by content index —
   * the continuity seed for a HITL resume, so post-approval batches still
   * see the pre-pause headers. Unfilled reservations are excluded by the
   * host; only text the user is actually reading belongs here.
   */
  initialLabels?: ReadonlyArray<{ index: number; text: string }>;
  /**
   * Receives the whole detached task (generate → fill → deferred usage) so
   * the host's bounded settle covers the accounting too. Deferring usage
   * until after the commit moved it PAST the fill's resolution, so a settle
   * keyed on fills alone could let finalization flush the usage sink and
   * snapshot metadata while the label's billing was still in flight. The
   * task never rejects.
   */
  trackTask?: (task: Promise<void>) => void;
}

const DEFAULT_MAX_PER_RUN = 20;
const DEFAULT_CHAR_LIMIT = 600;
/** Continuity window: matching the SDK prompt builder's own cap, and small
 *  because the point is avoiding a restatement of what is on screen NEAR the
 *  new header — a 20-label history would only dilute the batch content. */
const MAX_PREVIOUS_LABELS = 3;
/** Intent-line truncation only. Tool inputs and outputs both truncate at the
 *  configured `activityCharLimit` — the schema documents it as the per-entry
 *  limit for BOTH, so a hard-coded input cap would make the setting unable to
 *  reach a distinguishing path or query past the first 200 characters. */
const INTENT_CHAR_LIMIT = 200;
const SUMMARY_TIMEOUT_MS = 12_000;
/** Total budget for the entries section. Per-entry truncation alone leaves
 *  the batch dimension unbounded — a parallel batch of hundreds of calls
 *  would build a prompt past the fast model's window and bill input tokens
 *  far beyond what a one-line header justifies. Scales with the configured
 *  per-entry limit so a raised `activityCharLimit` still fits several
 *  entries; entries past the budget are skipped WITHOUT serializing them. */
const ENTRIES_CHAR_BUDGET = 8_000;
/** Hard bound on the PERSISTED label. The instruction asks for 4–9 words, but
 *  a model that ignores it — or is steered by injection through untrusted
 *  tool output — could otherwise turn one header into thousands of tokens
 *  duplicated through SSE, the durable chunk log, persistence, and the UI. */
const LABEL_OUTPUT_CHAR_LIMIT = 200;

/**
 * Normalizes raw model output into a header: the first non-empty line,
 * whitespace collapsed, hard-capped at {@link LABEL_OUTPUT_CHAR_LIMIT}. A
 * header renders as one line, so everything past the first line break is
 * noise at best and injected payload at worst.
 */
export function normalizeLabelOutput(text: string | null | undefined): string {
  if (text == null) {
    return '';
  }
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  return collapsed.length > LABEL_OUTPUT_CHAR_LIMIT
    ? `${collapsed.slice(0, LABEL_OUTPUT_CHAR_LIMIT - 1)}…`
    : collapsed;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * Serializes at most `limit + 1` characters of an arbitrary value. Tool
 * outputs are unbounded — a multi-megabyte result would otherwise be fully
 * materialized by `JSON.stringify` on EVERY detached label task just to keep
 * a few hundred characters, blocking the event loop for prompt fodder that
 * is immediately discarded. Traversal stops the moment the budget is spent
 * (the overshoot marks that `truncate` must append its ellipsis), which also
 * bounds cyclic structures: every level emits before recursing, so depth can
 * never exceed the budget. Output is JSON-shaped, not guaranteed JSON.
 */
function stringifyBounded(value: unknown, limit: number): string {
  const out: string[] = [];
  let length = 0;
  const push = (chunk: string): boolean => {
    out.push(chunk);
    length += chunk.length;
    return length <= limit;
  };
  const walk = (val: unknown): boolean => {
    if (typeof val === 'string') {
      /** Slice BEFORE quoting — quoting is what materializes the copy. */
      return push(JSON.stringify(val.length > limit + 1 ? val.slice(0, limit + 1) : val));
    }
    if (val == null || typeof val === 'number' || typeof val === 'boolean') {
      return push(String(val));
    }
    if (Array.isArray(val)) {
      if (!push('[')) {
        return false;
      }
      for (let i = 0; i < val.length; i++) {
        if ((i > 0 && !push(',')) || !walk(val[i])) {
          return false;
        }
      }
      return push(']');
    }
    if (typeof val === 'object') {
      const toJSON = (val as { toJSON?: () => unknown }).toJSON;
      if (typeof toJSON === 'function') {
        try {
          return walk(toJSON.call(val));
        } catch {
          return push(String(val).slice(0, limit + 1));
        }
      }
      if (!push('{')) {
        return false;
      }
      let first = true;
      /** for-in, not Object.keys: enumeration stops at the budget instead of
       *  materializing a key array for a million-property object first. The
       *  own-property guard replaces what Object.keys implied. */
      for (const key in val) {
        if (!Object.prototype.hasOwnProperty.call(val, key)) {
          continue;
        }
        const entry = (val as Record<string, unknown>)[key];
        if (entry === undefined || typeof entry === 'function') {
          continue;
        }
        /** Keys are untrusted too: slice BEFORE quoting, exactly like string
         *  values — quoting is what materializes the copy. */
        const boundedKey = key.length > limit + 1 ? key.slice(0, limit + 1) : key;
        if ((!first && !push(',')) || !push(`${JSON.stringify(boundedKey)}:`) || !walk(entry)) {
          return false;
        }
        first = false;
      }
      return push('}');
    }
    return push(String(val).slice(0, limit + 1));
  };
  walk(value);
  return out.join('').slice(0, limit + 1);
}

export function stringifyActivityEvidence(value: unknown, limit: number): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.length > limit + 1 ? value.slice(0, limit + 1) : value;
  }
  try {
    return stringifyBounded(value, limit);
  } catch {
    return String(value).slice(0, limit + 1);
  }
}

/**
 * Deterministic batch facts: which tool calls the label covers (for lane
 * stamping) and whether they succeeded (for failure tinting). No tool-type
 * tally — see {@link ActivityLabelBatchMeta}.
 */
export function classifyBatch(entries: BatchEntry[]): ActivityLabelBatchMeta {
  const toolCallIds: string[] = [];
  let failures = 0;
  for (const entry of entries) {
    toolCallIds.push(entry.toolUseId);
    if (entry.status === 'error') {
      failures += 1;
    }
  }
  let status: ActivityLabelBatchMeta['status'] = 'partial';
  if (failures === 0) {
    status = 'ok';
  } else if (failures === entries.length) {
    status = 'failed';
  }
  return { toolCallIds, status };
}

/**
 * The header sits directly above the tool cards it summarizes, so anything
 * the cards already display — tool names, how many ran, the arguments — is
 * noise when repeated. What the cards cannot show is the point of the batch
 * and how it came out, and that is the only thing worth a row of screen.
 *
 * Because this fires after the batch, the tool OUTPUTS are available: prefer
 * the answer the calls produced over a restatement of what was attempted.
 *
 * Sentence ORDER is deliberate, not stylistic: content rules first and
 * format rules last measurably improves both format adherence and opening-
 * verb diversity on small label models (eval corpus:
 * scripts/activity-labels/), so a reshuffle here regresses real output.
 */
export const ACTIVITY_INSTRUCTION: string = [
  'You write the one-line header above a group of tool calls an AI agent just made.',
  'Say what the calls established or produced — the outcome, not the attempt. If they answered a question, the answer is the line.',
  'Write it like a git commit subject: past tense, verb first, leading with the most distinctive file, name, or finding.',
  'Good: "Confirmed /mnt/data resets between calls". "Traced the leak to formatAgentMessages". "Found 3 failing auth tests".',
  'Bad: "Ran 1 command". "Used bash_tool twice". "Executed ls /mnt/data". "Searched the codebase".',
  'If every call failed, say what failed and why, plainly.',
  'A "Previous headers" list may precede the batch: never restate one — if this batch continues that activity, say only what is new.',
  'Never name the tools, never count them, never echo the arguments: the cards below the header already show all three.',
  'Write 4 to 9 words, sentence case, no trailing punctuation, no quotes or markdown.',
  'Output only the line.',
].join(' ');

export function buildPrompt(
  entries: BatchEntry[],
  charLimit: number,
  context?: ActivityLabelBlockContext,
  instruction?: string,
  previousLabels?: string[],
): string {
  const sections: string[] = [instruction ?? ACTIVITY_INSTRUCTION];
  if (previousLabels != null && previousLabels.length > 0) {
    sections.push(
      'Previous headers in this run (most recent last):\n' +
        previousLabels
          .slice(-MAX_PREVIOUS_LABELS)
          .map((label) => `- ${label}`)
          .join('\n'),
    );
  }
  if (context?.lastAssistantText && context.lastAssistantPhase !== 'final_answer') {
    sections.push(
      `Intent (assistant's last message): ${truncate(context.lastAssistantText, INTENT_CHAR_LIMIT)}`,
    );
  }
  if (context?.thinkingExcerpts?.length) {
    sections.push(
      'Reasoning excerpts:\n' +
        context.thinkingExcerpts
          .slice(0, 4)
          .map((excerpt) => `- ${truncate(excerpt, charLimit)}`)
          .join('\n'),
    );
  }
  const budget = Math.max(ENTRIES_CHAR_BUDGET, charLimit * 4);
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const entry of entries) {
    /** Prefix cut, never a mid-list sample: once the budget is spent the
     *  remaining entries are skipped unserialized (a giant batch must not
     *  even pay the stringify cost for lines that will be dropped). The
     *  first entry always fits, and the line that crosses the budget is
     *  kept, so at least one complete call is always shown. */
    if (lines.length > 0 && used >= budget) {
      omitted += 1;
      continue;
    }
    const input = truncate(stringifyActivityEvidence(entry.toolInput, charLimit), charLimit);
    const outcome =
      entry.status === 'error'
        ? `ERROR: ${truncate(entry.error ?? 'unknown error', charLimit)}`
        : truncate(stringifyActivityEvidence(entry.toolOutput, charLimit), charLimit);
    const line = `- ${entry.toolName}(${input}) → ${outcome}`;
    lines.push(line);
    used += line.length;
  }
  if (omitted > 0) {
    lines.push(`- (+${omitted} more tool calls not shown)`);
  }
  /** Flagged as reference material: without this the model tends to read the
   *  list as the thing to summarize and hands back a transcription of it. */
  sections.push(`What it called, and what came back (do not restate these):\n${lines.join('\n')}`);
  sections.push('Header:');
  return sections.join('\n\n');
}

function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'string' ? block : ((block as { text?: string })?.text ?? ''),
      )
      .join('')
      .trim();
  }
  return '';
}

function buildSignal(runSignal?: AbortSignal, hookSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
  const signals = [runSignal, hookSignal].filter((signal): signal is AbortSignal => signal != null);
  if (signals.length > 0 && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([...signals, timeout]);
  }
  return timeout;
}

/**
 * PoC PostToolBatch hook: claims a content slot synchronously, then generates
 * a one-line batch summary on a cheap model as a DETACHED promise — the hook
 * returns immediately so the next model call is never delayed. Failures fill
 * the slot with `null` (host renders nothing for empty summaries).
 */
export function createActivityLabelHook(
  opts: ActivityLabelHookOptions,
): HookCallback<'PostToolBatch'> {
  const maxPerRun = opts.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const charLimit = opts.charLimit ?? DEFAULT_CHAR_LIMIT;
  let generated = opts.initialGeneratedCount ?? 0;
  let llmPromise: Promise<ActivityLabelLLM> | null = null;
  /** Committed label text by content index. A Map because fills land in
   *  COMPLETION order, not run order — batch N+1's label can commit before
   *  batch N's — so continuity reads must re-sort by index rather than
   *  trusting insertion order. */
  const committedLabels = new Map<number, string>();
  for (const seed of opts.initialLabels ?? []) {
    committedLabels.set(seed.index, seed.text);
  }
  const recentLabels = (beforeIndex: number): string[] => {
    const prior: Array<[number, string]> = [];
    for (const entry of committedLabels) {
      if (entry[0] < beforeIndex) {
        prior.push(entry);
      }
    }
    return prior
      .sort((a, b) => a[0] - b[0])
      .slice(-MAX_PREVIOUS_LABELS)
      .map(([, text]) => text);
  };

  const getLLM = (): Promise<ActivityLabelLLM> => {
    llmPromise =
      llmPromise ??
      opts.resolveLLM().catch((error) => {
        /** Never cache a rejection: memoizing it would fail every later
         *  batch in the run instantly — and silently defeat the host
         *  resolver's own rejected-cache eviction, which exists precisely so
         *  a transient credential read failure stays transient. */
        llmPromise = null;
        throw error;
      });
    return llmPromise;
  };

  return async (input: PostToolBatchInput, hookSignal?: AbortSignal) => {
    /** Subagent scopes are skipped (`input.agentId` set), mirroring the steer
     *  drain: subagent content is buffered per spawning tool call, so a slot
     *  claimed here would land in the WRONG transcript (the main message). */
    if (input.agentId != null) {
      return {};
    }
    if (
      generated >= maxPerRun ||
      input.entries.length === 0 ||
      opts.signal?.aborted === true ||
      hookSignal?.aborted === true
    ) {
      return {};
    }
    /** A batch containing ANY handoff call gets no label — mixed batches
     *  included. Transfer parts are never groupable on the client, so the
     *  flush at the transfer card leaves the label with nothing to head and
     *  it could only orphan into a stray line after the cards; the handoff
     *  card already names the destination and the tool cards still show the
     *  work. Skipped BEFORE the quota so handoffs never consume
     *  `maxPerRun`. */
    if (
      input.entries.some((entry) => entry.toolName?.startsWith(Constants.LC_TRANSFER_TO_) === true)
    ) {
      return {};
    }
    generated += 1;
    const slot = opts.claimSlot({
      ...classifyBatch(input.entries),
      executingAgentId: input.executingAgentId,
    });

    const task = (async () => {
      /**
       * Usage accounting registered by whichever generation path ran, invoked
       * only after `slot.fill` settles. Billing BEFORE the commit let the
       * settlement deadline expire during the accounting's balance write —
       * the charge landed, then the fill was dropped as out-of-scope: billed,
       * never shown. Committing first makes the charge conditional on the
       * label actually surfacing.
       */
      let deferredUsage:
        | ((estimate?: () => LabelUsageEstimate) => void | Promise<void>)
        | undefined;
      const collectDeferredUsage = async (
        committed: boolean,
        estimate?: () => LabelUsageEstimate,
      ) => {
        if (!committed || deferredUsage == null) {
          return;
        }
        try {
          await deferredUsage(estimate);
        } catch (error) {
          logger.warn(
            `[activityLabel] usage accounting failed (slot ${slot.index}): ${(error as Error)?.message ?? error}`,
          );
        }
      };
      try {
        /** Host run-abort signal AND the dispatch signal both cancel the
         *  label call — a user abort must not keep paying for generation
         *  until the timeout. */
        const signal = buildSignal(opts.signal, hookSignal);
        /** Read at request-build time, not claim time: earlier batches'
         *  fills usually land in the gap between batch boundaries, so this
         *  captures labels a claim-time snapshot would miss — exactly the
         *  rapid consecutive batches where continuity matters most. */
        const previousLabels = recentLabels(slot.index);
        /** Direct, untraced call: the fallback when no SDK bridge is wired or
         *  when the bridge declines because the package is too old. */
        let directPromptText: string | undefined;
        const generateDirect = async (): Promise<string | null> => {
          const { provider, clientOptions } = await getLLM();
          const model = initializeModel({
            provider,
            clientOptions: { ...clientOptions, streaming: false } as ClientOptions,
          });
          const invokeCallbacks = opts.getInvokeCallbacks?.();
          directPromptText = buildPrompt(
            input.entries,
            charLimit,
            slot.context,
            opts.prompt,
            previousLabels,
          );
          const response = await (
            model as { invoke: (input: string, config?: object) => Promise<{ content?: unknown }> }
          ).invoke(directPromptText, {
            signal,
            ...(invokeCallbacks && { callbacks: invokeCallbacks.callbacks }),
          });
          const direct = extractText(response?.content);
          deferredUsage = invokeCallbacks?.collect;
          return direct;
        };

        let text: string | null = null;
        if (opts.generateLabel != null) {
          /** SDK-backed path: session-grouped Langfuse tracing via
           *  `run.generateActivityLabel()` (host bridges the call). */
          const bridged = await opts.generateLabel({
            entries: input.entries,
            context: slot.context ?? {},
            ...(previousLabels.length > 0 && { previousLabels }),
            traceSeed: `${input.runId}-activity-${slot.index}`,
            signal,
            charLimit,
            deferUsage: (collect) => {
              deferredUsage = collect;
            },
            ...(opts.prompt != null && { prompt: opts.prompt }),
            ...(input.executingAgentId != null && { executingAgentId: input.executingAgentId }),
          });
          /** Declined (no SDK support) — not the same as "no label". */
          text = bridged === undefined ? await generateDirect() : bridged;
        } else {
          text = await generateDirect();
        }
        /** Normalize centrally — BOTH paths: single line, bounded length,
         *  whitespace-only becomes null so the UI keeps the deterministic
         *  counts fallback. */
        const normalized = normalizeLabelOutput(text);
        const committed = (await slot.fill(normalized.length > 0 ? normalized : null)) === true;
        /** Continuity records only what actually surfaced: a dropped fill
         *  never reached the user, so later headers must not write around
         *  a line that is not on screen. */
        if (committed && normalized.length > 0) {
          committedLabels.set(slot.index, normalized);
        }
        /** Estimate for providers that omit usage metadata — title-style
         *  billing from locally counted text. LAZY: the thunk runs only when
         *  real usage is absent. The direct path counts the EXACT prompt it
         *  sent; the SDK path counts the locally built equivalent (same
         *  entries, context, instruction, and truncation contract). The
         *  completion counts the RAW model output, not the normalized label —
         *  a verbose multi-line reply consumed tokens up to the generation
         *  cap even though only its bounded first line persists. Success
         *  path only: a throw before a response consumed nothing billable
         *  beyond what real metadata already captured. */
        await collectDeferredUsage(committed, () => ({
          promptText:
            directPromptText ??
            buildPrompt(input.entries, charLimit, slot.context, opts.prompt, previousLabels),
          completionText: text ?? '',
        }));
      } catch (error) {
        logger.warn(
          `[activityLabel] label generation failed (slot ${slot.index}): ${(error as Error)?.message ?? error}`,
        );
        let committed = false;
        try {
          committed = (await slot.fill(null)) === true;
        } catch {
          /* host fill must never throw into the void chain */
        }
        /** A throw after the provider responded still consumed tokens; bill
         *  them when the empty fill committed, on the same shown-iff-billed
         *  rule (collect itself never throws past its own catch). */
        await collectDeferredUsage(committed);
      }
    })();
    opts.trackTask?.(task);

    return {};
  };
}
