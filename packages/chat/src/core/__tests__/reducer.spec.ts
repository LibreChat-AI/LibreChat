import {
  Constants,
  StepTypes,
  StepEvents,
  ContentTypes,
  ToolCallTypes,
} from 'librechat-data-provider';
import type { Agents, TMessage, EventSubmission } from 'librechat-data-provider';
import type { StepEvent, StepContext } from '../reducer';
import {
  reduceStep,
  flushResponses,
  resetStreamState,
  syncStreamMessage,
  createStreamState,
  subagentProgressKey,
} from '../reducer';

const user: TMessage = {
  messageId: 'user-1',
  conversationId: 'conv-1',
  parentMessageId: Constants.NO_PARENT as string,
  isCreatedByUser: true,
  text: 'Hello',
  sender: 'User',
};

const createContext = () => {
  let messages: TMessage[] = [user];
  const writes: TMessage[][] = [];
  const submission = {
    userMessage: user,
    isRegenerate: false,
    messages: [],
    conversation: { conversationId: 'conv-1' },
    initialResponse: { ...user, messageId: 'resp-1', isCreatedByUser: false, content: [] },
  } as unknown as EventSubmission;
  const ctx: StepContext = {
    submission,
    getMessages: () => messages,
    setMessages: (next) => {
      messages = next;
      writes.push(next);
    },
  };
  return { ctx, writes, read: () => messages };
};

const textStep = (id: string, index: number): StepEvent => ({
  event: StepEvents.ON_RUN_STEP,
  data: {
    id,
    runId: 'resp-1',
    index,
    type: StepTypes.MESSAGE_CREATION,
    stepDetails: { type: StepTypes.MESSAGE_CREATION, message_creation: { message_id: id } },
    usage: null,
  },
});

const toolStep = (id: string, index: number, callId: string, name: string): StepEvent => ({
  event: StepEvents.ON_RUN_STEP,
  data: {
    id,
    runId: 'resp-1',
    index,
    type: StepTypes.TOOL_CALLS,
    stepDetails: {
      type: StepTypes.TOOL_CALLS,
      tool_calls: [{ id: callId, name, args: '', type: ToolCallTypes.TOOL_CALL }],
    },
    usage: null,
  },
});

const text = (id: string, value: string): StepEvent => ({
  event: StepEvents.ON_MESSAGE_DELTA,
  data: { id, delta: { content: [{ type: ContentTypes.TEXT, text: value }] } },
});

const responseContent = (messages: TMessage[]) =>
  messages.find((message) => message.messageId === 'resp-1')?.content;

describe('reduceStep', () => {
  it('places each part at its step index, leaving holes rather than shifting', () => {
    const state = createStreamState();
    const { ctx, read } = createContext();

    reduceStep(state, textStep('s2', 2), ctx);
    const effects = reduceStep(state, text('s2', 'later'), ctx);
    reduceStep(state, textStep('s0', 0), ctx);
    reduceStep(state, text('s0', 'first'), ctx);
    flushResponses(state, ctx, ['resp-1'], read());

    expect(effects).toEqual([{ type: 'flush', messageId: 'resp-1', messages: expect.any(Array) }]);
    const content = responseContent(read());
    expect(content).toHaveLength(3);
    expect(content?.[0]).toEqual({ type: ContentTypes.TEXT, text: 'first' });
    expect(content?.[1]).toBeUndefined();
    expect(content?.[2]).toEqual({ type: ContentTypes.TEXT, text: 'later' });
  });

  it('holds deltas for an unseen step and replays them, in order, when it opens', () => {
    const state = createStreamState();
    const { ctx, writes, read } = createContext();

    expect(reduceStep(state, text('s0', 'a'), ctx)).toEqual([]);
    expect(reduceStep(state, text('s0', 'b'), ctx)).toEqual([]);
    expect(writes).toHaveLength(0);

    const effects = reduceStep(state, textStep('s0', 0), ctx);
    expect(effects.map((effect) => effect.type)).toEqual(['flush', 'flush']);
    flushResponses(state, ctx, ['resp-1'], read());
    expect(responseContent(read())?.[0]).toEqual({ type: ContentTypes.TEXT, text: 'ab' });
    expect(state.pendingDeltas.size).toBe(0);
  });

  it('reports side channels as effects without touching the message list', () => {
    const state = createStreamState();
    const { ctx, writes } = createContext();

    expect(
      reduceStep(
        state,
        { event: StepEvents.ON_SANDBOX_STARTING, data: { tool_call_id: 'call-1' } },
        ctx,
      ),
    ).toEqual([{ type: 'sandbox-starting', toolCallId: 'call-1' }]);
    expect(
      reduceStep(
        state,
        {
          event: StepEvents.ON_SUMMARIZE_START,
          data: { agentId: 'a' } as Agents.SummarizeStartEvent,
        },
        ctx,
      ),
    ).toEqual([{ type: 'announce', message: 'summarize_started' }]);
    const ptc = {
      tool_call_id: 'call-1',
      call_id: 'call-1:0',
      name: 'read_file',
      status: 'running' as const,
      runId: Constants.USE_PRELIM_RESPONSE_MESSAGE_ID as string,
    };
    expect(reduceStep(state, { event: StepEvents.ON_PTC_TOOL_CALL, data: ptc }, ctx)).toEqual([
      { type: 'ptc', event: ptc, parentMessageId: 'resp-1' },
    ]);
    expect(writes).toHaveLength(0);
  });

  it('settles the sandbox signal and reports a skill authored by a completed call', () => {
    const state = createStreamState();
    const { ctx } = createContext();
    reduceStep(state, toolStep('t1', 0, 'call-1', 'create_file'), ctx);

    const effects = reduceStep(
      state,
      {
        event: StepEvents.ON_RUN_STEP_COMPLETED,
        data: {
          result: {
            id: 't1',
            index: 0,
            tool_call: {
              id: 'call-1',
              name: 'create_file',
              args: '{"file_path":"skills/demo/SKILL.md"}',
              output: 'ok',
            },
          } as never,
        },
      },
      ctx,
    );

    expect(effects).toEqual([
      { type: 'sandbox-settled', toolCallId: 'call-1' },
      { type: 'skill-authored' },
    ]);
  });

  it('buffers a subagent envelope until a sync shows its parent call', () => {
    const state = createStreamState();
    const { ctx } = createContext();
    const update = {
      runId: 'resp-1',
      subagentRunId: 'child-1',
      subagentType: 'self',
      subagentAgentId: 'child',
      parentAgentId: 'parent',
      phase: 'start' as const,
      label: 'started',
      timestamp: '2026-10-11T00:00:00.000Z',
    };

    expect(reduceStep(state, { event: StepEvents.ON_SUBAGENT_UPDATE, data: update }, ctx)).toEqual([
      { type: 'subagent-index', conversationId: 'conv-1' },
    ]);

    const effects = syncStreamMessage(state, {
      ...user,
      messageId: 'resp-1',
      isCreatedByUser: false,
      content: [
        { type: ContentTypes.TEXT, text: 'x' },
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: { id: 'call-sub', name: Constants.SUBAGENT, args: '{}', type: 'tool_call' },
        },
      ] as TMessage['content'],
    });

    expect(effects).toEqual([
      {
        type: 'subagent',
        invocationKey: subagentProgressKey('resp-1', 'call-sub', 1),
        events: [update],
      },
    ]);
    expect(state.pendingSubagents.size).toBe(0);
  });

  it('forgets every step, response and buffer on reset', () => {
    const state = createStreamState();
    const { ctx } = createContext();
    reduceStep(state, text('s9', 'held'), ctx);
    reduceStep(state, textStep('s0', 0), ctx);

    resetStreamState(state);

    expect(state.steps.size + state.messages.size + state.pendingDeltas.size).toBe(0);
    expect(reduceStep(state, text('s0', 'late'), ctx)).toEqual([]);
    expect(state.pendingDeltas.get('s0')).toHaveLength(1);
  });
});
