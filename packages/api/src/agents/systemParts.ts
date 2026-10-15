import { Tools } from 'librechat-data-provider';
import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import { AGENT_TEMPORAL_INSTRUCTIONS_KEY } from './contextUpdates';

/**
 * How long a system prompt part keeps its text:
 * - `static`: the same for every conversation of the agent under the same settings;
 * - `conversation`: stable within a conversation, changes only with its source
 *   (dated by the conversation start, not by the turn);
 * - `turn`: computed for the current message.
 */
export type ContextKind = 'static' | 'conversation' | 'turn';

export interface ContextPart {
  key: string;
  kind: ContextKind;
  /** Position in the canonical order; parts of a tool context map share their map's. */
  order: number;
  text: string;
}

export interface ContextAgent {
  instructions?: string | null;
  /** The assembled tail; `contributeContext` keeps it in sync with `contextParts`. */
  additional_instructions?: string | null;
  /** Text of each contributed part, by key. Replaced, never mutated: agent copies share it. */
  contextParts?: Readonly<Record<string, string>>;
  /** Tool instructions, by tool name: `tool:<name>` parts. */
  toolContextMap?: Record<string, unknown>;
  /** Tool runtime context, by tool name: `runtime:<name>` parts. */
  dynamicToolContextMap?: Record<string, unknown>;
  /** The turn context delivers the runtime context, so the system prompt leaves it out. */
  runtimeInLedger?: boolean;
}

export const ContextPartKeys = {
  toolPrefix: 'tool:',
  /** The agent's own `additional_instructions`, as given to initialization. */
  agent: 'agent',
  project: 'project',
  memoryGuard: 'memory_guard',
  /** The agent's instructions when they hold temporal variables and `stableContext` is off. */
  temporal: 'temporal',
  artifacts: 'artifacts',
  skills: 'skills',
  rag: 'rag',
  memory: 'memory',
  agentFiles: 'agent_files',
  /** The segment's anchored context (turn context ledger), replacing the parts it owns. */
  conversation: 'conversation',
  alwaysApplySkills: 'always_apply_skills',
  runtimePrefix: 'runtime:',
} as const;

/**
 * The step that adds a tail part. Each keeps the join rule of the code that
 * used to concatenate strings there, so the tail stays byte-identical:
 * - `init` (`initializeAgent`): blank-line separated, untrimmed;
 * - `request` (`applyContextToAgent`): appended to the trimmed `init` block and
 *   trimmed again, also when it adds nothing, so its parts are recorded even empty;
 * - `subagent` (`createRun`, isolated children): appended as is.
 */
type Stage = 'init' | 'request' | 'subagent';

interface PartSpec {
  key: string;
  kind: ContextKind;
  stage?: Stage;
}

/** Canonical order and classification of every system prompt part. */
const CONTEXT_PARTS: PartSpec[] = [
  { key: ContextPartKeys.toolPrefix, kind: 'static' },
  { key: ContextPartKeys.agent, kind: 'static', stage: 'init' },
  /** The project belongs to the conversation, not to the agent. */
  { key: ContextPartKeys.project, kind: 'conversation', stage: 'init' },
  { key: ContextPartKeys.memoryGuard, kind: 'static', stage: 'init' },
  { key: ContextPartKeys.temporal, kind: 'turn', stage: 'init' },
  { key: ContextPartKeys.artifacts, kind: 'static', stage: 'init' },
  { key: ContextPartKeys.skills, kind: 'static', stage: 'init' },
  /** Retrieved for the text of the current message. */
  { key: ContextPartKeys.rag, kind: 'turn', stage: 'request' },
  /** The memory agent can rewrite it after any turn. */
  { key: ContextPartKeys.memory, kind: 'turn', stage: 'request' },
  /** Extracted text of the agent's own context files. */
  { key: ContextPartKeys.agentFiles, kind: 'static', stage: 'request' },
  { key: ContextPartKeys.conversation, kind: 'conversation', stage: 'request' },
  { key: ContextPartKeys.alwaysApplySkills, kind: 'static', stage: 'subagent' },
  { key: ContextPartKeys.runtimePrefix, kind: 'conversation' },
];

/**
 * Tool runtime context that is dated by the conversation start or lists the files available
 * to the conversation. Any other runtime key is treated as per-turn, so a new producer whose
 * text changes every turn cannot break the stable prefix by default; one that is stable
 * within a conversation is registered here.
 */
const CONVERSATION_RUNTIME_KEYS = new Set<string>([
  Tools.web_search,
  Tools.execute_code,
  Tools.file_search,
  'image_edit_oai',
  'gemini_image_gen',
  AGENT_TEMPORAL_INSTRUCTIONS_KEY,
]);

function findSpecIndex(key: string): number {
  return CONTEXT_PARTS.findIndex((spec) =>
    spec.key.endsWith(':') ? key.startsWith(spec.key) : key === spec.key,
  );
}

function kindOf(key: string, spec: PartSpec): ContextKind {
  if (spec.key !== ContextPartKeys.runtimePrefix) {
    return spec.kind;
  }
  const name = key.slice(spec.key.length);
  return CONVERSATION_RUNTIME_KEYS.has(name) ? 'conversation' : 'turn';
}

function mapParts(prefix: string, map?: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(map ?? {}).flatMap(
    ([name, text]): Array<[string, string]> =>
      typeof text === 'string' ? [[`${prefix}${name}`, text]] : [],
  );
}

/** Every system prompt part of an agent, in canonical order, tool map entries in map order. */
export function listContextParts(agent: ContextAgent): ContextPart[] {
  const entries = [
    ...mapParts(ContextPartKeys.toolPrefix, agent.toolContextMap),
    ...Object.entries(agent.contextParts ?? {}),
    ...(agent.runtimeInLedger === true
      ? []
      : mapParts(ContextPartKeys.runtimePrefix, agent.dynamicToolContextMap)),
  ];
  return entries
    .map(([key, text]) => {
      const order = findSpecIndex(key);
      return { key, kind: kindOf(key, CONTEXT_PARTS[order]), order, text };
    })
    .sort((a, b) => a.order - b.order);
}

const joinBlocks = (texts: string[]) => texts.filter(Boolean).join('\n\n');

/** An agent without contributions has only its own `additional_instructions`. */
function tailParts(agent: ContextAgent): Readonly<Record<string, string>> {
  const own = agent.additional_instructions;
  return agent.contextParts ?? (own ? { [ContextPartKeys.agent]: own } : {});
}

/**
 * Builds the tail from the contributed parts that `include` accepts.
 * @returns undefined when nothing remains
 */
export function assembleAdditionalInstructions(
  agent: ContextAgent,
  include: (part: ContextPart) => boolean = () => true,
): string | undefined {
  const parts = listContextParts({ contextParts: tailParts(agent) }).filter(include);
  const stageParts = (stage: Stage) =>
    parts.filter((part) => CONTEXT_PARTS[part.order].stage === stage).map((part) => part.text);

  let text = joinBlocks(stageParts('init'));
  const request = stageParts('request');
  if (request.length > 0) {
    text = joinBlocks([text.trim(), ...request]).trim();
  }
  return joinBlocks([text, ...stageParts('subagent')]) || undefined;
}

/**
 * Adds or replaces an agent's tail part and reassembles `additional_instructions`.
 * The first contribution keeps any existing `additional_instructions` as the agent's own part.
 */
export function contributeContext(
  agent: ContextAgent,
  key: string,
  text: string | null | undefined,
): void {
  if (CONTEXT_PARTS[findSpecIndex(key)]?.stage == null) {
    throw new Error(`Unknown system prompt part "${key}"`);
  }
  agent.contextParts = { ...tailParts(agent), [key]: text ?? '' };
  agent.additional_instructions = assembleAdditionalInstructions(agent);
}

/**
 * Replaces the parts the turn context owns with the segment's anchored block.
 * The runtime context leaves the system prompt too: the block or the messages carry it.
 */
export function setConversationContext(
  agent: ContextAgent,
  ownedKeys: readonly string[],
  block: string,
): void {
  const kept = Object.entries(tailParts(agent)).filter(([key]) => !ownedKeys.includes(key));
  agent.contextParts = { ...Object.fromEntries(kept), [ContextPartKeys.conversation]: block };
  agent.runtimeInLedger = true;
  agent.additional_instructions = assembleAdditionalInstructions(agent);
}

const isTurnPart = (part: ContextPart) => part.kind === 'turn';

/**
 * Providers whose system message the SDK marks for prompt caching: Anthropic, OpenRouter and
 * Bedrock with `promptCache: true`. There `conversation_instructions` gets its own breakpoint
 * after `instructions`, and a summary of the conversation is a stable message of its own, while
 * Anthropic and OpenRouter relocate a non-empty `additional_instructions` right before the last
 * user message, a position that shifts every turn. Elsewhere the SDK appends the block to the
 * system text, which gains nothing. The prompt prefix stability tests run the SDK against this
 * predicate for every provider. Not verified on a real Bedrock endpoint.
 */
export function sdkCachesConversationBlock(
  provider: string | undefined,
  clientOptions?: object,
): boolean {
  return (
    (provider === Providers.ANTHROPIC ||
      provider === Providers.OPENROUTER ||
      provider === Providers.BEDROCK) &&
    (clientOptions as { promptCache?: unknown } | undefined)?.promptCache === true
  );
}

/**
 * The tail as the parts define it. `additional_instructions` is a derived copy:
 * once parts exist they are the only source, so a direct write to the field
 * cannot make providers disagree about what the tail holds.
 */
function currentTail(agent: ContextAgent): string {
  if (agent.contextParts == null) {
    return agent.additional_instructions ?? '';
  }
  const assembled = assembleAdditionalInstructions(agent) ?? '';
  if ((agent.additional_instructions ?? '') !== assembled) {
    logger.warn(
      '[systemParts] additional_instructions was written directly after parts were contributed; using the parts',
    );
  }
  return assembled;
}

/**
 * The system prompt strings handed to the SDK.
 *
 * - Without `stableContext` the prompt is built as before: tool runtime context
 *   ahead of the tail, everything in `additional_instructions`.
 * - With it, the tail comes first and the runtime context last. With `conversationBlock`
 *   every part but the per-turn ones goes to `conversation_instructions`, which the SDK keeps
 *   right after `instructions` with its own cache breakpoint and never moves; the per-turn
 *   parts stay in `additional_instructions`, which it relocates next to the newest user
 *   message for some providers.
 */
export function assembleSystemPrompt(
  agent: ContextAgent,
  {
    stableContext = false,
    conversationBlock = false,
  }: { stableContext?: boolean; conversationBlock?: boolean } = {},
): {
  instructions: string;
  conversation_instructions: string;
  additional_instructions: string;
} {
  const parts = listContextParts(agent).filter(({ text }) => text !== '');
  const mapText = (prefix: string, include: (part: ContextPart) => boolean = () => true) =>
    parts
      .filter((part) => part.key.startsWith(prefix) && include(part))
      .map(({ text }) => text)
      .join('\n')
      .trim();
  const instructions = [mapText(ContextPartKeys.toolPrefix), agent.instructions ?? '']
    .join('\n')
    .trim();
  const tail = currentTail(agent);
  if (!stableContext) {
    /** Isolated children's parts were appended to the finished tail as given, untrimmed. */
    const isChildPart = (part: ContextPart) => CONTEXT_PARTS[part.order].stage === 'subagent';
    const childText = assembleAdditionalInstructions(agent, isChildPart) ?? '';
    const ownTail =
      childText === '' || agent.contextParts == null
        ? tail
        : (assembleAdditionalInstructions(agent, (part) => !isChildPart(part)) ?? '');
    return {
      instructions,
      conversation_instructions: '',
      additional_instructions: joinBlocks([
        [mapText(ContextPartKeys.runtimePrefix), ownTail].join('\n').trim(),
        agent.contextParts == null ? '' : childText,
      ]),
    };
  }
  const additional = [tail, mapText(ContextPartKeys.runtimePrefix)].join('\n').trim();
  if (!conversationBlock || additional === '') {
    return { instructions, conversation_instructions: '', additional_instructions: additional };
  }

  const isStable = (part: ContextPart) => !isTurnPart(part);
  const stable = [
    assembleAdditionalInstructions(agent, isStable)?.trim() ?? '',
    mapText(ContextPartKeys.runtimePrefix, isStable),
  ]
    .join('\n')
    .trim();
  return {
    instructions,
    conversation_instructions: stable,
    additional_instructions: joinBlocks([
      assembleAdditionalInstructions(agent, isTurnPart)?.trim() ?? '',
      mapText(ContextPartKeys.runtimePrefix, isTurnPart),
    ]),
  };
}
