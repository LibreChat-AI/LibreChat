import { randomUUID } from 'crypto';
import type { SeedMessage } from './db';
import { withMongo, deleteConversations, deleteMessagesByConversation } from './db';
import { getE2EUser } from '../../setup/user';
import { MOCK_ENDPOINTS } from './helpers';

/**
 * A long agent conversation, generated: the thread the performance checks open, scroll and
 * reply into. Its shape follows a real working session of about 250 rows: replies of one part
 * up to a couple of hundred, most of them tool calls grouped under activity labels and phases,
 * with reasoning between them, and user turns long enough to be collapsed.
 *
 * Everything a row renders comes from the seed, so two builds of the app are measured against
 * the same thread, and a count taken from it moves only when the app does.
 */

type Part = Record<string, unknown>;

export type Thread = {
  conversationId: string;
  title: string;
  /** Rows the thread renders: one per message. */
  rows: number;
  messages: SeedMessage[];
};

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const ENDPOINT = MOCK_ENDPOINTS[0];
/** A fixed clock, so a part's timings do not depend on when the thread was built. */
const EPOCH = Date.UTC(2026, 0, 5, 9, 0, 0);

/**
 * Parts per reply, cycled: half of the replies stay under a dozen parts and a few run into the
 * hundreds, which is where a session's tool calls are.
 */
const REPLY_PARTS = [6, 1, 13, 2, 57, 5, 22, 1, 125, 7, 3, 38, 10, 192, 16, 84];
/** Characters per user turn, cycled: half of them are pasted material a row collapses. */
const USER_CHARS = [70, 2000, 300, 9000, 1200, 2600];
/** Characters per tool result, cycled. */
const OUTPUT_CHARS = [150, 1200, 400, 6000, 800, 2000];

const WORDS = [
  'build',
  'cache',
  'query',
  'index',
  'worker',
  'stream',
  'render',
  'config',
  'schema',
  'request',
  'session',
  'gateway',
  'handler',
  'payload',
  'retry',
  'timeout',
  'migration',
  'snapshot',
  'pipeline',
  'release',
  'the',
  'a',
  'each',
  'after',
  'before',
  'while',
  'with',
  'without',
  'reads',
  'writes',
  'checks',
  'returns',
  'skips',
  'keeps',
  'drops',
  'again',
];
const PATHS = [
  'src/server/index.ts',
  'src/server/routes/session.ts',
  'src/client/components/Thread.tsx',
  'src/client/hooks/useStream.ts',
  'packages/core/src/cache.ts',
  'packages/core/src/retry.ts',
  'scripts/release.sh',
  'config/default.yaml',
];
const COMMANDS = ['npm test --', 'git diff --stat', 'rg -n', 'node scripts/check.mjs', 'ls -la'];

/** Mulberry32: the same seed gives the same thread on every machine. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

type Source = {
  next: () => number;
  pick: <T>(items: readonly T[]) => T;
  int: (low: number, high: number) => number;
};

function source(seed: number): Source {
  const next = random(seed);
  const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
  return { next, int, pick: (items) => items[Math.floor(next() * items.length)] };
}

function sentence(from: Source, words = from.int(6, 14)): string {
  const picked = Array.from({ length: words }, () => from.pick(WORDS));
  const text = picked.join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Prose of about `chars` characters, in paragraphs. */
function prose(from: Source, chars: number): string {
  const paragraphs: string[] = [];
  let length = 0;
  while (length < chars) {
    const lines: string[] = [];
    let size = 0;
    const target = Math.min(chars - length, from.int(180, 420));
    while (size < target) {
      const line = sentence(from);
      lines.push(line);
      size += line.length + 1;
    }
    paragraphs.push(lines.join(' '));
    length += size + 2;
  }
  return paragraphs.join('\n\n');
}

function code(from: Source): string {
  const lines = Array.from(
    { length: from.int(6, 18) },
    (_, line) => `  const ${from.pick(WORDS)}${line} = ${from.pick(WORDS)}(${from.int(1, 900)});`,
  );
  return [
    '```ts',
    `export function ${from.pick(WORDS)}Step() {`,
    ...lines,
    '  return true;',
    '}',
    '```',
  ].join('\n');
}

function table(from: Source): string {
  const rows = Array.from(
    { length: from.int(3, 6) },
    () => `| \`${from.pick(PATHS)}\` | ${from.int(1, 400)} | ${sentence(from, 4)} |`,
  );
  return ['| File | Lines | Note |', '| --- | --- | --- |', ...rows].join('\n');
}

/** A reply's prose, as markdown: every third one carries a code block, every fifth a table. */
function markdown(from: Source, turn: number, chars: number): string {
  const list = Array.from(
    { length: from.int(2, 5) },
    () => `- **${from.pick(WORDS)}**: ${sentence(from, 6)} See \`${from.pick(PATHS)}\`.`,
  );
  const blocks = [prose(from, chars), list.join('\n')];
  if (turn % 3 === 0) {
    blocks.push(code(from));
  }
  if (turn % 5 === 0) {
    blocks.push(table(from));
  }
  return blocks.join('\n\n');
}

function output(from: Source, chars: number): string {
  const lines: string[] = [];
  let length = 0;
  while (length < chars) {
    const line = `${from.pick(PATHS)}:${from.int(1, 900)}: ${sentence(from, 7)}`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n');
}

type Call = { name: string; args: Record<string, unknown>; output: string; extra?: Part };

/** One tool call, drawn from the mix a working session runs: mostly the shell and its tasks. */
function draw(from: Source, serial: number): Call {
  const roll = from.next();
  const chars = OUTPUT_CHARS[serial % OUTPUT_CHARS.length];
  const intent = sentence(from, 8);
  const path = from.pick(PATHS);
  if (roll < 0.6) {
    return {
      name: 'bash_tool',
      args: {
        intent,
        command: Array.from(
          { length: from.int(1, 6) },
          () => `${from.pick(COMMANDS)} ${from.pick(PATHS)}`,
        ).join(' && '),
        cwd: '/workspace/app',
        timeoutMs: 70000,
      },
      output: output(from, chars),
      extra: { executor: 'attached_workspace' },
    };
  }
  if (roll < 0.8) {
    const id = `task-${serial}`;
    return {
      name: 'check_background_task',
      args: { background_task_id: id },
      output: JSON.stringify({
        background_task_id: id,
        tool: 'bash_tool',
        status: 'completed',
        progress: 1,
        started_at: new Date(EPOCH + serial * 1000).toISOString(),
        settled_at: new Date(EPOCH + serial * 1000 + 76_000).toISOString(),
        elapsed_ms: 76_000,
        result: output(from, Math.min(chars, 1200)),
      }),
    };
  }
  if (roll < 0.87) {
    return {
      name: 'edit_file',
      args: {
        intent,
        path,
        edits: Array.from({ length: from.int(1, 3) }, () => ({
          old_text: prose(from, 300),
          new_text: prose(from, 260),
        })),
      },
      output: `Edited ${path}`,
    };
  }
  if (roll < 0.915) {
    return {
      name: 'subagent',
      args: {
        intent,
        subagent_type: 'self',
        run_in_background: true,
        description: prose(from, 1600),
      },
      output: JSON.stringify({
        background_task_id: `task-${serial}`,
        tool: 'subagent',
        subagent_type: 'self',
        status: 'running',
        message: sentence(from, 20),
      }),
    };
  }
  if (roll < 0.95) {
    return { name: 'read_file', args: { intent, path }, output: output(from, chars) };
  }
  if (roll < 0.975) {
    return {
      name: 'run_select_query_mcp_clickhouse',
      args: { serviceId: 'e2e-service', query: `SELECT ${from.pick(WORDS)} FROM events LIMIT 10` },
      output: JSON.stringify({
        result: {
          meta: [{ name: 'name', type: 'String' }],
          data: Array.from({ length: 6 }, () => ({ name: sentence(from, 5) })),
          rows: 6,
        },
      }),
    };
  }
  if (roll < 0.9875) {
    return {
      name: 'create_file',
      args: { intent, path, content: prose(from, 4000) },
      output: `Created ${path}`,
    };
  }
  return {
    name: 'skill',
    args: { intent, skillName: 'release' },
    output: 'Loaded the release skill.',
  };
}

/**
 * A reply of about `size` parts, in the order a run streams them: reasoning, batches of tool
 * calls each closed by its label, prose, and the phase that folds what came before it. Later
 * phases of a long reply run their calls unlabeled, as a run pressed for time does.
 */
function reply(from: Source, turn: number, size: number): Part[] {
  const parts: Part[] = [];
  let serial = 0;
  const text = (chars: number): Part => ({ type: 'text', text: markdown(from, turn, chars) });
  const think = (): Part => ({ type: 'think', think: prose(from, from.int(300, 900)) });
  const call = (): string => {
    serial += 1;
    const id = `call_${turn}_${serial}`;
    const drawn = draw(from, turn * 7 + serial);
    const prepared = from.int(20, 600);
    const executed = from.int(8, 9000);
    parts.push({
      type: 'tool_call',
      tool_call: {
        id,
        name: drawn.name,
        args: JSON.stringify(drawn.args),
        type: 'tool_call',
        progress: 1,
        output: drawn.output,
        stepId: `step_${turn}_${serial}`,
        toolPreparationDurationMs: prepared,
        toolExecutionDurationMs: executed,
        runStepStatus: 'completed',
        runStepClosedAt: EPOCH + turn * 60_000 + serial * 1000,
        runStepDurationMs: prepared + executed,
        ...drawn.extra,
      },
    });
    return id;
  };

  if (size === 1) {
    return [text(600)];
  }
  if (size === 2) {
    return [think(), text(900)];
  }
  let phases = 0;
  while (parts.length < size - 2) {
    const start = parts.length;
    const labeled = phases < 2;
    const budget = Math.min(size - 2 - start, from.int(6, 60));
    let calls = 0;
    if (from.next() < 0.5) {
      parts.push(think());
    }
    while (parts.length - start < budget) {
      const ids = Array.from({ length: labeled ? from.int(1, 4) : from.int(4, 12) }, call);
      calls += ids.length;
      if (labeled) {
        parts.push({
          type: 'activity_label',
          activity_label: sentence(from, 7),
          tool_call_ids: ids,
          status: from.next() < 0.9 ? 'ok' : 'partial',
          pending: false,
        });
      }
      if (from.next() < 0.2) {
        parts.push(think());
      }
    }
    const end = parts.length;
    parts.push(text(from.int(200, 900)));
    parts.push({
      type: 'activity_label',
      activity_label: '',
      activity_label_type: 'phase',
      activity_start_index: start,
      activity_end_index: end,
      activity_count: calls,
      status: 'ok',
      pending: false,
    });
    phases += 1;
  }
  return parts;
}

/**
 * The thread's messages, oldest first: `rows` of them, user and reply alternating. The same
 * `rows` and `seed` always give the same content; only the message ids differ, so that two
 * threads can be seeded side by side.
 */
export function buildThread(rows: number, seed = 1): SeedMessage[] {
  const from = source(seed);
  let parentMessageId = NO_PARENT;
  return Array.from({ length: rows }, (_, index) => {
    const messageId = randomUUID();
    const isCreatedByUser = index % 2 === 0;
    const turn = Math.floor(index / 2);
    const message: SeedMessage = isCreatedByUser
      ? {
          messageId,
          parentMessageId,
          isCreatedByUser,
          sender: 'User',
          text: `Request ${turn + 1}. ${prose(from, USER_CHARS[turn % USER_CHARS.length])}`,
        }
      : {
          messageId,
          parentMessageId,
          isCreatedByUser,
          sender: ENDPOINT.label,
          text: '',
          content: [
            ...reply(from, turn, REPLY_PARTS[turn % REPLY_PARTS.length]),
            { type: 'text', text: `Reply ${turn + 1} done.` },
          ],
          metadata: {
            usage: {
              input: from.int(2_000, 40_000),
              output: from.int(200, 9_000),
              cacheWrite: from.int(0, 90_000),
              cacheRead: from.int(0, 900_000),
              cost: from.int(1, 900) / 100,
            },
          },
        };
    parentMessageId = messageId;
    return message;
  });
}

/**
 * Seeds the thread as a conversation of the e2e user's, on the mock provider, so a reply can be
 * sent into it as it stands: choosing a model first would change the conversation every row
 * reads, and the counts taken from the send with it.
 */
export async function seedThread(
  rows: number,
  title = `Synthetic thread, ${rows} rows`,
): Promise<Thread> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  const messages = buildThread(rows);
  await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email });
    if (!user) {
      throw new Error(`E2E seed: user "${email}" not found`);
    }
    const owner = {
      conversationId,
      user: user._id.toString(),
      endpoint: ENDPOINT.label,
      model: ENDPOINT.model,
      __v: 0,
    };
    const updatedAt = new Date();
    await db.collection('conversations').insertOne({
      ...owner,
      title,
      endpointType: 'custom',
      /** What a first turn on this provider saves: without it the next reply is the one that
       *  sets it, and every row renders again for the conversation it now reads. */
      agent_id: `${ENDPOINT.label}__${ENDPOINT.model}___${ENDPOINT.label}`,
      isArchived: false,
      createdAt: updatedAt,
      updatedAt,
    });
    await db.collection('messages').insertMany(
      messages.map((message, index) => {
        const createdAt = new Date(EPOCH + index * 60_000);
        return {
          ...message,
          ...owner,
          error: false,
          unfinished: false,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );
  });
  return { conversationId, title, rows, messages };
}

export async function removeThread(thread: Thread): Promise<void> {
  await deleteMessagesByConversation([thread.conversationId]);
  await deleteConversations([thread.conversationId]);
}
