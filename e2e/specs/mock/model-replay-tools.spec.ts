import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import {
  assertFixtureConsumed,
  fixtureTurns,
  readReplayLedger,
  removeFixture,
} from './replay.helpers';
import {
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from './helpers';

/**
 * The tool-call half of the replay lane: one recorded turn in which the real
 * provider calls an MCP tool, the tool runs for real, and the model is invoked
 * a second time with its result.
 *
 * This is the shape a single prompt cannot express — one user turn spanning
 * several model invocations — so it is what proves the fixture format carries
 * `tool_call_chunks` and that replay advances through a turn's invocations
 * rather than binding once per prompt.
 *
 * Record (needs a real provider key):
 *   E2E_MODEL_FIXTURES=record E2E_MODEL_FIXTURE_NAME=deepseek-tool-call \
 *   E2E_RECORD_PROVIDER_API_KEY=<key> \
 *   npx playwright test --config=e2e/playwright.config.mock.ts model-replay-tools
 *
 * Replay (default, keyless): the same drive steps against the committed
 * fixture, with the recorded tool call streamed back through the real graph so
 * the tool executes again.
 */
const COMMITTED_FIXTURE = 'deepseek-tool-call';
const RECORDING = process.env.E2E_MODEL_FIXTURES === 'record';
const RECORDING_THIS_FIXTURE =
  RECORDING && process.env.E2E_MODEL_FIXTURE_NAME === COMMITTED_FIXTURE;
const FIXTURE = COMMITTED_FIXTURE;
const RECORD_ENDPOINT = {
  label: 'Replay Record Provider',
  model: process.env.E2E_RECORD_PROVIDER_MODEL || 'deepseek-chat',
};

const MCP_SERVER_TITLE = 'E2E Memory';
const TOOL_NAME = 'remember_fact';
/** MCP tools reach the model under a server-qualified name
 *  (`remember_fact_mcp_e2e-memory`), and that qualification has changed before,
 *  so assertions match the base name as a prefix rather than pinning the suffix. */
const namesTool = (names: string[]) => names.some((name) => name.startsWith(TOOL_NAME));
/** The MCP fixture echoes this back, so the tool result is deterministic. */
const FACT = 'the replay lane records tool calls';
const TOOL_PROMPT =
  `Call the ${TOOL_NAME} tool with fact set to "${FACT}", then reply with exactly the ` +
  'text the tool returned and nothing else.';

/** Enable the ephemeral MCP server whose tools this turn calls. */
async function selectEphemeralMCP(page: Page) {
  await page.getByRole('button', { name: 'MCP Servers', exact: true }).click();
  const serverItem = page.getByRole('menuitemcheckbox', { name: new RegExp(MCP_SERVER_TITLE) });
  await expect(serverItem).toBeVisible();
  await serverItem.click();
  await expect(serverItem).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: new RegExp(MCP_SERVER_TITLE) })).toBeVisible();
}

test.describe('recorded tool-call fixture replay', () => {
  test('a recorded tool call replays through the real tool node', async ({ page }) => {
    test.skip(
      RECORDING && !RECORDING_THIS_FIXTURE,
      `recording ${process.env.E2E_MODEL_FIXTURE_NAME}`,
    );
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    if (RECORDING) {
      removeFixture(FIXTURE);
      await selectMockEndpoint(page, RECORD_ENDPOINT);
    }
    await selectEphemeralMCP(page);

    await sendMessageAndWaitForCompletion(page, TOOL_PROMPT, { timeout: 120_000 });

    const conversationId = /\/c\/([^/]+)/.exec(new URL(page.url()).pathname)?.[1];
    expect(conversationId, 'conversation should have a persisted id').toBeTruthy();
    const token = await getAccessToken(page);
    const messages = await fetchJson<TMessage[]>(
      page,
      `/api/messages/${encodeURIComponent(conversationId as string)}`,
      token,
    );
    const assistant = messages.filter((message) => message.isCreatedByUser === false);
    expect(assistant).toHaveLength(1);
    /** The turn's durable proof that the tool ran: a persisted tool_call part
     *  naming the tool, independent of whatever prose the model wrapped it in. */
    const toolCallParts = (assistant[0].content ?? []).filter((part) => part?.type === 'tool_call');
    expect(toolCallParts.length, 'the turn should persist a tool call').toBeGreaterThan(0);
    expect(JSON.stringify(toolCallParts)).toContain(TOOL_NAME);

    if (RECORDING) {
      await expect
        .poll(
          () => {
            try {
              const settled = fixtureTurns(FIXTURE);
              return settled.length >= 2 && settled.every((turn) => turn.userText === TOOL_PROMPT);
            } catch {
              return false;
            }
          },
          {
            timeout: 15_000,
            intervals: [250, 500, 1_000],
            message: 'recording should settle with several invocations under one prompt',
          },
        )
        .toBe(true);
      const recorded = fixtureTurns(FIXTURE);
      expect(
        recorded.map((turn) => turn.userText),
        'every invocation of this turn shares its one user prompt',
      ).toEqual(recorded.map(() => TOOL_PROMPT));
      expect(
        recorded[0].toolCallChunkCount,
        'the first invocation should stream the tool call',
      ).toBeGreaterThan(0);
      expect(
        namesTool(recorded[0].toolNames),
        `the streamed tool call should name ${TOOL_NAME}, got ${JSON.stringify(recorded[0].toolNames)}`,
      ).toBe(true);
      expect(
        recorded[recorded.length - 1].contentChunkCount,
        'the post-tool invocation should stream the answer',
      ).toBeGreaterThan(0);
    } else {
      const turns = fixtureTurns(FIXTURE);
      expect(
        turns.length,
        'the fixture should hold more than one invocation for this single turn',
      ).toBeGreaterThan(1);
      expect(
        namesTool(turns[0].toolNames),
        `the recorded tool call should name ${TOOL_NAME}, got ${JSON.stringify(turns[0].toolNames)}`,
      ).toBe(true);

      /** Replay drives the real tool node, so the tool ran again in this run
       *  rather than being replayed as recorded output. */
      const toolResult = JSON.stringify(assistant[0].content ?? []);
      expect(toolResult, 'the replayed tool call should carry its real result').toContain(FACT);

      const ledger = readReplayLedger(FIXTURE);
      expect(
        ledger.invocationsConsumed,
        'replay should advance through every invocation of the turn',
      ).toBe(ledger.invocationsTotal);
      assertFixtureConsumed(FIXTURE);
    }

    expect(pageErrors, `Unexpected runtime errors: ${pageErrors.join(', ')}`).toHaveLength(0);
  });
});
