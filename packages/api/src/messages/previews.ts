import { logger } from '@librechat/data-schemas';
import {
  Constants,
  ContentTypes,
  TOOL_CALL_PREVIEWS_PARAM,
  TOOL_CALL_PREVIEWS_VERSION,
  COMMAND_RESULT_TRAILER,
  hasToolCallPreview,
  toolCallPreviewsConfigSchema,
} from 'librechat-data-provider';
import type { TToolCallPreviewsConfig, ToolCallPreviewMarkers } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { AppConfigUserLike, GetAppConfigOptions } from '~/app/service';
import { getAppConfigOptionsFromUser } from '~/app/service';

export type ToolCallPreviewLimits = Pick<TToolCallPreviewsConfig, 'outputChars' | 'argsChars'>;

/** Separates the kept start and end of an output preview. */
export const TOOL_CALL_PREVIEW_ELISION = '\n…\n';

/** Share of a text output preview taken from the start; the rest keeps the end. */
const OUTPUT_HEAD_SHARE = 0.5;

/** Shortest a string inside a JSON preview gets before the structure is abandoned for text. */
const MIN_JSON_STRING_CHARS = 8;

/** Deepest JSON nesting a structure-preserving preview walks; deeper values fall back to text. */
const MAX_JSON_DEPTH = 64;

/** Ceiling on a kept exit-status trailer, so a malformed one cannot defeat the bound. */
const MAX_TRAILER_CHARS = 2_048;

/**
 * Tools whose cards show their full record without going through a card disclosure, so a
 * preview would be what the reader sees: the question-and-answer record reads both fields
 * directly, and an image card's details dialog shows the prompt from its arguments.
 */
const FULL_CONTENT_TOOLS: ReadonlySet<string> = new Set([
  'ask_user_question',
  'image_gen_oai',
  'image_edit_oai',
  'gemini_image_gen',
]);

/**
 * Tools whose collapsed card parses its JSON output for the row's verdict (task failures,
 * partial results, warnings). When even a structure-preserving preview cannot fit, their output
 * goes in full rather than as text that no longer parses.
 */
const PARSED_OUTPUT_TOOLS: ReadonlySet<string> = new Set<string>([
  Constants.CHECK_BACKGROUND_TASK as string,
]);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The stored fields this module reads; everything else on the tool call passes through. */
interface StoredToolCall extends ToolCallPreviewMarkers {
  type?: string;
  name?: string;
  executor?: string;
  progress?: unknown;
  runStepStatus?: unknown;
  output?: unknown;
  args?: unknown;
  approval?: unknown;
  subagent_content?: unknown;
}

interface StoredToolCallPart {
  type?: string;
  tool_call?: StoredToolCall;
}

/** A message as read for a client; only `content` is inspected. */
export interface PreviewableMessage {
  content?: unknown[] | null;
}

const isObject = (value: unknown): value is object => value != null && typeof value === 'object';

const isToolCallPart = (
  part: unknown,
): part is StoredToolCallPart & { tool_call: StoredToolCall } =>
  isObject(part) &&
  (part as StoredToolCallPart).type === ContentTypes.TOOL_CALL &&
  isObject((part as StoredToolCallPart).tool_call);

/** Agent tool calls only; legacy Assistants shapes keep their own nested output fields. */
const isAgentToolCall = (toolCall: StoredToolCall): boolean =>
  toolCall.type == null || toolCall.type === 'tool_call';

const hasOutput = (toolCall: StoredToolCall): boolean =>
  typeof toolCall.output === 'string' && toolCall.output.length > 0;

/**
 * A call whose content no card still acts on: it has output, or its run step closed or reached
 * full progress, and it is not waiting on an approval. A subagent can finish with no final text,
 * and its transcript is as large as any other.
 */
const isSettled = (toolCall: StoredToolCall): boolean => {
  if (toolCall.approval != null && !hasOutput(toolCall)) {
    return false;
  }
  return (
    hasOutput(toolCall) ||
    toolCall.runStepStatus != null ||
    (typeof toolCall.progress === 'number' && toolCall.progress >= 1)
  );
};

/** An unresolved approval anywhere in the parts, including inside nested subagent runs. */
function hasPendingApproval(parts: unknown[]): boolean {
  const stack: unknown[][] = [parts];
  while (stack.length > 0) {
    const current = stack.pop() ?? [];
    for (const part of current) {
      if (!isToolCallPart(part)) {
        continue;
      }
      const toolCall = part.tool_call;
      if (toolCall.approval != null && !hasOutput(toolCall)) {
        return true;
      }
      if (Array.isArray(toolCall.subagent_content)) {
        stack.push(toolCall.subagent_content);
      }
    }
  }
  return false;
}

/** Cuts at `end` without splitting a surrogate pair. */
function sliceStart(text: string, end: number): string {
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}

/** Keeps the last `count` code units without starting inside a surrogate pair. */
function sliceEnd(text: string, count: number): string {
  if (count <= 0) {
    return '';
  }
  const start = text.length - count;
  const code = text.charCodeAt(start);
  return text.slice(code >= 0xdc00 && code <= 0xdfff ? start + 1 : start);
}

/**
 * Keeps the start and the end. Error prefixes and first error lines live at the start;
 * validation feedback, the last line of a traceback and exit-status trailers live at the end.
 * `minTailChars` widens the end to keep a trailer whole.
 */
export function previewOutputText(output: string, maxChars: number, minTailChars = 0): string {
  if (output.length <= maxChars) {
    return output;
  }
  const budget = Math.max(0, maxChars - TOOL_CALL_PREVIEW_ELISION.length);
  const tailChars = Math.max(budget - Math.floor(budget * OUTPUT_HEAD_SHARE), minTailChars);
  const headChars = Math.max(0, budget - tailChars);
  if (headChars + tailChars + TOOL_CALL_PREVIEW_ELISION.length >= output.length) {
    return output;
  }
  return `${sliceStart(output, headChars)}${TOOL_CALL_PREVIEW_ELISION}${sliceEnd(output, tailChars)}`;
}

function capJsonStrings(value: JsonValue, maxChars: number): JsonValue {
  if (typeof value === 'string') {
    return value.length > maxChars ? `${sliceStart(value, maxChars)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => capJsonStrings(item, maxChars));
  }
  if (value == null || typeof value !== 'object') {
    return value;
  }
  /** Null-prototype, so a `__proto__` key stays an ordinary data key. */
  const result: { [key: string]: JsonValue } = Object.create(null);
  for (const key in value) {
    result[key] = capJsonStrings(value[key], maxChars);
  }
  return result;
}

/**
 * Whether the JSON could fit `maxChars` once its strings are capped: every value serializes to
 * at least two characters with its separator, every string to at least `MIN_JSON_STRING_CHARS`,
 * and property names are never shortened, so a structure with more values, strings or key
 * characters than that allows cannot fit at any cap. The walk is iterative, stops as soon as either bound is passed, and treats
 * nesting deeper than `MAX_JSON_DEPTH` as unfit, so the cloning and serialization that follow
 * only ever run on small, shallow values.
 */
function mayFitJson(value: JsonValue, maxChars: number): boolean {
  const maxNodes = Math.floor(maxChars / 2);
  const maxStrings = Math.floor(maxChars / MIN_JSON_STRING_CHARS);
  let nodes = 0;
  let strings = 0;
  let keyChars = 0;
  const stack: Array<[JsonValue, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop() as [JsonValue, number];
    nodes++;
    if (nodes > maxNodes || depth > MAX_JSON_DEPTH) {
      return false;
    }
    if (typeof current === 'string') {
      strings++;
      if (strings > maxStrings) {
        return false;
      }
    } else if (Array.isArray(current)) {
      for (const item of current) {
        stack.push([item, depth + 1]);
      }
    } else if (current != null && typeof current === 'object') {
      for (const key in current) {
        keyChars += key.length + 3;
        if (keyChars > maxChars) {
          return false;
        }
        stack.push([current[key], depth + 1]);
      }
    }
  }
  return true;
}

function parseJsonContainer(text: string): JsonValue | undefined {
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[') {
    return undefined;
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * Serializes the JSON within `maxChars` by shortening only its longest strings: the largest
 * per-string cap that fits wins, so short fields (a command, a path, an intent, a status) stay
 * exact while a file body or log absorbs the cut. Every key, array item and scalar is kept, so
 * readers that parse the value still find their fields. Returns `undefined` when even the
 * shortest cap cannot fit, and the caller falls back to text.
 */
export function shrinkJsonToFit(value: JsonValue, maxChars: number): string | undefined {
  if (!mayFitJson(value, maxChars)) {
    return undefined;
  }
  const capped = capJsonStrings(value, maxChars);
  let low = MIN_JSON_STRING_CHARS;
  let high = maxChars;
  let best: string | undefined;
  while (low <= high) {
    const cap = Math.floor((low + high) / 2);
    const serialized = JSON.stringify(capJsonStrings(capped, cap));
    if (serialized.length <= maxChars) {
      best = serialized;
      low = cap + 1;
    } else {
      high = cap - 1;
    }
  }
  return best;
}

type ArgsPreview = { args: string | JsonValue; length: number };

export function previewToolCallArgs(args: unknown, maxChars: number): ArgsPreview | undefined {
  if (typeof args === 'string') {
    if (args.length <= maxChars) {
      return undefined;
    }
    const parsed = parseJsonContainer(args);
    const shrunk = parsed === undefined ? undefined : shrinkJsonToFit(parsed, maxChars);
    return { args: shrunk ?? sliceStart(args, maxChars), length: args.length };
  }
  if (!isObject(args)) {
    return undefined;
  }
  const serialized = JSON.stringify(args);
  if (serialized.length <= maxChars) {
    return undefined;
  }
  const shrunk = shrinkJsonToFit(args as JsonValue, maxChars);
  return {
    args:
      shrunk === undefined ? sliceStart(serialized, maxChars) : (JSON.parse(shrunk) as JsonValue),
    length: serialized.length,
  };
}

/**
 * Length of the exit-status trailer the attached-workspace `bash_tool` appends. Only a call the
 * server stamped with that executor carries one, and its collapsed card reads the verdict there.
 */
function commandTrailerLength(toolCall: StoredToolCall, output: string): number {
  if (toolCall.executor !== 'attached_workspace') {
    return 0;
  }
  const match = COMMAND_RESULT_TRAILER.exec(output.slice(-MAX_TRAILER_CHARS));
  return match == null ? 0 : match[0].length;
}

/** JSON output stays parseable (background-task results, handles); other text keeps both ends. */
export function previewToolCallOutput(
  toolCall: StoredToolCall,
  output: string,
  maxChars: number,
): string {
  if (output.length <= maxChars) {
    return output;
  }
  const parsed = parseJsonContainer(output);
  const shrunk = parsed === undefined ? undefined : shrinkJsonToFit(parsed, maxChars);
  if (shrunk != null) {
    return shrunk;
  }
  if (
    parsed !== undefined &&
    typeof toolCall.name === 'string' &&
    PARSED_OUTPUT_TOOLS.has(toolCall.name)
  ) {
    return output;
  }
  return previewOutputText(output, maxChars, commandTrailerLength(toolCall, output));
}

/**
 * Returns the tool call with long content replaced by previews, or the same object when nothing
 * needed shortening. Only settled calls change: a call still waiting on output, approval or a
 * reader's answer keeps every field, since its card acts on them.
 */
export function previewToolCall<T extends StoredToolCall>(
  toolCall: T,
  limits: ToolCallPreviewLimits,
): T {
  if (!isAgentToolCall(toolCall) || !isSettled(toolCall)) {
    return toolCall;
  }
  if (typeof toolCall.name === 'string' && FULL_CONTENT_TOOLS.has(toolCall.name)) {
    return toolCall;
  }

  const output = typeof toolCall.output === 'string' ? toolCall.output : '';
  const outputPreview = previewToolCallOutput(toolCall, output, limits.outputChars);
  const argsPreview = previewToolCallArgs(toolCall.args, limits.argsChars);
  const subagentContent = toolCall.subagent_content;
  const omitSubagentContent =
    Array.isArray(subagentContent) &&
    subagentContent.length > 0 &&
    !hasPendingApproval(subagentContent);

  if (outputPreview === output && argsPreview == null && !omitSubagentContent) {
    return toolCall;
  }

  const next: T = { ...toolCall };
  if (outputPreview !== output) {
    next.output = outputPreview;
    next.outputTruncated = true;
    next.outputLength = output.length;
  }
  if (argsPreview != null) {
    next.args = argsPreview.args;
    next.argsTruncated = true;
    next.argsLength = argsPreview.length;
  }
  if (omitSubagentContent) {
    delete next.subagent_content;
    next.subagentContentOmitted = true;
    next.subagentContentParts = (subagentContent as unknown[]).length;
  }
  return next;
}

/**
 * A call that cannot be previewed is sent as stored rather than failing the whole conversation
 * load; previews are an optimization, and the full value is what the client would otherwise get.
 */
function previewToolCallSafely<T extends StoredToolCall>(
  toolCall: T,
  limits: ToolCallPreviewLimits,
): T {
  try {
    return previewToolCall(toolCall, limits);
  } catch (error) {
    logger.warn('[toolCallPreviews] Sending a tool call in full; its preview failed', error);
    return toolCall;
  }
}

/** Previews every tool-call part of one content array; returns the same array when unchanged. */
export function previewContentToolCalls(
  content: unknown[],
  limits: ToolCallPreviewLimits,
): unknown[] {
  let result: unknown[] | undefined;
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (!isToolCallPart(part)) {
      continue;
    }
    const toolCall = previewToolCallSafely(part.tool_call, limits);
    if (toolCall === part.tool_call) {
      continue;
    }
    result ??= content.slice();
    result[i] = { ...part, tool_call: toolCall };
  }
  return result ?? content;
}

/** Applies previews across messages, copying only the messages whose content changed. */
export function previewMessagesToolCalls<T extends PreviewableMessage>(
  messages: T[],
  limits: ToolCallPreviewLimits,
): T[] {
  let result: T[] | undefined;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!Array.isArray(message?.content)) {
      continue;
    }
    const content = previewContentToolCalls(message.content, limits);
    if (content === message.content) {
      continue;
    }
    result ??= messages.slice();
    result[i] = { ...message, content };
  }
  return result ?? messages;
}

/** True when the request asked for this preview format. */
export function wantsToolCallPreviews(query: unknown): boolean {
  if (!isObject(query)) {
    return false;
  }
  return (
    (query as Record<string, unknown>)[TOOL_CALL_PREVIEWS_PARAM] === TOOL_CALL_PREVIEWS_VERSION
  );
}

export interface ToolCallPreviewRequest {
  query?: unknown;
  user?: AppConfigUserLike | null;
}

export interface ToolCallPreviewDeps {
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
}

type MessagesPreviewer = <T extends PreviewableMessage>(messages: T[]) => Promise<T[]>;

const sendInFull: MessagesPreviewer = (messages) => Promise.resolve(messages);

async function resolveLimits(
  req: ToolCallPreviewRequest,
  deps: ToolCallPreviewDeps,
): Promise<TToolCallPreviewsConfig> {
  try {
    const config = await deps.getAppConfig({
      ...getAppConfigOptionsFromUser(req.user),
      skipRuntimeAugmentation: true,
    });
    return config?.toolCallPreviews ?? toolCallPreviewsConfigSchema.parse({});
  } catch (error) {
    logger.warn('[toolCallPreviews] Config unavailable; using default preview bounds', error);
    return toolCallPreviewsConfigSchema.parse({});
  }
}

/**
 * Starts resolving the preview bounds for a message load, so the config read runs beside the
 * message read instead of ahead of it. The returned function shapes the messages once both are
 * in. A request without the preview parameter, or a deployment that turned previews off,
 * receives the messages untouched.
 */
export function prepareToolCallPreviews(
  req: ToolCallPreviewRequest,
  deps: ToolCallPreviewDeps,
): MessagesPreviewer {
  if (!wantsToolCallPreviews(req.query)) {
    return sendInFull;
  }
  const limitsPromise = resolveLimits(req, deps);
  return async (messages) => {
    const limits = await limitsPromise;
    if (!limits.enabled) {
      return messages;
    }
    return previewMessagesToolCalls(messages, limits);
  };
}

/** True when any tool call in the content, nested subagent runs included, carries preview markers. */
export function containsToolCallPreviews(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  const stack: unknown[][] = [content];
  while (stack.length > 0) {
    const current = stack.pop() ?? [];
    for (const part of current) {
      if (!isToolCallPart(part)) {
        continue;
      }
      if (hasToolCallPreview(part.tool_call)) {
        return true;
      }
      if (Array.isArray(part.tool_call.subagent_content)) {
        stack.push(part.tool_call.subagent_content);
      }
    }
  }
  return false;
}

interface PreviewableResultRequest {
  query?: unknown;
  config?: { toolCallPreviews?: TToolCallPreviewsConfig } | null;
}

/**
 * Previews the messages a fork, duplicate or shared-link fork returns, so a client that asked
 * for previews does not seed its conversation cache with the full history. Reads the bounds
 * from the config the route already resolved.
 */
export function withToolCallPreviews<T extends { messages?: PreviewableMessage[] | null }>(
  req: PreviewableResultRequest,
  result: T,
): T {
  if (!wantsToolCallPreviews(req.query) || !Array.isArray(result?.messages)) {
    return result;
  }
  const limits = req.config?.toolCallPreviews ?? toolCallPreviewsConfigSchema.parse({});
  if (!limits.enabled) {
    return result;
  }
  const messages = previewMessagesToolCalls(result.messages, limits);
  return messages === result.messages ? result : { ...result, messages };
}

/**
 * Previews one message a mutation returns (an artifact edit's content, a branched response), so
 * a client that asked for previews merges a bounded copy into its conversation cache.
 */
export function withMessageToolCallPreviews<T extends PreviewableMessage>(
  req: PreviewableResultRequest,
  message: T,
): T {
  if (message == null || !Array.isArray(message.content)) {
    return message;
  }
  return withToolCallPreviews(req, { messages: [message] }).messages[0];
}

interface MessageWriteRequest {
  body?: { content?: unknown } | null;
}

interface MessageWriteResponse {
  status: (code: number) => { json: (body: { error: string }) => unknown };
}

/**
 * Refuses a client-authored message whose content holds tool-call previews. A preview is a
 * display copy; saving it would replace the stored output, arguments or transcript with it.
 */
export function rejectToolCallPreviewWrites(
  req: MessageWriteRequest,
  res: MessageWriteResponse,
  next: () => void,
): void {
  if (containsToolCallPreviews(req.body?.content)) {
    res.status(400).json({ error: 'Tool call previews cannot be saved as message content' });
    return;
  }
  next();
}
