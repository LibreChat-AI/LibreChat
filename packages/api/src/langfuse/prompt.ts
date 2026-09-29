import type {
  TTracePrompt,
  TTraceMessage,
  TTraceContent,
  TTraceToolCall,
  TTraceMessageRole,
} from 'librechat-data-provider';

/** Shares of the content budget: the system message may not crowd out the turns the call answered. */
const SYSTEM_SHARE = 0.25;
const MESSAGE_SHARE = 0.25;
const MAX_TOOL_CALLS = 64;
const MAX_TOOL_NAMES = 128;
const MAX_ATTACHMENTS = 16;
const NAME_MAX_LENGTH = 256;

const ROLES: Record<string, TTraceMessageRole> = {
  system: 'system',
  developer: 'system',
  user: 'user',
  human: 'user',
  assistant: 'assistant',
  ai: 'assistant',
  tool: 'tool',
  function: 'tool',
};

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: Json | undefined): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Langfuse returns a generation's input and output as JSON text; an SDK may also hand back the value. */
function parse(value: unknown): Json | undefined {
  if (typeof value !== 'string') {
    return value as Json | undefined;
  }
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }
  try {
    return JSON.parse(value) as Json;
  } catch {
    return undefined;
  }
}

function bounded(text: string, maxLength: number): TTraceContent | undefined {
  if (text === '') {
    return undefined;
  }
  return text.length > maxLength
    ? { value: text.slice(0, maxLength), truncated: true }
    : { value: text, truncated: false };
}

function name(value: Json | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, NAME_MAX_LENGTH) : undefined;
}

/** A message's text and the types of its parts that are not text. */
function contentOf(content: Json | undefined): { text: string; attachments: string[] } {
  if (typeof content === 'string') {
    return { text: content, attachments: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', attachments: [] };
  }
  const texts: string[] = [];
  const attachments: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      texts.push(part);
      continue;
    }
    if (!isObject(part)) {
      continue;
    }
    if (typeof part.text === 'string') {
      texts.push(part.text);
      continue;
    }
    const type = name(part.type);
    if (type != null && attachments.length < MAX_ATTACHMENTS) {
      attachments.push(type);
    }
  }
  return { text: texts.join('\n'), attachments };
}

function toolCallsOf(calls: Json | undefined, maxLength: number): TTraceToolCall[] {
  if (!Array.isArray(calls)) {
    return [];
  }
  const result: TTraceToolCall[] = [];
  for (const call of calls) {
    if (result.length === MAX_TOOL_CALLS || !isObject(call)) {
      continue;
    }
    const fn = isObject(call.function) ? call.function : undefined;
    const callName = name(call.name) ?? name(fn?.name);
    if (callName == null) {
      continue;
    }
    const rawArgs = call.args ?? fn?.arguments;
    const args =
      rawArgs == null
        ? undefined
        : bounded(typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs), maxLength);
    result.push({ name: callName, ...(args ? { args } : {}) });
  }
  return result;
}

/**
 * One message in the application's terms. A tool's answer is recorded under the
 * tool's own name as its role, so a role that is none of the known ones is a
 * tool message from that tool.
 */
function toMessage(value: Json, maxLength: number): TTraceMessage | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const rawRole = name(value.role) ?? name(value.type);
  if (rawRole == null) {
    return undefined;
  }
  const known = ROLES[rawRole.toLowerCase()];
  const role = known ?? 'tool';
  const { text, attachments } = contentOf(value.content);
  const content = bounded(text, maxLength);
  const toolCalls = role === 'assistant' ? toolCallsOf(value.tool_calls, maxLength) : [];
  const toolName =
    role === 'tool' ? (name(value.name) ?? (known == null ? rawRole : undefined)) : undefined;
  return {
    role,
    ...(content ? { text: content } : {}),
    ...(toolName != null ? { toolName } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function costOf(message: TTraceMessage): number {
  let cost = message.text?.value.length ?? 0;
  for (const call of message.toolCalls ?? []) {
    cost += call.name.length + (call.args?.value.length ?? 0);
  }
  return cost;
}

function messagesOf(parsed: Json | undefined): Json | undefined {
  return isObject(parsed) ? parsed.messages : undefined;
}

/**
 * Reads a model call's input as a conversation within `maxLength` characters.
 * Cutting the raw input at its front keeps only the start of the system message
 * of a long conversation, so the budget goes to the system message first (a
 * share of it) and then to the newest messages backwards, each bounded alone.
 */
export function toTracePrompt(input: unknown, maxLength: number): TTracePrompt | undefined {
  const parsed = parse(input);
  const list = Array.isArray(parsed) ? parsed : messagesOf(parsed);
  if (!Array.isArray(list) || list.length === 0) {
    return undefined;
  }
  const perMessage = Math.max(1, Math.floor(maxLength * MESSAGE_SHARE));
  const first = toMessage(list[0], Math.max(1, Math.floor(maxLength * SYSTEM_SHARE)));
  const system = first?.role === 'system' ? first : undefined;
  const oldest = system ? 1 : 0;
  let remaining = maxLength - (system ? costOf(system) : 0);
  const newest: TTraceMessage[] = [];
  let index = list.length - 1;
  for (; index >= oldest && remaining > 0; index--) {
    const message = toMessage(list[index], Math.min(perMessage, remaining));
    if (message == null) {
      continue;
    }
    remaining -= costOf(message);
    newest.push(message);
  }
  const messages = [...(system ? [system] : []), ...newest.reverse()];
  if (messages.length === 0) {
    return undefined;
  }
  const tools = isObject(parsed) && Array.isArray(parsed.tools) ? toolNamesOf(parsed.tools) : [];
  return {
    messages,
    total: list.length,
    omitted: index - oldest + 1,
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function toolNamesOf(tools: Json[]): string[] {
  const names: string[] = [];
  for (const tool of tools) {
    if (names.length === MAX_TOOL_NAMES || !isObject(tool)) {
      continue;
    }
    const fn = isObject(tool.function) ? tool.function : undefined;
    const toolName = name(tool.name) ?? name(fn?.name);
    if (toolName != null) {
      names.push(toolName);
    }
  }
  return names;
}

/** Reads a model call's output as the message it wrote, when it is one. */
export function toTraceReply(output: unknown, maxLength: number): TTraceMessage | undefined {
  const parsed = parse(output);
  if (!isObject(parsed)) {
    return undefined;
  }
  const message = toMessage(parsed, maxLength);
  return message?.role === 'assistant' && (message.text != null || message.toolCalls != null)
    ? message
    : undefined;
}
