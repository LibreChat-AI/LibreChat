import { MAX_PATTERN_LENGTH, hasNestedQuantifier } from '@librechat/agents';
import type { HookEvent } from '@librechat/agents';
import type { PluginHookHandler, PluginHooksDocument } from './schema';

const EVENT_MAP = new Map<string, HookEvent>([
  ['RunStart', 'RunStart'],
  ['SessionStart', 'RunStart'],
  ['UserPromptSubmit', 'UserPromptSubmit'],
  ['PreToolUse', 'PreToolUse'],
  ['PostToolUse', 'PostToolUse'],
  ['PostToolUseFailure', 'PostToolUseFailure'],
  ['PostToolBatch', 'PostToolBatch'],
  ['PermissionDenied', 'PermissionDenied'],
  ['SubagentStart', 'SubagentStart'],
  ['SubagentStop', 'SubagentStop'],
  ['Stop', 'Stop'],
  ['StopFailure', 'StopFailure'],
  ['PreCompact', 'PreCompact'],
  ['PostCompact', 'PostCompact'],
]);

const QUERY_EVENTS = new Set<HookEvent>([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'SubagentStart',
  'SubagentStop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
]);

const TOOL_NAME_EVENTS = new Set<HookEvent>([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
]);

/** Events whose payloads carry tool names/inputs, including the matcherless batch event. */
const TOOL_PAYLOAD_EVENTS = new Set<HookEvent>([...TOOL_NAME_EVENTS, 'PostToolBatch']);

const GENERAL_EXACT_MATCHER = /^[-A-Za-z0-9_,| ]+$/;
const NARROW_EXACT_MATCHER = /^[A-Za-z0-9_|]+$/;
const NARROW_EXACT_MATCHER_EVENTS = new Set(['FileChanged', 'StopFailure']);

export type PluginHookIssueSeverity = 'warning' | 'error';

export type PluginHookIssueCode =
  | 'event_alias'
  | 'unsupported_event'
  | 'unsupported_handler'
  | 'invalid_matcher'
  | 'matcher_translated'
  | 'unmapped_matcher'
  | 'unmapped_tool_name'
  | 'unsupported_matcher'
  | 'unsupported_condition'
  | 'conflicting_condition'
  | 'unsupported_async'
  | 'unsupported_async_rewake'
  | 'unsupported_continue_on_block'
  | 'unsupported_handler_event'
  | 'unsupported_session_lifecycle'
  | 'unsupported_session_source'
  | 'unsupported_event_payload'
  | 'unsupported_event_output'
  | 'long_timeout';

export interface PluginHookCompatibilityIssue {
  code: PluginHookIssueCode;
  severity: PluginHookIssueSeverity;
  message: string;
}

export type PluginHookHandlerType = 'command' | 'prompt';

export interface PluginHookMatcherTranslation {
  sourceEvent: string;
  targetEvent: HookEvent;
  /** Authored regex, or a canonical pipe-separated list when Claude applies exact matching. */
  matcher: string;
}

export interface PluginHookMatcherTranslationResult {
  /** Runtime pattern; translations of Claude exact matchers are whole-string anchored. */
  matcher: string;
  requiresToolNameTranslation?: boolean;
  /**
   * Runtime tool names the translation produced. Reverse payload translation
   * applies per invocation to exactly these names, so a mixed matcher like
   * `Bash|create_file` keeps native payloads for its natively-authored
   * alternative. Omitted, translation applies to the whole declaration.
   */
  translatedToolNames?: string[];
}

export interface PluginHookToolNameTranslation {
  sourceEvent: string;
  targetEvent: HookEvent;
  toolName: string;
}

export interface PluginHookToolInputTranslation {
  sourceEvent: string;
  targetEvent: HookEvent;
  /** LibreChat runtime name of the invoked tool. */
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface PluginHookHandlerSupport {
  sourceEvent: string;
  handler: PluginHookHandler;
}

export interface PluginHookConditionMatch {
  sourceEvent: string;
  targetEvent: HookEvent;
  condition: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface PluginHookCapabilities {
  handlerTypes: ReadonlySet<PluginHookHandlerType>;
  translateMatcher?: (
    input: PluginHookMatcherTranslation,
  ) => string | PluginHookMatcherTranslationResult | undefined;
  /** Maps a LibreChat runtime tool name back into the plugin's source namespace. */
  toPluginToolName?: (input: PluginHookToolNameTranslation) => string;
  /** Presents a runtime tool input under the plugin's source field names. */
  toPluginToolInput?: (input: PluginHookToolInputTranslation) => Record<string, unknown>;
  /** Returns an error message when the executor cannot run this handler on the current host. */
  supportsHandler?: (input: PluginHookHandlerSupport) => string | undefined;
  /** Evaluates Claude permission-rule syntax before a conditional handler executes. */
  matchCondition?: (input: PluginHookConditionMatch) => boolean;
  async?: boolean;
  asyncRewake?: boolean;
  sessionLifecycle?: boolean;
}

export interface PluginHookPlanEntry {
  sourceEvent: string;
  targetEvent?: HookEvent;
  groupIndex: number;
  handlerIndex: number;
  sourceMatcher?: string;
  matcher?: string;
  /**
   * Set when the matcher was authored against the plugin's alias namespace
   * and translated to runtime tool names; payload name/input reverse
   * translation applies only to such declarations — a native-authored
   * matcher keeps native payloads.
   */
  requiresToolNameTranslation?: boolean;
  /** Runtime tool names the translation produced; see the translation result type. */
  translatedToolNames?: string[];
  condition?: string;
  timeoutMs?: number;
  handler: PluginHookHandler;
  status: 'ready' | 'unsupported';
  issues: PluginHookCompatibilityIssue[];
}

export interface PluginHookPlanSummary {
  declared: number;
  ready: number;
  unsupported: number;
}

export interface PluginHookPlan {
  description?: string;
  entries: PluginHookPlanEntry[];
  summary: PluginHookPlanSummary;
}

/**
 * SessionStart lifecycle sources no LibreChat run-construction path emits.
 * A matcher naming one is rejected at plan time — registering it would plan
 * ready and never fire, the silent-no-op failure mode planning exists to
 * surface.
 */
const UNAVAILABLE_SESSION_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  compact:
    'SessionStart source "compact" is unavailable because LibreChat PostCompact hook output cannot inject session context',
  clear:
    'SessionStart source "clear" is unavailable because LibreChat has no clear-conversation lifecycle path',
});

function normalizeMatcher(matcher: string | undefined): string | undefined {
  const trimmed = matcher?.trim();
  if (!trimmed || trimmed === '*' || trimmed === '.*') {
    return undefined;
  }
  return trimmed;
}

type ClaudeMatcherSemantics =
  | { kind: 'exact'; canonicalMatcher: string; values: string[] }
  | { kind: 'regex'; canonicalMatcher: string };

function getClaudeMatcherSemantics(sourceEvent: string, matcher: string): ClaudeMatcherSemantics {
  const isNarrowEvent = NARROW_EXACT_MATCHER_EVENTS.has(sourceEvent);
  const exactMatcher = isNarrowEvent ? NARROW_EXACT_MATCHER : GENERAL_EXACT_MATCHER;
  if (!exactMatcher.test(matcher)) {
    return { kind: 'regex', canonicalMatcher: matcher };
  }
  const values = matcher.split(isNarrowEvent ? /\|/ : /[|,]/).map((value) => value.trim());
  return {
    kind: 'exact',
    canonicalMatcher: values.join('|'),
    values,
  };
}

function anchorExactMatcher(matcher: string): string {
  return `^(?:${matcher})$`;
}

function matcherIncludesValue(matcher: string, value: string): boolean {
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
}

function getMatcherValidationIssue(
  sourceEvent: string,
  matcher: string | undefined,
  targetEvent: HookEvent | undefined,
): PluginHookCompatibilityIssue | undefined {
  if (!matcher) {
    return undefined;
  }
  if (targetEvent && !QUERY_EVENTS.has(targetEvent) && sourceEvent !== 'SessionStart') {
    return {
      code: 'unsupported_matcher',
      severity: 'error',
      message: `${targetEvent} does not expose a matcher query in the LibreChat hook runtime`,
    };
  }
  if (matcher.length > MAX_PATTERN_LENGTH || hasNestedQuantifier(matcher)) {
    return {
      code: 'invalid_matcher',
      severity: 'error',
      message: 'Matcher exceeds the safe regex limits enforced by the LibreChat hook runtime',
    };
  }
  try {
    void new RegExp(matcher);
    return undefined;
  } catch {
    return {
      code: 'invalid_matcher',
      severity: 'error',
      message: 'Matcher is not a valid regular expression',
    };
  }
}

function getEventIssues(
  sourceEvent: string,
  targetEvent: HookEvent | undefined,
  capabilities: PluginHookCapabilities,
): PluginHookCompatibilityIssue[] {
  if (!targetEvent) {
    return [
      {
        code: 'unsupported_event',
        severity: 'error',
        message: `${sourceEvent} has no equivalent LibreChat lifecycle event`,
      },
    ];
  }
  if (sourceEvent === 'SubagentStop') {
    return [
      {
        code: 'unsupported_event_payload',
        severity: 'error',
        message:
          'SubagentStop is unavailable because the LibreChat hook input does not expose stop-hook state',
      },
    ];
  }
  if (sourceEvent === 'PermissionDenied') {
    return [
      {
        code: 'unsupported_event_output',
        severity: 'error',
        message:
          'PermissionDenied is unavailable because the LibreChat hook output cannot request a retry',
      },
    ];
  }
  if (sourceEvent !== 'SessionStart') {
    return [];
  }
  if (capabilities.sessionLifecycle !== true) {
    return [
      {
        code: 'unsupported_session_lifecycle',
        severity: 'error',
        message: 'SessionStart requires a runtime that deduplicates RunStart by plugin session',
      },
    ];
  }
  return [
    {
      code: 'event_alias',
      severity: 'warning',
      message: 'SessionStart maps to RunStart with runtime-provided once-per-session semantics',
    },
  ];
}

const PROMPT_UNSUPPORTED_EVENTS = new Set([
  'SessionStart',
  'PermissionDenied',
  'SubagentStart',
  'StopFailure',
  'PreCompact',
  'PostCompact',
]);

function getHandlerIssues(
  sourceEvent: string,
  handler: PluginHookHandler,
  capabilities: PluginHookCapabilities,
): PluginHookCompatibilityIssue[] {
  const issues: PluginHookCompatibilityIssue[] = [];
  const supportedHandlerType =
    handler.type === 'command' || handler.type === 'prompt' ? handler.type : undefined;
  if (!supportedHandlerType || !capabilities.handlerTypes.has(supportedHandlerType)) {
    issues.push({
      code: 'unsupported_handler',
      severity: 'error',
      message: `The configured executor does not support ${handler.type} hook handlers`,
    });
  }
  const supportMessage = capabilities.supportsHandler?.({ sourceEvent, handler });
  if (supportMessage !== undefined) {
    issues.push({ code: 'unsupported_handler', severity: 'error', message: supportMessage });
  }
  if (handler.type === 'prompt' && PROMPT_UNSUPPORTED_EVENTS.has(sourceEvent)) {
    issues.push({
      code: 'unsupported_handler_event',
      severity: 'error',
      message: `${sourceEvent} does not support prompt hook handlers`,
    });
  }
  if (handler.async === true && capabilities.async !== true) {
    issues.push({
      code: 'unsupported_async',
      severity: 'error',
      message: 'The configured executor does not support asynchronous hook execution',
    });
  }
  if (handler.asyncRewake === true && capabilities.asyncRewake !== true) {
    issues.push({
      code: 'unsupported_async_rewake',
      severity: 'error',
      message: 'The configured executor does not support asyncRewake',
    });
  }
  if (handler.continueOnBlock === true && handler.type !== 'prompt') {
    issues.push({
      code: 'unsupported_continue_on_block',
      severity: 'error',
      message: 'continueOnBlock is only supported for prompt hook handlers',
    });
  }
  if ((handler.timeout ?? 0) > 600) {
    issues.push({
      code: 'long_timeout',
      severity: 'warning',
      message: 'Hook timeout exceeds the portable 600-second compatibility target',
    });
  }
  return issues;
}

interface MatcherPlan {
  sourceMatcher?: string;
  matcher?: string;
  requiresToolNameTranslation?: boolean;
  translatedToolNames?: string[];
  issues: PluginHookCompatibilityIssue[];
}

function planMatcher(
  sourceEvent: string,
  targetEvent: HookEvent | undefined,
  configuredMatcher: string | undefined,
  capabilities: PluginHookCapabilities,
): MatcherPlan {
  const sourceMatcher = normalizeMatcher(configuredMatcher);
  if (!sourceMatcher) {
    if (sourceEvent === 'SessionStart' && capabilities.sessionLifecycle === true) {
      return {
        issues: [
          {
            code: 'unsupported_session_source',
            severity: 'warning',
            message:
              'Wildcard SessionStart compatibility covers startup and resume; compact and clear never occur in LibreChat',
          },
        ],
      };
    }
    /**
     * A matcherless (or wildcard) declaration carries no namespace evidence
     * of its own, so it inherits the document's: hook documents are Claude
     * artifacts, and a wildcard guard inspecting standard Claude names or
     * fields must receive them. Declaration-wide translation (no produced
     * names) presents every aliased runtime tool in the plugin namespace.
     */
    if (
      targetEvent !== undefined &&
      TOOL_PAYLOAD_EVENTS.has(targetEvent) &&
      capabilities.toPluginToolName !== undefined
    ) {
      return { requiresToolNameTranslation: true, issues: [] };
    }
    return { issues: [] };
  }
  const matcherSemantics = getClaudeMatcherSemantics(sourceEvent, sourceMatcher);
  const validationIssue = getMatcherValidationIssue(sourceEvent, sourceMatcher, targetEvent);
  if (validationIssue?.code === 'unsupported_matcher' || !targetEvent) {
    return {
      sourceMatcher,
      matcher: sourceMatcher,
      issues: validationIssue ? [validationIssue] : [],
    };
  }
  if (sourceEvent === 'SessionStart') {
    const matcher =
      matcherSemantics.kind === 'exact'
        ? anchorExactMatcher(matcherSemantics.canonicalMatcher)
        : sourceMatcher;
    const runtimeValidationIssue =
      validationIssue ?? getMatcherValidationIssue(sourceEvent, matcher, targetEvent);
    const unavailableSource = Object.keys(UNAVAILABLE_SESSION_SOURCES).find((source) =>
      matcherSemantics.kind === 'exact'
        ? matcherSemantics.values.includes(source)
        : matcherIncludesValue(matcher, source),
    );
    if (!runtimeValidationIssue && unavailableSource !== undefined) {
      return {
        sourceMatcher,
        matcher,
        issues: [
          {
            code: 'unsupported_session_source',
            severity: 'error',
            message: UNAVAILABLE_SESSION_SOURCES[unavailableSource],
          },
        ],
      };
    }
    return {
      sourceMatcher,
      matcher,
      issues: runtimeValidationIssue ? [runtimeValidationIssue] : [],
    };
  }
  if (!capabilities.translateMatcher) {
    return {
      sourceMatcher,
      issues: [
        {
          code: 'unmapped_matcher',
          severity: 'error',
          message: 'Plugin matcher namespaces require an explicit LibreChat query translation',
        },
      ],
    };
  }

  let translation: string | PluginHookMatcherTranslationResult | undefined;
  try {
    translation = capabilities.translateMatcher({
      sourceEvent,
      targetEvent,
      matcher: matcherSemantics.canonicalMatcher,
    });
  } catch {
    translation = undefined;
  }
  const translatedMatcher = typeof translation === 'string' ? translation : translation?.matcher;
  const requiresToolNameTranslation =
    typeof translation === 'object' && translation.requiresToolNameTranslation === true;
  const translatedToolNames =
    typeof translation === 'object' ? translation.translatedToolNames : undefined;
  if (!translatedMatcher?.trim()) {
    return {
      sourceMatcher,
      issues: [
        {
          code: 'unmapped_matcher',
          severity: 'error',
          message: 'The configured matcher translator could not map this plugin matcher',
        },
      ],
    };
  }

  const normalizedTranslation = translatedMatcher.trim();
  const matcher =
    matcherSemantics.kind === 'exact'
      ? anchorExactMatcher(normalizedTranslation)
      : normalizedTranslation;
  const issues: PluginHookCompatibilityIssue[] = validationIssue ? [validationIssue] : [];
  const translatedValidationIssue = getMatcherValidationIssue(sourceEvent, matcher, targetEvent);
  if (translatedValidationIssue && !validationIssue) {
    issues.push(translatedValidationIssue);
  }
  if (normalizedTranslation !== matcherSemantics.canonicalMatcher) {
    issues.push({
      code: 'matcher_translated',
      severity: 'warning',
      message: `Plugin matcher "${sourceMatcher}" maps to LibreChat matcher "${matcher}"`,
    });
  }
  if (
    requiresToolNameTranslation &&
    TOOL_NAME_EVENTS.has(targetEvent) &&
    !capabilities.toPluginToolName
  ) {
    issues.push({
      code: 'unmapped_tool_name',
      severity: 'error',
      message: 'Translated tool matchers require a reverse tool-name mapping for plugin payloads',
    });
  }
  return {
    sourceMatcher,
    matcher,
    ...(requiresToolNameTranslation && { requiresToolNameTranslation }),
    ...(requiresToolNameTranslation &&
      translatedToolNames !== undefined && { translatedToolNames }),
    issues,
  };
}

function hasError(issues: readonly PluginHookCompatibilityIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

export function planPluginHooks(
  document: PluginHooksDocument,
  capabilities: PluginHookCapabilities,
): PluginHookPlan {
  const entries: PluginHookPlanEntry[] = [];
  const summary: PluginHookPlanSummary = { declared: 0, ready: 0, unsupported: 0 };

  for (const [sourceEvent, groups] of Object.entries(document.hooks)) {
    const targetEvent = EVENT_MAP.get(sourceEvent);
    const eventIssues = getEventIssues(sourceEvent, targetEvent, capabilities);

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      const matcherPlan = planMatcher(sourceEvent, targetEvent, group.matcher, capabilities);
      const groupIssues = [...eventIssues, ...matcherPlan.issues];

      for (let handlerIndex = 0; handlerIndex < group.hooks.length; handlerIndex++) {
        const handler = group.hooks[handlerIndex];
        const issues = [...groupIssues, ...getHandlerIssues(sourceEvent, handler, capabilities)];
        const condition = handler.if ?? group.if;
        if (handler.if && group.if && handler.if !== group.if) {
          issues.push({
            code: 'conflicting_condition',
            severity: 'error',
            message: 'A hook cannot combine different group-level and handler-level conditions',
          });
        }
        if (condition) {
          if (!targetEvent || !TOOL_NAME_EVENTS.has(targetEvent)) {
            issues.push({
              code: 'unsupported_condition',
              severity: 'error',
              message: 'Conditional `if` hook expressions are only supported for tool events',
            });
          } else if (!capabilities.matchCondition) {
            issues.push({
              code: 'unsupported_condition',
              severity: 'error',
              message: 'The configured executor does not support conditional `if` hook expressions',
            });
          }
        }
        const status = hasError(issues) ? 'unsupported' : 'ready';

        entries.push({
          sourceEvent,
          targetEvent,
          groupIndex,
          handlerIndex,
          ...(matcherPlan.sourceMatcher !== undefined && {
            sourceMatcher: matcherPlan.sourceMatcher,
          }),
          ...(matcherPlan.matcher !== undefined && { matcher: matcherPlan.matcher }),
          ...(matcherPlan.requiresToolNameTranslation === true && {
            requiresToolNameTranslation: true,
          }),
          ...(matcherPlan.translatedToolNames !== undefined && {
            translatedToolNames: matcherPlan.translatedToolNames,
          }),
          ...(condition !== undefined && { condition }),
          handler,
          status,
          issues,
          ...(handler.timeout !== undefined && { timeoutMs: handler.timeout * 1_000 }),
        });
        summary.declared++;
        summary[status === 'ready' ? 'ready' : 'unsupported']++;
      }
    }
  }

  return {
    ...(document.description !== undefined && { description: document.description }),
    entries,
    summary,
  };
}
