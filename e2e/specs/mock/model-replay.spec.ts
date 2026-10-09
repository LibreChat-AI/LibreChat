import { expect, test } from '@playwright/test';
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
  messagesView,
  getAccessToken,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from './helpers';

/**
 * Record-once/replay-forever coverage: one recorded real-provider conversation
 * replays keylessly through the real createRun → registered replay provider →
 * graph → SSE → persistence chain.
 *
 * Record (writes the fixture; needs a real provider key):
 *   E2E_MODEL_FIXTURES=record E2E_MODEL_FIXTURE_NAME=deepseek-two-turn \
 *   E2E_RECORD_PROVIDER_API_KEY=<key> \
 *   npx playwright test --config=e2e/playwright.config.mock.ts model-replay
 *
 * Replay (default, keyless): the same drive steps; the conversation binds to
 * the committed fixture by prompt text, assistant turns must equal the
 * recorded turns exactly, and the consumption ledger must drain completely.
 */
const COMMITTED_FIXTURE = 'deepseek-two-turn';
const RECORDING = process.env.E2E_MODEL_FIXTURES === 'record';
/**
 * Record mode collects every replay spec, so each one records only the fixture
 * it owns and stands down for the others. A spec must never write a fixture
 * other than its own: two fixtures carrying the same prompts would make the
 * server-side binding ambiguous and refuse both.
 */
const RECORDING_THIS_FIXTURE =
  RECORDING && process.env.E2E_MODEL_FIXTURE_NAME === COMMITTED_FIXTURE;
const FIXTURE = COMMITTED_FIXTURE;
const RECORD_ENDPOINT = {
  label: 'Replay Record Provider',
  model: process.env.E2E_RECORD_PROVIDER_MODEL || 'deepseek-chat',
};

/**
 * The closing prompt deliberately asks for prose: a one-token answer streams
 * as a single content delta wrapped in empty initialization and usage frames,
 * which cannot demonstrate incremental content streaming however many chunks
 * the provider emits around it.
 */
const TURN_PROMPTS = [
  'Name the two prime numbers between 20 and 30, comma separated, and nothing else.',
  'In two short sentences, explain why the sum of those two primes is an even number. Begin with the word "Because".',
];

test.describe('recorded model fixture replay', () => {
  test('a recorded conversation replays deterministically through the real pipeline', async ({
    page,
  }) => {
    test.skip(
      RECORDING && !RECORDING_THIS_FIXTURE,
      `recording ${process.env.E2E_MODEL_FIXTURE_NAME}`,
    );
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    if (RECORDING) {
      /** Proof of a fresh write: the assertions below cannot be satisfied by a
       * pre-existing fixture, so a run whose recorder never installed fails
       * instead of greening against a stale artifact. */
      removeFixture(FIXTURE);
      await selectMockEndpoint(page, RECORD_ENDPOINT);
    }

    for (const prompt of TURN_PROMPTS) {
      await sendMessageAndWaitForCompletion(page, prompt, { timeout: 90_000 });
    }

    const conversationId = /\/c\/([^/]+)/.exec(page.url())?.[1];
    expect(conversationId, 'conversation should have a persisted id').toBeTruthy();
    const token = await getAccessToken(page);
    const messages = await fetchJson<TMessage[]>(
      page,
      `/api/messages/${encodeURIComponent(conversationId as string)}`,
      token,
    );
    /** Agents-pipeline messages persist their text inside `content` parts;
     * top-level `text` stays empty. */
    const persistedText = (message: TMessage): string => {
      if (message.text) {
        return message.text;
      }
      return (message.content ?? [])
        .map((part) => {
          if (part?.type !== 'text') {
            return '';
          }
          const text = (part as { text?: string | { value?: string } }).text;
          return typeof text === 'string' ? text : (text?.value ?? '');
        })
        .join('');
    };
    const assistantTexts = messages
      .filter((message) => message.isCreatedByUser === false)
      .map(persistedText);
    expect(assistantTexts).toHaveLength(TURN_PROMPTS.length);

    if (RECORDING) {
      /** The recorder rides LangChain token callbacks, which the provider
       * stream dispatches without awaiting — the recording quiesces shortly
       * AFTER the durable-completion barrier, so the record-mode harvest
       * polls for the settled fixture instead of asserting a single read.
       * Replay mode needs no such poll: the replaying generator finishes its
       * ledger writes before the turn can persist. */
      await expect
        .poll(
          () => {
            try {
              const settled = fixtureTurns(FIXTURE);
              return (
                settled.length === TURN_PROMPTS.length &&
                settled.every(
                  (turn, index) =>
                    turn.userText === TURN_PROMPTS[index] &&
                    turn.finalText === assistantTexts[index],
                )
              );
            } catch {
              return false;
            }
          },
          {
            timeout: 15_000,
            intervals: [250, 500, 1_000],
            message: 'recorded fixture should quiesce with the persisted assistant turns',
          },
        )
        .toBe(true);
      const recorded = fixtureTurns(FIXTURE);
      for (const turn of recorded) {
        expect(turn.contentChunkCount, 'each turn should record assistant content').toBeGreaterThan(
          0,
        );
      }
      expect(
        recorded[recorded.length - 1].contentChunkCount,
        'the prose turn should record several content deltas, not one delta padded with empty frames',
      ).toBeGreaterThan(1);
    } else {
      const turns = fixtureTurns(FIXTURE);
      expect(
        turns.map((turn) => turn.userText),
        'fixture invocations should mirror the driven prompts',
      ).toEqual(TURN_PROMPTS);
      expect(assistantTexts, 'replayed assistant turns should equal the recording exactly').toEqual(
        turns.map((turn) => turn.finalText),
      );
      /** Compare against rendered markdown, not the raw recording: a reply
       * opening with `52.` is rendered as an ordered-list marker and never
       * appears in the DOM text, so a leading enumerator is stripped before
       * matching and only a prose prefix is used. */
      const renderedPrefix = turns[turns.length - 1].finalText
        .replace(/^\s*\d+[.)]\s*/, '')
        .trim()
        .slice(0, 30);
      expect(
        renderedPrefix.length,
        'the prose turn should yield a comparable prefix',
      ).toBeGreaterThan(15);
      await expect(messagesView(page)).toContainText(renderedPrefix);

      /** Streaming incrementality is asserted from the ledger's drained chunk
       * count, not by sampling transient DOM — every recorded chunk passed
       * through the live SSE wire before the durable completion barrier. */
      const ledger = readReplayLedger(FIXTURE);
      expect(ledger.chunksConsumed).toBe(ledger.chunksTotal);
      expect(
        turns[turns.length - 1].contentChunkCount,
        'replay should stream several content deltas for the prose turn',
      ).toBeGreaterThan(1);
      assertFixtureConsumed(FIXTURE);
    }

    expect(pageErrors, `Unexpected runtime errors: ${pageErrors.join(', ')}`).toHaveLength(0);
  });
});
