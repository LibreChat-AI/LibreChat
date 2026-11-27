import { Providers } from '@librechat/agents';
import type { PostToolBatchHookInput } from '@librechat/agents';

const mockInvoke = jest.fn();
const mockInitializeModel = jest.fn(() => ({ invoke: mockInvoke }));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  initializeModel: (...args: unknown[]) => mockInitializeModel(...(args as [])),
}));

import {
  ACTIVITY_INSTRUCTION,
  buildPrompt,
  classifyBatch,
  createActivityLabelHook,
} from '../runtime';
import type { ActivityLabelBatchMeta, ActivityLabelSlot, GenerateLabelPayload } from '../runtime';

/** Flushes the hook's detached generation chain. */
async function flushDetached(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function batchInput(overrides: Partial<PostToolBatchHookInput> = {}): PostToolBatchHookInput {
  return {
    hook_event_name: 'PostToolBatch',
    runId: 'run-1',
    entries: [
      {
        toolName: 'web_search',
        toolInput: { query: 'librechat' },
        toolUseId: 'tool-1',
        status: 'success',
        toolOutput: 'ten results about librechat',
      },
    ],
    ...overrides,
  } as PostToolBatchHookInput;
}

describe('classifyBatch', () => {
  it('collects the covered tool calls and derives batch status', () => {
    const meta = classifyBatch([
      { toolName: 'web_search', toolInput: {}, toolUseId: 'a', status: 'success', toolOutput: '' },
      { toolName: 'read_file', toolInput: {}, toolUseId: 'b', status: 'success', toolOutput: '' },
      { toolName: 'edit_file', toolInput: {}, toolUseId: 'c', status: 'error', error: 'denied' },
    ]);
    expect(meta.toolCallIds).toEqual(['a', 'b', 'c']);
    expect(meta.status).toBe('partial');
  });

  it('reports failed when every tool errors', () => {
    const meta = classifyBatch([
      { toolName: 'bash_tool', toolInput: {}, toolUseId: 'x', status: 'error', error: 'boom' },
    ]);
    expect(meta.status).toBe('failed');
  });

  /** A tool-type tally could only echo the cards under the header, so the
   *  metadata deliberately has no place to put one. */
  it('carries no tool-type tally', () => {
    const meta = classifyBatch([
      { toolName: 'bash_tool', toolInput: {}, toolUseId: 'x', status: 'success', toolOutput: '' },
    ]);
    expect(Object.keys(meta).sort()).toEqual(['status', 'toolCallIds']);
  });
});

describe('ACTIVITY_INSTRUCTION', () => {
  it('forbids restating what the tool cards already show', () => {
    expect(ACTIVITY_INSTRUCTION).toMatch(/never name the tools/i);
    expect(ACTIVITY_INSTRUCTION).toMatch(/never count them/i);
    expect(ACTIVITY_INSTRUCTION).toMatch(/never echo the arguments/i);
  });

  it('asks for a past-tense outcome, not the attempt', () => {
    expect(ACTIVITY_INSTRUCTION).toMatch(/past tense/i);
    expect(ACTIVITY_INSTRUCTION).toMatch(/outcome, not the attempt/i);
  });
});

describe('buildPrompt', () => {
  it('carries intent and marks the calls as reference material', () => {
    const prompt = buildPrompt(
      [
        {
          toolName: 'bash_tool',
          toolInput: { command: 'ls /mnt/data' },
          toolUseId: 'a',
          status: 'success',
          toolOutput: 'empty',
        },
      ],
      600,
      {
        lastAssistantText: 'Let me check what is actually in /mnt/data',
        thinkingExcerpts: ['The filesystem seems to reset between calls'],
      },
    );
    expect(prompt).toContain('Let me check what is actually in /mnt/data');
    expect(prompt).toContain('The filesystem seems to reset between calls');
    expect(prompt).toContain('do not restate these');
    /** Outputs are the whole reason this runs after the batch. */
    expect(prompt).toContain('empty');
  });

  it('uses the caller instruction verbatim when one is supplied', () => {
    const prompt = buildPrompt([], 600, undefined, 'CUSTOM RULE');
    expect(prompt.startsWith('CUSTOM RULE')).toBe(true);
    expect(prompt).not.toContain('git commit subject');
  });

  it('renders previous headers ahead of block context, oldest dropped at the cap', () => {
    const prompt = buildPrompt(
      batchInput().entries,
      600,
      { lastAssistantText: 'Now verifying persistence.' },
      undefined,
      ['One header', 'Two header', 'Three header', 'Four header'],
    );
    expect(prompt).toContain('Previous headers in this run (most recent last):');
    expect(prompt).not.toContain('- One header');
    expect(prompt.indexOf('- Two header')).toBeLessThan(prompt.indexOf('- Three header'));
    expect(prompt.indexOf('- Four header')).toBeLessThan(prompt.indexOf('Intent'));
  });

  it('omits the previous-headers section when the list is empty', () => {
    /** The instruction itself references "Previous headers", so the absence
     *  check must target the section heading, not the phrase. */
    const prompt = buildPrompt(batchInput().entries, 600, undefined, undefined, []);
    expect(prompt).not.toContain('Previous headers in this run');
  });

  /**
   * Serialization is bounded: a multi-megabyte tool result must not be fully
   * materialized just to keep a few hundred characters, and what IS kept must
   * truncate exactly as the unbounded path did.
   */
  it('truncates giant outputs with the ellipsis without serializing them whole', () => {
    const giant = 'x'.repeat(5_000_000);
    const prompt = buildPrompt(
      [
        {
          toolName: 'reader',
          toolInput: { rows: Array.from({ length: 100_000 }, (_, i) => ({ i, giant })) },
          toolUseId: 'a',
          status: 'success',
          toolOutput: giant,
        },
      ],
      600,
    );
    const line = prompt.split('\n').find((l) => l.startsWith('- reader')) ?? '';
    /** Instruction + intent + one entry line: nothing retains the megabytes. */
    expect(prompt.length).toBeLessThan(3_000);
    expect(line).toContain('…');
    expect(line).toContain('x'.repeat(100));
  });

  /** `activityCharLimit` is documented as the per-entry limit for tool input
   *  AND output — a hard-coded input cap would make the setting unable to
   *  reach a distinguishing path or query past the first 200 characters. */
  it('applies the configured charLimit to tool inputs, not a hard-coded cap', () => {
    const longQuery = 'q'.repeat(400);
    const prompt = buildPrompt(
      [
        {
          toolName: 'search',
          toolInput: { query: longQuery },
          toolUseId: 'a',
          status: 'success',
          toolOutput: 'ok',
        },
      ],
      450,
    );
    /** 400-char argument survives intact under a 450 limit (the old 200-char
     *  cap would have cut it), while a tighter limit still truncates. */
    expect(prompt).toContain(longQuery);
    const tight = buildPrompt(
      [
        {
          toolName: 'search',
          toolInput: { query: longQuery },
          toolUseId: 'a',
          status: 'success',
          toolOutput: 'ok',
        },
      ],
      50,
    );
    expect(tight).not.toContain('q'.repeat(60));
    expect(tight).toContain('…');
  });

  /** Per-entry truncation alone leaves the batch dimension unbounded: a
   *  parallel batch of hundreds of calls must not build a prompt past the
   *  fast model's window. */
  it('bounds the total entries section for giant parallel batches', () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      toolName: `tool_${i}`,
      toolInput: { i },
      toolUseId: `t${i}`,
      status: 'success' as const,
      toolOutput: 'y'.repeat(500),
    }));
    const prompt = buildPrompt(entries, 600);
    expect(prompt.length).toBeLessThan(15_000);
    expect(prompt).toMatch(/\(\+\d+ more tool calls not shown\)/);
    /** Prefix semantics: the first entry is always present in full. */
    expect(prompt).toContain('- tool_0(');
    expect(prompt).not.toContain('- tool_199(');
  });

  it('shows every entry when the batch fits the budget', () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({
      toolName: `tool_${i}`,
      toolInput: { i },
      toolUseId: `t${i}`,
      status: 'success' as const,
      toolOutput: 'ok',
    }));
    const prompt = buildPrompt(entries, 600);
    expect(prompt).toContain('- tool_2(');
    expect(prompt).not.toContain('more tool calls not shown');
  });

  it('serializes small structured values exactly like JSON.stringify', () => {
    const toolInput = { q: 'docs', filters: { lang: 'en', page: 2 }, ids: [1, 2] };
    const prompt = buildPrompt(
      [{ toolName: 'search', toolInput, toolUseId: 'a', status: 'success', toolOutput: 'ok' }],
      600,
    );
    expect(prompt).toContain(`search(${JSON.stringify(toolInput)})`);
  });
});

describe('createActivityLabelHook', () => {
  let slots: Array<{ index: number; filled: Array<string | null> }>;
  let claimSlot: () => ActivityLabelSlot;
  const resolveLLM = jest.fn(async () => ({
    provider: Providers.OPENAI,
    clientOptions: { model: 'small-model' },
  }));

  beforeEach(() => {
    jest.clearAllMocks();
    slots = [];
    claimSlot = () => {
      const record = { index: slots.length, filled: [] as Array<string | null> };
      slots.push(record);
      return {
        index: record.index,
        fill: (text) => {
          record.filled.push(text);
          return true;
        },
      };
    };
    mockInvoke.mockResolvedValue({ content: ' Searched the web for LibreChat docs. ' });
  });

  it('returns {} synchronously and fills the claimed slot when the model resolves', async () => {
    const hook = createActivityLabelHook({ claimSlot, resolveLLM });
    const result = await hook(batchInput(), new AbortController().signal);
    expect(result).toEqual({});
    expect(slots).toHaveLength(1);
    expect(slots[0].filled).toHaveLength(0);

    await flushDetached();
    expect(slots[0].filled).toEqual(['Searched the web for LibreChat docs.']);
    expect(mockInitializeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: Providers.OPENAI,
        clientOptions: expect.objectContaining({ model: 'small-model', streaming: false }),
      }),
    );
  });

  it('claims no slot for an empty batch', async () => {
    const hook = createActivityLabelHook({ claimSlot, resolveLLM });
    await hook(batchInput({ entries: [] }), new AbortController().signal);
    await flushDetached();
    expect(slots).toHaveLength(0);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('fills null when generation fails, without rejecting', async () => {
    mockInvoke.mockRejectedValue(new Error('provider down'));
    const hook = createActivityLabelHook({ claimSlot, resolveLLM });
    await expect(hook(batchInput(), new AbortController().signal)).resolves.toEqual({});
    await flushDetached();
    expect(slots[0].filled).toEqual([null]);
  });

  it('fills null for blank model output', async () => {
    mockInvoke.mockResolvedValue({ content: '   ' });
    const hook = createActivityLabelHook({ claimSlot, resolveLLM });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    expect(slots[0].filled).toEqual([null]);
  });

  /** A pure-handoff batch gets no label: the transfer card already names
   *  the destination, and the client renders transfers standalone, so a
   *  label could only orphan. Must not consume `maxPerRun` either. */
  it('claims nothing for a batch of only transfer calls', async () => {
    const hook = createActivityLabelHook({ claimSlot, resolveLLM });
    await hook(
      batchInput({
        entries: [
          {
            toolName: 'lc_transfer_to_billing_agent',
            toolInput: {},
            toolUseId: 'x1',
            status: 'success',
            toolOutput: '',
          },
        ],
      }),
      new AbortController().signal,
    );
    await flushDetached();
    expect(slots).toHaveLength(0);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  /** Mixed batches skip too: the client flushes the block at the transfer
   *  card, so the label would orphan even when real tools ran alongside. */
  it('claims nothing for a mixed batch containing a transfer call', async () => {
    const hook = createActivityLabelHook({ claimSlot, resolveLLM });
    await hook(
      batchInput({
        entries: [
          {
            toolName: 'lc_transfer_to_billing_agent',
            toolInput: {},
            toolUseId: 'x1',
            status: 'success',
            toolOutput: '',
          },
          {
            toolName: 'web_search',
            toolInput: { query: 'refund policy' },
            toolUseId: 'x2',
            status: 'success',
            toolOutput: 'found it',
          },
        ],
      }),
      new AbortController().signal,
    );
    await flushDetached();
    expect(slots).toHaveLength(0);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('skips subagent scopes entirely', async () => {
    const hook = createActivityLabelHook({ claimSlot, resolveLLM });
    await hook(batchInput({ agentId: 'subagent-1' }), new AbortController().signal);
    await flushDetached();
    expect(slots).toHaveLength(0);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('passes executingAgentId through to the claimed slot metadata', async () => {
    const captured: ActivityLabelBatchMeta[] = [];
    const hook = createActivityLabelHook({
      claimSlot: (meta) => {
        captured.push(meta);
        return { index: 0, fill: () => true };
      },
      resolveLLM,
    });
    await hook(batchInput({ executingAgentId: 'agent-a' }), new AbortController().signal);
    await flushDetached();
    expect(captured[0].executingAgentId).toBe('agent-a');
    expect(captured[0].status).toBe('ok');
  });

  it('prefers the SDK-backed generateLabel path with a per-slot trace seed', async () => {
    const generateLabel = jest.fn(async () => 'Searched runtime release notes');
    const hook = createActivityLabelHook({ claimSlot, resolveLLM, generateLabel });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    expect(generateLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        traceSeed: 'run-1-activity-0',
        charLimit: 600,
        entries: expect.any(Array),
        context: expect.any(Object),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(mockInitializeModel).not.toHaveBeenCalled();
    expect(slots[0].filled).toEqual(['Searched runtime release notes']);
  });

  describe('continuity', () => {
    it('threads committed labels into later payloads, oldest dropped at the cap', async () => {
      const payloads: GenerateLabelPayload[] = [];
      let seq = 0;
      const generateLabel = jest.fn(async (payload: GenerateLabelPayload) => {
        payloads.push(payload);
        seq += 1;
        return `Header ${seq}`;
      });
      const hook = createActivityLabelHook({ claimSlot, resolveLLM, generateLabel });
      for (let i = 0; i < 5; i += 1) {
        await hook(batchInput(), new AbortController().signal);
        await flushDetached();
      }
      expect(payloads[0].previousLabels).toBeUndefined();
      expect(payloads[1].previousLabels).toEqual(['Header 1']);
      expect(payloads[3].previousLabels).toEqual(['Header 1', 'Header 2', 'Header 3']);
      expect(payloads[4].previousLabels).toEqual(['Header 2', 'Header 3', 'Header 4']);
    });

    it('excludes uncommitted fills from continuity', async () => {
      const payloads: GenerateLabelPayload[] = [];
      const generateLabel = jest.fn(async (payload: GenerateLabelPayload) => {
        payloads.push(payload);
        return 'Dropped header';
      });
      let claims = 0;
      const hook = createActivityLabelHook({
        claimSlot: () => ({ index: claims++, fill: () => false }),
        resolveLLM,
        generateLabel,
      });
      await hook(batchInput(), new AbortController().signal);
      await flushDetached();
      await hook(batchInput(), new AbortController().signal);
      await flushDetached();
      expect(payloads[1].previousLabels).toBeUndefined();
    });

    it('seeds continuity from resumed labels, in index order', async () => {
      const payloads: GenerateLabelPayload[] = [];
      const generateLabel = jest.fn(async (payload: GenerateLabelPayload) => {
        payloads.push(payload);
        return 'Fresh header';
      });
      let claims = 0;
      const hook = createActivityLabelHook({
        claimSlot: () => ({ index: 10 + claims++, fill: () => true }),
        resolveLLM,
        generateLabel,
        initialGeneratedCount: 2,
        initialLabels: [
          { index: 7, text: 'Resumed late header' },
          { index: 4, text: 'Resumed early header' },
        ],
      });
      await hook(batchInput(), new AbortController().signal);
      await flushDetached();
      expect(payloads[0].previousLabels).toEqual(['Resumed early header', 'Resumed late header']);
    });

    it('renders previous headers on the fallback path', async () => {
      mockInvoke
        .mockResolvedValueOnce({ content: 'Wrote the marker file' })
        .mockResolvedValueOnce({ content: 'Confirmed the marker persists' });
      const hook = createActivityLabelHook({ claimSlot, resolveLLM });
      await hook(batchInput(), new AbortController().signal);
      await flushDetached();
      await hook(batchInput(), new AbortController().signal);
      await flushDetached();
      const secondPrompt = mockInvoke.mock.calls[1][0] as string;
      expect(secondPrompt).toContain(
        'Previous headers in this run (most recent last):\n- Wrote the marker file',
      );
    });
  });

  it('claims nothing when the host abort signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const hook = createActivityLabelHook({ claimSlot, resolveLLM, signal: controller.signal });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    expect(slots).toHaveLength(0);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('runs per-generation invoke callbacks and collects usage on the fallback path', async () => {
    const collect = jest.fn();
    const handleLLMEnd = jest.fn();
    const getInvokeCallbacks = jest.fn(() => ({ callbacks: [{ handleLLMEnd }], collect }));
    const hook = createActivityLabelHook({ claimSlot, resolveLLM, getInvokeCallbacks });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    expect(getInvokeCallbacks).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ callbacks: [{ handleLLMEnd }] }),
    );
    expect(collect).toHaveBeenCalledTimes(1);
  });

  /**
   * Billing runs only AFTER the visible label commits. Billing first let the
   * settlement deadline expire during the balance write, after which the fill
   * was dropped as out-of-scope: charged, never shown.
   */
  it('collects usage after the fill commits, in that order', async () => {
    const order: string[] = [];
    const collect = jest.fn(() => void order.push('collect'));
    const getInvokeCallbacks = jest.fn(() => ({ callbacks: [], collect }));
    const hook = createActivityLabelHook({
      claimSlot: () => ({
        index: 0,
        fill: () => {
          order.push('fill');
          return true;
        },
      }),
      resolveLLM,
      getInvokeCallbacks,
    });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    expect(order).toEqual(['fill', 'collect']);
  });

  /**
   * The settle must cover billing, not just the fill: deferred usage runs
   * after `fill` resolves, so a settle keyed on fills alone would let
   * finalization flush the usage sink while billing was still in flight.
   */
  it('reports a detached task that resolves only after usage collection', async () => {
    let releaseCollect: () => void = () => undefined;
    const collect = jest.fn(() => new Promise<void>((resolve) => (releaseCollect = resolve)));
    const tracked: Array<Promise<void>> = [];
    const hook = createActivityLabelHook({
      claimSlot: () => ({ index: 0, fill: () => true }),
      resolveLLM,
      getInvokeCallbacks: () => ({ callbacks: [], collect }),
      trackTask: (task) => void tracked.push(task),
    });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    expect(tracked).toHaveLength(1);
    let settled = false;
    void tracked[0].then(() => (settled = true));
    await flushDetached();
    /** Collection is still pending, so the task must be too. */
    expect(collect).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    releaseCollect();
    await flushDetached();
    expect(settled).toBe(true);
  });

  it('suppresses usage collection when the host drops the fill', async () => {
    const collect = jest.fn();
    const getInvokeCallbacks = jest.fn(() => ({ callbacks: [], collect }));
    const hook = createActivityLabelHook({
      /** `false` = the response finalized and the label never surfaced. */
      claimSlot: () => ({ index: 0, fill: () => false }),
      resolveLLM,
      getInvokeCallbacks,
    });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    expect(collect).not.toHaveBeenCalled();
  });

  it('runs usage accounting the SDK path deferred, after the commit', async () => {
    const order: string[] = [];
    const recordUsage = jest.fn(() => void order.push('usage'));
    const generateLabel = jest.fn(
      async ({ deferUsage }: { deferUsage: (fn: () => void) => void }) => {
        deferUsage(recordUsage);
        return 'Traced the failing request';
      },
    );
    const hook = createActivityLabelHook({
      claimSlot: () => ({
        index: 0,
        fill: () => {
          order.push('fill');
          return true;
        },
      }),
      resolveLLM,
      generateLabel,
    });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    expect(order).toEqual(['fill', 'usage']);
  });

  /** Title-convention estimated billing: when the provider omits usage
   *  metadata, the biller falls back to counting text — so the hook must
   *  hand it the EXACT prompt the direct path sent plus the final label. */
  it('passes a lazy usage estimate carrying the exact prompt and raw completion', async () => {
    /** Multi-line reply: only line one persists as the label, but the model
     *  GENERATED (and the provider would bill) the whole thing — the
     *  estimate must count the raw output, not the normalized 200-char cap. */
    mockInvoke.mockResolvedValue({
      content: 'Searched the web for LibreChat docs.\nExtra verbose reasoning the model emitted.',
    });
    const collect = jest.fn();
    const getInvokeCallbacks = jest.fn(() => ({ callbacks: [], collect }));
    const hook = createActivityLabelHook({ claimSlot, resolveLLM, getInvokeCallbacks });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    expect(slots[0].filled).toEqual(['Searched the web for LibreChat docs.']);
    expect(collect).toHaveBeenCalledTimes(1);
    const estimateThunk = collect.mock.calls[0][0] as () => {
      promptText: string;
      completionText: string;
    };
    expect(typeof estimateThunk).toBe('function');
    const estimate = estimateThunk();
    expect(estimate.promptText).toBe(mockInvoke.mock.calls[0][0]);
    expect(estimate.completionText).toContain('Extra verbose reasoning the model emitted.');
  });

  it('passes no estimate when generation threw before a label', async () => {
    const recordUsage = jest.fn();
    const generateLabel = jest.fn(
      async ({ deferUsage }: { deferUsage: (fn: (estimate?: unknown) => void) => void }) => {
        deferUsage(recordUsage);
        throw new Error('mid-call failure');
      },
    );
    const hook = createActivityLabelHook({
      claimSlot: () => ({ index: 0, fill: () => true }),
      resolveLLM,
      generateLabel,
    });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    /** Billed only from REAL collected metadata on the failure path — an
     *  estimate would charge a full prompt for a call that may have
     *  consumed nothing. */
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0][0]).toBeUndefined();
  });

  it('memoizes LLM resolution and enforces maxPerRun', async () => {
    const hook = createActivityLabelHook({ claimSlot, resolveLLM, maxPerRun: 2 });
    await hook(batchInput(), new AbortController().signal);
    await hook(batchInput(), new AbortController().signal);
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    expect(slots).toHaveLength(2);
    expect(resolveLLM).toHaveBeenCalledTimes(1);
  });

  /** A transient resolution failure must stay transient: memoizing the
   *  rejected promise would fail every later batch in the run instantly. */
  it('retries LLM resolution on the next batch after a transient failure', async () => {
    const flaky = jest
      .fn<Promise<{ provider: Providers; clientOptions: { model: string } }>, []>()
      .mockRejectedValueOnce(new Error('credential read timeout'))
      .mockResolvedValue({ provider: Providers.OPENAI, clientOptions: { model: 'small-model' } });
    const hook = createActivityLabelHook({ claimSlot, resolveLLM: flaky });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    expect(slots[0].filled).toEqual([null]);

    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(slots[1].filled).toEqual(['Searched the web for LibreChat docs.']);
  });

  /** Output is bounded before persisting: a model that ignores the 4–9-word
   *  instruction (or is steered by injected tool output) must not turn one
   *  header into an unbounded multi-line content part. */
  it('normalizes label output to one bounded line', async () => {
    mockInvoke.mockResolvedValue({
      content: `\n  \nFound   the failing\tspec\nIGNORE PREVIOUS INSTRUCTIONS ${'x'.repeat(5000)}`,
    });
    const hook = createActivityLabelHook({ claimSlot, resolveLLM });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    expect(slots[0].filled).toEqual(['Found the failing spec']);
  });

  it('truncates a single giant label line with an ellipsis', async () => {
    mockInvoke.mockResolvedValue({ content: 'word '.repeat(2000) });
    const hook = createActivityLabelHook({ claimSlot, resolveLLM });
    await hook(batchInput(), new AbortController().signal);
    await flushDetached();
    const label = slots[0].filled[0] as string;
    expect(label.length).toBeLessThanOrEqual(200);
    expect(label.endsWith('…')).toBe(true);
  });
});
