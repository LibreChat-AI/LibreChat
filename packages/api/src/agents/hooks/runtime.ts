import { HookRegistry, matchesQuery } from '@librechat/agents';
import type {
  HookInput,
  HookOutput,
  HookMatcher,
  HookCallback,
  HookEvent,
  PostToolBatchEntry,
} from '@librechat/agents';
import type { PluginHookCapabilities, PluginHookPlan } from './compatibility';
import type { PluginHookHandler, PluginHooksDocument } from './schema';
import { planPluginHooks } from './compatibility';

export interface PluginHookRuntimeContext {
  sessionId?: string;
  /** Authenticated principal owning the run; scopes cross-run dedup keys. */
  userId?: string;
  /**
   * Session working directory for the payload's `cwd`. LibreChat runs supply
   * none: tool paths address a remote code-execution sandbox, not the API
   * host where hook commands run, so no host directory describes the run.
   * Hook commands resolve their own paths from `PLUGIN_ROOT`, which is also
   * the process working directory.
   */
  cwd?: string;
  transcriptPath?: string | null;
  permissionMode?: string;
  sessionStartSource?: string;
  model?: string;
  agentType?: string;
}

export interface PluginHookBatchToolCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  tool_response?: unknown;
}

export interface PluginHookPayload {
  hook_event_name: string;
  session_id: string;
  run_id: string;
  thread_id?: string;
  cwd?: string;
  transcript_path?: string | null;
  permission_mode?: string;
  source?: string;
  model?: string;
  agent_id?: string;
  executing_agent_id?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
  error?: string;
  last_assistant_message?: string;
  reason?: string;
  agent_type?: string;
  stop_hook_active?: boolean;
  trigger?: string;
  compact_summary?: string;
  messages_before_count?: number;
  messages_after_count?: number;
  tool_calls?: PluginHookBatchToolCall[];
}

export interface PluginHookExecutionRequest {
  pluginId: string;
  sourceEvent: string;
  targetEvent: HookEvent;
  handler: PluginHookHandler;
  /** Declaration position in the source document; distinguishes identical handlers under different matchers. */
  groupIndex: number;
  handlerIndex: number;
  condition?: string;
  input: HookInput;
  payload: PluginHookPayload;
}

/**
 * Host-owned boundary for executing a planned hook.
 * This compatibility layer never launches plugin code in the LibreChat API process.
 */
export interface PluginHookExecutor {
  capabilities: PluginHookCapabilities;
  /**
   * Pre-execution gate consulted before the declaration claims its per-input
   * dedup slot. A suppressed declaration (for example, once-state already
   * recorded) must decline here rather than no-op inside `execute`, so an
   * identical handler under an overlapping matcher can still claim the slot
   * and fire independently.
   */
  shouldExecute?(request: PluginHookExecutionRequest): boolean | Promise<boolean>;
  execute(
    request: PluginHookExecutionRequest,
    signal: AbortSignal,
  ): HookOutput | Promise<HookOutput>;
}

export interface RegisterPluginHooksOptions {
  pluginId: string;
  registry: HookRegistry;
  document: PluginHooksDocument;
  executor: PluginHookExecutor;
  /**
   * Plan already computed from `document` with the SAME executor capabilities
   * (e.g. at plugin load). Supplying it skips re-planning up to 512 handlers
   * on every run; omitted, the document is planned here.
   */
  plan?: PluginHookPlan;
  context?: PluginHookRuntimeContext;
}

export interface PluginHookRegistration {
  plan: PluginHookPlan;
  registered: number;
  unregister: () => void;
}

interface PluginHookPayloadState {
  compactTrigger?: string;
  toPluginToolName?: (toolName: string) => string;
  toPluginToolInput?: (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => Record<string, unknown>;
}

function getSessionId(input: HookInput, context: PluginHookRuntimeContext): string {
  return context.sessionId ?? input.threadId ?? input.runId;
}

function toClaudeCompactTrigger(trigger: string | undefined): string | undefined {
  if (!trigger) {
    return undefined;
  }
  return trigger === 'manual' ? 'manual' : 'auto';
}

function getPluginToolName(toolName: string, state: PluginHookPayloadState): string {
  if (!state.toPluginToolName) {
    return toolName;
  }
  const translated = state.toPluginToolName(toolName);
  if (!translated?.trim()) {
    throw new Error(`No plugin tool-name mapping is available for "${toolName}"`);
  }
  return translated;
}

function getPluginToolInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  state: PluginHookPayloadState,
): Record<string, unknown> {
  return state.toPluginToolInput?.(toolName, toolInput) ?? toolInput;
}

function getMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object' || !('content' in message)) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((block) => {
      if (typeof block === 'string') {
        return [block];
      }
      if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
        return [block.text];
      }
      return [];
    })
    .join('\n');
  return text || undefined;
}

function toPluginBatchToolCall(
  entry: PostToolBatchEntry,
  state: PluginHookPayloadState,
): PluginHookBatchToolCall {
  const toolResponse = entry.status === 'success' ? entry.toolOutput : entry.error;
  return {
    tool_name: getPluginToolName(entry.toolName, state),
    tool_input: getPluginToolInput(entry.toolName, entry.toolInput, state),
    tool_use_id: entry.toolUseId,
    ...(toolResponse !== undefined && { tool_response: toolResponse }),
  };
}

function basePayload(
  sourceEvent: string,
  input: HookInput,
  context: PluginHookRuntimeContext,
): PluginHookPayload {
  const sessionId = getSessionId(input, context);
  return {
    hook_event_name: sourceEvent,
    session_id: sessionId,
    run_id: input.runId,
    ...(input.threadId !== undefined && { thread_id: input.threadId }),
    ...(context.cwd !== undefined && { cwd: context.cwd }),
    ...(context.transcriptPath !== undefined && { transcript_path: context.transcriptPath }),
    ...(context.permissionMode !== undefined && { permission_mode: context.permissionMode }),
    ...(input.agentId !== undefined && { agent_id: input.agentId }),
    ...(input.executingAgentId !== undefined && {
      executing_agent_id: input.executingAgentId,
    }),
  };
}

export function createPluginHookPayload(
  sourceEvent: string,
  input: HookInput,
  context: PluginHookRuntimeContext = {},
  state: PluginHookPayloadState = {},
): PluginHookPayload {
  const payload = basePayload(sourceEvent, input, context);

  switch (input.hook_event_name) {
    case 'RunStart':
      return {
        ...payload,
        ...(sourceEvent === 'SessionStart' && {
          source: context.sessionStartSource ?? 'startup',
          ...(context.model !== undefined && { model: context.model }),
          ...(context.agentType !== undefined && { agent_type: context.agentType }),
        }),
      };
    case 'UserPromptSubmit':
      return { ...payload, prompt: input.prompt };
    case 'PreToolUse':
      return {
        ...payload,
        tool_name: getPluginToolName(input.toolName, state),
        tool_input: getPluginToolInput(input.toolName, input.toolInput, state),
        tool_use_id: input.toolUseId,
      };
    case 'PostToolUse':
      return {
        ...payload,
        tool_name: getPluginToolName(input.toolName, state),
        tool_input: getPluginToolInput(input.toolName, input.toolInput, state),
        tool_use_id: input.toolUseId,
        tool_response: input.toolOutput,
      };
    case 'PostToolUseFailure':
      return {
        ...payload,
        tool_name: getPluginToolName(input.toolName, state),
        tool_input: getPluginToolInput(input.toolName, input.toolInput, state),
        tool_use_id: input.toolUseId,
        error: input.error,
      };
    case 'PostToolBatch':
      return {
        ...payload,
        tool_calls: input.entries.map((entry) => toPluginBatchToolCall(entry, state)),
      };
    /** LibreChat steering seal; no Claude counterpart, so it is never mapped to a declaration. */
    case 'PreemptBoundary':
      return payload;
    case 'PermissionDenied':
      return {
        ...payload,
        tool_name: getPluginToolName(input.toolName, state),
        tool_input: getPluginToolInput(input.toolName, input.toolInput, state),
        tool_use_id: input.toolUseId,
        reason: input.reason,
      };
    case 'SubagentStart':
    case 'SubagentStop':
      return { ...payload, agent_type: input.agentType };
    case 'Stop':
      return { ...payload, stop_hook_active: input.stopHookActive };
    /** Internal terminal-admission phase; plugin declarations cannot target it. */
    case 'StopFinalize':
      return payload;
    case 'StopFailure': {
      const lastAssistantMessage = getMessageText(input.lastAssistantMessage);
      return {
        ...payload,
        error: input.error,
        ...(lastAssistantMessage !== undefined && {
          last_assistant_message: lastAssistantMessage,
        }),
      };
    }
    case 'PreCompact':
      return {
        ...payload,
        trigger: toClaudeCompactTrigger(input.trigger),
        messages_before_count: input.messagesBeforeCount,
      };
    case 'PostCompact':
      return {
        ...payload,
        ...(state.compactTrigger !== undefined && {
          trigger: toClaudeCompactTrigger(state.compactTrigger),
        }),
        compact_summary: input.summary,
        messages_after_count: input.messagesAfterCount,
      };
  }
}

function getHookTimeoutMs(
  sourceEvent: string,
  handler: PluginHookHandler,
  configuredTimeoutMs: number | undefined,
): number | undefined {
  if (configuredTimeoutMs !== undefined) {
    return configuredTimeoutMs;
  }
  if (handler.type === 'command') {
    return sourceEvent === 'UserPromptSubmit' ? 30_000 : 600_000;
  }
  if (handler.type === 'prompt') {
    return 30_000;
  }
  return undefined;
}

function getHandlerIdentity(
  sourceEvent: string,
  handler: PluginHookHandler,
  condition: string | undefined,
): string {
  const handlerProperties = Object.entries(handler)
    .filter(([key]) => key !== 'if')
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([sourceEvent, condition ?? null, handlerProperties]);
}

export function registerPluginHooks(options: RegisterPluginHooksOptions): PluginHookRegistration {
  const { pluginId, registry, document, executor, context = {} } = options;
  const plan = options.plan ?? planPluginHooks(document, executor.capabilities);
  const unregisters: Array<() => void> = [];
  const compactTriggers = new Map<string, string>();
  const executedHandlers = new WeakMap<HookInput, Set<string>>();
  const tracksCompactTriggers = plan.entries.some(
    (entry) => entry.status === 'ready' && entry.targetEvent === 'PostCompact',
  );
  let registered = 0;

  if (tracksCompactTriggers) {
    const trackCompactTrigger: HookCallback<'PreCompact'> = (input) => {
      compactTriggers.set(getSessionId(input, context), input.trigger);
      return {};
    };
    unregisters.push(
      registry.register('PreCompact', {
        hooks: [trackCompactTrigger],
        internal: true,
      }),
    );
  }

  for (const entry of plan.entries) {
    if (entry.status !== 'ready' || entry.targetEvent === undefined) {
      continue;
    }
    const targetEvent = entry.targetEvent;
    const handlerIdentity = getHandlerIdentity(entry.sourceEvent, entry.handler, entry.condition);
    const seenSessionIds = entry.sourceEvent === 'SessionStart' ? new Set<string>() : undefined;
    const firedSessionIds = entry.handler.once === true ? new Set<string>() : undefined;
    /**
     * Payloads follow the namespace each alternative was authored in: only a
     * matcher that required alias translation gets reverse name/input
     * translation, and when the plan records which runtime names the
     * translation produced, it applies per invocation — a mixed matcher like
     * `Bash|create_file` presents Claude-shaped payloads for `bash_tool` and
     * native payloads for the natively-authored alternative.
     */
    const translated = entry.requiresToolNameTranslation === true;
    const translatedNames =
      translated && entry.translatedToolNames !== undefined
        ? new Set(entry.translatedToolNames)
        : undefined;
    const inTranslatedNamespace = (toolName: string): boolean =>
      translated && (translatedNames === undefined || translatedNames.has(toolName));
    const toolNameTranslator = translated ? executor.capabilities.toPluginToolName : undefined;
    const toPluginToolName =
      toolNameTranslator === undefined
        ? undefined
        : (toolName: string): string =>
            inTranslatedNamespace(toolName)
              ? toolNameTranslator({
                  sourceEvent: entry.sourceEvent,
                  targetEvent,
                  toolName,
                })
              : toolName;
    const toolInputTranslator = translated ? executor.capabilities.toPluginToolInput : undefined;
    const toPluginToolInput =
      toolInputTranslator === undefined
        ? undefined
        : (toolName: string, toolInput: Record<string, unknown>): Record<string, unknown> =>
            inTranslatedNamespace(toolName)
              ? toolInputTranslator({
                  sourceEvent: entry.sourceEvent,
                  targetEvent,
                  toolName,
                  toolInput,
                })
              : toolInput;
    const hook: HookCallback<HookEvent> = (input, signal) => {
      const sessionId = getSessionId(input, context);
      const compactTrigger = compactTriggers.get(sessionId);
      if (entry.sourceEvent === 'SessionStart') {
        const source = context.sessionStartSource ?? 'startup';
        if (
          source === 'compact' ||
          !matchesQuery(entry.matcher, source) ||
          seenSessionIds?.has(sessionId) === true
        ) {
          return {};
        }
        seenSessionIds?.add(sessionId);
      }
      if (
        targetEvent === 'PreCompact' &&
        input.hook_event_name === 'PreCompact' &&
        !matchesQuery(entry.matcher, input.trigger)
      ) {
        return {};
      }
      if (
        targetEvent === 'PostCompact' &&
        input.hook_event_name === 'PostCompact' &&
        (compactTrigger === undefined || !matchesQuery(entry.matcher, compactTrigger))
      ) {
        return {};
      }
      if (
        targetEvent === 'StopFailure' &&
        input.hook_event_name === 'StopFailure' &&
        !matchesQuery(entry.matcher, input.error)
      ) {
        return {};
      }
      if (entry.condition !== undefined) {
        const matchCondition = executor.capabilities.matchCondition;
        if (!matchCondition || !('toolName' in input) || !('toolInput' in input)) {
          return {};
        }
        let matchesCondition = false;
        try {
          matchesCondition = matchCondition({
            sourceEvent: entry.sourceEvent,
            targetEvent,
            condition: entry.condition,
            toolName: getPluginToolName(input.toolName, { toPluginToolName }),
            toolInput: getPluginToolInput(input.toolName, input.toolInput, { toPluginToolInput }),
          });
        } catch {
          return {};
        }
        if (!matchesCondition) {
          return {};
        }
      }
      if (firedSessionIds?.has(sessionId) === true) {
        return {};
      }
      const handlersForInput = executedHandlers.get(input);
      if (handlersForInput?.has(handlerIdentity) === true) {
        firedSessionIds?.add(sessionId);
        return {};
      }
      const request: PluginHookExecutionRequest = {
        pluginId,
        sourceEvent: entry.sourceEvent,
        targetEvent,
        handler: entry.handler,
        groupIndex: entry.groupIndex,
        handlerIndex: entry.handlerIndex,
        ...(entry.condition !== undefined && { condition: entry.condition }),
        input,
        payload: createPluginHookPayload(entry.sourceEvent, input, context, {
          compactTrigger,
          toPluginToolName,
          toPluginToolInput,
        }),
      };
      /**
       * The per-input dedup slot is claimed only by a declaration that will
       * actually run: one the executor suppresses (spent once-state) must
       * not consume it, or an identical handler under an overlapping matcher
       * could never claim the slot and would be permanently shadowed.
       */
      const claimAndExecute = (): HookOutput | Promise<HookOutput> => {
        if (handlersForInput) {
          handlersForInput.add(handlerIdentity);
        } else {
          executedHandlers.set(input, new Set([handlerIdentity]));
        }
        firedSessionIds?.add(sessionId);
        return executor.execute(request, signal);
      };
      const shouldRun = executor.shouldExecute?.(request) ?? true;
      if (shouldRun === true) {
        return claimAndExecute();
      }
      if (shouldRun === false) {
        return {};
      }
      return shouldRun.then((run) => (run ? claimAndExecute() : {}));
    };
    const runtimeFiltered =
      entry.sourceEvent === 'SessionStart' ||
      targetEvent === 'PreCompact' ||
      targetEvent === 'PostCompact' ||
      targetEvent === 'StopFailure';
    const timeoutMs = getHookTimeoutMs(entry.sourceEvent, entry.handler, entry.timeoutMs);
    const matcher: HookMatcher<HookEvent> = {
      hooks: [hook],
      ...(!runtimeFiltered && entry.matcher !== undefined && { pattern: entry.matcher }),
      ...(timeoutMs !== undefined && { timeout: timeoutMs }),
    };
    unregisters.push(registry.register(targetEvent, matcher));
    registered++;
  }

  if (tracksCompactTriggers) {
    const clearCompactTrigger: HookCallback<'PostCompact'> = (input) => {
      compactTriggers.delete(getSessionId(input, context));
      return {};
    };
    unregisters.push(
      registry.register('PostCompact', {
        hooks: [clearCompactTrigger],
        internal: true,
      }),
    );
  }

  let active = true;
  return {
    plan,
    registered,
    unregister: () => {
      if (!active) {
        return;
      }
      active = false;
      compactTriggers.clear();
      for (let index = unregisters.length - 1; index >= 0; index--) {
        unregisters[index]();
      }
    },
  };
}
