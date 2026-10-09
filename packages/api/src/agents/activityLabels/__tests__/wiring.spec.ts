import { Providers } from '@librechat/agents';
import type { PostToolBatchHookInput } from '@librechat/agents';
import type { GenerateLabelPayload } from '../runtime';
import type { LooseContentPart } from '../wiring';
import {
  captureActivityBlockContext,
  createActivityLabelWiring,
  stripActivityLabelParts,
  synthesizeActivityLabelGapEvents,
} from '../wiring';
import { ACTIVITY_INSTRUCTION } from '../runtime';

async function flushDetached(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const batchInput = (): PostToolBatchHookInput =>
  ({
    hook_event_name: 'PostToolBatch',
    runId: 'run-1',
    entries: [
      {
        toolName: 'web_search',
        toolInput: { query: 'x' },
        toolUseId: 'tool-1',
        status: 'success',
        toolOutput: 'ok',
      },
    ],
  }) as PostToolBatchHookInput;

describe('createActivityLabelWiring', () => {
  it('captures block context BEFORE pushing the label part', async () => {
    const parts: Array<LooseContentPart | null | undefined> = [
      { type: 'think', think: 'Comparing runtime versions before searching' },
      { type: 'tool_call', tool_call: { id: 'tool-1' } },
    ];
    const capturedPayloads: GenerateLabelPayload[] = [];
    const generateLabel = jest.fn(async (payload: GenerateLabelPayload) => {
      capturedPayloads.push(payload);
      return 'Searched runtime versions';
    });
    const { hook } = createActivityLabelWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      resolveLLM: jest.fn(async () => ({
        provider: Providers.OPENAI,
        clientOptions: { model: 'm' },
      })),
      generateLabel,
    });

    await hook(batchInput(), new AbortController().signal);
    await flushDetached();

    expect(generateLabel).toHaveBeenCalledTimes(1);
    expect(capturedPayloads[0]?.context.thinkingExcerpts).toEqual([
      'Comparing runtime versions before searching',
    ]);
    /** And the label part landed at the tail with the claimed index. */
    expect(parts[2]).toMatchObject({ type: 'activity_label', pending: false });
  });

  it('threads committed labels across batches and seeds from resumed parts', async () => {
    const parts: Array<LooseContentPart | null | undefined> = [
      { type: 'activity_label', activity_label: 'Resumed header', pending: false },
      { type: 'activity_label', activity_label: '', pending: true },
      { type: 'tool_call', tool_call: { id: 'tool-1' } },
    ];
    const payloads: GenerateLabelPayload[] = [];
    let seq = 0;
    const generateLabel = jest.fn(async (payload: GenerateLabelPayload) => {
      payloads.push(payload);
      seq += 1;
      return `Fresh header ${seq}`;
    });
    const { hook } = createActivityLabelWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      resolveLLM: jest.fn(async () => ({
        provider: Providers.OPENAI,
        clientOptions: { model: 'm' },
      })),
      generateLabel,
    });

    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();

    /** The unfilled pending reservation is excluded from the seed; the
     *  committed resumed text and the first fresh commit both thread. */
    expect(payloads[0]?.previousLabels).toEqual(['Resumed header']);
    expect(payloads[1]?.previousLabels).toEqual(['Resumed header', 'Fresh header 1']);
  });
});

describe('captureActivityBlockContext', () => {
  it('stops reasoning collection at a prior label but keeps intent', () => {
    const parts: LooseContentPart[] = [
      { type: 'text', text: 'Let me verify each runtime.' },
      { type: 'think', think: 'Earlier batch reasoning' },
      { type: 'activity_label', activity_label: 'Searched Node versions' },
      { type: 'think', think: 'Current batch reasoning' },
    ];
    const context = captureActivityBlockContext(parts);
    expect(context.thinkingExcerpts).toEqual(['Current batch reasoning']);
    expect(context.lastAssistantText).toBe('Let me verify each runtime.');
  });

  it('filters reasoning by executing agent in multi-agent runs', () => {
    const parts: LooseContentPart[] = [
      { type: 'think', think: 'Agent B reasoning', agentId: 'agent-b' },
      { type: 'think', think: 'Agent A reasoning', agentId: 'agent-a' },
    ];
    const context = captureActivityBlockContext(parts, 'agent-a');
    expect(context.thinkingExcerpts).toEqual(['Agent A reasoning']);
  });
});

describe('stripActivityLabelParts', () => {
  it('removes label parts and keeps the reference when none exist', () => {
    const withLabel = [{ content: [{ type: 'text', text: 'hi' }, { type: 'activity_label' }] }];
    const stripped = stripActivityLabelParts(withLabel);
    expect(stripped[0].content).toHaveLength(1);

    const clean = [{ content: [{ type: 'text', text: 'hi' }] }];
    expect(stripActivityLabelParts(clean)).toBe(clean);
  });
});

describe('captureActivityBlockContext intent filtering', () => {
  it("skips another agent's tail text when resolving intent", () => {
    const parts: LooseContentPart[] = [
      { type: 'text', text: 'Agent A plan for this batch', agentId: 'agent-a' },
      { type: 'text', text: 'Agent B unrelated narration', agentId: 'agent-b' },
    ];
    const context = captureActivityBlockContext(parts, 'agent-a');
    expect(context.lastAssistantText).toBe('Agent A plan for this batch');
  });
});

describe('synthesizeActivityLabelGapEvents', () => {
  const meta = { conversationId: 'c1', responseMessageId: 'm1' };

  it('re-emits a label filled during the snapshot gap', () => {
    const snapshot: LooseContentPart[] = [
      { type: 'tool_call', tool_call: { id: 't1' } },
      { type: 'activity_label', activity_label: '', pending: true },
    ];
    const fresh: LooseContentPart[] = [
      { type: 'tool_call', tool_call: { id: 't1' } },
      { type: 'activity_label', activity_label: 'Searched release notes', pending: false },
    ];
    const events = synthesizeActivityLabelGapEvents(snapshot, fresh, meta);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('on_activity_label');
    expect(events[0].data).toMatchObject({ index: 1, conversationId: 'c1' });
  });

  it('re-emits a label claimed entirely within the gap', () => {
    const fresh: LooseContentPart[] = [
      { type: 'tool_call', tool_call: { id: 't1' } },
      { type: 'activity_label', activity_label: '', pending: true },
    ];
    expect(synthesizeActivityLabelGapEvents([fresh[0]], fresh, meta)).toHaveLength(1);
  });

  it('emits nothing when the snapshot already matches', () => {
    const parts: LooseContentPart[] = [
      { type: 'activity_label', activity_label: 'Same label', pending: false },
    ];
    expect(synthesizeActivityLabelGapEvents(parts, parts, meta)).toEqual([]);
  });

  it('re-emits a completed phase when its reconciled bounds changed', () => {
    const snapshot: LooseContentPart[] = [
      {
        type: 'activity_label',
        activity_label: 'Inspected and fixed the session',
        activity_label_type: 'phase',
        activity_start_index: 0,
        activity_end_index: 1,
        activity_count: 2,
        pending: false,
      },
    ];
    const fresh: LooseContentPart[] = [{ ...snapshot[0], activity_end_index: 2 }];

    expect(synthesizeActivityLabelGapEvents(snapshot, fresh, meta)).toHaveLength(1);
  });
});

describe('createActivityLabelWiring close gate', () => {
  it('drops a late fill once the response has finalized', async () => {
    const parts: Array<LooseContentPart | null | undefined> = [
      { type: 'tool_call', tool_call: { id: 'tool-1' } },
    ];
    const emitLabelEvent = jest.fn(async () => undefined);
    let closed = false;
    let releaseLabel: (value: string) => void = () => undefined;
    const generateLabel = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseLabel = resolve;
        }),
    );
    const { hook } = createActivityLabelWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent,
      trackPendingFill: jest.fn(),
      isClosed: () => closed,
      resolveLLM: jest.fn(async () => ({
        provider: Providers.OPENAI,
        clientOptions: { model: 'm' },
      })),
      generateLabel,
    });

    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    /** Claiming publishes the reservation so replay cannot compact the index
     *  away — empty and pending, which renders nothing. */
    expect(emitLabelEvent).toHaveBeenCalledTimes(1);
    expect(emitLabelEvent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ activity_label: '', pending: true }),
    );

    /** Settle timed out: the scope closes, then the straggler resolves. */
    closed = true;
    releaseLabel('Late label that must not land');
    await flushDetached();

    /** No SECOND emit: the late fill neither mutates nor publishes. */
    expect(emitLabelEvent).toHaveBeenCalledTimes(1);
    const labelPart = parts[1] as LooseContentPart;
    expect(labelPart.activity_label).toBe('');
    expect(labelPart.pending).toBe(true);
  });
});

describe('createActivityLabelWiring reservation', () => {
  /**
   * Without a claim-time event the slot exists only in server memory, so a
   * cross-instance replay rebuilds [tool, <hole>, laterText], compacts the
   * hole, and the fill for the reserved index then overwrites `laterText`.
   * Publishing the empty part keeps the index real for every consumer.
   */
  it('publishes the reserved index before any label exists', async () => {
    const parts: Array<LooseContentPart | null | undefined> = [
      { type: 'tool_call', tool_call: { id: 'tool-1' } },
    ];
    const emitted: Array<{ index: number; label: unknown; pending?: boolean }> = [];
    const emitLabelEvent = jest.fn(async (index: number, part: LooseContentPart) => {
      emitted.push({ index, label: part.activity_label, pending: part.pending });
      return undefined;
    });
    const { hook } = createActivityLabelWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent,
      trackPendingFill: jest.fn(),
      resolveLLM: jest.fn(async () => ({
        provider: Providers.OPENAI,
        clientOptions: { model: 'm' },
      })),
      generateLabel: jest.fn(async () => 'Stored the release notes'),
    });

    await hook(batchInput(), new AbortController().signal);
    await flushDetached();

    /** Reservation first (empty, pending), then the fill at the SAME index. */
    expect(emitted).toEqual([
      { index: 1, label: '', pending: true },
      { index: 1, label: 'Stored the release notes', pending: false },
    ]);
  });

  /** A blank result must still settle the slot, or the client stays pending. */
  it('publishes a settled empty part when generation yields nothing', async () => {
    const parts: Array<LooseContentPart | null | undefined> = [
      { type: 'tool_call', tool_call: { id: 'tool-1' } },
    ];
    const emitLabelEvent = jest.fn(async () => undefined);
    const { hook } = createActivityLabelWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent,
      trackPendingFill: jest.fn(),
      resolveLLM: jest.fn(async () => ({
        provider: Providers.OPENAI,
        clientOptions: { model: 'm' },
      })),
      generateLabel: jest.fn(async () => null),
    });

    await hook(batchInput(), new AbortController().signal);
    await flushDetached();

    expect(emitLabelEvent).toHaveBeenCalledTimes(2);
    expect(emitLabelEvent).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ activity_label: '', pending: false }),
    );
  });
});

describe('createActivityLabelWiring instruction', () => {
  const runWith = async (prompt?: string) => {
    const parts: Array<LooseContentPart | null | undefined> = [
      { type: 'tool_call', tool_call: { id: 'tool-1' } },
    ];
    const generateLabel = jest.fn(async () => 'Confirmed the sandbox resets');
    const { hook } = createActivityLabelWiring({
      getContentParts: () => parts,
      bumpIndexOffset: jest.fn(),
      emitLabelEvent: jest.fn(async () => undefined),
      trackPendingFill: jest.fn(),
      resolveLLM: jest.fn(async () => ({
        provider: Providers.OPENAI,
        clientOptions: { model: 'm' },
      })),
      generateLabel,
      ...(prompt != null && { prompt }),
    });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    return generateLabel;
  };

  /** Without this the SDK path silently uses the published package's own
   *  generic prompt, and only the fallback path gets this repo's register. */
  it('always forwards an instruction to the SDK path', async () => {
    const generateLabel = await runWith();
    expect(generateLabel).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: ACTIVITY_INSTRUCTION }),
    );
  });

  it('prefers the configured activityPrompt when one is set', async () => {
    const generateLabel = await runWith('House style, please');
    expect(generateLabel).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'House style, please' }),
    );
  });
});
