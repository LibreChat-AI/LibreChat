import { EModelEndpoint, formatPromptTimestamp } from 'librechat-data-provider';
import type { ContextAgent } from '../systemParts';
import { AGENT_TEMPORAL_INSTRUCTIONS_KEY, hasConversationDateContext } from '../contextUpdates';
import { agentHasInlineMemoryTools, formatMemoryContext, memoryInstructions } from '../memory';
import { QUEUED_CODE_FILES_CONTEXT_KEY } from '~/files/code/queued';
import { generateArtifactsPrompt } from '~/prompts';

type Instant = string | number | Date;

/** One source state; `value` null means the source is switched off. */
export interface ContextEntry {
  key: string;
  value: string | null;
}

export interface TurnContextAgent extends ContextAgent {
  id?: string;
  provider?: string;
  artifacts?: unknown;
  tools?: unknown[];
  memoryToolsRegistered?: boolean;
}

/** What the sources read, sampled once when the user sends the message. */
export interface SendSnapshot {
  agent: TurnContextAgent;
  turnStartedAt?: Instant | null;
  timezone?: string;
  /** Whether a system prompt of the run states the conversation date. */
  dateContext: boolean;
  messageTimestamps: boolean;
  /** Formatted memory the agent may see; undefined while memory is unavailable. */
  memory?: string;
  /** Context retrieved for the text of the sent message (RAG). */
  rag?: string;
}

/**
 * A context source:
 * - `state`: the model keeps knowing its value; the segment anchor carries it in
 *   the system prompt and a change is announced once, on the message sent with it;
 * - `message`: describes only the message sent with it.
 *
 * `whenOff` decides what switching a state source off does: `announce` says so,
 * `silent` stops updating, `withhold` keeps its text out of the whole request.
 */
export interface ContextSource {
  /** Exact key, or a prefix ending in `:` that owns every key starting with it. */
  key: string;
  kind: 'state' | 'message';
  whenOff?: 'announce' | 'silent' | 'withhold';
  collect: (snapshot: SendSnapshot) => Iterable<[string, string]>;
  /**
   * The value an update stores for a state source whose live value changed, when it is
   * smaller than the live value. `undefined` means nothing changed. Without it the live
   * value is stored.
   */
  diff?: (previous: string | null, live: string | null) => string | null | undefined;
  /** The state after an update stored by `diff`; without `diff` the stored value is the state. */
  apply?: (previous: string | null, stored: string) => string;
  /** System prompt text of an anchored value; omitted when the anchor states it elsewhere. */
  renderAnchor?: (key: string, value: string, agent: TurnContextAgent) => string;
  /** The update line(s); `previous` is what the model knew before, null when nothing. */
  renderUpdate: (
    key: string,
    value: string | null,
    previous: string | null,
    agent: TurnContextAgent,
  ) => string;
}

/** The request fields a send-time snapshot reads. */
export interface SnapshotRequest {
  turnStartedAt?: number;
  body?: { timezone?: string } | null;
  config?: {
    endpoints?: { [EModelEndpoint.agents]?: { promptMessageTimestamps?: boolean } };
  } | null;
}

/**
 * Samples the primary agent's sources when the user sends a message.
 * @param agents - every agent of the run: any of them stating the date tracks it
 * @param memories - the primary agent's formatted memories; undefined while unavailable
 */
export function createSendSnapshot({
  agent,
  agents,
  req,
  memories,
  rag,
}: {
  agent: TurnContextAgent;
  agents: Iterable<{ dynamicToolContextMap?: Record<string, unknown> } | null | undefined>;
  req: SnapshotRequest;
  memories?: { withKeys?: string; withoutKeys?: string } | null;
  rag?: string | null;
}): SendSnapshot {
  return {
    agent,
    turnStartedAt: req.turnStartedAt,
    timezone: req.body?.timezone,
    dateContext: hasConversationDateContext(agents),
    messageTimestamps:
      req.config?.endpoints?.[EModelEndpoint.agents]?.promptMessageTimestamps === true,
    memory:
      memories != null
        ? formatMemoryContext(
            agentHasInlineMemoryTools(agent) ? memories.withKeys : memories.withoutKeys,
          )
        : undefined,
    rag: rag ?? undefined,
  };
}

/** The system prompt part keys of the sources the anchor renders, and the message sources. */
export const ContextSourceKeys = {
  memoryGuard: 'memory_guard',
  artifacts: 'artifacts',
  skills: 'skills',
  project: 'project',
  runtimePrefix: 'runtime:',
  date: 'date',
  messageTime: 'message_time',
  memory: 'memory',
  rag: 'rag',
  queuedCodeFiles: 'queued_code_files',
} as const;

/** System prompt parts the anchor owns for an agent whose context is ledgered. */
export const LEDGER_PART_KEYS: readonly string[] = [
  ContextSourceKeys.memoryGuard,
  ContextSourceKeys.artifacts,
  ContextSourceKeys.skills,
  ContextSourceKeys.project,
  ContextSourceKeys.memory,
  ContextSourceKeys.rag,
];

const formatDate = (now: Instant, timezone?: string) =>
  formatPromptTimestamp({ now, timezone, precision: 'date' });

function contributedPart(key: string) {
  return ({ agent }: SendSnapshot): Array<[string, string]> => {
    const text = agent.contextParts?.[key];
    return text ? [[key, text]] : [];
  };
}

const identity = (_key: string, value: string) => value;

/** Replaces any earlier version, or announces the source no longer applies. */
function describeText(label: (key: string) => string) {
  return (key: string, value: string | null, previous: string | null, agent: TurnContextAgent) => {
    if (value == null) {
      return `${label(key)} no longer applies.`;
    }
    const heading = previous == null ? label(key) : `${label(key)} (replaces any earlier version)`;
    return `${heading}:\n${renderAnchorText(key, value, agent)}`;
  };
}

const runtimeName = (key: string) => key.slice(ContextSourceKeys.runtimePrefix.length);

/** One entry of the formatted memory text, without its list number. */
interface MemoryEntry {
  /** The memory key when the text carries one, else the entry text itself. */
  id: string;
  text: string;
}

interface MemoryDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

const MEMORY_HEADING = '# Existing memory about the user:\n';
const MEMORY_ENTRY_START = /\n\n(?=\d+\. \[)/;
const NUMBERED_ENTRY = /^\d+\. \[/;
const MEMORY_KEY = /\["key": "((?:[^"\\]|\\.)*)"\]/;

const memoryEntry = (text: string): MemoryEntry => ({
  id: MEMORY_KEY.exec(text)?.[1] ?? text,
  text,
});

function parseMemoryEntries(formatted: string | null): MemoryEntry[] {
  if (formatted == null) {
    return [];
  }
  const start = formatted.indexOf(MEMORY_HEADING);
  const body =
    start >= 0
      ? formatted.slice(start + MEMORY_HEADING.length)
      : formatted.replace(memoryInstructions, '');
  /** Memory is a numbered list; any other text counts a line as an entry. */
  const chunks = NUMBERED_ENTRY.test(body) ? body.split(MEMORY_ENTRY_START) : body.split('\n');
  return chunks
    .map((entry) => entry.replace(/^\d+\. /, '').trim())
    .filter(Boolean)
    .map(memoryEntry);
}

function diffMemory(previous: string | null, live: string | null): string | null | undefined {
  if (live == null) {
    return null;
  }
  const before = new Map(parseMemoryEntries(previous).map(({ id, text }) => [id, text]));
  const now = parseMemoryEntries(live);
  const diff: MemoryDiff = { added: [], changed: [], removed: [] };
  for (const { id, text } of now) {
    if (!before.has(id)) {
      diff.added.push(text);
    } else if (before.get(id) !== text) {
      diff.changed.push(text);
    }
  }
  const liveIds = new Set(now.map(({ id }) => id));
  for (const [id, text] of before) {
    if (!liveIds.has(id)) {
      diff.removed.push(text);
    }
  }
  const unchanged = diff.added.length + diff.changed.length + diff.removed.length === 0;
  return previous != null && unchanged ? undefined : JSON.stringify(diff);
}

function readMemoryDiff(stored: string): MemoryDiff {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  try {
    const parsed = JSON.parse(stored) as Partial<Record<keyof MemoryDiff, unknown>>;
    return {
      added: strings(parsed.added),
      changed: strings(parsed.changed),
      removed: strings(parsed.removed),
    };
  } catch {
    return { added: [], changed: [], removed: [] };
  }
}

function applyMemoryDiff(previous: string | null, stored: string): string {
  const { added, changed, removed } = readMemoryDiff(stored);
  const entries = parseMemoryEntries(previous).filter(({ text }) => !removed.includes(text));
  for (const text of changed) {
    const entry = memoryEntry(text);
    const index = entries.findIndex(({ id }) => id === entry.id);
    if (index < 0) {
      entries.push(entry);
    } else {
      entries[index] = entry;
    }
  }
  entries.push(...added.map(memoryEntry));
  const list = entries.map(({ text }) => text).join('\n\n');
  return list ? `${memoryInstructions}\n\n${MEMORY_HEADING}${list}` : memoryInstructions;
}

function renderMemoryUpdate(_key: string, value: string | null, previous: string | null): string {
  if (value == null) {
    return 'Memory about the user no longer applies.';
  }
  if (previous == null) {
    return `Memory about the user:\n${applyMemoryDiff(null, value)}`;
  }
  const { added, changed, removed } = readMemoryDiff(value);
  const sections: Array<[string, string[]]> = [
    ['Added', added],
    ['Changed', changed],
    ['Removed', removed],
  ];
  return [
    'Memory about the user changed:',
    ...sections
      .filter(([, entries]) => entries.length > 0)
      .map(([title, entries]) => `${title}:\n${entries.join('\n\n')}`),
  ].join('\n');
}

/** Registry order is the order of lines in an update and of parts in a new anchor. */
const SOURCES: ContextSource[] = [
  {
    key: ContextSourceKeys.memoryGuard,
    kind: 'state',
    collect: contributedPart(ContextSourceKeys.memoryGuard),
    renderAnchor: identity,
    renderUpdate: describeText(() => 'Memory tool guidance'),
  },
  {
    key: ContextSourceKeys.artifacts,
    kind: 'state',
    /** Stored as the mode: the prompt is long and fully determined by it. */
    collect: ({ agent }) =>
      agent.contextParts?.[ContextSourceKeys.artifacts] && typeof agent.artifacts === 'string'
        ? [[ContextSourceKeys.artifacts, agent.artifacts]]
        : [],
    renderAnchor: (_key, mode, agent) =>
      generateArtifactsPrompt({ endpoint: agent.provider ?? '', artifacts: mode as never }) ?? '',
    renderUpdate: describeText(() => 'Artifacts instructions'),
  },
  {
    key: ContextSourceKeys.skills,
    kind: 'state',
    collect: contributedPart(ContextSourceKeys.skills),
    renderAnchor: identity,
    renderUpdate: describeText(() => 'Skills catalog'),
  },
  {
    key: ContextSourceKeys.project,
    kind: 'state',
    collect: contributedPart(ContextSourceKeys.project),
    renderAnchor: identity,
    renderUpdate: describeText(() => 'Project guidance'),
  },
  {
    key: ContextSourceKeys.runtimePrefix,
    kind: 'state',
    collect: ({ agent }) =>
      Object.entries(agent.dynamicToolContextMap ?? {}).flatMap(
        ([name, text]): Array<[string, string]> =>
          typeof text === 'string' && text !== '' && name !== QUEUED_CODE_FILES_CONTEXT_KEY
            ? [[`${ContextSourceKeys.runtimePrefix}${name}`, text]]
            : [],
      ),
    renderAnchor: identity,
    renderUpdate: describeText((key) =>
      runtimeName(key) === AGENT_TEMPORAL_INSTRUCTIONS_KEY
        ? 'Agent instructions'
        : `Runtime context for the \`${runtimeName(key)}\` tool`,
    ),
  },
  {
    key: ContextSourceKeys.date,
    kind: 'state',
    whenOff: 'silent',
    collect: ({ dateContext, turnStartedAt, timezone }) =>
      dateContext && turnStartedAt != null
        ? [[ContextSourceKeys.date, formatDate(turnStartedAt, timezone)]]
        : [],
    /** Dates the segment: the runtime context states when the conversation started, not today. */
    renderAnchor: (_key, value) => `Current date: ${value}`,
    renderUpdate: (_key, value, previous) =>
      previous == null ? `Current date: ${value}` : `Current date changed to: ${value}`,
  },
  {
    key: ContextSourceKeys.messageTime,
    kind: 'message',
    collect: ({ messageTimestamps, turnStartedAt, timezone }) =>
      messageTimestamps && turnStartedAt != null
        ? [
            [
              ContextSourceKeys.messageTime,
              formatPromptTimestamp({ now: turnStartedAt, timezone, precision: 'second' }),
            ],
          ]
        : [],
    renderUpdate: (_key, value) => `Message sent: ${value}`,
  },
  {
    key: ContextSourceKeys.memory,
    kind: 'state',
    /** Memory the user switched off reaches the model nowhere, not even from earlier turns. */
    whenOff: 'withhold',
    collect: ({ memory }) => (memory ? [[ContextSourceKeys.memory, memory]] : []),
    renderAnchor: identity,
    /** An update stores which entries were added, changed or removed, not the whole memory. */
    diff: diffMemory,
    apply: applyMemoryDiff,
    renderUpdate: renderMemoryUpdate,
  },
  {
    /**
     * Stored with its message and replayed, like the file context bound to the message that
     * carried the files: retrieval cannot be repeated byte for byte on a later turn.
     */
    key: ContextSourceKeys.rag,
    kind: 'message',
    collect: ({ rag }) => (rag?.trim() ? [[ContextSourceKeys.rag, rag.trim()]] : []),
    renderUpdate: (_key, value) => value ?? '',
  },
  {
    key: ContextSourceKeys.queuedCodeFiles,
    kind: 'message',
    collect: ({ agent }) => {
      const text = agent.dynamicToolContextMap?.[QUEUED_CODE_FILES_CONTEXT_KEY];
      return typeof text === 'string' && text !== ''
        ? [[ContextSourceKeys.queuedCodeFiles, text]]
        : [];
    },
    renderUpdate: (_key, value) => value ?? '',
  },
];

function findSourceIndex(key: string): number {
  const exact = SOURCES.findIndex((source) => source.key === key);
  if (exact >= 0) {
    return exact;
  }
  return SOURCES.findIndex((source) => source.key.endsWith(':') && key.startsWith(source.key));
}

export function findContextSource(key: string): ContextSource | undefined {
  return SOURCES[findSourceIndex(key)];
}

/** Registry order; keys of one prefix source by name. */
export function compareContextKeys(a: string, b: string): number {
  const rank = findSourceIndex(a) - findSourceIndex(b);
  if (rank !== 0 || a === b) {
    return rank;
  }
  return a < b ? -1 : 1;
}

/** Evaluates every source at send time. */
export function collectLiveContext(snapshot: SendSnapshot): Map<string, string> {
  const live = new Map<string, string>();
  for (const source of SOURCES) {
    for (const [key, value] of source.collect(snapshot)) {
      live.set(key, value);
    }
  }
  return live;
}

/** System prompt text of an anchored value; empty for sources the anchor states elsewhere. */
export function renderAnchorText(key: string, value: string, agent: TurnContextAgent): string {
  const source = findContextSource(key);
  if (source == null) {
    return '';
  }
  return source.renderAnchor?.(key, value, agent) ?? '';
}

/** Keys of `withhold` sources that are off now: their text reaches the model nowhere. */
export function getWithheldKeys(
  live: ReadonlyMap<string, string>,
  known: Iterable<string>,
): Set<string> {
  const withheld = new Set<string>();
  const candidates = [...SOURCES.map(({ key }) => key), ...known];
  for (const key of candidates) {
    if (findContextSource(key)?.whenOff === 'withhold' && !live.has(key)) {
      withheld.add(key);
    }
  }
  return withheld;
}
