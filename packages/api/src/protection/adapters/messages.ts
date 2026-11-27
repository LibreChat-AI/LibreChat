import { isProxy } from 'node:util/types';
import type { ContentFieldMap, ContentSource, TextContentFragment } from '../types';
import type { ContentTraversalScope, VisitNestedStringsBudget } from './nested';
import {
  CONTENT_TRAVERSAL_MAX_DEPTH,
  CONTENT_TRAVERSAL_MAX_NODES,
  ContentTraversalLimitError,
  getBoundedOwnEnumerableEntries,
  isDataUri,
  reserveContentMaterialization,
  shouldIncludeNestedSubmittedText,
  visitNestedStrings,
} from './nested';

export interface ExternalMessagePart {
  readonly type?: string;
  readonly text?: string;
  readonly data?: string;
  readonly url?: string;
  readonly source_type?: string;
  readonly image_url?: string | { readonly url?: string };
  readonly file_id?: string;
  readonly file_data?: string;
  readonly filename?: string;
  readonly source?: {
    readonly type?: string;
    readonly data?: string;
    readonly url?: string;
    readonly [key: string]: unknown;
  };
  readonly input_audio?: {
    readonly data?: string;
    readonly format?: string;
  };
  readonly file?: {
    readonly file_id?: string;
    readonly file_data?: string;
    readonly filename?: string;
  };
  readonly [key: string]: unknown;
}

export interface ExternalToolCall {
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

export interface ExternalChatMessage {
  readonly role?: string;
  readonly name?: string;
  readonly content?: string | readonly (ExternalMessagePart | null | undefined)[];
  readonly tool_calls?: readonly (ExternalToolCall | null | undefined)[];
}

function createMessageFragment<Source extends ContentSource>(
  id: string,
  path: TextContentFragment['path'],
  text: string,
  source: Source,
  field: ContentFieldMap[Source],
  format: TextContentFragment['format'] = 'plain',
  treatment: TextContentFragment['treatment'] = 'replaceable',
): Extract<TextContentFragment, { source: Source }> {
  return {
    id,
    path,
    text,
    source,
    field,
    format,
    treatment,
    provenance: 'user',
  } as Extract<TextContentFragment, { source: Source }>;
}

type InlineFileTextField = 'content' | 'extracted_text';

interface ProviderReference {
  readonly key: string;
  readonly value: string;
  readonly path: TextContentFragment['path'];
}

interface InspectableReference {
  readonly key: string;
  readonly value: string | undefined;
  readonly path: TextContentFragment['path'];
  readonly format: TextContentFragment['format'];
  readonly fileField: ContentFieldMap['file'] | undefined;
}

interface ProviderInlineText {
  readonly key: string;
  readonly value: string;
  readonly path: TextContentFragment['path'];
  readonly fileField: InlineFileTextField;
  readonly includeAsMessageContent: boolean;
}

interface ProviderPartClassification {
  readonly handledPaths: ReadonlySet<string>;
  readonly references: readonly ProviderReference[];
  readonly inlineTexts: readonly ProviderInlineText[];
}

const PROVIDER_ATTACHMENT_TYPES = new Set(['document', 'file', 'image']);
const PROVIDER_DOCUMENT_TYPES = new Set(['document', 'file']);
const MAX_EXTERNAL_MESSAGES = CONTENT_TRAVERSAL_MAX_NODES;
const MAX_EXTERNAL_MESSAGE_ARRAY_ITEMS = CONTENT_TRAVERSAL_MAX_NODES;
/** One submitted part root, one common payload wrapper, and 4,096 submitted leaves. */
const DEFAULT_EXTERNAL_MESSAGE_TRAVERSAL_MAX_NODES = CONTENT_TRAVERSAL_MAX_NODES + 2;
const MAX_EXTERNAL_MESSAGE_FRAGMENTS = CONTENT_TRAVERSAL_MAX_NODES * 4;
const MAX_EXTERNAL_MESSAGE_SNAPSHOT_WORK = CONTENT_TRAVERSAL_MAX_NODES * 4;
/** Keys and values can each contribute once for every bounded nested node. */
const MAX_ASSEMBLED_CONTEXT_PARTS = CONTENT_TRAVERSAL_MAX_NODES * 2;
const SNAPSHOT_SUPPORTED_PROPERTY_SLACK = 32;

const EXTERNAL_MESSAGE_TRAVERSAL_SCOPES: readonly ContentTraversalScope[] = [
  { source: 'message', fields: ['name', 'text', 'content_part', 'attachment_reference'] },
  { source: 'assembled_context', fields: ['assembled_context'] },
  { source: 'agent_instruction', fields: ['instructions'] },
  { source: 'file', fields: ['name', 'uri', 'content', 'extracted_text', 'transcript'] },
  { source: 'tool_argument', fields: ['name', 'arguments', 'output'] },
];
const ASSEMBLED_CONTEXT_TRAVERSAL_SCOPE: readonly ContentTraversalScope[] = [
  { source: 'assembled_context', fields: ['assembled_context'] },
];

function getAssembledContextTraversalScopes(
  role: string | undefined,
  isInstruction: boolean,
): ContentTraversalScope[] {
  const scopes: ContentTraversalScope[] = [...ASSEMBLED_CONTEXT_TRAVERSAL_SCOPE];
  if (isInstruction) {
    scopes.push({ source: 'agent_instruction', fields: ['instructions'] });
  }
  if (role === 'tool') {
    scopes.push({ source: 'tool_argument', fields: ['output'] });
  }
  return scopes;
}

const PART_SNAPSHOT_KEYS = [
  'type',
  'text',
  'data',
  'url',
  'source_type',
  'image_url',
  'file_id',
  'file_data',
  'filename',
  'source',
  'input_audio',
  'file',
] as const;
const SNAPSHOT_KEYS_BY_PARENT_KEY: Readonly<Record<string, readonly string[]>> = {
  source: ['type', 'data', 'url'],
  image_url: ['url'],
  file: ['file_id', 'file_data', 'filename'],
  input_audio: ['data', 'format'],
  tool_call: ['name', 'args', 'arguments', 'function', 'code_interpreter', 'output'],
  function: ['name', 'arguments', 'output'],
  code_interpreter: ['input', 'outputs'],
};
const OMIT_SNAPSHOT_VALUE = Symbol('omit-snapshot-value');

interface SnapshotState {
  remaining: number;
  complete: boolean;
  readonly seen: WeakMap<object, unknown>;
}

interface MessageEnvelopeSnapshot {
  readonly role: string | undefined;
  readonly name: unknown;
  readonly content: unknown;
  readonly toolCalls: unknown;
  readonly complete: boolean;
}

interface ToolCallSnapshot {
  readonly name: unknown;
  readonly arguments: unknown;
  readonly complete: boolean;
}

function readSubmittedProperty(
  value: object,
  key: string,
): { readonly value: unknown; readonly complete: boolean } {
  try {
    return {
      value: (value as { readonly [key: string]: unknown })[key],
      complete: true,
    };
  } catch {
    return { value: undefined, complete: false };
  }
}

function snapshotMessageEnvelope(message: object): MessageEnvelopeSnapshot {
  const name = readSubmittedProperty(message, 'name');
  const role = readSubmittedProperty(message, 'role');
  let normalizedRole = typeof role.value === 'string' ? role.value : undefined;
  let roleComplete = role.complete;
  if (normalizedRole == null) {
    const typeGetter = readSubmittedProperty(message, '_getType');
    roleComplete = roleComplete && typeGetter.complete;
    if (typeof typeGetter.value === 'function') {
      try {
        const type = typeGetter.value.call(message);
        normalizedRole = typeof type === 'string' ? type : undefined;
      } catch {
        roleComplete = false;
      }
    }
  }
  if (normalizedRole === 'human') {
    normalizedRole = 'user';
  } else if (normalizedRole === 'ai') {
    normalizedRole = 'assistant';
  }
  const content = readSubmittedProperty(message, 'content');
  const toolCalls = readSubmittedProperty(message, 'tool_calls');
  return {
    name: name.value,
    role: normalizedRole,
    content: content.value,
    toolCalls: toolCalls.value,
    complete: name.complete && roleComplete && content.complete && toolCalls.complete,
  };
}

function snapshotToolCall(value: object): ToolCallSnapshot {
  const fn = readSubmittedProperty(value, 'function');
  if (fn.value == null || typeof fn.value !== 'object') {
    return {
      name: undefined,
      arguments: undefined,
      complete: fn.complete,
    };
  }
  const name = readSubmittedProperty(fn.value, 'name');
  const args = readSubmittedProperty(fn.value, 'arguments');
  return {
    name: name.value,
    arguments: args.value,
    complete: fn.complete && name.complete && args.complete,
  };
}

function snapshotNestedSubmittedValue(
  value: unknown,
  state: SnapshotState,
  depth: number,
  parentKey: string | undefined,
  root = false,
): unknown | typeof OMIT_SNAPSHOT_VALUE {
  if (depth > CONTENT_TRAVERSAL_MAX_DEPTH || state.remaining <= 0) {
    state.complete = false;
    return OMIT_SNAPSHOT_VALUE;
  }
  state.remaining--;
  if (value == null || typeof value !== 'object') {
    return value;
  }

  const seen = state.seen.get(value);
  if (seen != null) {
    return seen;
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    state.complete = false;
    return OMIT_SNAPSHOT_VALUE;
  }
  if (isArray) {
    const candidate = value as readonly unknown[];
    let length: number;
    try {
      length = candidate.length;
    } catch {
      state.complete = false;
      return OMIT_SNAPSHOT_VALUE;
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      state.complete = false;
      return OMIT_SNAPSHOT_VALUE;
    }
    const snapshot: unknown[] = [];
    state.seen.set(value, snapshot);
    const scheduled = Math.min(length, state.remaining);
    if (scheduled < length) {
      state.complete = false;
    }
    for (let index = 0; index < scheduled; index++) {
      let child: unknown;
      try {
        child = candidate[index];
      } catch {
        state.complete = false;
        break;
      }
      const captured = snapshotNestedSubmittedValue(child, state, depth + 1, String(index));
      if (captured === OMIT_SNAPSHOT_VALUE) {
        break;
      }
      snapshot.push(captured);
    }
    return Object.freeze(snapshot);
  }

  if (isProxy(value)) {
    state.complete = false;
    return OMIT_SNAPSHOT_VALUE;
  }

  const snapshot = Object.create(null) as Record<string, unknown>;
  state.seen.set(value, snapshot);
  const boundedEntries = getBoundedOwnEnumerableEntries(value, state.remaining);
  if (!boundedEntries.complete) {
    state.complete = false;
  }
  const capturedKeys = new Set<string>();
  for (const [key, child] of boundedEntries.entries) {
    capturedKeys.add(key);
    const captured = snapshotNestedSubmittedValue(child, state, depth + 1, key);
    if (captured === OMIT_SNAPSHOT_VALUE) {
      break;
    }
    snapshot[key] = captured;
  }

  const supportedKeys = root ? PART_SNAPSHOT_KEYS : SNAPSHOT_KEYS_BY_PARENT_KEY[parentKey ?? ''];
  for (const key of supportedKeys ?? []) {
    if (capturedKeys.has(key)) {
      continue;
    }
    const child = readSubmittedProperty(value, key);
    if (!child.complete) {
      state.complete = false;
      continue;
    }
    if (child.value === undefined) {
      continue;
    }
    const captured = snapshotNestedSubmittedValue(child.value, state, depth + 1, key);
    if (captured === OMIT_SNAPSHOT_VALUE) {
      break;
    }
    snapshot[key] = captured;
  }
  return Object.freeze(snapshot);
}

function snapshotProviderPart(
  part: object,
  traversalBudget: VisitNestedStringsBudget,
  traversalMaxNodes: number,
  availableSnapshotWork = Number.POSITIVE_INFINITY,
): {
  readonly value: ExternalMessagePart | undefined;
  readonly complete: boolean;
  readonly snapshotWork: number;
} {
  const remainingTraversalWork = Math.max(0, traversalMaxNodes - traversalBudget.visitedNodes);
  const snapshotCapacity = Math.min(
    remainingTraversalWork + SNAPSHOT_SUPPORTED_PROPERTY_SLACK,
    availableSnapshotWork,
  );
  const state: SnapshotState = {
    remaining: snapshotCapacity,
    complete: true,
    seen: new WeakMap(),
  };
  const snapshot = snapshotNestedSubmittedValue(part, state, 0, undefined, true);
  return {
    value:
      snapshot === OMIT_SNAPSHOT_VALUE ? undefined : (snapshot as ExternalMessagePart | undefined),
    complete: state.complete,
    snapshotWork: snapshotCapacity - state.remaining,
  };
}

const PREPARED_EXTERNAL_MESSAGES: unique symbol = Symbol('prepared-external-messages');

export interface PreparedExternalMessages {
  readonly messages: readonly (ExternalChatMessage | null | undefined)[];
  readonly roles: readonly (string | undefined)[];
  readonly traversalError: ContentTraversalLimitError | null;
  readonly traversalBudget: VisitNestedStringsBudget;
  readonly [PREPARED_EXTERNAL_MESSAGES]: true;
}

function isPreparedExternalMessages(value: unknown): value is PreparedExternalMessages {
  try {
    return (
      value != null &&
      typeof value === 'object' &&
      (value as Partial<PreparedExternalMessages>)[PREPARED_EXTERNAL_MESSAGES] === true
    );
  } catch {
    return false;
  }
}

/**
 * Captures the bounded message graph once so file and text inspection observe identical values.
 * The returned graph is frozen and can be passed directly to extractMessageContent.
 */
export function snapshotExternalMessages(
  submittedMessages: readonly (ExternalChatMessage | null | undefined)[],
  traversalBudget: VisitNestedStringsBudget = { visitedNodes: 0 },
): PreparedExternalMessages {
  const messages: Array<ExternalChatMessage | null | undefined> = [];
  const roles: Array<string | undefined> = [];
  const traversalMaxNodes =
    traversalBudget.maxNodes ?? DEFAULT_EXTERNAL_MESSAGE_TRAVERSAL_MAX_NODES;
  let complete = true;
  let haltAfterCurrentMessage = false;
  let visitedArrayItems = 0;
  let remainingSnapshotWork = MAX_EXTERNAL_MESSAGE_SNAPSHOT_WORK;
  let remainingNestedSnapshotWork = Math.max(0, traversalMaxNodes - traversalBudget.visitedNodes);
  const captureArrayLength = (value: unknown): number | undefined => {
    let isArray: boolean;
    let length: number;
    try {
      isArray = Array.isArray(value);
      if (!isArray) {
        complete = false;
        haltAfterCurrentMessage = true;
        return undefined;
      }
      length = (value as readonly unknown[]).length;
    } catch {
      complete = false;
      haltAfterCurrentMessage = true;
      return undefined;
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      complete = false;
      haltAfterCurrentMessage = true;
      return undefined;
    }
    return length;
  };

  if (
    !Number.isSafeInteger(traversalMaxNodes) ||
    traversalMaxNodes < 0 ||
    !Number.isSafeInteger(traversalBudget.visitedNodes) ||
    traversalBudget.visitedNodes < 0
  ) {
    complete = false;
    haltAfterCurrentMessage = true;
  }
  try {
    if (isProxy(submittedMessages)) {
      complete = false;
    }
  } catch {
    complete = false;
    haltAfterCurrentMessage = true;
  }
  const submittedLength = captureArrayLength(submittedMessages) ?? 0;
  const boundedMessageLength = Math.min(submittedLength, MAX_EXTERNAL_MESSAGES);
  if (boundedMessageLength < submittedLength) {
    complete = false;
  }

  for (let messageIndex = 0; messageIndex < boundedMessageLength; messageIndex++) {
    let submittedMessage: ExternalChatMessage | null | undefined;
    try {
      submittedMessage = submittedMessages[messageIndex];
    } catch {
      complete = false;
      break;
    }
    if (submittedMessage == null) {
      messages.push(submittedMessage);
      roles.push(undefined);
      continue;
    }
    if (typeof submittedMessage !== 'object') {
      complete = false;
      break;
    }

    let messageIsProxy = false;
    try {
      messageIsProxy = isProxy(submittedMessage);
    } catch {
      complete = false;
      haltAfterCurrentMessage = true;
    }
    const envelope = snapshotMessageEnvelope(submittedMessage);
    const role = envelope.role;
    let messageComplete = envelope.complete && !messageIsProxy;
    if (messageIsProxy) {
      complete = false;
    }
    let contentSnapshot: ExternalChatMessage['content'];
    if (typeof envelope.content === 'string') {
      contentSnapshot = envelope.content;
    } else if (envelope.content != null) {
      const contentLength = captureArrayLength(envelope.content);
      if (contentLength != null) {
        const availableArrayWork = Math.max(
          0,
          MAX_EXTERNAL_MESSAGE_ARRAY_ITEMS - visitedArrayItems,
        );
        const boundedContentLength = Math.min(contentLength, availableArrayWork);
        if (boundedContentLength < contentLength) {
          complete = false;
          messageComplete = false;
        }
        const content: Array<ExternalMessagePart | null | undefined> = [];
        for (let partIndex = 0; partIndex < boundedContentLength; partIndex++) {
          visitedArrayItems++;
          let submittedPart: ExternalMessagePart | null | undefined;
          try {
            submittedPart = (
              envelope.content as readonly (ExternalMessagePart | null | undefined)[]
            )[partIndex];
          } catch {
            complete = false;
            messageComplete = false;
            break;
          }
          if (submittedPart == null) {
            content.push(submittedPart);
            continue;
          }
          if (remainingSnapshotWork <= 0 || remainingNestedSnapshotWork <= 0) {
            complete = false;
            messageComplete = false;
            break;
          }
          let stablePart: unknown = submittedPart;
          let partSnapshotComplete = true;
          if (typeof submittedPart === 'object') {
            const partSnapshot = snapshotProviderPart(
              submittedPart,
              traversalBudget,
              traversalMaxNodes,
              Math.min(
                remainingSnapshotWork,
                remainingNestedSnapshotWork + SNAPSHOT_SUPPORTED_PROPERTY_SLACK,
              ),
            );
            remainingSnapshotWork -= partSnapshot.snapshotWork;
            stablePart = partSnapshot.value;
            partSnapshotComplete = partSnapshot.complete && stablePart != null;
          }
          if (stablePart == null || stablePart === OMIT_SNAPSHOT_VALUE) {
            complete = false;
            messageComplete = false;
            break;
          }
          const basePath = `/${messageIndex}/content/${partIndex}` as const;
          const stableProviderPart =
            typeof stablePart === 'object' ? (stablePart as ExternalMessagePart) : undefined;
          const providerPart =
            stableProviderPart == null
              ? undefined
              : classifyProviderPart(stableProviderPart, basePath);
          const handledPaths = getProviderPartHandledPaths(
            stableProviderPart,
            basePath,
            providerPart,
          );
          const snapshotTraversalBudget: VisitNestedStringsBudget = {
            visitedNodes: 0,
            maxNodes: remainingNestedSnapshotWork,
          };
          const nestedSnapshotComplete = visitNestedStrings(stablePart, basePath, () => undefined, {
            includeKeys: true,
            budget: snapshotTraversalBudget,
            shouldVisit: ({ path, value }) =>
              !handledPaths.has(path) &&
              !(path === `${basePath}/source` && typeof value === 'string' && value === 'source'),
            shouldInclude: shouldIncludeNestedSubmittedText,
          });
          remainingNestedSnapshotWork -= snapshotTraversalBudget.visitedNodes;
          content.push(stablePart as ExternalMessagePart);
          if (!partSnapshotComplete || !nestedSnapshotComplete) {
            complete = false;
            messageComplete = false;
            break;
          }
        }
        contentSnapshot = Object.freeze(content);
      }
    }

    let toolCallSnapshot: ExternalChatMessage['tool_calls'];
    if (envelope.toolCalls != null && messageComplete) {
      const toolCallLength = captureArrayLength(envelope.toolCalls);
      if (toolCallLength != null) {
        const availableArrayWork = Math.max(
          0,
          MAX_EXTERNAL_MESSAGE_ARRAY_ITEMS - visitedArrayItems,
        );
        const boundedToolCallLength = Math.min(toolCallLength, availableArrayWork);
        if (boundedToolCallLength < toolCallLength) {
          complete = false;
          messageComplete = false;
        }
        const toolCalls: Array<ExternalToolCall | null | undefined> = [];
        for (let callIndex = 0; callIndex < boundedToolCallLength; callIndex++) {
          visitedArrayItems++;
          let submittedToolCall: ExternalToolCall | null | undefined;
          try {
            submittedToolCall = (
              envelope.toolCalls as readonly (ExternalToolCall | null | undefined)[]
            )[callIndex];
          } catch {
            complete = false;
            messageComplete = false;
            break;
          }
          if (submittedToolCall == null) {
            toolCalls.push(submittedToolCall);
            continue;
          }
          if (typeof submittedToolCall !== 'object') {
            complete = false;
            messageComplete = false;
            break;
          }
          const callSnapshot = snapshotToolCall(submittedToolCall);
          if (!callSnapshot.complete) {
            complete = false;
            messageComplete = false;
          }
          toolCalls.push(
            Object.freeze({
              function: Object.freeze({
                name: typeof callSnapshot.name === 'string' ? callSnapshot.name : undefined,
                arguments:
                  typeof callSnapshot.arguments === 'string' ? callSnapshot.arguments : undefined,
              }),
            }),
          );
          if (!callSnapshot.complete) {
            break;
          }
        }
        toolCallSnapshot = Object.freeze(toolCalls);
      }
    }

    messages.push(
      Object.freeze({
        role,
        name: typeof envelope.name === 'string' ? envelope.name : undefined,
        content: contentSnapshot,
        tool_calls: toolCallSnapshot,
      }),
    );
    roles.push(role);
    if (!messageComplete || haltAfterCurrentMessage) {
      complete = false;
      break;
    }
  }

  return Object.freeze({
    messages: Object.freeze(messages),
    roles: Object.freeze(roles),
    traversalError: complete
      ? null
      : new ContentTraversalLimitError([], EXTERNAL_MESSAGE_TRAVERSAL_SCOPES),
    traversalBudget,
    [PREPARED_EXTERNAL_MESSAGES]: true as const,
  });
}

function classifyProviderPart(
  part: ExternalMessagePart,
  basePath: TextContentFragment['path'],
): ProviderPartClassification {
  const handledPaths = new Set<string>();
  const references: ProviderReference[] = [];
  const inlineTexts: ProviderInlineText[] = [];
  if (!PROVIDER_ATTACHMENT_TYPES.has(part.type ?? '')) {
    return { handledPaths, references, inlineTexts };
  }

  const seenReferences = new Set<string>();
  const addReference = (
    key: string,
    value: string | undefined,
    path: TextContentFragment['path'],
  ): void => {
    handledPaths.add(path);
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      isDataUri(value) ||
      seenReferences.has(value)
    ) {
      return;
    }
    seenReferences.add(value);
    references.push({ key, value, path });
  };
  const addInlineText = (
    key: string,
    value: string | undefined,
    path: TextContentFragment['path'],
    fileField: InlineFileTextField,
    includeAsMessageContent: boolean,
  ): void => {
    handledPaths.add(path);
    if (typeof value !== 'string' || value.length === 0 || isDataUri(value)) {
      return;
    }
    inlineTexts.push({ key, value, path, fileField, includeAsMessageContent });
  };

  const sourceType = part.source?.type;
  if (sourceType === 'url') {
    addReference('source-data', part.source?.data, `${basePath}/source/data`);
    addReference('source-url', part.source?.url, `${basePath}/source/url`);
  } else if (sourceType === 'text' && PROVIDER_DOCUMENT_TYPES.has(part.type ?? '')) {
    addInlineText(
      'source-data',
      part.source?.data,
      `${basePath}/source/data`,
      'content',
      part.source?.data !== part.text,
    );
  } else if (sourceType === 'base64') {
    handledPaths.add(`${basePath}/source/data`);
  }

  if (typeof part.source_type !== 'string') {
    return { handledPaths, references, inlineTexts };
  }
  handledPaths.add(`${basePath}/source_type`);
  if (part.source_type === 'url') {
    addReference('data', part.data, `${basePath}/data`);
    addReference('url', part.url, `${basePath}/url`);
  } else if (part.source_type === 'text' && PROVIDER_DOCUMENT_TYPES.has(part.type ?? '')) {
    addInlineText('text', part.text, `${basePath}/text`, 'extracted_text', false);
  } else if (part.source_type === 'base64') {
    handledPaths.add(`${basePath}/data`);
  }

  return { handledPaths, references, inlineTexts };
}

function getProviderPartHandledPaths(
  part: ExternalMessagePart | undefined,
  basePath: TextContentFragment['path'],
  providerPart: ProviderPartClassification | undefined,
): ReadonlySet<string> {
  return new Set([
    `${basePath}/type`,
    `${basePath}/text`,
    `${basePath}/image_url`,
    `${basePath}/file_id`,
    `${basePath}/file_data`,
    `${basePath}/filename`,
    `${basePath}/input_audio`,
    `${basePath}/file`,
    `${basePath}/file/file_id`,
    `${basePath}/file/file_data`,
    `${basePath}/file/filename`,
    ...(providerPart?.handledPaths ?? []),
  ]);
}

export function* extractMessageContent(
  input: readonly (ExternalChatMessage | null | undefined)[] | PreparedExternalMessages,
  sharedTraversalBudget?: VisitNestedStringsBudget,
): Generator<TextContentFragment, void, undefined> {
  const prepared = isPreparedExternalMessages(input) ? input : undefined;
  const messages: readonly (ExternalChatMessage | null | undefined)[] =
    prepared != null
      ? prepared.messages
      : (input as readonly (ExternalChatMessage | null | undefined)[]);
  const traversalBudget = sharedTraversalBudget ?? prepared?.traversalBudget ?? { visitedNodes: 0 };
  let traversalComplete = prepared?.traversalError == null;
  let deferredPreparationError = prepared?.traversalError ?? null;
  let hasUnscopedTraversalIncomplete = false;
  const aggregateTraversalScopes: ContentTraversalScope[] = [];
  const aggregateTraversalScopeKeys = new Set<string>();
  let haltAfterCurrentMessage = false;
  let stopAfterCurrentMessage = false;
  let visitedArrayItems = 0;
  let emittedFragments = 0;
  const traversalMaxNodes =
    traversalBudget.maxNodes ?? DEFAULT_EXTERNAL_MESSAGE_TRAVERSAL_MAX_NODES;
  const pendingFragments: TextContentFragment[] = [];
  const markTraversalIncomplete = (): void => {
    traversalComplete = false;
    hasUnscopedTraversalIncomplete = true;
    haltAfterCurrentMessage = true;
  };
  const markAssembledContextIncomplete = (scopes: readonly ContentTraversalScope[]): void => {
    traversalComplete = false;
    for (const scope of scopes) {
      const key = `${scope.source}:${scope.fields.join(',')}`;
      if (!aggregateTraversalScopeKeys.has(key)) {
        aggregateTraversalScopeKeys.add(key);
        aggregateTraversalScopes.push(scope);
      }
    }
  };
  const appendFragment = (fragment: TextContentFragment): boolean => {
    if (emittedFragments >= MAX_EXTERNAL_MESSAGE_FRAGMENTS) {
      markTraversalIncomplete();
      return false;
    }
    emittedFragments++;
    pendingFragments.push(fragment);
    return true;
  };
  const captureArrayLength = (value: unknown): number | undefined => {
    let array: boolean;
    let length: number;
    try {
      array = Array.isArray(value);
      if (!array) {
        if (value != null) {
          markTraversalIncomplete();
        }
        return undefined;
      }
      length = (value as readonly unknown[]).length;
    } catch {
      markTraversalIncomplete();
      return undefined;
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      markTraversalIncomplete();
      return undefined;
    }
    return length;
  };

  let messageLength = captureArrayLength(messages) ?? 0;
  if (
    !Number.isSafeInteger(traversalMaxNodes) ||
    traversalMaxNodes < 0 ||
    !Number.isSafeInteger(traversalBudget.visitedNodes) ||
    traversalBudget.visitedNodes < 0
  ) {
    markTraversalIncomplete();
    messageLength = 0;
  }
  const boundedMessageLength = Math.min(messageLength, MAX_EXTERNAL_MESSAGES);
  if (boundedMessageLength < messageLength) {
    traversalComplete = false;
    hasUnscopedTraversalIncomplete = true;
  }
  if (prepared == null) {
    try {
      if (isProxy(messages)) {
        traversalComplete = false;
        deferredPreparationError = new ContentTraversalLimitError(
          [],
          EXTERNAL_MESSAGE_TRAVERSAL_SCOPES,
        );
      }
    } catch {
      markTraversalIncomplete();
    }
  }

  for (let messageIndex = 0; messageIndex < boundedMessageLength; messageIndex++) {
    let submittedMessage: ExternalChatMessage | null | undefined;
    try {
      submittedMessage = messages[messageIndex];
    } catch {
      markTraversalIncomplete();
      break;
    }
    if (submittedMessage == null) {
      if (haltAfterCurrentMessage) {
        break;
      }
      continue;
    }
    if (typeof submittedMessage !== 'object') {
      markTraversalIncomplete();
      break;
    }

    if (prepared == null) {
      const messageSnapshot = snapshotExternalMessages([submittedMessage], traversalBudget);
      submittedMessage = messageSnapshot.messages[0];
      if (messageSnapshot.traversalError != null) {
        traversalComplete = false;
        deferredPreparationError ??= messageSnapshot.traversalError;
        stopAfterCurrentMessage = true;
      }
      if (submittedMessage == null) {
        break;
      }
    }

    const message = snapshotMessageEnvelope(submittedMessage);
    if (!message.complete) {
      markTraversalIncomplete();
    }
    const role = typeof message.role === 'string' ? message.role : undefined;
    const name = typeof message.name === 'string' ? message.name : undefined;
    const isInstruction = role === 'system' || role === 'developer';
    const assembledContextScopes = getAssembledContextTraversalScopes(role, isInstruction);
    const assembledText: string[] = [];
    let assembledCharacters = 0;
    let assembledBudgetReserved = false;
    let assembledContextOverflowed = false;
    const appendAssembledText = (text: string): void => {
      if (assembledContextOverflowed) {
        return;
      }
      if (assembledText.length === 0) {
        assembledText.push(text);
        assembledCharacters = text.length;
        return;
      }
      const requestedCharacters = assembledBudgetReserved
        ? text.length
        : assembledCharacters + text.length;
      if (
        assembledText.length >= MAX_ASSEMBLED_CONTEXT_PARTS ||
        !reserveContentMaterialization(traversalBudget, requestedCharacters)
      ) {
        // Individual content parts remain inspectable. Stop only aggregate
        // construction so later direct fragments cannot be hidden by a
        // scoped aggregate overflow.
        assembledContextOverflowed = true;
        markAssembledContextIncomplete(assembledContextScopes);
        return;
      }
      assembledBudgetReserved = true;
      assembledText.push(text);
      assembledCharacters += text.length;
    };
    if (name != null && name.length > 0) {
      appendFragment(
        createMessageFragment(
          `external-message.${messageIndex}.name`,
          `/${messageIndex}/name`,
          name,
          'message',
          'name',
        ),
      );
    }
    const content = message.content;
    if (typeof content === 'string') {
      appendAssembledText(content);
      appendFragment(
        createMessageFragment(
          `external-message.${messageIndex}.content`,
          `/${messageIndex}/content`,
          content,
          'message',
          'text',
        ),
      );
      if (isInstruction) {
        appendFragment(
          createMessageFragment(
            `external-message.${messageIndex}.instruction`,
            `/${messageIndex}/content`,
            content,
            'agent_instruction',
            'instructions',
          ),
        );
      }
      if (role === 'tool') {
        appendFragment(
          createMessageFragment(
            `external-message.${messageIndex}.tool-output`,
            `/${messageIndex}/content`,
            content,
            'tool_argument',
            'output',
            'plain',
            'inspect_only',
          ),
        );
      }
    }
    yield* pendingFragments;
    pendingFragments.length = 0;

    const contentLength =
      typeof content === 'string' || content == null ? undefined : captureArrayLength(content);
    if (contentLength != null) {
      const availableArrayWork = Math.max(0, MAX_EXTERNAL_MESSAGE_ARRAY_ITEMS - visitedArrayItems);
      const boundedContentLength = Math.min(contentLength, availableArrayWork);
      const contentOverflowed = boundedContentLength < contentLength;
      if (contentOverflowed) {
        traversalComplete = false;
        hasUnscopedTraversalIncomplete = true;
      }
      for (let partIndex = 0; partIndex < boundedContentLength; partIndex++) {
        if (traversalBudget.visitedNodes >= traversalMaxNodes) {
          markTraversalIncomplete();
          break;
        }
        visitedArrayItems++;
        let submittedPart: ExternalMessagePart | null | undefined;
        try {
          submittedPart = (content as readonly (ExternalMessagePart | null | undefined)[])[
            partIndex
          ];
        } catch {
          markTraversalIncomplete();
          break;
        }
        if (submittedPart == null) {
          if (haltAfterCurrentMessage) {
            break;
          }
          continue;
        }

        const part =
          typeof submittedPart === 'object' ? (submittedPart as ExternalMessagePart) : undefined;
        const nestedValue: unknown = submittedPart;

        const directText =
          typeof part?.text === 'string' && !isDataUri(part.text) ? part.text : undefined;
        if (directText != null) {
          appendAssembledText(directText);
          appendFragment(
            createMessageFragment(
              `external-message.${messageIndex}.part.${partIndex}`,
              `/${messageIndex}/content/${partIndex}/text`,
              directText,
              'message',
              'content_part',
            ),
          );
          if (isInstruction) {
            appendFragment(
              createMessageFragment(
                `external-message.${messageIndex}.part.${partIndex}.instruction`,
                `/${messageIndex}/content/${partIndex}/text`,
                directText,
                'agent_instruction',
                'instructions',
              ),
            );
          }
          if (role === 'tool') {
            appendFragment(
              createMessageFragment(
                `external-message.${messageIndex}.part.${partIndex}.tool-output`,
                `/${messageIndex}/content/${partIndex}/text`,
                directText,
                'tool_argument',
                'output',
                'plain',
                'inspect_only',
              ),
            );
          }
        }
        let uri: string | undefined;
        if (typeof part?.image_url === 'string') {
          uri = part.image_url;
        } else if (typeof part?.image_url?.url === 'string') {
          uri = part.image_url.url;
        }
        const basePath = `/${messageIndex}/content/${partIndex}` as const;
        const providerPart = part == null ? undefined : classifyProviderPart(part, basePath);
        const inspectableUri = uri != null && !isDataUri(uri) ? uri : undefined;
        const references: InspectableReference[] = [
          {
            key: 'uri',
            value: inspectableUri,
            path: `/${messageIndex}/content/${partIndex}/image_url`,
            format: 'uri' as const,
            fileField: 'uri' as const,
          },
          {
            key: 'file-id',
            value: part?.file_id,
            path: `/${messageIndex}/content/${partIndex}/file_id`,
            format: 'plain' as const,
            fileField: undefined,
          },
          {
            key: 'filename',
            value: part?.filename,
            path: `/${messageIndex}/content/${partIndex}/filename`,
            format: 'plain' as const,
            fileField: 'name' as const,
          },
          {
            key: 'nested-file-id',
            value: part?.file?.file_id,
            path: `/${messageIndex}/content/${partIndex}/file/file_id`,
            format: 'plain' as const,
            fileField: undefined,
          },
          {
            key: 'nested-filename',
            value: part?.file?.filename,
            path: `/${messageIndex}/content/${partIndex}/file/filename`,
            format: 'plain' as const,
            fileField: 'name' as const,
          },
          ...(providerPart?.references.map((reference) => ({
            ...reference,
            format: 'uri' as const,
            fileField: 'uri' as const,
          })) ?? []),
        ];
        const seenAttachmentReferences = new Set<string>();
        const seenFileReferences = new Set<string>();
        for (const reference of references) {
          if (typeof reference.value !== 'string' || reference.value.length === 0) {
            continue;
          }
          if (!seenAttachmentReferences.has(reference.value)) {
            seenAttachmentReferences.add(reference.value);
            if (
              !appendFragment(
                createMessageFragment(
                  `external-message.${messageIndex}.part.${partIndex}.attachment.${reference.key}`,
                  reference.path,
                  reference.value,
                  'message',
                  'attachment_reference',
                  reference.format,
                  'inspect_only',
                ),
              )
            ) {
              break;
            }
          }
          if (
            reference.fileField == null ||
            seenFileReferences.has(`${reference.fileField}:${reference.value}`)
          ) {
            continue;
          }
          seenFileReferences.add(`${reference.fileField}:${reference.value}`);
          if (
            !appendFragment(
              createMessageFragment(
                `external-message.${messageIndex}.part.${partIndex}.file.${reference.key}`,
                reference.path,
                reference.value,
                'file',
                reference.fileField,
                reference.format,
                'inspect_only',
              ),
            )
          ) {
            break;
          }
        }

        for (const inlineText of providerPart?.inlineTexts ?? []) {
          if (inlineText.includeAsMessageContent) {
            appendAssembledText(inlineText.value);
            appendFragment(
              createMessageFragment(
                `external-message.${messageIndex}.part.${partIndex}.provider.${inlineText.key}`,
                inlineText.path,
                inlineText.value,
                'message',
                'content_part',
              ),
            );
            if (isInstruction) {
              appendFragment(
                createMessageFragment(
                  `external-message.${messageIndex}.part.${partIndex}.provider.${inlineText.key}.instruction`,
                  inlineText.path,
                  inlineText.value,
                  'agent_instruction',
                  'instructions',
                ),
              );
            }
            if (role === 'tool') {
              appendFragment(
                createMessageFragment(
                  `external-message.${messageIndex}.part.${partIndex}.provider.${inlineText.key}.tool-output`,
                  inlineText.path,
                  inlineText.value,
                  'tool_argument',
                  'output',
                  'plain',
                  'inspect_only',
                ),
              );
            }
          }
          appendFragment(
            createMessageFragment(
              `external-message.${messageIndex}.part.${partIndex}.file.${inlineText.key}`,
              inlineText.path,
              inlineText.value,
              'file',
              inlineText.fileField,
              'plain',
              'inspect_only',
            ),
          );
        }

        yield* pendingFragments;
        pendingFragments.length = 0;

        if (nestedValue == null || nestedValue === OMIT_SNAPSHOT_VALUE) {
          if (haltAfterCurrentMessage) {
            break;
          }
          continue;
        }
        const handledPaths = new Set([
          `${basePath}/type`,
          `${basePath}/text`,
          `${basePath}/image_url`,
          `${basePath}/file_id`,
          `${basePath}/file_data`,
          `${basePath}/filename`,
          `${basePath}/input_audio`,
          `${basePath}/file`,
          `${basePath}/file/file_id`,
          `${basePath}/file/file_data`,
          `${basePath}/file/filename`,
          ...(providerPart?.handledPaths ?? []),
        ]);
        let nestedIndex = 0;
        const nestedFragments: TextContentFragment[] = [];
        const complete = visitNestedStrings(
          nestedValue,
          basePath,
          (nestedText, nestedPath) => {
            appendAssembledText(nestedText);
            if (emittedFragments + nestedFragments.length >= MAX_EXTERNAL_MESSAGE_FRAGMENTS) {
              markTraversalIncomplete();
              return;
            }
            nestedFragments.push(
              createMessageFragment(
                `external-message.${messageIndex}.part.${partIndex}.nested.${nestedIndex}`,
                nestedPath,
                nestedText,
                'message',
                'content_part',
              ),
            );
            if (isInstruction) {
              if (emittedFragments + nestedFragments.length >= MAX_EXTERNAL_MESSAGE_FRAGMENTS) {
                markTraversalIncomplete();
                return;
              }
              nestedFragments.push(
                createMessageFragment(
                  `external-message.${messageIndex}.part.${partIndex}.nested.${nestedIndex}.instruction`,
                  nestedPath,
                  nestedText,
                  'agent_instruction',
                  'instructions',
                ),
              );
            }
            if (role === 'tool') {
              if (emittedFragments + nestedFragments.length >= MAX_EXTERNAL_MESSAGE_FRAGMENTS) {
                markTraversalIncomplete();
                return;
              }
              nestedFragments.push(
                createMessageFragment(
                  `external-message.${messageIndex}.part.${partIndex}.nested.${nestedIndex}.tool-output`,
                  nestedPath,
                  nestedText,
                  'tool_argument',
                  'output',
                  'plain',
                  'inspect_only',
                ),
              );
            }
            nestedIndex++;
          },
          {
            includeKeys: true,
            maxNodes: traversalMaxNodes,
            budget: traversalBudget,
            shouldVisit: ({ path, value }) =>
              !handledPaths.has(path) &&
              !(path === `${basePath}/source` && typeof value === 'string' && value === 'source'),
            shouldInclude: shouldIncludeNestedSubmittedText,
          },
        );
        for (const fragment of nestedFragments) {
          if (!appendFragment(fragment)) {
            break;
          }
        }
        if (!complete) {
          markTraversalIncomplete();
        }
        yield* pendingFragments;
        pendingFragments.length = 0;
        if (haltAfterCurrentMessage) {
          break;
        }
      }
      if (contentOverflowed) {
        haltAfterCurrentMessage = true;
      }
    }

    if (assembledText.length > 1) {
      const text = assembledText.join('');
      appendFragment(
        createMessageFragment(
          `external-message.${messageIndex}.assembled`,
          `/${messageIndex}/content`,
          text,
          'assembled_context',
          'assembled_context',
          'plain',
          'inspect_only',
        ),
      );
      if (isInstruction) {
        appendFragment(
          createMessageFragment(
            `external-message.${messageIndex}.assembled.instruction`,
            `/${messageIndex}/content`,
            text,
            'agent_instruction',
            'instructions',
            'plain',
            'inspect_only',
          ),
        );
      }
      if (role === 'tool') {
        appendFragment(
          createMessageFragment(
            `external-message.${messageIndex}.assembled.tool-output`,
            `/${messageIndex}/content`,
            text,
            'tool_argument',
            'output',
            'plain',
            'inspect_only',
          ),
        );
      }
    }
    yield* pendingFragments;
    pendingFragments.length = 0;

    if (haltAfterCurrentMessage || stopAfterCurrentMessage) {
      break;
    }
    if (message.toolCalls == null) {
      continue;
    }
    const toolCallLength = captureArrayLength(message.toolCalls);
    if (toolCallLength == null) {
      break;
    }
    const availableArrayWork = Math.max(0, MAX_EXTERNAL_MESSAGE_ARRAY_ITEMS - visitedArrayItems);
    const boundedToolCallLength = Math.min(toolCallLength, availableArrayWork);
    const toolCallsOverflowed = boundedToolCallLength < toolCallLength;
    if (toolCallsOverflowed) {
      traversalComplete = false;
      hasUnscopedTraversalIncomplete = true;
    }
    for (let callIndex = 0; callIndex < boundedToolCallLength; callIndex++) {
      visitedArrayItems++;
      let submittedToolCall: ExternalToolCall | null | undefined;
      try {
        submittedToolCall = (message.toolCalls as readonly (ExternalToolCall | null | undefined)[])[
          callIndex
        ];
      } catch {
        markTraversalIncomplete();
        break;
      }
      if (submittedToolCall == null) {
        continue;
      }
      if (typeof submittedToolCall !== 'object') {
        markTraversalIncomplete();
        break;
      }
      const toolCall = snapshotToolCall(submittedToolCall);
      if (!toolCall.complete) {
        markTraversalIncomplete();
      }
      const name = toolCall.name;
      if (typeof name === 'string' && name.length > 0) {
        appendFragment(
          createMessageFragment(
            `external-message.${messageIndex}.tool-call.${callIndex}.name`,
            `/${messageIndex}/tool_calls/${callIndex}/function/name`,
            name,
            'tool_argument',
            'name',
            'plain',
            'inspect_only',
          ),
        );
      }
      const args = toolCall.arguments;
      if (typeof args !== 'string' || args.length === 0) {
        yield* pendingFragments;
        pendingFragments.length = 0;
        if (haltAfterCurrentMessage) {
          break;
        }
        continue;
      }
      appendFragment(
        createMessageFragment(
          `external-message.${messageIndex}.tool-call.${callIndex}.arguments`,
          `/${messageIndex}/tool_calls/${callIndex}/function/arguments`,
          args,
          'tool_argument',
          'arguments',
          'json',
          'inspect_only',
        ),
      );
      yield* pendingFragments;
      pendingFragments.length = 0;
      if (haltAfterCurrentMessage) {
        break;
      }
    }
    if (toolCallsOverflowed) {
      haltAfterCurrentMessage = true;
    }
    yield* pendingFragments;
    pendingFragments.length = 0;
    if (haltAfterCurrentMessage) {
      break;
    }
  }
  if (!traversalComplete) {
    let traversalError = deferredPreparationError;
    if (traversalError == null && hasUnscopedTraversalIncomplete) {
      traversalError = new ContentTraversalLimitError([], EXTERNAL_MESSAGE_TRAVERSAL_SCOPES);
    }
    if (traversalError == null && aggregateTraversalScopes.length > 0) {
      traversalError = new ContentTraversalLimitError([], aggregateTraversalScopes);
    }
    throw traversalError ?? new ContentTraversalLimitError([], EXTERNAL_MESSAGE_TRAVERSAL_SCOPES);
  }
}
