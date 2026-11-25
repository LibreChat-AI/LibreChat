import { unescapeJsonString } from '../../core/parts/parseJsonField';

const PROMPT_KEYS = ['prompt', 'description', 'task', 'instructions'] as const;

/** The task a subagent call was given, read from its arguments (JSON text or parsed). */
export function getSubagentPrompt(
  args: string | Record<string, unknown> | null | undefined,
): string | undefined {
  let parsed: unknown = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  if (parsed == null || typeof parsed !== 'object') {
    return undefined;
  }
  return promptOf(parsed as Record<string, unknown>);
}

function promptOf(parsed: Record<string, unknown>): string | undefined {
  for (const key of PROMPT_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

/** What a subagent call's arguments say so far, complete or still streaming. */
export type SubagentArgs = {
  /** The arguments are a whole JSON object: the parent has finished writing the call. */
  complete: boolean;
  /** The brief, as far as it has streamed. */
  prompt?: string;
  /** The requested type, once its value has closed; never a half-written alias. */
  subagentType?: string;
};

/**
 * A key's string value from arguments that may still be streaming. The key is matched with its
 * own unescaped quotes, which a JSON string value can never contain, so text inside the brief
 * that merely names a key does not match. `closed` requires the value's closing quote.
 */
function readStringField(
  args: string,
  key: string,
  closed: boolean,
): { value: string; settled: boolean } | undefined {
  const at = args.indexOf(`"${key}"`);
  if (at < 0) {
    return undefined;
  }
  const match = VALUE_REGEX.exec(args.slice(at + key.length + 2));
  if (match == null || (closed && match[2] !== '"')) {
    return undefined;
  }
  const settled = match[2] === '"';
  return { value: unescapeJsonString(match[1], !settled), settled };
}

/** `: "value"` after a key, tolerating a missing closing quote and a dangling escape. */
const VALUE_REGEX = /^\s*:\s*"((?:[^"\\]|\\.)*)(")?/;

/**
 * Reads a subagent call's arguments in one pass: the whole object once it parses, otherwise
 * the brief as far as it has streamed and the type once its value has closed. The SDK writes
 * `intent`, then `description`, then `subagent_type`, so the brief streams before the type.
 */
export function readSubagentArgs(
  args: string | Record<string, unknown> | null | undefined,
): SubagentArgs {
  if (args == null) {
    return { complete: false };
  }
  if (typeof args === 'object') {
    return whole(args);
  }
  if (args.trimEnd().endsWith('}')) {
    try {
      const parsed: unknown = JSON.parse(args);
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return whole(parsed as Record<string, unknown>);
      }
    } catch {
      /** A brief can end in `}` mid-stream; read it as partial. */
    }
  }
  const result: SubagentArgs = { complete: false };
  for (const key of PROMPT_KEYS) {
    const field = readStringField(args, key, false);
    if (field != null && field.value.trim().length > 0) {
      result.prompt = field.value;
      break;
    }
  }
  const type = readStringField(args, 'subagent_type', true);
  if (type != null && type.value !== '') {
    result.subagentType = type.value;
  }
  return result;
}

function whole(parsed: Record<string, unknown>): SubagentArgs {
  const type = parsed.subagent_type;
  const prompt = promptOf(parsed);
  return {
    complete: true,
    ...(prompt == null ? {} : { prompt }),
    ...(typeof type === 'string' && type !== '' ? { subagentType: type } : {}),
  };
}
