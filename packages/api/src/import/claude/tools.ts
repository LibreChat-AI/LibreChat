import { ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { ToolCallPart, ClaudeResultBlock, ClaudeContentBlock } from '~/import/types';
import type { SourceIndex } from './citations';
import { safeSourceUrl } from '~/import/url';
import { addSource } from './citations';

type ToolCallData = ToolCallPart[ContentTypes.TOOL_CALL];

const UNNAMED_TOOL = 'tool';

/**
 * Tool calls of the current conversation still waiting for their result.
 * `byId` handles the majority of the export, where `tool_use.id` is populated;
 * `pending` is the fallback for the calls Claude exports with a null id.
 */
export interface ToolRegistry {
  byId: Map<string, ToolCallData>;
  pending: ToolCallData[];
}

export function createToolRegistry(): ToolRegistry {
  return { byId: new Map(), pending: [] };
}

/**
 * `FileAuthoringCall` reads `file_path` and `content`, but Claude exports the
 * same call as `path` and `file_text` (measured: 453 of 457 `create_file`
 * blocks send `{description, file_text, path}`). Renaming here, rather than
 * teaching the shared card a second vocabulary, keeps the adapter's knowledge
 * of the export format inside the importer.
 */
const ARG_ALIASES: Record<string, Record<string, string>> = {
  create_file: { path: 'file_path', file_text: 'content' },
  edit_file: { path: 'file_path', file_text: 'content' },
};

function normalizeInput(name: string | null | undefined, input: object): object {
  const aliases = name != null ? ARG_ALIASES[name] : undefined;
  if (!aliases) {
    return input;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    normalized[aliases[key] ?? key] = value;
  }
  return normalized;
}

function stringifyInput(name: string | null | undefined, input: object | null | undefined): string {
  if (input == null) {
    return '';
  }
  try {
    return JSON.stringify(normalizeInput(name, input));
  } catch {
    return '';
  }
}

/**
 * Turns one `tool_use` block into the content part `Part.tsx` renders and
 * registers it as awaiting output. `progress: 1` is required: every tool card
 * reads `toolCall.progress ?? 0.1`, so an imported call left below 1 renders as
 * still running.
 */
export function beginToolCall(registry: ToolRegistry, block: ClaudeContentBlock): ToolCallPart {
  const data: ToolCallData = {
    name: block.name || UNNAMED_TOOL,
    args: stringifyInput(block.name, block.input),
    progress: 1,
    type: ToolCallTypes.TOOL_CALL,
  };

  if (block.id) {
    data.id = block.id;
    registry.byId.set(block.id, data);
  }
  registry.pending.push(data);

  return { type: ContentTypes.TOOL_CALL, [ContentTypes.TOOL_CALL]: data };
}

function knowledgeSource(block: ClaudeResultBlock): { link: string; title?: string } | null {
  const link = safeSourceUrl(block.url);
  if (!link) {
    return null;
  }
  return { link, title: block.title ?? undefined };
}

/** Result blocks that reference bytes the export never ships. */
function isUnavailableResource(type: string): boolean {
  return type === 'image' || type === 'image_gallery';
}

interface ResultOutput {
  text: string;
  unavailable: number;
}

/**
 * Renders a `tool_result`'s blocks into the single output string the tool cards
 * display, registering any `knowledge` block as a web source along the way so
 * the same search results back both the tool card and the message's citations.
 */
function renderResult(blocks: ClaudeResultBlock[], sources: SourceIndex): ResultOutput {
  const lines: string[] = [];
  let unavailable = 0;

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) {
        lines.push(block.text);
      }
      continue;
    }

    if (block.type === 'knowledge') {
      const source = knowledgeSource(block);
      if (!source) {
        continue;
      }
      addSource(sources, source);
      lines.push(`- [${source.title ?? source.link}](${source.link})`);
      continue;
    }

    if (block.type === 'local_resource') {
      /** The export ships the name or path but never the bytes, so this is a
       * missing attachment even though it renders a label. Not counting it made
       * the report understate what the import could not bring across. */
      unavailable += 1;
      const label = block.name ?? block.file_path;
      if (label) {
        lines.push(`- ${label}`);
      }
      continue;
    }

    if (isUnavailableResource(block.type)) {
      unavailable += 1;
    }
  }

  return { text: lines.join('\n'), unavailable };
}

export interface ResolvedResult {
  /** The call this result belongs to, or null when no open call matched it. */
  target: ToolCallData | null;
  output: string;
  unavailable: number;
}

/**
 * Pairs a `tool_result` with its `tool_use` and writes the rendered output onto
 * it. The join prefers `tool_use_id`, which Claude populates for most calls;
 * when it is null the oldest still-open call is used, matching the request order
 * the API returns results in.
 */
export function completeToolCall(
  registry: ToolRegistry,
  block: ClaudeContentBlock,
  sources: SourceIndex,
): ResolvedResult {
  const rendered = renderResult(block.content ?? [], sources);
  const output = block.is_error === true ? `Error:\n${rendered.text}` : rendered.text;

  const hasExplicitId = block.tool_use_id != null;
  const byId = hasExplicitId ? registry.byId.get(block.tool_use_id as string) : undefined;
  const target = hasExplicitId ? (byId ?? null) : (registry.pending.shift() ?? null);

  if (target) {
    target.output = output;
    if (byId) {
      registry.byId.delete(block.tool_use_id as string);
      const position = registry.pending.indexOf(byId);
      if (position !== -1) {
        registry.pending.splice(position, 1);
      }
    } else if (target.id) {
      registry.byId.delete(target.id);
    }
  }

  return { target, output, unavailable: rendered.unavailable };
}

/**
 * A result that matched no open call still has to render, or its output is lost:
 * it becomes a standalone, already-complete tool call named after the result.
 */
export function orphanToolCall(block: ClaudeContentBlock, output: string): ToolCallPart {
  return {
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      name: block.name || UNNAMED_TOOL,
      args: '',
      output,
      progress: 1,
      type: ToolCallTypes.TOOL_CALL,
    },
  };
}
