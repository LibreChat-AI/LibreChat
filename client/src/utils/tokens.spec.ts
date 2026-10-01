import { Constants, Providers } from 'librechat-data-provider';
import type { TMessage, TResponseUsage } from 'librechat-data-provider';
import {
  buildIndex,
  upsertEntries,
  migrateIndex,
  clearIndex,
  hasIndex,
  sumBranch,
  mergeUsage,
  setEntryUsage,
  sumTotalUsage,
  prunedBranchTokens,
  collectAnchorSeries,
  latestExchangeTokens,
  findBranchSnapshotAnchor,
  estimateTokens,
  normalizeUsageUnits,
  formatTokens,
  formatCost,
  groupToolTokens,
  countTrailingOutputChars,
  EMPTY_BRANCH,
  EMPTY_USAGE,
  EMPTY_TOOL_GROUPS,
} from './tokens';

const CONVO = 'convo-1';

function msg(
  messageId: string,
  parentMessageId: string | null,
  isCreatedByUser: boolean,
  tokenCount?: number,
): TMessage {
  return {
    messageId,
    parentMessageId,
    isCreatedByUser,
    tokenCount,
    conversationId: CONVO,
    text: '',
  } as TMessage;
}

/** Response message carrying a persisted `metadata.usage` rollup (the backend
 *  persists already-normalized display units). */
function responseMsg(
  messageId: string,
  parentMessageId: string | null,
  tokenCount: number,
  usage: TResponseUsage,
): TMessage {
  return {
    messageId,
    parentMessageId,
    isCreatedByUser: false,
    tokenCount,
    conversationId: CONVO,
    text: '',
    metadata: { usage },
  } as TMessage;
}

const USAGE_A: TResponseUsage = { input: 100, output: 50, cacheWrite: 0, cacheRead: 0, cost: 0.01 };
const USAGE_B: TResponseUsage = { input: 200, output: 80, cacheWrite: 0, cacheRead: 0, cost: 0.02 };

describe('token index', () => {
  afterEach(() => {
    clearIndex(CONVO);
    clearIndex('convo-2');
    clearIndex(Constants.NEW_CONVO);
  });

  it('sums only the active branch via the parent chain', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      msg('a1', 'u1', false, 20),
      msg('u2', 'a1', true, 30),
      msg('a2', 'u2', false, 40),
      /** Sibling branch that must not be counted */
      msg('a2-alt', 'u2', false, 999),
    ]);

    const totals = sumBranch(CONVO, 'a2');
    expect(totals.input).toBe(40);
    expect(totals.output).toBe(60);
    expect(totals.total).toBe(4);
    expect(totals.counted).toBe(4);

    const altTotals = sumBranch(CONVO, 'a2-alt');
    expect(altTotals.output).toBe(1019);
  });

  it('estimates count-less messages by text length without inflating counted totals', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 12),
      /** Imported message with no `tokenCount`: 40 chars of text → ~10 est tokens. */
      {
        messageId: 'a1',
        parentMessageId: 'u1',
        isCreatedByUser: false,
        conversationId: CONVO,
        text: 'x'.repeat(40),
      } as TMessage,
    ]);

    const totals = sumBranch(CONVO, 'a1');
    /** Known counts feed input/output/counted; the count-less message stays out
     *  of those and lands in the separate (uncalibrated) estimate bucket. */
    expect(totals.input).toBe(12);
    expect(totals.output).toBe(0);
    expect(totals.counted).toBe(1);
    expect(totals.total).toBe(2);
    expect(totals.estTokens).toBe(10);
  });

  it('estimates object-form content text and merged quote excerpts', () => {
    buildIndex(CONVO, [
      /** Assistant body lives only in object-form content (`text.value`). */
      {
        messageId: 'a1',
        parentMessageId: Constants.NO_PARENT,
        isCreatedByUser: false,
        conversationId: CONVO,
        content: [{ type: 'text', text: { value: 'y'.repeat(20) } }],
      } as unknown as TMessage,
      /** User turn whose quotes are merged into the prompt at send time. */
      {
        messageId: 'u1',
        parentMessageId: 'a1',
        isCreatedByUser: true,
        conversationId: CONVO,
        text: 'z'.repeat(16),
        quotes: ['q'.repeat(8)],
      } as TMessage,
    ]);

    /** a1: 20 content chars / 4 = 5; u1: (16 text + 8 quote) / 4 = 6. */
    const totals = sumBranch(CONVO, 'u1');
    expect(totals.counted).toBe(0);
    expect(totals.estTokens).toBe(11);
  });

  it('recounts quoted user turns (ignoring stale counts), counts tool calls, skips reasoning', () => {
    buildIndex(CONVO, [
      /** Quoted user turn with a stale text-only stored count: the send path
       *  recounts the merged prompt every turn, so the estimate ignores the count
       *  and recounts from text+quotes. */
      {
        messageId: 'u1',
        parentMessageId: Constants.NO_PARENT,
        isCreatedByUser: true,
        conversationId: CONVO,
        tokenCount: 999,
        text: 'hi',
        quotes: ['q'.repeat(38)],
      } as TMessage,
      /** Count-less assistant turn: tool-call name/args/output count toward the
       *  estimate (sent back as context); reasoning does not. */
      {
        messageId: 'a1',
        parentMessageId: 'u1',
        isCreatedByUser: false,
        conversationId: CONVO,
        content: [
          { type: 'think', think: 'r'.repeat(40) },
          { type: 'tool_call', tool_call: { name: 'sub', args: 'aa', output: 'o'.repeat(11) } },
        ],
      } as unknown as TMessage,
    ]);

    const totals = sumBranch(CONVO, 'a1');
    /** u1 quoted: stored 999 ignored; (2 text + 38 quote) / 4 = 10. a1 tool_call
     *  name 3 + args 2 + output 11 = 16 / 4 = 4 (think skipped). */
    expect(totals.input).toBe(0);
    expect(totals.counted).toBe(0);
    expect(totals.estTokens).toBe(14);
  });

  it('prefers content over text for count-less messages carrying both', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 8),
      /** Stopped agent response: saved with both a short `text` and structured
       *  `content` (a tool call). The send path formats from content, so the
       *  estimate must use content (tool tokens), not the shorter text. */
      {
        messageId: 'a1',
        parentMessageId: 'u1',
        isCreatedByUser: false,
        conversationId: CONVO,
        text: 'hi',
        content: [
          { type: 'tool_call', tool_call: { name: 'run', args: 'aa', output: 'o'.repeat(13) } },
        ],
      } as unknown as TMessage,
    ]);

    const totals = sumBranch(CONVO, 'a1');
    /** a1 uses content (name 3 + args 2 + output 13 = 18 / 4 = 5), not text 'hi'. */
    expect(totals.input).toBe(8);
    expect(totals.estTokens).toBe(5);
  });

  it('exposes the count-less tail estimate so live output is not double-counted', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 12),
      /** In-flight / resumed response: count-less, so it lands in estTokens; it is
       *  also covered by liveTokens, so the estimate path drops tailEstTokens. */
      {
        messageId: 'a1',
        parentMessageId: 'u1',
        isCreatedByUser: false,
        conversationId: CONVO,
        text: 'o'.repeat(20),
      } as TMessage,
    ]);

    const totals = sumBranch(CONVO, 'a1');
    /** a1 is the tail: 20 / 4 = 5, surfaced both in estTokens and tailEstTokens. */
    expect(totals.estTokens).toBe(5);
    expect(totals.tailEstTokens).toBe(5);
  });

  it('splits the tool-call share out of counted and count-less messages', () => {
    buildIndex(CONVO, [
      /** Counted assistant turn: text 80 + tool payload (3+2+38=43 chars).
       *  Tool share 43/4 = 11, clamped to the entry's 30-token count → 11. */
      {
        messageId: 'a1',
        parentMessageId: Constants.NO_PARENT,
        isCreatedByUser: false,
        conversationId: CONVO,
        tokenCount: 30,
        content: [
          { type: 'text', text: 't'.repeat(80) },
          { type: 'tool_call', tool_call: { name: 'run', args: 'aa', output: 'o'.repeat(38) } },
        ],
      } as unknown as TMessage,
      /** Counted user turn with no tool parts: contributes nothing. */
      msg('u1', 'a1', true, 12),
      /** Count-less assistant turn: tool chars 3+2+7=12 → 3 (≤ its est 8). */
      {
        messageId: 'a2',
        parentMessageId: 'u1',
        isCreatedByUser: false,
        conversationId: CONVO,
        text: 'z'.repeat(20),
        content: [
          { type: 'tool_call', tool_call: { name: 'sub', args: 'aa', output: 'o'.repeat(7) } },
        ],
      } as unknown as TMessage,
    ]);

    const totals = sumBranch(CONVO, 'a2');
    expect(totals.estToolTokens).toBe(14);
    /** a2 is the tail */
    expect(totals.tailEstToolTokens).toBe(3);
  });

  it('keeps a counted tail out of both tail estimates', () => {
    /** A resumed partial response that already carries a `tokenCount` stays in
     *  `output`, so the estimate path may drop neither its estimate nor its tool
     *  share — dropping the share alone left the message total holding tokens
     *  whose tool traffic had been removed from the split. */
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 12),
      {
        messageId: 'a1',
        parentMessageId: 'u1',
        isCreatedByUser: false,
        conversationId: CONVO,
        tokenCount: 40,
        content: [
          { type: 'text', text: 't'.repeat(60) },
          { type: 'tool_call', tool_call: { name: 'run', args: 'aa', output: 'o'.repeat(38) } },
        ],
      } as unknown as TMessage,
    ]);

    const totals = sumBranch(CONVO, 'a1');
    expect(totals.output).toBe(40);
    expect(totals.estToolTokens).toBe(11);
    expect(totals.tailEstTokens).toBe(0);
    expect(totals.tailEstToolTokens).toBe(0);
  });

  describe('prunedBranchTokens (over-window mirror of getMessagesWithinTokenLimit)', () => {
    /** u1 ← a1(huge, old) ← u2 ← a2(tail). */
    const buildChain = () =>
      buildIndex(CONVO, [
        msg('u1', Constants.NO_PARENT, true, 2),
        msg('a1', 'u1', false, 10),
        msg('u2', 'a1', true, 2),
        msg('a2', 'u2', false, 2),
      ]);

    it('keeps the newest messages that fit and stops at the first overflow', () => {
      buildChain();
      /** Budget 8: a2(2)+u2(2)=4 fit; a1(10) would overflow → pruned. */
      expect(prunedBranchTokens(CONVO, 'a2', 8, false)).toEqual({ tokens: 4, toolTokens: 0 });
    });

    it('returns the full branch sum when it fits the budget', () => {
      buildChain();
      expect(prunedBranchTokens(CONVO, 'a2', 100, false)).toEqual({
        tokens: 16,
        toolTokens: 0,
      });
    });

    it('skips the in-flight tail when excludeTail is set', () => {
      buildChain();
      /** Skip a2; a1(10)+u2(2)+u1(2)=14 all fit under 100. */
      expect(prunedBranchTokens(CONVO, 'a2', 100, true)).toEqual({
        tokens: 14,
        toolTokens: 0,
      });
    });

    it('returns the tool-call share of the kept messages', () => {
      /** u1(counted, 4) ← a2(tail): content-only estimate 11/4 = 3, tool chars
       *  3+2+6=11 → 3. Kept total 7, tool share 3. */
      buildIndex(CONVO, [
        msg('u1', Constants.NO_PARENT, true, 4),
        {
          messageId: 'a2',
          parentMessageId: 'u1',
          isCreatedByUser: false,
          conversationId: CONVO,
          text: 'z'.repeat(4),
          content: [
            { type: 'tool_call', tool_call: { name: 'sub', args: 'aa', output: 'o'.repeat(6) } },
          ],
        } as unknown as TMessage,
      ]);

      expect(prunedBranchTokens(CONVO, 'a2', 100, false)).toEqual({
        tokens: 7,
        toolTokens: 3,
      });
    });
  });

  it('caps the branch at a summary marker instead of re-summing compacted history', () => {
    const summarized = {
      messageId: 'a2',
      parentMessageId: 'u2',
      isCreatedByUser: false,
      tokenCount: 40,
      conversationId: CONVO,
      text: '',
      /** a2's turn compacted the history; pre-invoke context was 500 tokens. */
      metadata: { summaryUsedTokens: 500 },
    } as TMessage;
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 100),
      msg('a1', 'u1', false, 9000) /** huge pre-summary history, now discarded */,
      msg('u2', 'a1', true, 200),
      summarized,
      msg('u3', 'a2', true, 15),
      msg('a3', 'u3', false, 25),
    ]);

    const totals = sumBranch(CONVO, 'a3');
    /** Walk stops at a2: only its output + the post-summary turn are summed. */
    expect(totals.summaryBaseline).toBe(500);
    expect(totals.input).toBe(15);
    expect(totals.output).toBe(65); // a3 (25) + a2 (40)
    /** Estimate used = post-summary + compacted baseline = 580, not the 9380
     *  raw history sum that pinned the gauge at 100%. */
    expect(totals.input + totals.output + totals.summaryBaseline).toBe(580);
  });

  it('keeps provider usage/cost across the full branch even past a summary marker', () => {
    const summarized = {
      messageId: 'a2',
      parentMessageId: 'u2',
      isCreatedByUser: false,
      tokenCount: 40,
      conversationId: CONVO,
      text: '',
      metadata: { usage: USAGE_B, summaryUsedTokens: 500 },
    } as TMessage;
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      responseMsg('a1', 'u1', 9000, USAGE_A) /** pre-summary spend */,
      msg('u2', 'a1', true, 200),
      summarized,
      msg('u3', 'a2', true, 15),
      responseMsg('a3', 'u3', 25, USAGE_A) /** post-summary spend */,
    ]);

    const totals = sumBranch(CONVO, 'a3');
    /** Context is capped at the marker... */
    expect(totals.summaryBaseline).toBe(500);
    /** ...but cost/usage is cumulative spend and spans the WHOLE branch
     *  (a1 + a2 + a3 = 0.01 + 0.02 + 0.01), not truncated at the summary boundary. */
    expect(totals.usage.cost).toBeCloseTo(0.04);
    expect(totals.usage.input).toBe(400); // 100 + 200 + 100
  });

  it('flags whether the anchor message is on the branch', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      msg('a1', 'u1', false, 20),
      msg('a1-alt', 'u1', false, 25),
    ]);

    expect(sumBranch(CONVO, 'a1', 'a1').containsAnchor).toBe(true);
    expect(sumBranch(CONVO, 'a1-alt', 'a1').containsAnchor).toBe(false);
  });

  it('stops matching the anchor once the context is capped at a summary marker', () => {
    const summarized = {
      messageId: 'a2',
      parentMessageId: 'u2',
      isCreatedByUser: false,
      tokenCount: 40,
      conversationId: CONVO,
      text: '',
      metadata: { summaryUsedTokens: 500 },
    } as TMessage;
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 100),
      msg('a1', 'u1', false, 20),
      msg('u2', 'a1', true, 200),
      summarized,
      msg('u3', 'a2', true, 15),
      msg('a3', 'u3', false, 25),
    ]);
    /** a1 is older than the summary marker (a2): a snapshot anchored there is
     *  pre-summary, so it must NOT count as on-branch — else useTokenUsage revives
     *  that stale breakdown over the summary-baseline estimate. */
    expect(sumBranch(CONVO, 'a3', 'a1').containsAnchor).toBe(false);
    /** The summarized response's own (post-summary) snapshot still matches... */
    expect(sumBranch(CONVO, 'a3', 'a2').containsAnchor).toBe(true);
    /** ...as does a snapshot from a newer turn. */
    expect(sumBranch(CONVO, 'a3', 'a3').containsAnchor).toBe(true);
  });

  it('tracks uncounted messages and tolerates missing parents', () => {
    buildIndex(CONVO, [msg('u2', 'missing-parent', true, undefined), msg('a2', 'u2', false, 15)]);

    const totals = sumBranch(CONVO, 'a2');
    expect(totals.total).toBe(2);
    expect(totals.counted).toBe(1);
    expect(totals.output).toBe(15);
  });

  it('returns EMPTY_BRANCH without an index or tail', () => {
    expect(sumBranch('unknown', 'x')).toBe(EMPTY_BRANCH);
    buildIndex(CONVO, []);
    expect(sumBranch(CONVO, null)).toBe(EMPTY_BRANCH);
  });

  it('upserts incrementally and overwrites by messageId', () => {
    buildIndex(CONVO, [msg('u1', Constants.NO_PARENT, true, 10)]);
    upsertEntries(CONVO, [msg('a1', 'u1', false, 20), null, undefined]);
    expect(sumBranch(CONVO, 'a1').output).toBe(20);

    upsertEntries(CONVO, [msg('a1', 'u1', false, 35)]);
    expect(sumBranch(CONVO, 'a1').output).toBe(35);
  });

  it('migrates the index to a new conversation id', () => {
    buildIndex(Constants.NEW_CONVO, [msg('u1', Constants.NO_PARENT, true, 10)]);
    migrateIndex(Constants.NEW_CONVO, 'convo-2');

    expect(hasIndex(Constants.NEW_CONVO)).toBe(false);
    expect(sumBranch('convo-2', 'u1').input).toBe(10);
  });
});

describe('findBranchSnapshotAnchor', () => {
  afterEach(() => clearIndex(CONVO));

  it('returns the deepest stored anchor on the viewed branch', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      msg('a1', 'u1', false, 20),
      msg('u2', 'a1', true, 30),
      msg('a2', 'u2', false, 40),
      msg('a2-alt', 'u2', false, 50),
    ]);
    /** Both a1 and a2 stored; walking from a2 must return the nearer one (a2). */
    const anchors = new Map([
      ['a1', 1],
      ['a2', 1],
    ]);
    expect(findBranchSnapshotAnchor(CONVO, 'a2', anchors)).toBe('a2');
    /** From the sibling branch tail, the only on-branch anchor is a1. */
    expect(findBranchSnapshotAnchor(CONVO, 'a2-alt', anchors)).toBe('a1');
  });

  it('returns null when no stored anchor sits on the branch', () => {
    buildIndex(CONVO, [msg('u1', Constants.NO_PARENT, true, 10), msg('a1', 'u1', false, 20)]);
    expect(findBranchSnapshotAnchor(CONVO, 'a1', new Map([['other', 1]]))).toBeNull();
    expect(findBranchSnapshotAnchor(CONVO, 'a1', new Map())).toBeNull();
    expect(findBranchSnapshotAnchor('unknown', 'a1', new Map([['a1', 1]]))).toBeNull();
  });

  it('does not cross a summary marker to recover a stale pre-summary snapshot', () => {
    const summarized = {
      messageId: 'a2',
      parentMessageId: 'u2',
      isCreatedByUser: false,
      tokenCount: 40,
      conversationId: CONVO,
      text: '',
      metadata: { summaryUsedTokens: 500 },
    } as TMessage;
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      msg('a1', 'u1', false, 20) /** has a snapshot, but pre-summary */,
      msg('u2', 'a1', true, 30),
      summarized /** compacted here, no snapshot of its own */,
      msg('u3', 'a2', true, 15),
      msg('a3', 'u3', false, 25),
    ]);
    /** a1 is the only stored anchor, but it sits before the summary — the walk
     *  must stop at a2 and return null so the summary-baseline estimate is used. */
    expect(findBranchSnapshotAnchor(CONVO, 'a3', new Map([['a1', 1]]))).toBeNull();
    /** When the summarized response itself has a snapshot, return it. */
    expect(findBranchSnapshotAnchor(CONVO, 'a3', new Map([['a2', 1]]))).toBe('a2');
  });
});

describe('estimateTokens', () => {
  it('estimates chars/4 scaled by calibration ratio', () => {
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(400, 1.1)).toBe(110);
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(100, 0)).toBe(25);
  });

  it('renders malformed token counts as a bounded zero', () => {
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
    expect(formatTokens(-10)).toBe('0');
  });
});

describe('normalizeUsageUnits', () => {
  it('subtracts cache from input for Anthropic (input_tokens is cache-inclusive)', () => {
    /** The agents SDK folds cache into Anthropic input_tokens, so cache is a
     *  subset of input and must be subtracted: 900 − 100 read = 800. */
    expect(
      normalizeUsageUnits({
        input_tokens: 900,
        output_tokens: 100,
        provider: Providers.ANTHROPIC,
        input_token_details: { cache_read: 100 },
      }),
    ).toEqual({ input: 800, output: 100, cacheWrite: 0, cacheRead: 100 });
  });

  it('keeps cache additive for Bedrock (Converse input_tokens excludes cache)', () => {
    expect(
      normalizeUsageUnits({
        input_tokens: 900,
        output_tokens: 100,
        provider: Providers.BEDROCK,
        input_token_details: { cache_read: 100 },
      }),
    ).toEqual({ input: 900, output: 100, cacheWrite: 0, cacheRead: 100 });
  });

  it('keeps subset semantics for OpenAI regardless of magnitude', () => {
    expect(
      normalizeUsageUnits({
        input_tokens: 900,
        output_tokens: 100,
        provider: Providers.OPENAI,
        input_token_details: { cache_read: 100 },
      }),
    ).toEqual({ input: 800, output: 100, cacheWrite: 0, cacheRead: 100 });
  });

  it('falls back to a magnitude heuristic when provider is unknown', () => {
    /** cacheSum (12000) > input (1000) ⇒ additive */
    expect(
      normalizeUsageUnits({
        input_tokens: 1000,
        output_tokens: 500,
        input_token_details: { cache_creation: 2000, cache_read: 10000 },
      }),
    ).toEqual({ input: 1000, output: 500, cacheWrite: 2000, cacheRead: 10000 });
  });

  it('repairs under-reported completion tokens (Vertex thinking)', () => {
    /** total - input = 500 recovers the dropped thinking tokens */
    expect(
      normalizeUsageUnits({
        input_tokens: 1000,
        output_tokens: 200,
        total_tokens: 1500,
        provider: Providers.VERTEXAI,
      }).output,
    ).toBe(500);
  });

  it('does not mistake additive cache for missing completion tokens (Bedrock)', () => {
    /** Bedrock keeps cache separate, so total = input + output + cache (1700).
     *  Without the cache adjustment the repair would falsely inflate completion. */
    expect(
      normalizeUsageUnits({
        input_tokens: 1000,
        output_tokens: 200,
        total_tokens: 1700,
        provider: Providers.BEDROCK,
        input_token_details: { cache_creation: 300, cache_read: 200 },
      }).output,
    ).toBe(200);
  });

  it('does not inflate completion for cache-inclusive Anthropic totals', () => {
    /** Anthropic total already includes cache (input 1000 covers the 500 cache),
     *  so total 1200 leaves output at 200 — no false repair. */
    expect(
      normalizeUsageUnits({
        input_tokens: 1000,
        output_tokens: 200,
        total_tokens: 1200,
        provider: Providers.ANTHROPIC,
        input_token_details: { cache_creation: 300, cache_read: 200 },
      }).output,
    ).toBe(200);
  });
});

describe('formatCost', () => {
  it('formats across magnitude bands (USD default, unchanged)', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.0523)).toBe('$0.0523');
    expect(formatCost(1.234)).toBe('$1.23');
  });

  it('applies the static USD→local rate', () => {
    expect(formatCost(2, { code: 'USD', rate: 0.5 })).toBe('$1.00');
    expect(formatCost(10, { code: 'USD', rate: 0.1 })).toBe('$1.00');
  });

  it('formats in the configured currency', () => {
    const eur = formatCost(5, { code: 'EUR', rate: 1 });
    expect(eur).toContain('€');
    expect(eur).toContain('5');
  });

  it('respects zero-decimal currencies', () => {
    const jpy = formatCost(5, { code: 'JPY', rate: 1 });
    expect(jpy).toContain('¥');
    expect(jpy).not.toContain('.');
  });

  it('falls back to USD on a malformed currency code', () => {
    expect(formatCost(5, { code: 'invalid', rate: 1 })).toBe('$5.00');
  });

  it('drops the rate too when the currency code is unsupported', () => {
    /** A typo in `code` must not leave a converted amount under the $ symbol. */
    expect(formatCost(10, { code: 'EURO', rate: 0.92 })).toBe('$10.00');
  });

  it('rejects well-formed but non-ISO codes that Intl would accept', () => {
    /** `EUU`/`RMB` are 3 letters so Intl does not throw; the ISO-4217 set must
     *  still reject them and fall back to USD (no converted amount, no rate). */
    expect(formatCost(10, { code: 'EUU', rate: 0.92 })).toBe('$10.00');
    expect(formatCost(10, { code: 'RMB', rate: 0.5 })).toBe('$10.00');
  });

  it('uses the currency minor unit for three-decimal currencies', () => {
    /** KWD has 3 fractional digits, so the tiny threshold is 0.001, not 0.01. */
    const small = formatCost(0.005, { code: 'KWD', rate: 1 });
    expect(small).toContain('0.005');
    expect(small).not.toContain('<');
    expect(formatCost(0.0005, { code: 'KWD', rate: 1 })).toContain('0.001');
  });

  it('falls back to rate 1 when rate is not a finite positive number', () => {
    /** Partial admin override (code set before rate) must never render NaN. */
    const eur = formatCost(10, { code: 'EUR', rate: undefined as unknown as number });
    expect(eur).toContain('€');
    expect(eur).toContain('10');
    expect(eur).not.toContain('NaN');
    expect(formatCost(10, { code: 'USD', rate: Number.NaN })).toBe('$10.00');
  });
});

describe('groupToolTokens', () => {
  it('classifies tools into system, mcp, skills, and subagent groups', () => {
    const groups = groupToolTokens(
      {
        execute_code: 500,
        web_search: 300,
        skill: 200,
        subagent: 150,
        'search_mcp_Google-Workspace': 400,
        fetch_mcp_Github: 250,
      },
      ['fetch_mcp_Github', 'web_search'],
    );

    expect(groups).toEqual({
      system: 500,
      mcp: 400,
      skills: 200,
      subagents: 150,
      systemDeferred: 300,
      mcpDeferred: 250,
    });
  });

  it('returns empty groups without counts and skips zero entries', () => {
    expect(groupToolTokens(undefined)).toBe(EMPTY_TOOL_GROUPS);
    expect(groupToolTokens({ execute_code: 0 })).toEqual(EMPTY_TOOL_GROUPS);
  });

  it('handles prototype-sensitive names and malformed tool counts safely', () => {
    const counts = Object.fromEntries([
      ['__proto__', 7],
      ['constructor', 5],
      ['web_search', Number.NaN],
    ]);

    expect(groupToolTokens(counts)).toEqual({
      ...EMPTY_TOOL_GROUPS,
      system: 12,
    });
  });
});

describe('countTrailingOutputChars', () => {
  const text = (value: string) => ({ type: 'text', text: value });
  const think = (value: string) => ({ type: 'think', think: value });
  const tool = () => ({ type: 'tool_call', tool_call: { id: 'tc' } });

  it('counts the trailing run of text and think parts', () => {
    expect(countTrailingOutputChars([text('aaaa'), tool(), think('bb'), text('ccc')])).toBe(5);
  });

  it('returns 0 when the latest part is a tool call (no in-flight output)', () => {
    /** Once a tool call is emitted, its preceding text is folded into the next
     *  snapshot's messageTokens — counting it here would double-count. */
    expect(countTrailingOutputChars([text('aaaa'), tool(), text('ccc'), tool()])).toBe(0);
  });

  it('stops at the previous tool boundary', () => {
    expect(countTrailingOutputChars([text('aaaa'), tool(), text('ccc')])).toBe(3);
  });

  it('handles empty and non-output content', () => {
    expect(countTrailingOutputChars(undefined)).toBe(0);
    expect(countTrailingOutputChars([])).toBe(0);
    expect(countTrailingOutputChars([tool()])).toBe(0);
  });
});

describe('per-message usage index (branch + total)', () => {
  afterEach(() => {
    clearIndex(CONVO);
  });

  it('reads metadata.usage onto entries and sums it along the branch', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      responseMsg('a1', 'u1', 50, USAGE_A),
      msg('u2', 'a1', true, 30),
      responseMsg('a2', 'u2', 80, USAGE_B),
    ]);

    const { usage } = sumBranch(CONVO, 'a2');
    expect(usage).toEqual({
      input: 300,
      output: 130,
      cacheWrite: 0,
      cacheRead: 0,
      cost: 0.03,
      costKnown: true,
    });
  });

  it('reads persisted display units (incl. cache) directly', () => {
    /** The backend already normalized per-event; the client reads as-is */
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      responseMsg('a1', 'u1', 100, {
        input: 600,
        output: 100,
        cacheWrite: 0,
        cacheRead: 400,
        cost: 0.03,
      }),
    ]);

    const { usage } = sumBranch(CONVO, 'a1');
    expect(usage).toEqual({
      input: 600,
      output: 100,
      cacheWrite: 0,
      cacheRead: 400,
      cost: 0.03,
      costKnown: true,
    });
  });

  it('marks cost unknown when persisted usage omits cost (contextCost off)', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      responseMsg('a1', 'u1', 50, { input: 100, output: 50, cacheWrite: 0, cacheRead: 0 }),
    ]);
    const { usage } = sumBranch(CONVO, 'a1');
    expect(usage.costKnown).toBe(false);
    expect(usage.cost).toBe(0);
    expect(usage.input).toBe(100);
  });

  it('ignores malformed persisted usage values instead of poisoning totals', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      responseMsg('a1', 'u1', 50, {
        input: Number.NaN,
        output: Number.POSITIVE_INFINITY,
        cacheWrite: -2,
        cacheRead: 4.8,
        cost: Number.NaN,
      }),
    ]);

    expect(sumBranch(CONVO, 'a1').usage).toEqual({
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 4,
      cost: 0,
      costKnown: false,
    });
  });

  it('messages without metadata.usage contribute zero (backward compat)', () => {
    buildIndex(CONVO, [msg('u1', Constants.NO_PARENT, true, 10), msg('a1', 'u1', false, 50)]);
    expect(sumBranch(CONVO, 'a1').usage).toEqual(EMPTY_USAGE);
    expect(sumTotalUsage(CONVO)).toEqual(EMPTY_USAGE);
  });

  it('selects only the viewed response as the last turn across compaction and regeneration', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      responseMsg('a1', 'u1', 50, USAGE_A),
      msg('u2', 'a1', true, 20),
      {
        ...responseMsg('a2', 'u2', 80, { ...USAGE_B, cacheRead: 400, cacheWrite: 30 }),
        metadata: {
          usage: { ...USAGE_B, cacheRead: 400, cacheWrite: 30 },
          summaryUsedTokens: 500,
        },
      },
      responseMsg('a2-alt', 'u2', 60, { ...USAGE_A, cost: 0 }),
    ]);

    expect(sumBranch(CONVO, 'a2').lastTurnUsage).toEqual({
      input: 200,
      output: 80,
      cacheRead: 400,
      cacheWrite: 30,
      cost: 0.02,
      costKnown: true,
    });
    expect(sumBranch(CONVO, 'a2').usage.input).toBe(300);
    expect(sumBranch(CONVO, 'a2-alt').lastTurnUsage?.cost).toBe(0);
    expect(sumBranch(CONVO, 'u2').lastTurnUsage).toBeUndefined();
    expect(sumTotalUsage(CONVO).cacheRead).toBe(400);
  });

  it('does not borrow an ancestor response when the selected tail has no usage', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      responseMsg('a1', 'u1', 50, USAGE_A),
      msg('u2', 'a1', true, 10),
      msg('a2', 'u2', false, 20),
    ]);
    expect(sumBranch(CONVO, 'a2').lastTurnUsage).toBeUndefined();
    expect(sumBranch(CONVO, 'a2').usage.cost).toBe(0.01);
    expect(sumBranch(CONVO, 'u2').lastTurnUsage).toBeUndefined();
  });

  it('preserves a prior entry usage when a rebuilt message lacks metadata.usage', () => {
    /** Live finalize flushes usage into the index before persisted metadata
     *  reaches the cache; a mid-session rebuild from a cache message without
     *  metadata.usage must not wipe it (regenerate keeps the sibling's cost). */
    buildIndex(CONVO, [msg('u1', Constants.NO_PARENT, true, 10), msg('a1', 'u1', false, 50)]);
    setEntryUsage(CONVO, 'a1', {
      input: 100,
      output: 50,
      cacheWrite: 0,
      cacheRead: 0,
      cost: 0.01,
      costKnown: true,
    });
    /** Rebuild from the same cache (still no metadata.usage on a1) */
    buildIndex(CONVO, [msg('u1', Constants.NO_PARENT, true, 10), msg('a1', 'u1', false, 50)]);
    expect(sumBranch(CONVO, 'a1').usage.cost).toBeCloseTo(0.01);
    expect(sumBranch(CONVO, 'a1').usage.input).toBe(100);
    expect(sumBranch(CONVO, 'a1').lastTurnUsage?.cost).toBeCloseTo(0.01);
  });

  it('restores branch cost from sticky history after regenerate drops then re-adds a sibling', () => {
    /** a1 generated live; its cache message never carries metadata.usage */
    buildIndex(CONVO, [msg('u1', Constants.NO_PARENT, true, 10), msg('a1', 'u1', false, 50)]);
    setEntryUsage(CONVO, 'a1', {
      input: 100,
      output: 50,
      cacheWrite: 0,
      cacheRead: 0,
      cost: 0.01,
      costKnown: true,
    });

    /** Regenerate streaming shows only the active branch — a1 is dropped */
    buildIndex(CONVO, [msg('u1', Constants.NO_PARENT, true, 10), msg('a1-alt', 'u1', false, 60)]);
    expect(sumBranch(CONVO, 'a1').usage).toEqual(EMPTY_USAGE);

    /** Post-regenerate full rebuild re-adds a1 (still no metadata.usage) */
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      msg('a1', 'u1', false, 50),
      msg('a1-alt', 'u1', false, 60),
    ]);

    /** Switching back to branch A must still show its cost (the reported bug) */
    expect(sumBranch(CONVO, 'a1').usage.cost).toBeCloseTo(0.01);
    expect(sumBranch(CONVO, 'a1').usage.input).toBe(100);
  });

  it('scopes branch usage to the active thread while total spans all branches', () => {
    /** Regenerate: a1 and a1-alt are sibling responses under the same user msg */
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      responseMsg('a1', 'u1', 50, USAGE_A),
      responseMsg('a1-alt', 'u1', 80, USAGE_B),
    ]);

    /** Viewing branch B (the regenerated response) */
    expect(sumBranch(CONVO, 'a1-alt').usage.cost).toBeCloseTo(0.02);
    /** Viewing branch A (the original) */
    expect(sumBranch(CONVO, 'a1').usage.cost).toBeCloseTo(0.01);
    /** Total spans both abandoned + active branches */
    const total = sumTotalUsage(CONVO);
    expect(total.cost).toBeCloseTo(0.03);
    expect(total.input).toBe(300);
    expect(total.output).toBe(130);
  });

  it('is idempotent across rebuilds', () => {
    const messages = [
      msg('u1', Constants.NO_PARENT, true, 10),
      responseMsg('a1', 'u1', 50, USAGE_A),
      responseMsg('a1-alt', 'u1', 80, USAGE_B),
    ];
    buildIndex(CONVO, messages);
    const first = sumTotalUsage(CONVO);
    buildIndex(CONVO, messages);
    const second = sumTotalUsage(CONVO);
    expect(second).toEqual(first);
  });

  it('flushes a live response usage via setEntryUsage (no metadata yet)', () => {
    buildIndex(CONVO, [msg('u1', Constants.NO_PARENT, true, 10), msg('a1', 'u1', false, 50)]);
    /** Live response entry has no metadata.usage until persisted; finalize flushes it */
    expect(sumBranch(CONVO, 'a1').usage).toEqual(EMPTY_USAGE);
    setEntryUsage(CONVO, 'a1', {
      input: 100,
      output: 50,
      cacheWrite: 0,
      cacheRead: 0,
      cost: 0.01,
      costKnown: true,
    });
    expect(sumBranch(CONVO, 'a1').usage.cost).toBeCloseTo(0.01);
    expect(sumBranch(CONVO, 'a1').usage.input).toBe(100);
  });

  it('mergeUsage sums records and ANDs costKnown (incomplete coverage wins)', () => {
    const a = { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, cost: 0.5, costKnown: false };
    const b = { input: 10, output: 20, cacheWrite: 30, cacheRead: 40, cost: 1.5, costKnown: true };
    expect(mergeUsage(a, b)).toEqual({
      input: 11,
      output: 22,
      cacheWrite: 33,
      cacheRead: 44,
      cost: 2,
      costKnown: false,
    });
  });

  it('marks branch cost incomplete when any usage-bearing entry lacks cost', () => {
    /** A turn saved before cost display was on (no cost) alongside one with cost
     *  → the summed cost under-reports, so coverage is incomplete. */
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 10),
      responseMsg('a1', 'u1', 50, { input: 100, output: 50, cacheWrite: 0, cacheRead: 0 }),
      responseMsg('a2', 'a1', 60, USAGE_B),
    ]);
    const { usage } = sumBranch(CONVO, 'a2');
    expect(usage.costKnown).toBe(false);
    /** Cost still sums what it can, but coverage is flagged incomplete */
    expect(usage.cost).toBeCloseTo(0.02);
    expect(sumTotalUsage(CONVO).costKnown).toBe(false);
  });

  it('EMPTY_BRANCH carries an empty usage record', () => {
    expect(sumBranch('missing-convo', 'x')).toBe(EMPTY_BRANCH);
    expect(EMPTY_BRANCH.usage).toEqual(EMPTY_USAGE);
  });

  it('collectAnchorSeries reads used tokens per anchor, oldest → newest', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 4),
      msg('a1', 'u1', false, 10),
      msg('u2', 'a1', true, 4),
      msg('a2', 'u2', false, 20),
      msg('u3', 'a2', true, 4),
      msg('a3', 'u3', false, 30),
    ]);
    const snap = (remaining: number) => ({
      contextBudget: 1000,
      remainingContextTokens: remaining,
      breakdown: { maxContextTokens: 1000 },
    });
    const anchors = new Map([
      ['a1', snap(960)],
      ['a2', snap(920)],
      ['a3', snap(860)],
    ]);

    const series = collectAnchorSeries(CONVO, 'a3', anchors);
    /** used = budget − remaining: 40 → 80 → 140, oldest first */
    expect(series).toEqual([
      { used: 40, basis: 'remaining' },
      { used: 80, basis: 'remaining' },
      { used: 140, basis: 'remaining' },
    ]);
    expect(collectAnchorSeries(CONVO, 'a3', new Map())).toEqual([]);
  });

  it('collectAnchorSeries derives a snapshot saved without remaining headroom', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 4),
      msg('a1', 'u1', false, 10),
      msg('u2', 'a1', true, 4),
      msg('a2', 'u2', false, 20),
    ]);
    const anchors = new Map<string, unknown>([
      /** The older shape: a budget and a breakdown, no remaining count. Read as
       *  zero remaining it would claim the whole 1000-token window was spent. */
      [
        'a1',
        {
          contextBudget: 1000,
          breakdown: {
            maxContextTokens: 1000,
            instructionTokens: 100,
            summaryTokens: 25,
            messageTokens: 60,
          },
        },
      ],
      /** Nothing to read at all — skipped rather than counted as a full window. */
      ['a2', { contextBudget: 1000, breakdown: { maxContextTokens: 1000 } }],
    ]);

    expect(collectAnchorSeries(CONVO, 'a2', anchors)).toEqual([{ used: 185, basis: 'breakdown' }]);
  });

  it('latestExchangeTokens sums the tail response and its user turn', () => {
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 12),
      msg('a1', 'u1', false, 40),
      msg('u2', 'a1', true, 9),
      msg('a2', 'u2', false, 50),
    ]);

    expect(latestExchangeTokens(CONVO, 'a2', false)).toBe(59);
    /** In-flight tail rides liveTokens — only the user turn remains */
    expect(latestExchangeTokens(CONVO, 'a2', true)).toBe(9);
  });

  it('keeps tool results outside model completion counts in the latest exchange', () => {
    const response = {
      messageId: 'a1',
      parentMessageId: 'u1',
      conversationId: CONVO,
      isCreatedByUser: false,
      tokenCount: 40,
      content: [
        {
          type: 'tool_call',
          tool_call: {
            name: 'read_file',
            args: 'a'.repeat(80),
            output: 'r'.repeat(2000),
          },
        },
      ],
    } as TMessage;
    buildIndex(CONVO, [msg('u1', Constants.NO_PARENT, true, 10), response]);
    expect(latestExchangeTokens(CONVO, 'a1', false)).toBe(550);
    expect(latestExchangeTokens(CONVO, 'a1', true)).toBe(10);
    buildIndex(CONVO, [msg('u1', Constants.NO_PARENT, true, 10), { ...response, tokenCount: 0 }]);
    expect(latestExchangeTokens(CONVO, 'a1', false)).toBe(532);
  });

  it('latestExchangeTokens drops a summarizing turn’s summary completion', () => {
    /** The backend folds the summarization pass into the response's
     *  `tokenCount`, while the snapshot holds those tokens in `summaryTokens`
     *  instead of `messageTokens`. Subtracting the whole tail would remove a
     *  summary the message total never carried. */
    buildIndex(CONVO, [
      msg('u1', Constants.NO_PARENT, true, 9),
      {
        messageId: 'a1',
        parentMessageId: 'u1',
        isCreatedByUser: false,
        conversationId: CONVO,
        tokenCount: 500,
        text: 'answer',
        metadata: { summaryUsedTokens: 4000 },
      } as unknown as TMessage,
    ]);

    expect(latestExchangeTokens(CONVO, 'a1', false, 300)).toBe(209);
    /** A turn that did not summarize keeps its whole response. */
    expect(latestExchangeTokens(CONVO, 'a1', false)).toBe(509);
  });
});
