import type { FiltersConfig, MessageFilterPiiConfig } from 'librechat-data-provider';
import type { ContentFieldMap, ContentSource, JsonPointer, TextContentFragment } from '../types';

export const CONTENT_TRAVERSAL_MAX_DEPTH = 24;
export const CONTENT_TRAVERSAL_MAX_NODES = 4096;
export const CONTENT_MATERIALIZATION_MAX_CHARACTERS: number = 8 * 1024 * 1024;
const DATA_URI_PREFIX = 'data:';
const BASE64_VALUE = /^[A-Za-z0-9+/]+={0,2}$/;
const STRUCTURAL_CONTENT_KEYS = new Set([
  'detail',
  'file_id',
  'filename',
  'filepath',
  'format',
  'id',
  'media_type',
  'mime_type',
  'originalname',
  'role',
  'type',
  'uri',
  'url',
]);

export interface NestedStringContext {
  readonly key: string | undefined;
  readonly parent: object | undefined;
  readonly path: JsonPointer;
}

export interface VisitNestedStringsBudget {
  visitedNodes: number;
  /** Optional aggregate ceiling for callers whose valid envelope spans several traversals. */
  readonly maxNodes?: number;
  /** Aggregate characters copied into joined/assembled inspection strings. */
  materializedCharacters?: number;
  readonly maxMaterializedCharacters?: number;
}

export function reserveContentMaterialization(
  budget: VisitNestedStringsBudget,
  requestedCharacters: number,
): boolean {
  const maxCharacters = budget.maxMaterializedCharacters ?? CONTENT_MATERIALIZATION_MAX_CHARACTERS;
  const usedCharacters = budget.materializedCharacters ?? 0;
  if (
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters < 0 ||
    !Number.isSafeInteger(usedCharacters) ||
    usedCharacters < 0 ||
    !Number.isSafeInteger(requestedCharacters) ||
    requestedCharacters < 0 ||
    requestedCharacters > maxCharacters - usedCharacters
  ) {
    budget.materializedCharacters = Math.max(0, maxCharacters);
    return false;
  }
  budget.materializedCharacters = usedCharacters + requestedCharacters;
  return true;
}

export interface VisitNestedStringsOptions {
  readonly includeKeys?: boolean;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly budget?: VisitNestedStringsBudget;
  readonly shouldVisit?: (context: NestedStringContext & { readonly value: unknown }) => boolean;
  readonly shouldInclude?: (value: string, context: NestedStringContext) => boolean;
}

export function getBoundedOwnEnumerableEntries(
  value: object,
  limit: number,
): {
  readonly entries: [string, unknown][];
  readonly complete: boolean;
  readonly reason?: 'object_entries' | 'reflection_error';
} {
  const entries: [string, unknown][] = [];
  if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit < 0)) {
    return { entries, complete: false, reason: 'object_entries' };
  }
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        continue;
      }
      if (entries.length >= limit) {
        return { entries, complete: false, reason: 'object_entries' };
      }
      entries.push([key, (value as { readonly [key: string]: unknown })[key]]);
    }
  } catch {
    return { entries, complete: false, reason: 'reflection_error' };
  }
  return { entries, complete: true };
}

export interface UninspectableNestedContentResponse {
  readonly error: 'content_filter_uninspectable';
  readonly message: string;
  readonly source: ContentSource;
  readonly field: ContentFieldMap[ContentSource];
}

export type ContentTraversalScope = {
  [Source in ContentSource]: {
    readonly source: Source;
    readonly fields: readonly ContentFieldMap[Source][];
  };
}[ContentSource];

const CONTENT_TRAVERSAL_FRAGMENTS = new WeakMap<object, readonly TextContentFragment[]>();
const CONTENT_TRAVERSAL_SCOPES = new WeakMap<object, readonly ContentTraversalScope[]>();

export type ContentTraversalLimitReason =
  | 'max_depth'
  | 'max_nodes'
  | 'array_length'
  | 'object_entries'
  | 'reflection_error';

export interface ContentTraversalDiagnostics {
  readonly operation: 'omit_resolved_file_locators';
  readonly reason: ContentTraversalLimitReason;
  readonly visitedNodes: number;
  readonly depth: number;
}

export class ContentTraversalLimitError extends Error {
  public readonly code = 'content_filter_uninspectable';
  public readonly statusCode = 400;
  public readonly body: UninspectableNestedContentResponse;
  public readonly diagnostics?: ContentTraversalDiagnostics;

  constructor(
    fragments: readonly TextContentFragment[] = [],
    scopes: readonly ContentTraversalScope[] = [],
    diagnostics?: ContentTraversalDiagnostics,
  ) {
    const primaryScope = scopes.find(({ fields }) => fields.length > 0);
    const body: UninspectableNestedContentResponse = {
      error: 'content_filter_uninspectable',
      message: 'Submitted content could not be completely inspected before processing.',
      source: primaryScope?.source ?? 'message',
      field: primaryScope?.fields[0] ?? 'content_part',
    };
    super(body.message);
    this.name = 'ContentTraversalLimitError';
    this.body = body;
    this.diagnostics = diagnostics;
    CONTENT_TRAVERSAL_FRAGMENTS.set(this, fragments);
    CONTENT_TRAVERSAL_SCOPES.set(this, scopes);
    Object.setPrototypeOf(this, ContentTraversalLimitError.prototype);
  }
}

export function isContentTraversalLimitError(error: unknown): error is ContentTraversalLimitError {
  return error instanceof ContentTraversalLimitError;
}

export function getContentTraversalFragments(
  error: ContentTraversalLimitError,
): readonly TextContentFragment[] {
  return CONTENT_TRAVERSAL_FRAGMENTS.get(error) ?? [];
}

export function prependContentTraversalFragments(
  error: ContentTraversalLimitError,
  fragments: readonly TextContentFragment[],
): void {
  if (fragments.length === 0) {
    return;
  }
  CONTENT_TRAVERSAL_FRAGMENTS.set(error, [
    ...fragments,
    ...(CONTENT_TRAVERSAL_FRAGMENTS.get(error) ?? []),
  ]);
}

export function getContentTraversalScopes(
  error: ContentTraversalLimitError,
): readonly ContentTraversalScope[] {
  return CONTENT_TRAVERSAL_SCOPES.get(error) ?? [];
}

function isFieldEnabled(
  pii: { readonly fields?: readonly string[] } | null | undefined,
  field: string,
): boolean {
  return pii != null && (pii.fields == null || pii.fields.includes(field));
}

function hasActivePatterns(
  pii:
    | {
        readonly starterPatterns?: readonly string[];
        readonly customPatterns?: readonly unknown[];
      }
    | null
    | undefined,
): boolean {
  return (
    pii != null &&
    (pii.starterPatterns == null ||
      pii.starterPatterns.length > 0 ||
      (pii.customPatterns?.length ?? 0) > 0)
  );
}

type PiiActionConfig = Pick<NonNullable<NonNullable<FiltersConfig['messages']>['pii']>, 'action'>;

function blocksFindings(pii: PiiActionConfig | null | undefined): boolean {
  return pii?.action !== 'audit';
}

function isScopedTraversalProtected(
  scopes: readonly ContentTraversalScope[],
  source: ContentSource,
  pii:
    | {
        readonly fields?: readonly string[];
        readonly starterPatterns?: readonly string[];
        readonly customPatterns?: readonly unknown[];
        readonly action?: PiiActionConfig['action'];
      }
    | null
    | undefined,
): boolean {
  if (!hasActivePatterns(pii) || !blocksFindings(pii)) {
    return false;
  }
  const sourceScopes = scopes.filter((scope) => scope.source === source);
  if (sourceScopes.length === 0) {
    return false;
  }
  return (
    pii?.fields == null ||
    sourceScopes.some(({ fields }) => fields.some((field) => pii.fields?.includes(field) === true))
  );
}

function isScopedFileTraversalProtected(
  scopes: readonly ContentTraversalScope[],
  pii: NonNullable<FiltersConfig['files']>['pii'],
): boolean {
  if (
    pii == null ||
    ((!hasActivePatterns(pii) || !blocksFindings(pii)) && pii.uninspectable !== 'block')
  ) {
    return false;
  }
  const fileScopes = scopes.filter((scope) => scope.source === 'file');
  if (fileScopes.length === 0) {
    return false;
  }
  return (
    pii.fields == null ||
    fileScopes.some(({ fields }) => fields.some((field) => pii.fields?.includes(field) === true))
  );
}

export function isNestedMessageTraversalProtected(params: {
  readonly filters?: FiltersConfig;
  readonly legacyPii?: MessageFilterPiiConfig;
  readonly roles?: readonly (string | undefined)[];
}): boolean {
  if (
    hasActivePatterns(params.legacyPii) ||
    (hasActivePatterns(params.filters?.messages?.pii) &&
      blocksFindings(params.filters?.messages?.pii) &&
      (isFieldEnabled(params.filters?.messages?.pii, 'content_part') ||
        isFieldEnabled(params.filters?.messages?.pii, 'assembled_context')))
  ) {
    return true;
  }
  const roles = params.roles ?? [];
  if (
    roles.some((role) => role === 'system' || role === 'developer') &&
    hasActivePatterns(params.filters?.agentInstructions?.pii) &&
    blocksFindings(params.filters?.agentInstructions?.pii) &&
    isFieldEnabled(params.filters?.agentInstructions?.pii, 'instructions')
  ) {
    return true;
  }
  return (
    roles.some((role) => role === 'tool') &&
    hasActivePatterns(params.filters?.toolArguments?.pii) &&
    blocksFindings(params.filters?.toolArguments?.pii) &&
    isFieldEnabled(params.filters?.toolArguments?.pii, 'output')
  );
}

export function isModelParameterTraversalProtected(params: {
  readonly error: ContentTraversalLimitError;
  readonly filters?: FiltersConfig;
}): boolean {
  const pii = params.filters?.modelParameters?.pii;
  if (!hasActivePatterns(pii) || !blocksFindings(pii)) {
    return false;
  }
  const scopes = getContentTraversalScopes(params.error).filter(
    (scope): scope is Extract<ContentTraversalScope, { readonly source: 'model_parameter' }> =>
      scope.source === 'model_parameter',
  );
  if (scopes.length === 0) {
    return false;
  }
  return (
    pii?.fields == null ||
    scopes.some(({ fields }) => fields.some((field) => pii.fields?.includes(field) === true))
  );
}

export function isContentTraversalProtected(params: {
  readonly error: ContentTraversalLimitError;
  readonly filters?: FiltersConfig;
  readonly legacyPii?: MessageFilterPiiConfig;
  readonly roles?: readonly (string | undefined)[];
}): boolean {
  const scopes = getContentTraversalScopes(params.error);
  if (isModelParameterTraversalProtected(params)) {
    return true;
  }
  if (
    isScopedTraversalProtected(scopes, 'tool_argument', params.filters?.toolArguments?.pii) ||
    isScopedTraversalProtected(scopes, 'message', params.filters?.messages?.pii) ||
    isScopedTraversalProtected(scopes, 'assembled_context', params.filters?.messages?.pii) ||
    isScopedTraversalProtected(scopes, 'prompt', params.filters?.prompts?.pii) ||
    isScopedTraversalProtected(scopes, 'memory', params.filters?.memories?.pii) ||
    isScopedFileTraversalProtected(scopes, params.filters?.files?.pii) ||
    isScopedTraversalProtected(
      scopes,
      'agent_instruction',
      params.filters?.agentInstructions?.pii,
    ) ||
    isScopedTraversalProtected(
      scopes,
      'conversation_starter',
      params.filters?.conversationStarters?.pii,
    ) ||
    isScopedTraversalProtected(
      scopes,
      'conversation_title',
      params.filters?.conversationTitles?.pii,
    ) ||
    isScopedTraversalProtected(scopes, 'feedback', params.filters?.feedback?.pii) ||
    isScopedTraversalProtected(scopes, 'skill', params.filters?.skills?.pii) ||
    isScopedTraversalProtected(scopes, 'action_metadata', params.filters?.actionMetadata?.pii)
  ) {
    return true;
  }
  if (
    scopes.length > 0 &&
    hasActivePatterns(params.legacyPii) &&
    scopes.some(
      (scope) =>
        scope.source === 'message' ||
        scope.source === 'assembled_context' ||
        (scope.source === 'tool_argument' &&
          (scope.fields.includes('arguments') || scope.fields.includes('output'))),
    )
  ) {
    return true;
  }
  if (scopes.length > 0) {
    return false;
  }
  return isNestedMessageTraversalProtected(params);
}

interface PendingValue {
  readonly value: unknown;
  readonly path: JsonPointer;
  readonly key: string | undefined;
  readonly parent: object | undefined;
  readonly depth: number;
}

export function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function isDataUri(value: string): boolean {
  return value.trimStart().slice(0, DATA_URI_PREFIX.length).toLowerCase() === DATA_URI_PREFIX;
}

export function isLikelyEncodedPayload(
  value: string,
  key: string | undefined,
  parent: object | undefined,
): boolean {
  if (isDataUri(value) || key === 'file_data') {
    return true;
  }
  if (key !== 'data') {
    return false;
  }
  const type =
    parent != null && 'type' in parent && typeof parent.type === 'string'
      ? parent.type.toLowerCase()
      : '';
  const typedPayload =
    type.includes('audio') ||
    type.includes('base64') ||
    type.includes('file') ||
    type.includes('image') ||
    type.includes('video');
  return typedPayload || (value.length >= 128 && BASE64_VALUE.test(value));
}

export function shouldIncludeNestedSubmittedText(
  value: string,
  context: NestedStringContext,
): boolean {
  return (
    !STRUCTURAL_CONTENT_KEYS.has(context.key ?? '') &&
    !isLikelyEncodedPayload(value, context.key, context.parent)
  );
}

/**
 * Visits textual leaves with hard object/depth budgets and cycle protection.
 * Callers decide which already-classified or opaque subtrees should be skipped.
 */
export function visitNestedStrings(
  value: unknown,
  path: JsonPointer,
  onString: (value: string, path: JsonPointer) => void,
  options: VisitNestedStringsOptions = {},
): boolean {
  const maxDepth = options.maxDepth ?? CONTENT_TRAVERSAL_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? options.budget?.maxNodes ?? CONTENT_TRAVERSAL_MAX_NODES;
  const pending: PendingValue[] = [{ value, path, key: undefined, parent: undefined, depth: 0 }];
  const seen = new WeakSet<object>();
  let visitedNodes = 0;
  let complete = true;
  const getVisitedNodes = () => options.budget?.visitedNodes ?? visitedNodes;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null) {
      continue;
    }
    if (current.depth > maxDepth) {
      complete = false;
      continue;
    }
    const context = {
      key: current.key,
      parent: current.parent,
      path: current.path,
    };
    if (options.shouldVisit?.({ ...context, value: current.value }) === false) {
      continue;
    }
    if (getVisitedNodes() >= maxNodes) {
      complete = false;
      break;
    }
    visitedNodes++;
    if (options.budget != null) {
      options.budget.visitedNodes++;
    }
    if (typeof current.value === 'string') {
      if (current.value.length > 0 && options.shouldInclude?.(current.value, context) !== false) {
        onString(current.value, current.path);
      }
      continue;
    }
    if (current.value == null || typeof current.value !== 'object') {
      continue;
    }
    if (seen.has(current.value)) {
      continue;
    }
    seen.add(current.value);

    let currentIsArray: boolean;
    try {
      currentIsArray = Array.isArray(current.value);
    } catch {
      complete = false;
      continue;
    }
    if (currentIsArray) {
      const arrayValue = current.value as unknown[];
      let arrayLength: number;
      try {
        arrayLength = arrayValue.length;
      } catch {
        complete = false;
        continue;
      }
      if (!Number.isSafeInteger(arrayLength) || arrayLength < 0) {
        complete = false;
        continue;
      }
      if (current.depth >= maxDepth && arrayLength > 0) {
        complete = false;
        continue;
      }
      const availableNodes = Math.max(0, maxNodes - getVisitedNodes() - pending.length);
      const scheduledNodes = Math.min(arrayLength, availableNodes);
      if (scheduledNodes < arrayLength) {
        complete = false;
      }
      try {
        for (let index = scheduledNodes - 1; index >= 0; index--) {
          pending.push({
            value: arrayValue[index],
            path: `${current.path}/${index}`,
            key: String(index),
            parent: arrayValue,
            depth: current.depth + 1,
          });
        }
      } catch {
        complete = false;
      }
      continue;
    }

    const availableNodes = Math.max(0, maxNodes - getVisitedNodes() - pending.length);
    const boundedEntries = getBoundedOwnEnumerableEntries(current.value, availableNodes);
    const entries = boundedEntries.entries;
    if (!boundedEntries.complete) {
      complete = false;
    }
    if (current.depth >= maxDepth && (entries.length > 0 || !boundedEntries.complete)) {
      complete = false;
      continue;
    }
    const scheduledNodes = entries.length;
    if (options.includeKeys === true) {
      for (let index = 0; index < scheduledNodes; index++) {
        const [key] = entries[index];
        const keyPath = `${current.path}/${escapeJsonPointer(key)}` as JsonPointer;
        const context = { key, parent: current.value, path: keyPath };
        if (
          key.length > 0 &&
          options.shouldVisit?.({ ...context, value: key }) !== false &&
          options.shouldInclude?.(key, context) !== false
        ) {
          onString(key, keyPath);
        }
      }
    }
    for (let index = scheduledNodes - 1; index >= 0; index--) {
      const [key, entryValue] = entries[index];
      pending.push({
        value: entryValue,
        path: `${current.path}/${escapeJsonPointer(key)}`,
        key,
        parent: current.value,
        depth: current.depth + 1,
      });
    }
  }
  return complete && pending.length === 0;
}
