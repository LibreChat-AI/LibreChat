import fs from 'fs';
import path from 'path';

/**
 * Spec-side readers for the model-fixture replay lane. The server-side
 * recorder/replayer (`e2e/setup/model-replay.js`) owns the formats; these
 * readers stay dependency-free on that CJS module so the spec plane needs no
 * runtime import of server code.
 */
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/model-replay');
const LEDGER_DIR = path.resolve(__dirname, '../.test-results/model-replay');

export type FixtureTurn = {
  userText: string;
  finalText: string;
  chunkCount: number;
  /**
   * Chunks carrying assistant text, as distinct from the empty
   * initialization and usage-metadata chunks a provider also emits. Only
   * these prove incremental content streaming — a total chunk count above one
   * is satisfied by a single content delta wrapped in empty frames.
   */
  contentChunkCount: number;
  /** Chunks carrying `tool_call_chunks`, i.e. the streamed tool invocation. */
  toolCallChunkCount: number;
  /** Tool names streamed by this invocation, in order of first appearance. */
  toolNames: string[];
};

export type ReplayLedger = {
  fixture: string;
  invocationsTotal: number;
  chunksTotal: number;
  invocationsConsumed: number;
  chunksConsumed: number;
  overruns: Array<{ at: string; userText: string }>;
  promptMismatches: Array<{ invocation: number; expected: string; received: string }>;
};

export function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, `${name}.jsonl`);
}

/**
 * Remove a fixture before a recording run so its assertions cannot be
 * satisfied by a pre-existing artifact. Without this, a run whose hook failed
 * to install the recorder would still see the live provider answer these
 * deterministic prompts while the poll read the stale file — matching answers,
 * valid chunk counts, and a green run that wrote nothing.
 */
export function removeFixture(name: string): void {
  fs.rmSync(fixturePath(name), { force: true });
}

/**
 * Parse a fixture's invocations in recorded order. An invocation's final text
 * is the concatenation of its recorded chunk texts — the chunks are written
 * synchronously during the stream, while the provider's `handleLLMEnd`
 * dispatch (the `end` line) can land after the durable-completion barrier a
 * spec waits on, so nothing here depends on it.
 */
export function fixtureTurns(name: string): FixtureTurn[] {
  const lines = fs
    .readFileSync(fixturePath(name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const turns: FixtureTurn[] = [];
  for (const entry of lines) {
    if (entry.type === 'invocation') {
      turns[entry.index as number] = {
        userText: entry.userText as string,
        finalText: '',
        chunkCount: 0,
        contentChunkCount: 0,
        toolCallChunkCount: 0,
        toolNames: [],
      };
    } else if (entry.type === 'chunk') {
      const turn = turns[entry.invocation as number];
      if (turn) {
        const text = (entry.text as string) ?? '';
        turn.chunkCount += 1;
        turn.finalText += text;
        if (text !== '') {
          turn.contentChunkCount += 1;
        }
        const message = entry.message as
          | { tool_call_chunks?: Array<{ name?: string }> }
          | undefined;
        const toolCallChunks = message?.tool_call_chunks ?? [];
        if (toolCallChunks.length > 0) {
          turn.toolCallChunkCount += 1;
          for (const call of toolCallChunks) {
            if (call.name && !turn.toolNames.includes(call.name)) {
              turn.toolNames.push(call.name);
            }
          }
        }
      }
    } else if (entry.type === 'error') {
      throw new Error(`Fixture ${name} recorded a provider error: ${String(entry.message)}`);
    }
  }
  return turns;
}

export function readReplayLedger(name: string): ReplayLedger {
  const ledgerPath = path.join(LEDGER_DIR, `${name}.json`);
  if (!fs.existsSync(ledgerPath)) {
    throw new Error(
      `Replay ledger missing for fixture "${name}" (${ledgerPath}); ` +
        'the conversation never bound to the fixture',
    );
  }
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as ReplayLedger;
}

/**
 * The teardown consumption check: every recorded invocation and chunk was
 * drained, nothing was invoked past the script, and every prompt matched its
 * recording. Converts silent underruns and shifted bindings into crisp
 * diagnostics.
 */
export function assertFixtureConsumed(name: string): void {
  const ledger = readReplayLedger(name);
  const failures: string[] = [];
  if (ledger.invocationsConsumed !== ledger.invocationsTotal) {
    failures.push(
      `under-consumed: ${ledger.invocationsConsumed}/${ledger.invocationsTotal} invocations`,
    );
  }
  if (ledger.chunksConsumed !== ledger.chunksTotal) {
    failures.push(`under-streamed: ${ledger.chunksConsumed}/${ledger.chunksTotal} chunks`);
  }
  if (ledger.overruns.length > 0) {
    failures.push(`over-consumed ${ledger.overruns.length}x: ${JSON.stringify(ledger.overruns)}`);
  }
  if (ledger.promptMismatches.length > 0) {
    failures.push(`prompt mismatches: ${JSON.stringify(ledger.promptMismatches)}`);
  }
  if (failures.length > 0) {
    throw new Error(`Fixture "${name}" consumption check failed — ${failures.join('; ')}`);
  }
}
