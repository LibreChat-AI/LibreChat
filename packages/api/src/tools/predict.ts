import { logger } from '@librechat/data-schemas';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { TClassificationConfig } from 'librechat-data-provider';
import type { LCToolRegistry } from '@librechat/agents';
import type {
  Classifier,
  ChoiceQuestion,
  BooleanQuestion,
  ClassificationUsage,
} from '~/classification/types';
import { isBooleanAnswer, isChoiceAnswer } from '~/classification/types';
import { boolean, choice, ranked } from '~/classification/questions';
import { classificationCapability } from '~/classification/resolve';
import { extractDiscoveredToolsFromHistory } from '~/agents/run';

/** Option key standing for "none of these fit". Not a legal MCP tool name. */
const NO_MATCH = '__no_tool_fits__';

/** Largest option set one ranking question may carry, including no-match. */
const MAX_QUESTION_OPTIONS = 255;

export const RANKING_QUESTION: {
  instructions: string;
  guidance: string;
  noMatch: string;
} = {
  instructions:
    'Which tool should the assistant call first to carry out `request`? Each option is a tool ' +
    'name; the text beside it is what that tool does.',
  guidance:
    'Choose the tool whose own purpose matches the request, not one that merely shares words ' +
    'with it. Choose the no-match option when the request is conversational, is answerable ' +
    'from the conversation, or when no listed tool does this kind of work.',
  noMatch: 'None of these tools would help with this request.',
};

export const NEEDS_TOOL_QUESTION: BooleanQuestion = boolean(
  'Carrying out `request` requires calling a tool, rather than answering from general ' +
    'knowledge or from what the conversation already contains.',
  {
    true: 'The request asks for an action, or for current or private data the assistant cannot already have.',
    false:
      'The request is conversational, or answerable from general knowledge or the conversation so far.',
  },
);

export interface PredictCandidate {
  name: string;
  description?: string;
}

export type ToolSelectionConfig = TClassificationConfig['toolSelection'];

export interface PredictToolsParams {
  classifier: Classifier;
  candidates: readonly PredictCandidate[];
  request: string;
  config: ToolSelectionConfig;
  signal?: AbortSignal;
}

export interface PredictToolsResult {
  names: string[];
  needsTool: number;
  /** Surfaced because the request named them, not because of rank. */
  named: string[];
  usage: ClassificationUsage;
  requests: number;
}

const EMPTY_RESULT: PredictToolsResult = {
  names: [],
  needsTool: 0,
  named: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  requests: 0,
};

function summarize(description: string | undefined, limit: number): string | null {
  if (!description) {
    return null;
  }
  const flat = description.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) {
    return null;
  }
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export function baseToolName(name: string): string {
  const index = name.indexOf('_mcp_');
  return index === -1 ? name : name.slice(0, index);
}

function mentionsWord(haystack: string, word: string): boolean {
  for (let at = haystack.indexOf(word); at !== -1; at = haystack.indexOf(word, at + 1)) {
    const before = at === 0 ? '' : haystack[at - 1];
    const after = haystack[at + word.length] ?? '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
      return true;
    }
  }
  return false;
}

/**
 * Word-boundary matched, so a short name cannot match inside another word, and
 * capped at `limit` so a common word ("search") cannot surface a tool from every server.
 */
export function namedInRequest(
  candidates: readonly PredictCandidate[],
  request: string,
  limit: number = Number.POSITIVE_INFINITY,
): string[] {
  const haystack = request.toLowerCase();
  if (haystack.length === 0 || limit <= 0) {
    return [];
  }
  const found: string[] = [];
  for (const candidate of candidates) {
    const base = baseToolName(candidate.name).toLowerCase();
    if (base.length < 4 || !mentionsWord(haystack, base)) {
      continue;
    }
    found.push(candidate.name);
    if (found.length >= limit) {
      break;
    }
  }
  return found;
}

export function batchCandidates(
  candidates: readonly PredictCandidate[],
  maxPerBatch: number,
): PredictCandidate[][] {
  /** One option is spent on the no-match outcome. */
  const size = Math.max(1, Math.min(maxPerBatch, MAX_QUESTION_OPTIONS - 1));
  if (candidates.length <= size) {
    return [[...candidates]];
  }
  const batches: PredictCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += size) {
    batches.push(candidates.slice(i, i + size));
  }
  return batches;
}

function rankingQuestion(
  batch: readonly PredictCandidate[],
  config: ToolSelectionConfig,
): ChoiceQuestion {
  const criteria: Record<string, string | null> = {};
  for (const candidate of batch) {
    criteria[candidate.name] = summarize(candidate.description, config.descriptionChars);
  }
  criteria[NO_MATCH] = RANKING_QUESTION.noMatch;
  return choice(
    {
      question: config.instructions ?? RANKING_QUESTION.instructions,
      guidance: config.guidance ?? RANKING_QUESTION.guidance,
    },
    criteria,
  );
}

function addUsage(total: ClassificationUsage, next: ClassificationUsage): ClassificationUsage {
  return {
    inputTokens: total.inputTokens + (next.inputTokens ?? 0),
    outputTokens: total.outputTokens + (next.outputTokens ?? 0),
  };
}

/**
 * An omission costs a round trip, an extra only tokens, so unsure widens.
 * Unmeasured confidence counts as unsure for the same reason.
 */
export function shortlistSize(confidence: number | null, config: ToolSelectionConfig): number {
  if (config.lowConfidenceExtra <= 0) {
    return config.shortlist;
  }
  if (confidence != null && confidence > config.lowConfidenceBelow) {
    return config.shortlist;
  }
  return config.shortlist + config.lowConfidenceExtra;
}

export async function predictTools(params: PredictToolsParams): Promise<PredictToolsResult> {
  const { classifier, candidates, request, config, signal } = params;

  const text = request?.trim();
  if (!text || candidates.length === 0) {
    return EMPTY_RESULT;
  }

  const named = config.surfaceNamedTools ? namedInRequest(candidates, text, config.shortlist) : [];

  const batches = batchCandidates(candidates, config.maxCatalogTools);
  let usage: ClassificationUsage = { inputTokens: 0, outputTokens: 0 };
  let requests = 0;

  try {
    const responses = await Promise.all(
      batches.map((batch, index) =>
        classifier.classify({
          label: `tool-selection[${index + 1}/${batches.length}]`,
          signal,
          timeoutMs: config.timeoutMs,
          state: { request: text },
          questions:
            index === 0
              ? {
                  best_tool: rankingQuestion(batch, config),
                  needs_tool: boolean(
                    config.needsToolInstructions ?? NEEDS_TOOL_QUESTION.instructions,
                    NEEDS_TOOL_QUESTION.criteria,
                  ),
                }
              : { best_tool: rankingQuestion(batch, config) },
        }),
      ),
    );

    requests = responses.length;
    let needsTool = 1;
    let lowestConfidence: number | null = 1;
    const pooled: Array<{ name: string; probability: number }> = [];

    for (const response of responses) {
      usage = addUsage(usage, response.usage);
      const needs = response.answers.needs_tool;
      if (isBooleanAnswer(needs)) {
        needsTool = needs.probability;
      }
      const best = response.answers.best_tool;
      if (!isChoiceAnswer(best)) {
        continue;
      }
      if (best.confidence == null || lowestConfidence == null) {
        lowestConfidence = null;
      } else {
        lowestConfidence = Math.min(lowestConfidence, best.confidence);
      }
      for (const name of ranked(best, config.minProbability)) {
        if (name !== NO_MATCH) {
          pooled.push({ name, probability: best.probabilities[name] });
        }
      }
    }

    if (needsTool < config.needsToolThreshold) {
      logger.debug(
        `[predictTools] needs_tool ${needsTool.toFixed(2)} below ${config.needsToolThreshold}: ` +
          `surfacing ${named.length} named tool(s) only`,
      );
      /** A tool the user named outright still applies; the ranker's guess does not. */
      return { names: [...named], needsTool, named, usage, requests };
    }

    const limit = shortlistSize(lowestConfidence, config);
    const byProbability = pooled
      .sort((a, b) => b.probability - a.probability)
      .map((entry) => entry.name);

    /** Named tools do not consume the ranked shortlist's budget. */
    const names: string[] = [];
    for (const name of named) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }
    for (const name of byProbability) {
      if (names.length >= limit + named.length) {
        break;
      }
      if (!names.includes(name)) {
        names.push(name);
      }
    }

    logger.debug(
      `[predictTools] surfaced ${names.length} of ${candidates.length} tools ` +
        `in ${requests} request(s), ${usage.inputTokens} input tokens` +
        (named.length > 0 ? `, ${named.length} named by the request` : '') +
        (limit > config.shortlist
          ? ` (widened: confidence ${lowestConfidence?.toFixed(2) ?? 'unmeasured'})`
          : ''),
    );

    return { names, needsTool, named, usage, requests };
  } catch (error) {
    logger.warn(
      '[predictTools] prediction failed, continuing without it: ' +
        (error instanceof Error ? error.message : String(error)),
    );
    return { ...EMPTY_RESULT, names: named, named, usage, requests };
  }
}

export function deferredCandidates(
  registry: LCToolRegistry | undefined,
  alreadyLoaded?: ReadonlySet<string>,
): PredictCandidate[] {
  if (registry == null) {
    return [];
  }
  const candidates: PredictCandidate[] = [];
  for (const tool of registry.values()) {
    if (tool.defer_loading !== true) {
      continue;
    }
    if (alreadyLoaded?.has(tool.name) === true) {
      continue;
    }
    candidates.push({ name: tool.name, description: tool.description });
  }
  return candidates;
}

export function latestRequestText(messages: readonly BaseMessage[] | undefined): string {
  if (messages == null) {
    return '';
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message._getType?.() !== 'human') {
      continue;
    }
    const content = message.content;
    if (typeof content === 'string') {
      return content.trim();
    }
    if (!Array.isArray(content)) {
      continue;
    }
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part != null && typeof part === 'object' && 'text' in part) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') {
          parts.push(text);
        }
      }
    }
    return parts.join(' ').trim();
  }
  return '';
}

export interface AgentWithRegistry {
  id?: string;
  toolRegistry?: LCToolRegistry;
}

export interface PredictToolsForTurnParams {
  config?: TClassificationConfig | null;
  agents: readonly AgentWithRegistry[];
  messages: readonly BaseMessage[] | undefined;
  signal?: AbortSignal;
  apiKey?: string;
  alreadyLoaded?: ReadonlySet<string>;
  /** Receives what the ranking cost, so the caller can bill it. */
  onUsage?: (usage: ClassificationUsage, model: string) => void;
}

export async function predictToolsForTurn(params: PredictToolsForTurnParams): Promise<string[]> {
  const capability = classificationCapability(params.config, 'toolSelection', {
    apiKey: params.apiKey,
  });
  if (capability == null) {
    logger.debug('[predictToolsForTurn] skipped: tool selection is off, or no usable classifier');
    return [];
  }

  const alreadyLoaded =
    params.alreadyLoaded ??
    (params.messages?.length ? extractDiscoveredToolsFromHistory(params.messages) : undefined);

  /** Names are unique across agents; `createRun` routes each to its owner. */
  const seen = new Set<string>();
  const candidates: PredictCandidate[] = [];
  for (const agent of params.agents) {
    for (const candidate of deferredCandidates(agent.toolRegistry, alreadyLoaded)) {
      if (seen.has(candidate.name)) {
        continue;
      }
      seen.add(candidate.name);
      candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    logger.debug(
      `[predictToolsForTurn] skipped: none of the ${params.agents.length} agent(s) defer a tool`,
    );
    return [];
  }

  const request = latestRequestText(params.messages);
  logger.debug(
    `[predictToolsForTurn] ranking ${candidates.length} deferred tool(s) against ` +
      `${request.length} characters of request`,
  );

  const result = await predictTools({
    classifier: capability.classifier,
    config: capability.settings,
    candidates,
    request,
    signal: params.signal,
  });

  if (result.requests > 0) {
    params.onUsage?.(result.usage, capability.classifier.model);
  }

  logger.debug(
    `[predictToolsForTurn] surfacing ${result.names.length} tool(s)` +
      (result.names.length > 0 ? `: ${result.names.join(', ')}` : ''),
  );

  return result.names;
}
