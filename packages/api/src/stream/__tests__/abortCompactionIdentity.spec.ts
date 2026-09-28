/**
 * A Stop persists the aborted turn from job data alone, so the row only knows
 * the run was a compaction through the job's `compact` metadata. Without the
 * marker the stopped row reads as an answer to the message it hangs off and
 * keeps that message's rerun controls: on a branch ending in a user message,
 * Regenerate would answer the user turn behind the compaction.
 */
import { ContentTypes, ErrorTypes } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';

/** Suppress winston Console transport output (survives jest.resetModules) */
jest.spyOn(console, 'log').mockImplementation();

const COMPACTION_FAILED_ERROR = JSON.stringify({ type: ErrorTypes.COMPACTION_FAILED });

/** Streamed deltas never carry a boundary; a stopped round keeps them. */
const partialSummary: Agents.MessageContentComplex = {
  type: ContentTypes.SUMMARY,
  content: [{ type: ContentTypes.TEXT, text: 'Half a summary' }],
  summarizing: true,
};

const partialText: Agents.MessageContentComplex = { type: ContentTypes.TEXT, text: 'Partial' };

/** The abort result's `finalEvent` is `unknown` to the interface; the fields
 *  these tests read are the ones the abort FINAL always carries. */
type AbortFinalEvent = {
  responseMessage?: { unfinished?: boolean; error?: boolean } | null;
  earlyAbort?: boolean;
};

async function configureManager() {
  const { GenerationJobManager } = await import('../GenerationJobManager');
  const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
  const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

  const jobStore = new InMemoryJobStore();
  GenerationJobManager.configure({
    jobStore,
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
    cleanupOnComplete: false,
  });
  GenerationJobManager.initialize();
  return { manager: GenerationJobManager, jobStore };
}

describe('abortJob compaction identity', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('stamps the partial summary a stopped compaction had streamed', async () => {
    const { manager, jobStore } = await configureManager();
    const streamId = 'abort-compaction-partial';
    const job = await manager.createJob(streamId, 'user-1', 'conversation-1', {
      initialMetadata: { compact: true },
    });
    jobStore.setContentParts(streamId, [partialSummary], job.createdAt);

    const result = await manager.abortJob(streamId);
    const finalEvent = result.finalEvent as AbortFinalEvent;

    expect(result.success).toBe(true);
    /** The row keeps its unfinished shape; only the marker is added. */
    expect(finalEvent.responseMessage).toMatchObject({ unfinished: true, error: false });
    expect(result.content).toEqual([
      { ...partialSummary, initiatedBy: 'user' } as Agents.MessageContentComplex,
    ]);

    await manager.destroy();
  });

  /** A run stopped before any part streamed still needs an identifiable row:
   *  an empty one reads as an answer to the message it hangs off. */
  it('records the typed failure when a stopped compaction streamed nothing', async () => {
    const { manager } = await configureManager();
    const streamId = 'abort-compaction-empty';
    await manager.createJob(streamId, 'user-1', 'conversation-1', {
      initialMetadata: { compact: true },
    });

    const result = await manager.abortJob(streamId);
    const finalEvent = result.finalEvent as AbortFinalEvent;
    const expectedContent: Agents.MessageContentComplex[] = [
      {
        type: ContentTypes.ERROR,
        error: COMPACTION_FAILED_ERROR,
        initiatedBy: 'user',
      },
    ];

    expect(result.success).toBe(true);
    expect(result.content).toEqual(expectedContent);
    /** The typed failure makes the row persistable, so this is not an early
     *  abort: the compaction's turn exists and must reach storage. */
    expect(finalEvent.responseMessage).not.toBeNull();
    expect(finalEvent.earlyAbort).not.toBe(true);

    await manager.destroy();
  });

  it('leaves a stopped ordinary turn without the marker', async () => {
    const { manager, jobStore } = await configureManager();
    const streamId = 'abort-ordinary-turn';
    const job = await manager.createJob(streamId, 'user-1', 'conversation-1');
    jobStore.setContentParts(streamId, [partialText], job.createdAt);

    const result = await manager.abortJob(streamId);

    expect(result.success).toBe(true);
    expect(result.content).toEqual([partialText]);
    expect(result.content[0]).not.toHaveProperty('initiatedBy');

    await manager.destroy();
  });
});
