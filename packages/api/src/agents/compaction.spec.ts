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
  markCompactionOutcome,
  resolveFailedTurnContent,
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
