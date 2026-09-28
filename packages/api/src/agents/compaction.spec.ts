import { ContentTypes, ErrorTypes } from 'librechat-data-provider';
import { COMPACTION_SEMANTIC_INDEX_LIMITS } from '@librechat/agents';
import {
  MAX_COMPACTION_SEMANTIC_INDEX_ENTRIES,
  MAX_COMPACTION_SEMANTIC_INDEX_IDENTITY_LENGTH,
  MAX_COMPACTION_SEMANTIC_INDEX_SOURCE_CONTENT_INDEX,
  MAX_COMPACTION_SEMANTIC_INDEX_TEXT_LENGTH,
  AGENT_EVENT_ACTOR_SUMMARY_VERSION,
} from '@librechat/data-schemas';
import type { CompactionSemanticIndex, CompactionSemanticIndexSnapshot } from '@librechat/agents';
import type { SummaryContentPart, TMessageContentParts } from 'librechat-data-provider';
import type { ICompactionSemanticIndexProjection } from '@librechat/data-schemas';
import {
  createCompactionSemanticIndexProjection,
  dropUnusableSummaryParts,
  findCheckpointSummaryPart,
  getSummaryPartText,
  markAbortedCompactionContent,
  markCompactionOutcome,
  persistFinalizedCompactionTurn,
  resolveAbortAnchorDecision,
  resolveFailedTurnContent,
  resolveCheckpointMessage,
  resolveFinalizedCompactionTurn,
  restoreCompactionSemanticIndex,
  restoreCompactionSemanticIndexSnapshot,
  stripUnusableSummaryParts,
  getLatestEventActorSummary,
} from './compaction';

const index = [
  {
    type: 'activity_phase',
    sourceMessageId: 'message-1',
    sourceContentIndex: 2,
    revision: 1,
    status: 'committed',
    text: 'Verified the release',
  },
  {
    type: 'reasoning_label',
    sourceMessageId: 'message-1',
    sourceContentIndex: 3,
    revision: 2,
    status: 'pending',
    text: 'This pending text must not persist',
    reasoningStepId: 'reasoning-1',
  },
] satisfies CompactionSemanticIndex;

describe('compaction semantic index continuation projection', () => {
  it('keeps persistence bounds aligned with the SDK admission limits', () => {
    expect(MAX_COMPACTION_SEMANTIC_INDEX_ENTRIES).toBe(
      COMPACTION_SEMANTIC_INDEX_LIMITS.maxInputEntries,
    );
    expect(MAX_COMPACTION_SEMANTIC_INDEX_TEXT_LENGTH).toBe(
      COMPACTION_SEMANTIC_INDEX_LIMITS.maxInputTextChars,
    );
    expect(MAX_COMPACTION_SEMANTIC_INDEX_IDENTITY_LENGTH).toBe(
      COMPACTION_SEMANTIC_INDEX_LIMITS.maxIdentityChars,
    );
    expect(MAX_COMPACTION_SEMANTIC_INDEX_SOURCE_CONTENT_INDEX).toBe(
      COMPACTION_SEMANTIC_INDEX_LIMITS.maxSourceContentIndex,
    );
  });

  it('snapshots exact JSON-safe guidance and blanks pending text', () => {
    const projection = createCompactionSemanticIndexProjection(index);

    expect(projection).toEqual({
      version: 1,
      providedEntryCount: 2,
      entries: [
        index[0],
        {
          ...index[1],
          text: '',
        },
      ],
    });
    expect(restoreCompactionSemanticIndex(projection)).toEqual(projection?.entries);
  });

  it('preserves cumulative omission counts across JSON persistence', () => {
    const snapshot = {
      entries: index,
      providedEntryCount: 17,
    } satisfies CompactionSemanticIndexSnapshot;
    const projection = createCompactionSemanticIndexProjection(snapshot);

    expect(projection).toEqual({
      version: 1,
      entries: [index[0], { ...index[1], text: '' }],
      providedEntryCount: 17,
    });
    expect(restoreCompactionSemanticIndexSnapshot(JSON.parse(JSON.stringify(projection)))).toEqual({
      entries: projection?.entries,
      providedEntryCount: 17,
    });
  });

  it('defaults legacy projections to their retained entry count', () => {
    const legacyProjection = {
      version: 1,
      entries: [index[0]],
    } satisfies ICompactionSemanticIndexProjection;

    expect(restoreCompactionSemanticIndexSnapshot(legacyProjection)).toEqual({
      entries: legacyProjection.entries,
      providedEntryCount: 1,
    });
  });

  it('fails closed for malformed or oversized continuation state', () => {
    const malformed = {
      version: 1,
      entries: [{ ...index[0], sourceContentIndex: -1 }],
    } as ICompactionSemanticIndexProjection;
    const oversized = {
      version: 1,
      entries: Array.from({ length: MAX_COMPACTION_SEMANTIC_INDEX_ENTRIES + 1 }, () => index[0]),
    } as ICompactionSemanticIndexProjection;
    const corrupt = {
      version: 1,
      entries: [null],
    } as never;
    const impossibleCount = {
      version: 1,
      entries: index,
      providedEntryCount: 1,
    } as ICompactionSemanticIndexProjection;

    expect(restoreCompactionSemanticIndex(malformed)).toBeUndefined();
    expect(restoreCompactionSemanticIndex(oversized)).toBeUndefined();
    expect(restoreCompactionSemanticIndex(corrupt)).toBeUndefined();
    expect(restoreCompactionSemanticIndexSnapshot(impossibleCount)).toBeUndefined();
    expect(createCompactionSemanticIndexProjection(oversized.entries)).toBeUndefined();
  });

  it('redacts oversized text before persistence', () => {
    const projection = createCompactionSemanticIndexProjection([
      {
        ...index[0],
        text: 'x'.repeat(MAX_COMPACTION_SEMANTIC_INDEX_TEXT_LENGTH + 1),
      },
    ]);

    expect(projection?.entries[0]).toEqual({
      ...index[0],
      text: '',
      redacted: true,
    });
  });
});

/** Only a completed round's final block carries a boundary; streamed deltas never do. */
const completedBoundary = { messageId: 'step_summary', contentIndex: 0 };

describe('markCompactionOutcome', () => {
  const summary = (
    text: string,
    overrides: Partial<SummaryContentPart> = {},
  ): TMessageContentParts => ({
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text }],
    boundary: completedBoundary,
    ...overrides,
  });
  const failure = (error: string): TMessageContentParts => ({ type: ContentTypes.ERROR, error });

  it('marks the summary a compaction produced', () => {
    const parts = [summary('Earlier turns, compacted.')];

    markCompactionOutcome(parts);

    expect(parts[0]).toMatchObject({ initiatedBy: 'user' });
  });

  /** The turn has no other record of having been a compaction: without the
   *  marker a failure hanging off a user message keeps a Regenerate that
   *  answers that message instead of redoing the compaction. */
  it('marks the failure a compaction recorded instead of a summary', () => {
    const parts = [failure('Nothing to summarize')];

    markCompactionOutcome(parts);

    expect(parts[0]).toMatchObject({ initiatedBy: 'user' });
  });

  it('marks the failure when only a partial summary streamed before it', () => {
    const parts = [summary('Half a checkpoint', { failed: true }), failure('Summarization failed')];

    markCompactionOutcome(parts);

    expect(parts[0]).not.toHaveProperty('initiatedBy');
    expect(parts[1]).toMatchObject({ initiatedBy: 'user' });
  });

  /** The fallback the reviewed head threw on: a run that produced neither a
   *  summary nor an explanation now records the typed failure itself, so the
   *  turn carries the marker on the stream and in storage instead of being
   *  saved as a bare error row with no content. */
  it.each([
    ['nothing at all', []],
    ['an empty summary', [summary('   ')]],
    [
      'a partial summary with no recorded failure',
      [summary('Half a checkpoint', { failed: true })],
    ],
  ])('records a marked typed failure for a run that produced %s', (_label, parts) => {
    markCompactionOutcome(parts);

    /** The typed failure is the turn's whole outcome: a truncated summary left
     *  beside it would report the same failure a second time. */
    expect(parts).toEqual([
      {
        type: ContentTypes.ERROR,
        error: JSON.stringify({ type: ErrorTypes.COMPACTION_FAILED }),
        initiatedBy: 'user',
      },
    ]);
  });

  /** A cancelled compaction stopped early rather than failing, and the abort
   *  path owns that turn: it must not be turned into a failure row. */
  it('fails as a typed error when the run was cancelled', () => {
    const parts: TMessageContentParts[] = [];

    expect(() => markCompactionOutcome(parts, { aborted: true })).toThrow(
      JSON.stringify({ type: ErrorTypes.COMPACTION_FAILED }),
    );
    expect(parts).toHaveLength(0);
  });
});

describe('resolveFailedTurnContent', () => {
  /** A thrown failure leaves the turn with no content of its own, so the row a
   *  compaction persists carries the marked failure instead. */
  it('gives a failed compaction turn its marked failure content', () => {
    expect(resolveFailedTurnContent({ compact: true }, 'Summarization failed')).toEqual({
      content: [{ type: ContentTypes.ERROR, error: 'Summarization failed', initiatedBy: 'user' }],
    });
  });

  it.each([
    ['an ordinary turn', { compact: false }],
    ['a turn that never asked to compact', {}],
    ['a request with no body', undefined],
  ])('leaves %s with its text-only shape', (_label, requestBody) => {
    expect(resolveFailedTurnContent(requestBody, 'Something failed')).toEqual({});
  });
});

describe('resolveCheckpointMessage', () => {
  const summaryPart = {
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text: 'Earlier context' }],
    boundary: completedBoundary,
    tokenCount: 7,
  };

  it('keeps the parts a response produced after its summary', () => {
    const trailingText = { type: ContentTypes.TEXT, text: 'Answer after summarizing' };
    const message = {
      messageId: 'response',
      tokenCount: 90,
      content: [{ type: ContentTypes.TEXT, text: 'Before summarizing' }, summaryPart, trailingText],
    };

    const resolved = resolveCheckpointMessage(message);

    expect(resolved).toEqual({ messageId: 'response', content: [summaryPart, trailingText] });
    expect(resolved?.tokenCount).toBeUndefined();
  });

  it('starts at the last usable summary', () => {
    const between = { type: ContentTypes.TEXT, text: 'Between summaries' };
    const after = { type: ContentTypes.TEXT, text: 'After the latest' };
    const latest = {
      ...summaryPart,
      content: [{ type: ContentTypes.TEXT, text: 'Latest context' }],
    };

    expect(resolveCheckpointMessage({ content: [summaryPart, between, latest, after] })).toEqual({
      content: [latest, after],
    });
  });

  it('keeps the parts after a completed summary when a later one failed', () => {
    const after = { type: ContentTypes.TEXT, text: 'After the completed summary' };
    const failed = { ...summaryPart, failed: true };

    expect(resolveCheckpointMessage({ content: [summaryPart, after, failed] })).toEqual({
      content: [summaryPart, after, failed],
    });
  });

  it('returns the row itself when it already starts at its summary', () => {
    const message = { content: [summaryPart], tokenCount: 12 };

    expect(resolveCheckpointMessage(message)).toBe(message);
  });

  it('replaces the whole row for a legacy summary field', () => {
    expect(
      resolveCheckpointMessage({ summary: 'Legacy', summaryTokenCount: 4, tokenCount: 30 }),
    ).toEqual({
      summary: 'Legacy',
      summaryTokenCount: 4,
      role: 'system',
      content: [{ type: ContentTypes.TEXT, text: 'Legacy' }],
      tokenCount: 4,
    });
  });

  it('is null for a row that is no checkpoint', () => {
    expect(resolveCheckpointMessage({ content: [{ ...summaryPart, failed: true }] })).toBeNull();
    expect(
      resolveCheckpointMessage({ content: [{ type: ContentTypes.TEXT, text: 'x' }] }),
    ).toBeNull();
  });
});

describe('markAbortedCompactionContent', () => {
  const partialSummary = (text: string): TMessageContentParts => ({
    type: ContentTypes.SUMMARY,
    /** Streamed deltas never carry a boundary; a stopped round keeps them. */
    content: [{ type: ContentTypes.TEXT, text }],
    summarizing: true,
  });

  /** The summarizer opens the part when its round starts, so a stop can land
   *  between that and the first delta. */
  const emptySummaryPlaceholder = (): TMessageContentParts => ({
    type: ContentTypes.SUMMARY,
    content: [],
    summarizing: true,
  });

  const completedSummary = (text: string): TMessageContentParts => ({
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text }],
    boundary: completedBoundary,
  });

  /** The abort path owns a cancelled run's row: its partial summary must still
   *  carry the marker, or on a branch ending in a user message the row keeps a
   *  Regenerate that answers that user turn instead of redoing the compaction.
   *  The truncated prefix is kept but marked failed, or its label presents it
   *  as a finished checkpoint. */
  it('marks the partial summary a stopped compaction had streamed as failed', () => {
    const parts = [partialSummary('Half a summary')];

    markAbortedCompactionContent(parts, true);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ initiatedBy: 'user', failed: true, summarizing: true });
  });

  /** A round that finished before the Stop landed is a real checkpoint: the
   *  race is not a failure. */
  it('marks a summary that completed before the stop without failing it', () => {
    const parts = [completedSummary('Finished before the stop.')];

    markAbortedCompactionContent(parts, true);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ initiatedBy: 'user' });
    expect(parts[0]).not.toHaveProperty('failed');
  });

  /** Every part that can carry the marker gets it: the row's identity must not
   *  depend on which of its parts a reader inspects first. */
  it('marks an error part the stopped run had already recorded', () => {
    const parts: TMessageContentParts[] = [
      partialSummary('Half a summary'),
      { type: ContentTypes.ERROR, error: 'Something else failed first' },
    ];

    markAbortedCompactionContent(parts, true);

    expect(parts[0]).toMatchObject({ initiatedBy: 'user', failed: true });
    expect(parts[1]).toMatchObject({ initiatedBy: 'user' });
  });

  /** A summary placeholder with no text is not an outcome: nothing of the
   *  round survived to show, so the typed failure is the row's whole
   *  outcome. */
  it('replaces a summary placeholder that streamed nothing with the typed failure', () => {
    const parts = [emptySummaryPlaceholder()];

    markAbortedCompactionContent(parts, true);

    expect(parts).toEqual([
      {
        type: ContentTypes.ERROR,
        error: JSON.stringify({ type: ErrorTypes.COMPACTION_FAILED }),
        initiatedBy: 'user',
      },
    ]);
  });

  /** A run stopped before any part streamed still needs an identifiable row:
   *  an empty one reads as an answer to the message it hangs off. */
  it('records the typed failure when nothing streamed before the stop', () => {
    const parts: TMessageContentParts[] = [];

    markAbortedCompactionContent(parts, true);

    expect(parts).toEqual([
      {
        type: ContentTypes.ERROR,
        error: JSON.stringify({ type: ErrorTypes.COMPACTION_FAILED }),
        initiatedBy: 'user',
      },
    ]);
  });

  /** The disconnect save runs while the generation is still live and the
   *  completion path overwrites the row: it stamps identity and rewrites
   *  nothing else, not even the failure flag of a still-streaming part. */
  it('marks a non-terminal snapshot without failing or synthesizing anything', () => {
    const parts: TMessageContentParts[] = [partialSummary('Half a summary')];

    markAbortedCompactionContent(parts, true, { synthesizeFailure: false });

    expect(parts).toEqual([{ ...partialSummary('Half a summary'), initiatedBy: 'user' }]);
  });

  it('returns content from a turn that was not a compaction unchanged', () => {
    const parts = [partialSummary('An automatic detour partial')];

    expect(markAbortedCompactionContent(parts, false)).toBe(parts);
    expect(parts[0]).not.toHaveProperty('initiatedBy');
  });
});

describe('resolveAbortAnchorDecision', () => {
  it('keeps the prerequisite user write for an ordinary turn', () => {
    expect(resolveAbortAnchorDecision({}, true)).toBe('persist');
    expect(resolveAbortAnchorDecision(null, false)).toBe('persist');
  });

  /** The compaction's `userMessage` is the persisted leaf projected for
   *  identity only; upserting it would erase the leaf. */
  it('skips the prerequisite write for a compaction anchored on a persisted leaf', () => {
    expect(resolveAbortAnchorDecision({ compact: true }, true)).toBe('skip-anchor');
  });

  /** Stop can win the race before the branch loaded, leaving the projection
   *  with no row behind it: a response written there would be orphaned. */
  it('skips the whole turn when the compaction anchor was never persisted', () => {
    expect(resolveAbortAnchorDecision({ compact: true }, false)).toBe('skip-turn');
  });
});

describe('persistFinalizedCompactionTurn', () => {
  it('writes the finalized content with the terminal envelope', async () => {
    const saved: Record<string, unknown>[] = [];
    const partialRow = {
      content: [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'Half a summary' }],
          summarizing: true,
        },
      ],
    };

    await persistFinalizedCompactionTurn(
      partialRow,
      { compact: true },
      {
        messageId: 'response-1',
        conversationId: 'conversation-1',
        saveMessage: async (message) => {
          saved.push(message);
          return message;
        },
      },
    );

    /** The snapshot was saved `unfinished` with no error while the run was
     *  live; the settled row must not keep reading as an incomplete
     *  response. */
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      messageId: 'response-1',
      conversationId: 'conversation-1',
      unfinished: false,
      error: true,
    });
    expect(saved[0].content).toEqual([
      expect.objectContaining({ type: ContentTypes.SUMMARY, failed: true, initiatedBy: 'user' }),
    ]);
  });

  it('writes nothing when the row needs no finalization', async () => {
    const saveMessage = jest.fn();

    await persistFinalizedCompactionTurn(
      { content: [{ type: ContentTypes.TEXT, text: 'An ordinary partial' }] },
      {},
      { messageId: 'response-1', conversationId: 'conversation-1', saveMessage },
    );

    expect(saveMessage).not.toHaveBeenCalled();
  });
});

describe('resolveFinalizedCompactionTurn', () => {
  const compactionFailed = JSON.stringify({ type: ErrorTypes.COMPACTION_FAILED });

  it('leaves a partial row of a turn that was not a compaction alone', () => {
    const row = { content: [{ type: ContentTypes.TEXT, text: 'Partial answer' }] };

    expect(resolveFinalizedCompactionTurn(row, {})).toBeNull();
  });

  /** The disconnect snapshot is marker-only, so a run that fails afterwards
   *  leaves a row with no summary or error part and no marker at all. */
  it('finalizes a snapshot without a summary or error part with the typed failure', () => {
    const row = { content: [{ type: ContentTypes.THINK, think: 'Picking what to summarize' }] };

    expect(resolveFinalizedCompactionTurn(row, { compact: true })).toEqual({
      content: [
        { type: ContentTypes.THINK, think: 'Picking what to summarize' },
        { type: ContentTypes.ERROR, error: compactionFailed, initiatedBy: 'user' },
      ],
    });
  });

  it('marks a partial summary failed beside its text', () => {
    const row = {
      content: [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'Half a summary' }],
          summarizing: true,
          initiatedBy: 'user',
        },
      ],
    };

    expect(resolveFinalizedCompactionTurn(row, { compact: true })).toEqual({
      content: [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'Half a summary' }],
          summarizing: true,
          initiatedBy: 'user',
          failed: true,
        },
      ],
    });
  });

  it('leaves a row that already carries a terminal outcome alone', () => {
    const failedSummary = {
      content: [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'Half a summary' }],
          summarizing: true,
          failed: true,
          initiatedBy: 'user',
        },
      ],
    };
    const recordedFailure = {
      content: [{ type: ContentTypes.ERROR, error: 'Summarization failed', initiatedBy: 'user' }],
    };

    expect(resolveFinalizedCompactionTurn(failedSummary, { compact: true })).toBeNull();
    expect(resolveFinalizedCompactionTurn(recordedFailure, { compact: true })).toBeNull();
  });

  /** A row can hold an earlier round's terminal outcome beside a later
   *  unfinished summary: only the inspection of every part catches it, and
   *  the failure lands on the summary that never finished. */
  it('finalizes a later unfinished summary beside an earlier terminal outcome', () => {
    const row = {
      content: [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'An earlier checkpoint.' }],
          boundary: completedBoundary,
        },
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'A later partial round.' }],
          summarizing: true,
        },
      ],
    };

    expect(resolveFinalizedCompactionTurn(row, { compact: true })).toEqual({
      content: [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'An earlier checkpoint.' }],
          boundary: completedBoundary,
          initiatedBy: 'user',
        },
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'A later partial round.' }],
          summarizing: true,
          initiatedBy: 'user',
          failed: true,
        },
      ],
    });
  });
});

describe('findCheckpointSummaryPart', () => {
  const legacySummary = { type: ContentTypes.SUMMARY, text: 'Summary of conversation' };

  it('takes the last summary that carries text', () => {
    const content = [
      { type: ContentTypes.TEXT, text: 'some text' },
      {
        type: ContentTypes.SUMMARY,
        content: [{ type: ContentTypes.TEXT, text: 'First' }],
        boundary: completedBoundary,
      },
      {
        type: ContentTypes.SUMMARY,
        content: [{ type: ContentTypes.TEXT, text: 'Latest' }],
        boundary: completedBoundary,
      },
    ];

    expect(getSummaryPartText(findCheckpointSummaryPart(content))).toBe('Latest');
  });

  /** Rows persisted before summary `content` blocks carry a bare `text`. */
  it('reads a legacy summary’s text field', () => {
    expect(findCheckpointSummaryPart([legacySummary])).toBe(legacySummary);
  });

  /** A round that failed or never finished holds a truncated prefix of the
   *  history it was summarizing, so the turn offers no checkpoint at all. */
  it.each([
    ['failed', { failed: true }],
    ['still summarizing', { summarizing: true }],
  ])('offers no checkpoint when the only summary is %s', (_label, state) => {
    const content = [
      {
        type: ContentTypes.SUMMARY,
        content: [{ type: ContentTypes.TEXT, text: 'Partial' }],
        boundary: completedBoundary,
        ...state,
      },
    ];

    expect(findCheckpointSummaryPart(content)).toBeNull();
  });

  /** A round that errored before failures were stamped kept its deltas and no
   *  flag. Deltas never carry a boundary, so the part still reads as unfinished. */
  it('offers no checkpoint for a streamed summary that never recorded a boundary', () => {
    const content = [
      { type: ContentTypes.TEXT, text: 'An answer' },
      { type: ContentTypes.SUMMARY, content: [{ type: ContentTypes.TEXT, text: 'Partial' }] },
    ];

    expect(findCheckpointSummaryPart(content)).toBeNull();
  });

  it('keeps the last complete summary when a later round never recorded a boundary', () => {
    const content = [
      {
        type: ContentTypes.SUMMARY,
        content: [{ type: ContentTypes.TEXT, text: 'Complete' }],
        boundary: completedBoundary,
      },
      { type: ContentTypes.SUMMARY, content: [{ type: ContentTypes.TEXT, text: 'Partial' }] },
    ];

    expect(getSummaryPartText(findCheckpointSummaryPart(content))).toBe('Complete');
  });

  it('keeps the last complete summary when a later round failed', () => {
    const content = [
      {
        type: ContentTypes.SUMMARY,
        content: [{ type: ContentTypes.TEXT, text: 'Complete' }],
        boundary: completedBoundary,
      },
      { type: ContentTypes.SUMMARY, text: 'Partial', failed: true },
    ];

    expect(getSummaryPartText(findCheckpointSummaryPart(content))).toBe('Complete');
  });

  it.each([
    ['content without a summary', [{ type: ContentTypes.TEXT, text: 'some text' }]],
    ['an empty summary', [{ type: ContentTypes.SUMMARY, tokenCount: 10 }]],
    ['a whitespace-only summary', [{ type: ContentTypes.SUMMARY, text: '  \n' }]],
    ['string content', 'just a string'],
    ['missing content', undefined],
  ])('returns null for %s', (_label, content) => {
    expect(findCheckpointSummaryPart(content)).toBeNull();
  });
});

describe('getLatestEventActorSummary', () => {
  const part = (text: string, extra: Record<string, unknown> = {}) => ({
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text }],
    boundary: completedBoundary,
    ...extra,
  });

  it('stamps the last usable summary as actor state', () => {
    expect(
      getLatestEventActorSummary([
        part('Earlier checkpoint', { tokenCount: 4 }),
        { type: ContentTypes.TEXT, text: 'An answer' },
        part('Latest checkpoint', { tokenCount: 9 }),
      ]),
    ).toEqual({
      text: 'Latest checkpoint',
      tokenCount: 9,
      version: AGENT_EVENT_ACTOR_SUMMARY_VERSION,
    });
  });

  /** A later round that failed, is still running, or never recorded a boundary
   *  holds a truncated prefix; the continuation must keep the real checkpoint. */
  it.each([
    ['failed', { failed: true }],
    ['still summarizing', { summarizing: true }],
    ['stored without a boundary', { boundary: undefined }],
  ])('skips a later summary that is %s', (_label, state) => {
    expect(
      getLatestEventActorSummary([
        part('Real checkpoint', { tokenCount: 5 }),
        part('Parti', state),
      ]),
    ).toMatchObject({ text: 'Real checkpoint', tokenCount: 5 });
  });

  it.each([
    ['a missing count', {}],
    ['a negative count', { tokenCount: -3 }],
    ['a non-finite count', { tokenCount: Number.NaN }],
  ])('records zero tokens for %s', (_label, extra) => {
    expect(getLatestEventActorSummary([part('Checkpoint', extra)])).toMatchObject({
      tokenCount: 0,
    });
  });

  it.each([
    ['content without a usable summary', [part('Parti', { failed: true })]],
    ['non-array content', 'just a string'],
    ['missing content', undefined],
  ])('returns undefined for %s', (_label, content) => {
    expect(getLatestEventActorSummary(content)).toBeUndefined();
  });
});

describe('unusable summary parts', () => {
  const failedSummary = {
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text: 'Half a checkpoint' }],
    boundary: completedBoundary,
    failed: true,
  };
  const unfinishedSummary = {
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text: 'Half a checkpoint' }],
    boundary: completedBoundary,
    summarizing: true,
  };
  const unstampedSummary = {
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text: 'Half a checkpoint' }],
  };
  const completeSummary = {
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text: 'Earlier turns, compacted.' }],
    boundary: completedBoundary,
  };
  const emptySummary = { type: ContentTypes.SUMMARY, content: [], failed: true };
  const text = { type: ContentTypes.TEXT, text: 'An answer' };

  /** The formatter reads the last summary part with text as the history
   *  boundary, so an unusable one left on the prompt copy drops the turns it
   *  never summarized. */
  it.each([
    ['a failed summary', failedSummary],
    ['a summary whose round never finished', unfinishedSummary],
    ['a streamed summary stored without a boundary or a flag', unstampedSummary],
  ])('drops %s from a prompt copy and keeps the rest of the turn', (_label, summary) => {
    const message = { role: 'assistant', content: [text, summary] };

    expect(dropUnusableSummaryParts(message)).toBe(true);
    expect(message.content).toEqual([text]);
  });

  it('keeps a complete summary, so a real checkpoint still bounds the history', () => {
    const message = { role: 'assistant', content: [completeSummary, failedSummary] };

    expect(dropUnusableSummaryParts(message)).toBe(true);
    expect(message.content).toEqual([completeSummary]);
  });

  /** A formatted prompt copy shares its content array with the stored message
   *  it came from, so the drop must repoint the copy rather than splice: a
   *  splice would reindex the persisted row's parts under every reader that
   *  holds it, including the edit path's `/content/N` provenance. */
  it('leaves the stored content array it was handed untouched', () => {
    const stored = [text, failedSummary];
    const promptCopy = { role: 'assistant', content: stored };

    expect(dropUnusableSummaryParts(promptCopy)).toBe(true);
    expect(promptCopy.content).not.toBe(stored);
    expect(stored).toEqual([text, failedSummary]);
  });

  it.each<[string, { role: string; content?: unknown }]>([
    ['no unusable summary', { role: 'assistant', content: [completeSummary] }],
    ['an empty summary, which bounds nothing', { role: 'assistant', content: [emptySummary] }],
    ['string content', { role: 'user', content: 'Plain text turn' }],
  ])('reports nothing dropped for %s', (_label, message) => {
    const before = JSON.stringify(message);

    expect(dropUnusableSummaryParts(message)).toBe(false);
    expect(JSON.stringify(message)).toBe(before);
  });

  /** The memory payload is not the caller's to mutate, so that path gets a copy
   *  with the same parts removed and the same positions. */
  it('strips a payload the caller does not own without touching it', () => {
    const payload = [
      { role: 'user', content: [{ type: ContentTypes.TEXT, text: 'First question' }] },
      { role: 'assistant', content: [text, failedSummary] },
    ];

    const result = stripUnusableSummaryParts(payload);

    expect(result[0]).toBe(payload[0]);
    expect(result[1].content).toEqual([text]);
    expect(payload[1].content).toEqual([text, failedSummary]);
  });

  it('returns the same payload reference when nothing needed stripping', () => {
    const payload = [{ role: 'assistant', content: [completeSummary] }];

    expect(stripUnusableSummaryParts(payload)).toBe(payload);
  });
});
