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
  isSettledJobRecord,
  resolveDisconnectSnapshotMode,
  resolveReconciledSnapshotEnvelope,
  planAbortedTurnPersistence,
  resolveAbortedTurnPersistence,
  resolveAbortedTurnAnchorDecision,
  settleExistingRowsBeforeErrorTurn,
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

    const marked = markAbortedCompactionContent(parts, true);

    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ initiatedBy: 'user', failed: true, summarizing: true });
    /** The aggregated parts belong to the live run: the input is untouched. */
    expect(parts[0]).not.toHaveProperty('initiatedBy');
  });

  /** A round that finished before the Stop landed is a real checkpoint: the
   *  race is not a failure. */
  it('marks a summary that completed before the stop without failing it', () => {
    const parts = [completedSummary('Finished before the stop.')];

    const marked = markAbortedCompactionContent(parts, true);

    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ initiatedBy: 'user' });
    expect(marked[0]).not.toHaveProperty('failed');
  });

  /** Every part that can carry the marker gets it: the row's identity must not
   *  depend on which of its parts a reader inspects first. */
  it('marks an error part the stopped run had already recorded', () => {
    const parts: TMessageContentParts[] = [
      partialSummary('Half a summary'),
      { type: ContentTypes.ERROR, error: 'Something else failed first' },
    ];

    const marked = markAbortedCompactionContent(parts, true);

    expect(marked[0]).toMatchObject({ initiatedBy: 'user', failed: true });
    expect(marked[1]).toMatchObject({ initiatedBy: 'user' });
  });

  /** A summary placeholder with no text is not an outcome: nothing of the
   *  round survived to show, so the typed failure is the row's whole
   *  outcome. */
  it('replaces a summary placeholder that streamed nothing with the typed failure', () => {
    const parts = [emptySummaryPlaceholder()];

    const marked = markAbortedCompactionContent(parts, true);

    expect(marked).toEqual([
      {
        type: ContentTypes.ERROR,
        error: JSON.stringify({ type: ErrorTypes.COMPACTION_FAILED }),
        initiatedBy: 'user',
      },
    ]);
  });

  /** An earlier round's checkpoint is not the stopped round's outcome: the
   *  failure lands beside it, or the row reads as the successful compaction
   *  the checkpoint describes (and as a leaf that can no longer compact). */
  it('records the typed failure beside an earlier checkpoint when the current round streamed nothing', () => {
    const parts = [completedSummary('An earlier checkpoint.'), emptySummaryPlaceholder()];

    const marked = markAbortedCompactionContent(parts, true);

    expect(marked).toEqual([
      expect.objectContaining({
        type: ContentTypes.SUMMARY,
        initiatedBy: 'user',
      }),
      {
        type: ContentTypes.ERROR,
        error: JSON.stringify({ type: ErrorTypes.COMPACTION_FAILED }),
        initiatedBy: 'user',
      },
    ]);
  });

  /** Checkpoints are last-summary-wins: an earlier round that never
   *  finished is superseded by the later usable summary, not a failure. */
  it('synthesizes no failure when a later round completed after an empty one', () => {
    const parts = [emptySummaryPlaceholder(), completedSummary('The later checkpoint.')];

    const marked = markAbortedCompactionContent(parts, true);

    expect(marked).toEqual([
      expect.objectContaining({
        type: ContentTypes.SUMMARY,
        initiatedBy: 'user',
      }),
    ]);
  });

  /** A run stopped before any part streamed still needs an identifiable row:
   *  an empty one reads as an answer to the message it hangs off. */
  it('records the typed failure when nothing streamed before the stop', () => {
    const parts: TMessageContentParts[] = [];

    const marked = markAbortedCompactionContent(parts, true);

    expect(marked).toEqual([
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

    const marked = markAbortedCompactionContent(parts, true, { synthesizeFailure: false });

    expect(marked).toEqual([{ ...partialSummary('Half a summary'), initiatedBy: 'user' }]);
    expect(parts[0]).not.toHaveProperty('initiatedBy');
  });

  it('returns content from a turn that was not a compaction unchanged', () => {
    const parts = [partialSummary('An automatic detour partial')];

    expect(markAbortedCompactionContent(parts, false)).toBe(parts);
    expect(parts[0]).not.toHaveProperty('initiatedBy');
  });
});

describe('resolveAbortedTurnAnchorDecision', () => {
  const reader = (exists: boolean) => jest.fn(async () => exists);
  const jobData = {
    compact: true,
    conversationId: 'conversation-1',
    userMessage: { messageId: 'leaf-1' },
  };

  it('keeps the prerequisite user write for an ordinary turn', async () => {
    const messageExists = reader(true);

    await expect(resolveAbortedTurnAnchorDecision({}, { messageExists })).resolves.toBe('persist');
    await expect(resolveAbortedTurnAnchorDecision(null, { messageExists })).resolves.toBe(
      'persist',
    );
    expect(messageExists).not.toHaveBeenCalled();
  });

  /** The compaction's `userMessage` is the persisted leaf projected for
   *  identity only; upserting it would erase the leaf. */
  it('skips the prerequisite write for a compaction anchored on a persisted leaf', async () => {
    await expect(
      resolveAbortedTurnAnchorDecision(jobData, { messageExists: reader(true) }),
    ).resolves.toBe('skip-anchor');
  });

  /** Stop can win the race before the branch loaded, leaving the projection
   *  with no row behind it: a response written there would be orphaned. */
  it('skips the whole turn when the compaction anchor was never persisted', async () => {
    await expect(
      resolveAbortedTurnAnchorDecision(jobData, { messageExists: reader(false) }),
    ).resolves.toBe('skip-turn');
  });

  it('skips the whole turn when a compaction carries no anchor id', async () => {
    const messageExists = reader(true);

    for (const userMessage of [undefined, null, {}, { messageId: '' }]) {
      await expect(
        resolveAbortedTurnAnchorDecision({ ...jobData, userMessage }, { messageExists }),
      ).resolves.toBe('skip-turn');
    }
    expect(messageExists).not.toHaveBeenCalled();
  });

  /** A read that throws must not escape past the caller's remaining cleanup:
   *  nothing is known about the anchor, so nothing is written either. */
  it('skips the whole turn when the anchor read fails', async () => {
    const messageExists = jest.fn(async () => {
      throw new Error('mongo unavailable');
    });

    await expect(resolveAbortedTurnAnchorDecision(jobData, { messageExists })).resolves.toBe(
      'skip-turn',
    );
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

  it('writes the envelope with the marking reapplied when the parts already carry the failure', async () => {
    const saved: Record<string, unknown>[] = [];
    const partialRow = {
      content: [{ type: ContentTypes.ERROR, error: 'Summarization failed', initiatedBy: 'user' }],
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

    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({
      messageId: 'response-1',
      conversationId: 'conversation-1',
      unfinished: false,
      error: true,
      content: [{ type: ContentTypes.ERROR, error: 'Summarization failed', initiatedBy: 'user' }],
    });
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

  /** The surrounding failed-turn persistence treats a falsy save as a
   *  failure, not a settled row. */
  it('fails when the injected save resolves falsy', async () => {
    const partialRow = {
      content: [
        {
          type: ContentTypes.ERROR,
          error: 'Summarization failed',
          initiatedBy: 'user',
        },
      ],
    };

    await expect(
      persistFinalizedCompactionTurn(
        partialRow,
        { compact: true },
        {
          messageId: 'response-1',
          conversationId: 'conversation-1',
          saveMessage: async () => null,
        },
      ),
    ).rejects.toThrow('Failed compaction turn could not be finalized');
  });
});

describe('resolveFinalizedCompactionTurn', () => {
  const compactionFailed = JSON.stringify({ type: ErrorTypes.COMPACTION_FAILED });

  it('leaves a partial row of a turn that was not a compaction alone', () => {
    const row = { content: [{ type: ContentTypes.TEXT, text: 'Partial answer' }] };

    expect(resolveFinalizedCompactionTurn(row, {})).toEqual({ write: false });
  });

  /** The disconnect snapshot is marker-only, so a run that fails afterwards
   *  leaves a row with no summary or error part and no marker at all. */
  it('finalizes a snapshot without a summary or error part with the typed failure', () => {
    const row = { content: [{ type: ContentTypes.THINK, think: 'Picking what to summarize' }] };

    expect(resolveFinalizedCompactionTurn(row, { compact: true })).toEqual({
      write: true,
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
      write: true,
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

  /** The parts already carry the failure, but the snapshot's live-run flags
   *  are still unsettled: the write settles the envelope with the marking
   *  reapplied (idempotent on marked parts). */
  it('settles a row whose parts already carry the failure', () => {
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

    expect(resolveFinalizedCompactionTurn(failedSummary, { compact: true })).toEqual({
      write: true,
      content: failedSummary.content,
    });
    expect(resolveFinalizedCompactionTurn(recordedFailure, { compact: true })).toEqual({
      write: true,
      content: recordedFailure.content,
    });
  });

  /** Legacy and imported rows can carry failure parts that predate the
   *  identity marker: the settle write stamps them, or the restored turn
   *  keeps the wrong rerun target. */
  it('stamps legacy failure parts that never carried the marker', () => {
    const legacyRow = {
      unfinished: true,
      content: [{ type: ContentTypes.ERROR, error: 'Summarization failed' }],
    };

    expect(resolveFinalizedCompactionTurn(legacyRow, { compact: true })).toEqual({
      write: true,
      content: [{ type: ContentTypes.ERROR, error: 'Summarization failed', initiatedBy: 'user' }],
    });
  });

  /** A checkpoint the run completed before failing is preserved as content,
   *  but a snapshot still flagged unfinished settles its envelope: the
   *  restored conversation must not keep treating the terminal job as live. */
  it('settles the envelope of an unfinished snapshot holding a completed checkpoint', () => {
    const snapshot = {
      unfinished: true,
      content: [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'A finished checkpoint.' }],
          boundary: completedBoundary,
        },
      ],
    };

    expect(resolveFinalizedCompactionTurn(snapshot, { compact: true })).toEqual({
      write: true,
      content: [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'A finished checkpoint.' }],
          boundary: completedBoundary,
          initiatedBy: 'user',
        },
      ],
    });
  });

  /** A stopped compaction is written settled by the abort route, and an
   *  error row is settled by its own write: a late failure leaves both. */
  it.each([
    ['a settled error row', [{ type: ContentTypes.ERROR, error: 'Summarization failed' }], true],
    [
      'a settled stopped row',
      [{ type: ContentTypes.SUMMARY, content: [], summarizing: true, initiatedBy: 'user' }],
      false,
    ],
  ])('leaves %s untouched', (_label, content, error) => {
    const row = { unfinished: false, error, content: content as TMessageContentParts[] };

    expect(resolveFinalizedCompactionTurn(row, { compact: true })).toEqual({ write: false });
  });

  it('leaves an already-settled checkpoint row untouched', () => {
    const row = {
      unfinished: false,
      content: [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'A finished checkpoint.' }],
          boundary: completedBoundary,
        },
      ],
    };

    expect(resolveFinalizedCompactionTurn(row, { compact: true })).toEqual({ write: false });
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
      write: true,
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

describe('planAbortedTurnPersistence', () => {
  it('writes both rows for an ordinary turn the abort must persist', () => {
    expect(planAbortedTurnPersistence('persist', true)).toEqual({
      writeUserRow: true,
      writeResponseRow: true,
      responseUnfinished: true,
      withholdFinal: false,
    });
  });

  it('writes only the response for a compaction anchored on a persisted leaf', () => {
    expect(planAbortedTurnPersistence('skip-anchor', true)).toEqual({
      writeUserRow: false,
      writeResponseRow: true,
      responseUnfinished: false,
      withholdFinal: false,
    });
  });

  it('withholds the final and every row when the anchor never persisted', () => {
    expect(planAbortedTurnPersistence('skip-turn', true)).toEqual({
      writeUserRow: false,
      writeResponseRow: false,
      responseUnfinished: false,
      withholdFinal: true,
      withholdReason: expect.stringContaining('anchor unavailable'),
    });
  });

  it('writes nothing for a turn the abort would not persist', () => {
    expect(planAbortedTurnPersistence('persist', false)).toEqual({
      writeUserRow: false,
      writeResponseRow: false,
      responseUnfinished: true,
      withholdFinal: false,
    });
  });

  /** An abort with no persistable content and no created event publishes an
   *  early-abort FINAL of its own; withholding it would replace that frame
   *  with a reconciliation one even though no row was ever at stake. */
  it('does not withhold the final when no row needed writing', () => {
    expect(planAbortedTurnPersistence('skip-turn', false)).toEqual({
      writeUserRow: false,
      writeResponseRow: false,
      responseUnfinished: false,
      withholdFinal: false,
    });
  });
});

describe('resolveAbortedTurnPersistence', () => {
  const jobData = {
    compact: true,
    conversationId: 'conversation-1',
    userMessage: { messageId: 'leaf-1' },
  };

  /** Nothing continues a stopped compaction, so its row is written settled. */
  it('writes a settled response under a persisted compaction anchor', async () => {
    const getMessages = jest.fn(async () => [{ _id: 'row' }]);

    const plan = await resolveAbortedTurnPersistence(jobData, true, {
      userId: 'user-1',
      getMessages,
    });

    expect(getMessages).toHaveBeenCalledWith(
      { user: 'user-1', messageId: 'leaf-1', conversationId: 'conversation-1' },
      '_id',
    );
    expect(plan).toMatchObject({
      writeUserRow: false,
      writeResponseRow: true,
      responseUnfinished: false,
      withholdFinal: false,
      persistenceErrors: [],
    });
  });

  it('reports the withheld final when the compaction anchor is missing', async () => {
    const plan = await resolveAbortedTurnPersistence(jobData, true, {
      userId: 'user-1',
      getMessages: jest.fn(async () => []),
    });

    expect(plan.writeResponseRow).toBe(false);
    expect(plan.withholdFinal).toBe(true);
    expect(plan.persistenceErrors).toHaveLength(1);
    expect(plan.persistenceErrors[0].message).toContain('anchor unavailable');
  });

  /** The outage itself reaches the caller's error boundary, not only the
   *  synthetic withheld-turn reason an absent anchor also produces. */
  it('reports the anchor read failure beside the withheld turn', async () => {
    const outage = new Error('mongo unavailable');

    const plan = await resolveAbortedTurnPersistence(jobData, true, {
      userId: 'user-1',
      getMessages: jest.fn(async () => {
        throw outage;
      }),
    });

    expect(plan.writeResponseRow).toBe(false);
    expect(plan.withholdFinal).toBe(true);
    expect(plan.persistenceErrors[0]).toBe(outage);
    expect(plan.persistenceErrors[1].message).toContain('anchor unavailable');
  });

  it('reads no anchor and reports nothing when the abort writes no row', async () => {
    const getMessages = jest.fn(async () => {
      throw new Error('mongo unavailable');
    });

    const plan = await resolveAbortedTurnPersistence(jobData, false, { getMessages });

    expect(getMessages).not.toHaveBeenCalled();
    expect(plan).toMatchObject({
      writeUserRow: false,
      writeResponseRow: false,
      withholdFinal: false,
      persistenceErrors: [],
    });
  });

  it('keeps an ordinary stopped reply unfinished without reading its anchor', async () => {
    const getMessages = jest.fn(async () => []);

    const plan = await resolveAbortedTurnPersistence({}, true, { getMessages });

    expect(getMessages).not.toHaveBeenCalled();
    expect(plan).toMatchObject({
      writeUserRow: true,
      writeResponseRow: true,
      responseUnfinished: true,
      persistenceErrors: [],
    });
  });
});

describe('settleExistingRowsBeforeErrorTurn', () => {
  const partialSummaryRow = () => ({
    messageId: 'live-response',
    unfinished: true,
    content: [
      {
        type: ContentTypes.SUMMARY,
        content: [{ type: ContentTypes.TEXT, text: 'Half a summary' }],
        summarizing: true,
      },
    ],
  });
  const deps = (rowsByMessageId: Record<string, unknown[]>) => {
    const saved: Record<string, unknown>[] = [];
    return {
      saved,
      deps: {
        userId: 'user-1',
        conversationId: 'conversation-1',
        errorMessageId: 'error-target',
        liveResponseMessageId: 'live-response',
        getMessages: jest.fn(async ({ messageId }: { messageId: string }) =>
          (rowsByMessageId[messageId] ?? []).map((row) => row),
        ) as never,
        saveFinalizedTurn: async (message: Record<string, unknown>) => {
          saved.push(message);
          return message;
        },
      },
    };
  };

  it('settles a compaction snapshot under its live id and blocks the error row', async () => {
    const { saved, deps: d } = deps({ 'live-response': [partialSummaryRow()] });

    await expect(settleExistingRowsBeforeErrorTurn({ compact: true }, d)).resolves.toEqual({
      covered: true,
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      messageId: 'live-response',
      unfinished: false,
      error: true,
    });
  });

  /** The error row's own path announces the persisted turn; a finalized live
   *  row stands in for it, so it is announced the same way. */
  it('announces the live row it finalized', async () => {
    const announceSettledTurn = jest.fn(async () => undefined);
    const { deps: d } = deps({ 'live-response': [partialSummaryRow()] });

    await settleExistingRowsBeforeErrorTurn({ compact: true }, { ...d, announceSettledTurn });

    expect(announceSettledTurn).toHaveBeenCalledWith('live-response');
  });

  it('announces nothing when the existing row needed no write', async () => {
    const announceSettledTurn = jest.fn(async () => undefined);
    const { saved, deps: d } = deps({ 'live-response': [{ messageId: 'live-response' }] });

    await settleExistingRowsBeforeErrorTurn({}, { ...d, announceSettledTurn });

    expect(saved).toHaveLength(0);
    expect(announceSettledTurn).not.toHaveBeenCalled();
  });

  /** The error id normalizes back to the anchor itself when the anchor ends
   *  in `_`: the anchor match must not stop the live row from settling, and
   *  nothing may be written over that match. */
  it('settles the live row past an anchor-shaped collision', async () => {
    const { saved, deps: d } = deps({
      'error-target': [{ messageId: 'error-target', _id: 'anchor-shaped-match' }],
      'live-response': [partialSummaryRow()],
    });

    await expect(settleExistingRowsBeforeErrorTurn({ compact: true }, d)).resolves.toEqual({
      covered: true,
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ messageId: 'live-response' });
  });

  /** The collision with no live row saved must not swallow the failure: the
   *  error row proceeds under the failed run's own response id, where it can
   *  never overwrite the anchor. */
  it('redirects the error row to the live id when only the anchor matched', async () => {
    const { saved, deps: d } = deps({
      'error-target': [{ messageId: 'error-target', _id: 'anchor-shaped-match' }],
    });

    await expect(settleExistingRowsBeforeErrorTurn({ compact: true }, d)).resolves.toEqual({
      covered: false,
      errorRowMessageId: 'live-response',
    });

    expect(saved).toHaveLength(0);
  });

  /** A failure before the response id was allocated leaves nowhere safe to
   *  write the error row: writing it under the error id would overwrite the
   *  anchor, so it is withheld instead. */
  it('withholds the error row when the collision has no live id to redirect to', async () => {
    const { saved, deps: d } = deps({
      'error-target': [{ messageId: 'error-target', _id: 'anchor-shaped-match' }],
    });
    const { liveResponseMessageId: _omitted, ...dWithoutLiveId } = d;

    await expect(
      settleExistingRowsBeforeErrorTurn({ compact: true }, dWithoutLiveId),
    ).resolves.toEqual({ covered: true });

    expect(saved).toHaveLength(0);
  });

  it('blocks the error row for an ordinary turn with an existing row, writing nothing', async () => {
    const { saved, deps: d } = deps({
      'error-target': [{ messageId: 'error-target', _id: 'existing' }],
      'live-response': [{ messageId: 'live-response', _id: 'partial' }],
    });

    await expect(settleExistingRowsBeforeErrorTurn({}, d)).resolves.toEqual({ covered: true });

    expect(saved).toHaveLength(0);
    // The ordinary early return never reads the live row.
    expect(d.getMessages).toHaveBeenCalledTimes(1);
  });

  it('lets the error row through when no row covers the turn', async () => {
    const { saved, deps: d } = deps({});

    await expect(settleExistingRowsBeforeErrorTurn({ compact: true }, d)).resolves.toEqual({
      covered: false,
      errorRowMessageId: 'error-target',
    });

    expect(saved).toHaveLength(0);
  });
});

describe('isSettledJobRecord', () => {
  it.each(['complete', 'error', 'aborted'])('treats a %s record as settled', (status) => {
    expect(isSettledJobRecord({ createdAt: 1000, status })).toBe(true);
  });

  /** The terminal claim precedes its row write, so the status alone does not
   *  prove the row is durable: the snapshot stays the fallback until the
   *  pending marker clears. */
  it('treats a record with terminal persistence still pending as unsettled', () => {
    expect(
      isSettledJobRecord({ createdAt: 1000, status: 'error', terminalPersistencePending: true }),
    ).toBe(false);
  });

  /** A failed terminal write clears the marker while publishing a
   *  reconciliation frame: no row was persisted, so the streamed snapshot
   *  stays the turn's only fallback. */
  it('treats a record whose durable final event is a reconciliation frame as unsettled', () => {
    const reconciled = {
      createdAt: 1000,
      status: 'aborted',
      finalEvent: JSON.stringify({ final: true, reconcile: true }),
    };
    const settled = {
      createdAt: 1000,
      status: 'aborted',
      finalEvent: JSON.stringify({ final: true }),
    };

    expect(isSettledJobRecord(reconciled)).toBe(false);
    expect(isSettledJobRecord(settled)).toBe(true);
  });

  it('leaves live and missing records unsettled', () => {
    expect(isSettledJobRecord({ createdAt: 1000, status: 'running' })).toBe(false);
    expect(isSettledJobRecord({ createdAt: 1000, status: 'requires_action' })).toBe(false);
    expect(isSettledJobRecord(null)).toBe(false);
    expect(isSettledJobRecord(undefined)).toBe(false);
  });

  /** Another epoch's record describes a different generation, not this one. */
  it('ignores a record from another epoch', () => {
    expect(isSettledJobRecord({ createdAt: 2000, status: 'error' }, 1000)).toBe(false);
    expect(isSettledJobRecord({ createdAt: 1000, status: 'error' }, 1000)).toBe(true);
  });
});

describe('resolveDisconnectSnapshotMode', () => {
  it.each(['complete', 'error', 'aborted'])(
    'withholds the snapshot of a %s compaction job',
    async (status) => {
      await expect(
        resolveDisconnectSnapshotMode(true, { createdAt: 1000, status }, 1000),
      ).resolves.toBe('skip');
    },
  );

  it('writes the snapshot for a live, missing, or other-epoch record', async () => {
    await expect(
      resolveDisconnectSnapshotMode(true, { createdAt: 1000, status: 'running' }, 1000),
    ).resolves.toBe('live');
    await expect(resolveDisconnectSnapshotMode(true, null, 1000)).resolves.toBe('live');
    await expect(
      resolveDisconnectSnapshotMode(true, { createdAt: 2000, status: 'error' }, 1000),
    ).resolves.toBe('live');
  });

  /** A durable terminal row settles an ordinary turn too: a late snapshot
   *  would reopen the completed reply. */
  it('withholds the snapshot of a settled ordinary turn', async () => {
    await expect(
      resolveDisconnectSnapshotMode(false, { createdAt: 1000, status: 'complete' }, 1000),
    ).resolves.toBe('skip');
  });

  /** Only a compaction is promoted: an ordinary turn whose terminal write
   *  reconciled keeps its live snapshot as the fallback row. */
  it('keeps a reconciled ordinary turn on its live snapshot', async () => {
    const anchorExists = jest.fn(async () => true);
    await expect(
      resolveDisconnectSnapshotMode(
        false,
        {
          createdAt: 1000,
          status: 'complete',
          finalEvent: JSON.stringify({ final: true, reconcile: true }),
        },
        1000,
        { anchorExists },
      ),
    ).resolves.toBe('live');
    expect(anchorExists).not.toHaveBeenCalled();
  });

  const reconciled = () => ({
    createdAt: 1000,
    status: 'error',
    finalEvent: JSON.stringify({ final: true, reconcile: true }),
  });

  /** The terminal write failed and settled for a reconciliation frame: the
   *  snapshot is promoted to the turn's terminal row, because no other row
   *  will ever be persisted for it. */
  it('promotes a reconciled compaction snapshot to the terminal row', async () => {
    await expect(resolveDisconnectSnapshotMode(true, reconciled(), 1000)).resolves.toBe('terminal');
  });

  /** The promotion must not recreate the orphan an absent-anchor abort
   *  deliberately withheld: without a persisted anchor there is nothing to
   *  hang the terminal row on. */
  it('withholds a reconciled snapshot whose anchor was never persisted', async () => {
    await expect(
      resolveDisconnectSnapshotMode(true, reconciled(), 1000, {
        anchorExists: async () => false,
      }),
    ).resolves.toBe('skip');
  });
});

describe('resolveReconciledSnapshotEnvelope', () => {
  it('keeps the abort row shape for an aborted claim', () => {
    expect(resolveReconciledSnapshotEnvelope('aborted')).toEqual({
      unfinished: true,
      error: false,
    });
  });

  it('settles a completed claim as a finished row', () => {
    expect(resolveReconciledSnapshotEnvelope('complete')).toEqual({
      unfinished: false,
      error: false,
    });
  });

  it('settles everything else with the error envelope', () => {
    expect(resolveReconciledSnapshotEnvelope('error')).toEqual({
      unfinished: false,
      error: true,
    });
    expect(resolveReconciledSnapshotEnvelope(undefined)).toEqual({
      unfinished: false,
      error: true,
    });
  });
});
