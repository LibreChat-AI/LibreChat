import { HITL_MESSAGE_FILTER_FIELDS } from 'librechat-data-provider';
import type { UserSubmittedMessageFieldPath } from 'librechat-data-provider';
import type { JsonPointer } from './types';
import { CONTENT_TRAVERSAL_MAX_NODES } from './adapters/nested';

export const MAX_USER_SUBMITTED_PATHS = 256;
export const MAX_USER_SUBMITTED_PATH_LENGTH = 2048;

const BLOCKED_POINTER_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const HITL_MESSAGE_FILTER_FIELD_SET = new Set<string>(HITL_MESSAGE_FILTER_FIELDS);
const STORED_MESSAGE_SUBMITTED_ROOTS = new Set([
  'attachments',
  'content',
  'files',
  'name',
  'original',
  'quotes',
  'sender',
  'summary',
  'text',
  'tool_calls',
  'updated',
]);
const SHARED_MESSAGE_SUBMITTED_ROOTS = new Set([
  ...STORED_MESSAGE_SUBMITTED_ROOTS,
  'alwaysAppliedSkills',
  'finish_reason',
  'iconURL',
  'manualSkills',
]);

export interface UserSubmittedPathState {
  readonly paths: JsonPointer[];
  readonly overflowed: boolean;
}

export interface UserSubmittedPathOptions {
  readonly scope?: 'stored_message' | 'shared_message';
  /** Restricts semantic steer discovery to provider-retained source parts. */
  readonly semanticContentPartIndices?: Iterable<number>;
  /** Allows callers that cache explicit metadata separately to defer content scans. */
  readonly includeSemanticContent?: boolean;
  /** Allows callers to add semantic paths to an already-captured explicit snapshot. */
  readonly includeExplicitPaths?: boolean;
  /** Optional caller-owned aggregate budget shared across provenance carriers. */
  readonly budget?: UserSubmittedProvenanceWorkBudget;
  /** Reuses a caller-captured content carrier across path and field snapshots. */
  readonly capturedContent?: unknown;
  readonly hasCapturedContent?: boolean;
  /** Reuses the caller's single validated array-length observation. */
  readonly capturedContentLength?: number;
  /** Reuses each content-part value across attribution and projection phases. */
  readonly capturedContentParts?: Map<number, unknown>;
  /** Materializes a content part once before any attribution or projection read. */
  readonly captureContentPart?: (part: unknown, index: number) => unknown;
}

export interface UserSubmittedProvenanceWorkBudget {
  remaining: number;
  overflowed: boolean;
}

type UserSubmittedPathCarrier = object & {
  readonly userSubmittedPaths?: readonly unknown[];
  readonly userSubmittedMessageFieldPaths?: readonly unknown[];
  readonly content?: readonly unknown[];
  readonly text?: unknown;
};

export interface UserSubmittedMessageFieldPathState {
  readonly entries: UserSubmittedMessageFieldPath[];
  readonly overflowed: boolean;
}

interface EffectiveUserSubmittedPathState {
  readonly effective: boolean;
  readonly contentPartIndex?: number;
  readonly contentPart?: unknown;
  readonly contentPartIsSteer: boolean;
}

export interface CapturedUserSubmittedPathMetadata {
  readonly contentParts: ReadonlyMap<number, unknown>;
  readonly steerPaths: ReadonlySet<string>;
}

const CAPTURED_USER_SUBMITTED_PATH_METADATA = new WeakMap<
  UserSubmittedPathState,
  CapturedUserSubmittedPathMetadata
>();

export function getCapturedUserSubmittedPathMetadata(
  state: UserSubmittedPathState,
): CapturedUserSubmittedPathMetadata {
  return (
    CAPTURED_USER_SUBMITTED_PATH_METADATA.get(state) ?? {
      contentParts: new Map(),
      steerPaths: new Set(),
    }
  );
}

function captureProvenanceArrayLength(candidate: readonly unknown[]): number {
  const length = candidate.length;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError('invalid provenance array length');
  }
  return length;
}

function consumeProvenanceWork(budget: UserSubmittedProvenanceWorkBudget | undefined): boolean {
  if (budget == null) {
    return true;
  }
  if (budget.remaining <= 0) {
    budget.overflowed = true;
    return false;
  }
  budget.remaining--;
  return true;
}

function readCapturedContentPart(
  content: readonly unknown[],
  index: number,
  capturedContentParts: Map<number, unknown>,
  captureContentPart?: UserSubmittedPathOptions['captureContentPart'],
): unknown {
  if (capturedContentParts.has(index)) {
    return capturedContentParts.get(index);
  }
  const rawPart = content[index];
  const part = captureContentPart == null ? rawPart : captureContentPart(rawPart, index);
  capturedContentParts.set(index, part);
  return part;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function getSafeUserSubmittedPathSegments(path: JsonPointer): readonly string[] | undefined {
  const encodedSegments = path.slice(1).split('/');
  if (encodedSegments.some((segment) => /~(?:[^01]|$)/.test(segment))) {
    return undefined;
  }
  const segments = encodedSegments.map(decodeJsonPointerSegment);
  if (segments.length === 0 || segments.some((segment) => BLOCKED_POINTER_SEGMENTS.has(segment))) {
    return undefined;
  }
  return segments;
}

function isEffectiveUserSubmittedPath(
  message: UserSubmittedPathCarrier,
  path: JsonPointer,
  scope: NonNullable<UserSubmittedPathOptions['scope']>,
  capturedContent: unknown,
  capturedContentLength: number | undefined,
  capturedContentParts: Map<number, unknown>,
  captureContentPart?: UserSubmittedPathOptions['captureContentPart'],
): EffectiveUserSubmittedPathState {
  const segments = getSafeUserSubmittedPathSegments(path);
  if (segments == null) {
    return { effective: false, contentPartIsSteer: false };
  }
  const submittedRoots =
    scope === 'shared_message' ? SHARED_MESSAGE_SUBMITTED_ROOTS : STORED_MESSAGE_SUBMITTED_ROOTS;
  if (!submittedRoots.has(segments[0])) {
    return { effective: false, contentPartIsSteer: false };
  }
  let source: unknown = message;
  let contentPartIndex: number | undefined;
  let contentPart: unknown;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const isContentPartIndex =
      index === 1 &&
      segments[0] === 'content' &&
      /^\d+$/.test(segment) &&
      String(Number(segment)) === segment;
    if (isContentPartIndex) {
      const numericIndex = Number(segment);
      if (
        !Array.isArray(capturedContent) ||
        (capturedContentLength != null && numericIndex >= capturedContentLength) ||
        (capturedContentLength == null &&
          !Object.prototype.hasOwnProperty.call(capturedContent, segment))
      ) {
        return { effective: false, contentPartIsSteer: false };
      }
      source = readCapturedContentPart(
        capturedContent,
        numericIndex,
        capturedContentParts,
        captureContentPart,
      );
      contentPartIndex = numericIndex;
      contentPart = source;
      continue;
    }
    if (
      source == null ||
      typeof source !== 'object' ||
      !Object.prototype.hasOwnProperty.call(source, segment)
    ) {
      return { effective: false, contentPartIsSteer: false };
    }
    source =
      index === 0 && segment === 'content'
        ? capturedContent
        : (source as Record<string, unknown>)[segment];
  }
  return {
    effective: source !== undefined,
    contentPartIndex,
    contentPart,
    contentPartIsSteer:
      contentPart != null &&
      typeof contentPart === 'object' &&
      Object.prototype.hasOwnProperty.call(contentPart, 'type') &&
      (contentPart as Record<string, unknown>).type === 'steer',
  };
}

function visitSemanticUserSubmittedPaths(
  contentCandidate: unknown,
  visit: (path: JsonPointer) => boolean,
  contentPartIndices?: Iterable<number>,
  budget?: UserSubmittedProvenanceWorkBudget,
  capturedLength?: number,
  capturedContentParts = new Map<number, unknown>(),
  captureContentPart?: UserSubmittedPathOptions['captureContentPart'],
): boolean {
  let content: readonly unknown[];
  let contentLength: number;
  try {
    if (!Array.isArray(contentCandidate)) {
      return true;
    }
    content = contentCandidate;
    contentLength = capturedLength ?? captureProvenanceArrayLength(content);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return false;
    }
  } catch {
    return false;
  }
  const visitSteerPath = (index: number): boolean => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= contentLength) {
      return true;
    }
    if (!consumeProvenanceWork(budget)) {
      return false;
    }
    try {
      const part = readCapturedContentPart(
        content,
        index,
        capturedContentParts,
        captureContentPart,
      );
      if (
        part != null &&
        typeof part === 'object' &&
        Object.prototype.hasOwnProperty.call(part, 'type') &&
        (part as Record<string, unknown>).type === 'steer'
      ) {
        return visit(`/content/${index}` as JsonPointer);
      }
      return true;
    } catch {
      return false;
    }
  };
  if (contentPartIndices != null) {
    let visitedIndices = 0;
    try {
      for (const index of contentPartIndices) {
        if (visitedIndices >= MAX_USER_SUBMITTED_PATHS) {
          return false;
        }
        visitedIndices++;
        if (!visitSteerPath(index)) {
          return false;
        }
      }
    } catch {
      return false;
    }
    return true;
  }
  const boundedContentLength = Math.min(contentLength, CONTENT_TRAVERSAL_MAX_NODES);
  for (let index = 0; index < boundedContentLength; index++) {
    if (!visitSteerPath(index)) {
      return false;
    }
  }
  return contentLength <= CONTENT_TRAVERSAL_MAX_NODES;
}

/**
 * Resolves durable caller-authorship pointers against the exact stored row.
 * Ineffective or unsafe pointers never suppress strict whole-row attribution;
 * excessive unique bounded candidates still fail closed via `overflowed`.
 */
export function getUserSubmittedPathState(
  message: UserSubmittedPathCarrier,
  options: UserSubmittedPathOptions = {},
): UserSubmittedPathState {
  const paths: JsonPointer[] = [];
  const seen = new Set<string>();
  const capturedContentParts = options.capturedContentParts ?? new Map<number, unknown>();
  const steerPaths = new Set<string>();
  const createState = (overflowed: boolean): UserSubmittedPathState => {
    const state = { paths, overflowed };
    CAPTURED_USER_SUBMITTED_PATH_METADATA.set(state, {
      contentParts: capturedContentParts,
      steerPaths,
    });
    return state;
  };
  let capturedContent: unknown;
  let capturedContentLength: number | undefined;
  try {
    capturedContent =
      options.hasCapturedContent === true ? options.capturedContent : message.content;
    if (Array.isArray(capturedContent)) {
      capturedContentLength =
        options.capturedContentLength ?? captureProvenanceArrayLength(capturedContent);
      if (!Number.isSafeInteger(capturedContentLength) || capturedContentLength < 0) {
        return createState(true);
      }
    }
  } catch {
    return createState(true);
  }
  const appendCandidate = (path: unknown, knownEffective = false): boolean => {
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.length > MAX_USER_SUBMITTED_PATH_LENGTH ||
      seen.has(path)
    ) {
      return true;
    }
    seen.add(path);
    if (seen.size > MAX_USER_SUBMITTED_PATHS) {
      return false;
    }
    const pointer = path as JsonPointer;
    try {
      if (knownEffective) {
        paths.push(pointer);
        return true;
      }
      const effectiveState = isEffectiveUserSubmittedPath(
        message,
        pointer,
        options.scope ?? 'stored_message',
        capturedContent,
        capturedContentLength,
        capturedContentParts,
        options.captureContentPart,
      );
      if (effectiveState.effective) {
        paths.push(pointer);
        if (effectiveState.contentPartIndex != null) {
          capturedContentParts.set(effectiveState.contentPartIndex, effectiveState.contentPart);
        }
        if (effectiveState.contentPartIsSteer) {
          steerPaths.add(pointer);
        }
      }
    } catch {
      return false;
    }
    return true;
  };

  if (options.includeExplicitPaths !== false) {
    try {
      const candidatePaths = message.userSubmittedPaths;
      if (Array.isArray(candidatePaths)) {
        const candidateCount = captureProvenanceArrayLength(candidatePaths);
        const boundedCandidateCount = Math.min(candidateCount, MAX_USER_SUBMITTED_PATHS);
        for (let index = 0; index < boundedCandidateCount; index++) {
          if (!consumeProvenanceWork(options.budget)) {
            return createState(true);
          }
          if (!appendCandidate(candidatePaths[index])) {
            return createState(true);
          }
        }
        if (candidateCount > MAX_USER_SUBMITTED_PATHS) {
          return createState(true);
        }
      }
    } catch {
      return createState(true);
    }
  }
  if (options.includeSemanticContent !== false) {
    if (
      !visitSemanticUserSubmittedPaths(
        capturedContent,
        (path) => appendCandidate(path, true),
        options.semanticContentPartIndices,
        options.budget,
        capturedContentLength,
        capturedContentParts,
        options.captureContentPart,
      )
    ) {
      return createState(true);
    }
  }
  return createState(false);
}

/**
 * Resolves exact HITL message-field identities against the stored row. Invalid,
 * stale, or unsafe metadata is ignored; excessive distinct entries retain a
 * fail-closed overflow signal without broadening any individual field label.
 */
export function getUserSubmittedMessageFieldPathState(
  message: UserSubmittedPathCarrier,
  options: UserSubmittedPathOptions = {},
): UserSubmittedMessageFieldPathState {
  const entries: UserSubmittedMessageFieldPath[] = [];
  const seen = new Set<string>();
  let candidateFieldPaths: readonly unknown[];
  try {
    const candidate = message.userSubmittedMessageFieldPaths;
    if (!Array.isArray(candidate)) {
      return { entries, overflowed: false };
    }
    candidateFieldPaths = candidate;
  } catch {
    return { entries, overflowed: true };
  }
  try {
    const candidateCount = captureProvenanceArrayLength(candidateFieldPaths);
    const capturedContent =
      options.hasCapturedContent === true ? options.capturedContent : message.content;
    const capturedContentLength = options.capturedContentLength;
    if (capturedContentLength != null) {
      if (!Number.isSafeInteger(capturedContentLength) || capturedContentLength < 0) {
        return { entries, overflowed: true };
      }
    }
    const capturedContentParts = options.capturedContentParts ?? new Map<number, unknown>();
    const boundedCandidateCount = Math.min(candidateCount, MAX_USER_SUBMITTED_PATHS);
    for (let index = 0; index < boundedCandidateCount; index++) {
      if (!consumeProvenanceWork(options.budget)) {
        return { entries, overflowed: true };
      }
      const value = candidateFieldPaths[index];
      if (value == null || typeof value !== 'object') {
        continue;
      }
      const { path, field } = value as { readonly path?: unknown; readonly field?: unknown };
      if (
        typeof path !== 'string' ||
        !path.startsWith('/') ||
        path.length > MAX_USER_SUBMITTED_PATH_LENGTH ||
        typeof field !== 'string' ||
        !HITL_MESSAGE_FILTER_FIELD_SET.has(field)
      ) {
        continue;
      }
      const key = `${field}:${path}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const pointer = path as JsonPointer;
      if (
        !isEffectiveUserSubmittedPath(
          message,
          pointer,
          options.scope ?? 'stored_message',
          capturedContent,
          capturedContentLength,
          capturedContentParts,
          options.captureContentPart,
        ).effective
      ) {
        continue;
      }
      entries.push({
        path,
        field: field as UserSubmittedMessageFieldPath['field'],
      });
    }
    return { entries, overflowed: candidateCount > MAX_USER_SUBMITTED_PATHS };
  } catch {
    return { entries, overflowed: true };
  }
}
