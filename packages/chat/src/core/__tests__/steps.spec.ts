import { StepTypes, ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  EventSubmission,
  SummaryContentPart,
  TMessageContentParts,
} from 'librechat-data-provider';
import {
  applyToolCallCompleted,
  calculateContentIndex,
  applyReasoningDelta,
  applySummarizeDelta,
  applyToolCallDelta,
  applyRunStepClosed,
  applyToolCallsStep,
  finalizeSummaries,
  applyMessageDelta,
  applySummaryStep,
  applyAgentUpdate,
  getEditPrefix,
  updateContent,
} from '../steps';

const RUN_ID = 'response-1';

const createResponse = (content: TMessageContentParts[] = []): TMessage =>
  ({
    messageId: RUN_ID,
    conversationId: 'convo-1',
    parentMessageId: 'user-1',
    isCreatedByUser: false,
    text: '',
    content,
  }) as TMessage;

const messageStep = (
  id: string,
  index: number,
  overrides: Partial<Agents.RunStep> = {},
): Agents.RunStep => ({
  id,
  index,
  runId: RUN_ID,
  type: StepTypes.MESSAGE_CREATION,
  stepDetails: { type: StepTypes.MESSAGE_CREATION, message_creation: { message_id: id } },
  ...overrides,
});

const toolStep = (
  id: string,
  index: number,
  toolCalls: Agents.ToolCall[],
  overrides: Partial<Agents.RunStep> = {},
): Agents.RunStep => ({
  id,
  index,
  runId: RUN_ID,
  type: StepTypes.TOOL_CALLS,
  stepDetails: { type: StepTypes.TOOL_CALLS, tool_calls: toolCalls as Agents.AgentToolCall[] },
  ...overrides,
});

const textDelta = (id: string, text: string): Agents.MessageDeltaEvent => ({
  id,
  delta: { content: [{ type: ContentTypes.TEXT, text }] },
});

const thinkDelta = (id: string, think: string): Agents.ReasoningDeltaEvent => ({
  id,
  delta: { content: [{ type: ContentTypes.THINK, think }] },
});

const argsDelta = (id: string, args: string): Agents.RunStepDeltaEvent => ({
  id,
  delta: { type: StepTypes.TOOL_CALLS, tool_calls: [{ args } as Agents.ToolCallChunk] },
});

const toolEnd = (id: string, toolCall: Partial<Agents.ToolCall>): Agents.ToolEndEvent => ({
  id,
  index: 0,
  tool_call: { type: ToolCallTypes.TOOL_CALL, ...toolCall } as Agents.ToolCall,
});

const typesOf = (message: TMessage) => (message.content ?? []).map((part) => part?.type);

const toolCallAt = (message: TMessage, index: number) =>
  (message.content?.[index] as Agents.ToolCallContent | undefined)?.tool_call;

/**
 * The invariant every reducer keeps: each step's part sits at `step.index + offset`, whatever
 * order the events arrived in.
 */
const expectStepPositions = (
  message: TMessage,
  steps: Array<[Agents.RunStep, ContentTypes]>,
  offset = 0,
) => {
  for (const [step, type] of steps) {
    expect(message.content?.[step.index + offset]?.type).toBe(type);
  }
};

const streamText = (message: TMessage, step: Agents.RunStep, chunks: string[], offset = 0) =>
  chunks.reduce(
    (current, chunk) => applyMessageDelta(current, step, textDelta(step.id, chunk), offset).message,
    message,
  );

describe('steps', () => {
  describe('text deltas', () => {
    it('appends a recorded sequence of chunks into the step slot', () => {
      const step = messageStep('step-text', 0);
      const result = streamText(createResponse(), step, ['Hel', 'lo', ', world']);

      expect(result.content).toEqual([{ type: ContentTypes.TEXT, text: 'Hello, world' }]);
      expectStepPositions(result, [[step, ContentTypes.TEXT]]);
    });

    it('applies every part of a multi-part delta in order', () => {
      const step = messageStep('step-text', 0);
      const result = applyMessageDelta(
        createResponse(),
        step,
        {
          id: step.id,
          delta: {
            content: [
              { type: ContentTypes.TEXT, text: 'a' },
              null as unknown as Agents.MessageContentComplex,
              { type: ContentTypes.TEXT, text: 'b' },
            ],
          },
        },
        0,
      );

      expect(result.updated).toBe(true);
      expect(result.message.content).toEqual([{ type: ContentTypes.TEXT, text: 'ab' }]);
    });

    it('reports no update and returns the same message for an empty delta', () => {
      const response = createResponse();
      const result = applyMessageDelta(
        response,
        messageStep('step-text', 0),
        { id: 'step-text', delta: {} },
        0,
      );

      expect(result).toEqual({ message: response, updated: false, foldedEditPrefix: false });
      expect(result.message).toBe(response);
    });

    it('stamps the step phase on text parts', () => {
      const step = messageStep('step-final', 0, {
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'm', phase: 'final_answer' },
        },
      });
      const result = streamText(createResponse(), step, ['done']);

      expect(result.content?.[0]).toEqual({
        type: ContentTypes.TEXT,
        text: 'done',
        phase: 'final_answer',
      });
    });

    it('streams into a message step that carries no message_creation details', () => {
      const step = messageStep('step-bare', 0, {
        stepDetails: { type: StepTypes.MESSAGE_CREATION } as Agents.StepDetails,
      });
      const result = streamText(createResponse(), step, ['still streams']);

      expect(result.content).toEqual([{ type: ContentTypes.TEXT, text: 'still streams' }]);
    });

    it('keeps slots in place when a later step streams before an earlier one', () => {
      const first = messageStep('step-a', 0);
      const second = messageStep('step-b', 2);
      let result = streamText(createResponse(), second, ['second']);
      expect(result.content?.[0]).toBeUndefined();
      expect(result.content?.[1]).toBeUndefined();

      result = streamText(result, first, ['first']);

      expectStepPositions(result, [
        [first, ContentTypes.TEXT],
        [second, ContentTypes.TEXT],
      ]);
      expect(result.content?.[1]).toBeUndefined();
      expect(result.content).toHaveLength(3);
    });

    it('does not dedupe a redelivered chunk; the transport owns delivery', () => {
      const step = messageStep('step-text', 0);
      const result = streamText(createResponse(), step, ['once', 'once']);

      expect(result.content).toEqual([{ type: ContentTypes.TEXT, text: 'onceonce' }]);
    });

    it('never overwrites a slot holding a different part type', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const opened = createResponse([
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: { id: 'call-1', name: 'search', args: '', type: 'tool_call' },
        } as TMessageContentParts,
      ]);

      const result = streamText(opened, messageStep('step-text', 0), ['collide']);

      expect(result).toBe(opened);
      expect(typesOf(result)).toEqual([ContentTypes.TOOL_CALL]);
      expect(warn).toHaveBeenCalledWith('Content type mismatch', expect.any(Object));
      warn.mockRestore();
    });

    it('propagates agent and group metadata without mutating the previous part', () => {
      const step = messageStep('step-text', 0, { agentId: 'agent-a', groupId: 2 });
      const before = streamText(createResponse(), messageStep('step-text', 0), ['a']);
      const previousPart = before.content?.[0];

      const result = streamText(before, step, ['b']);

      expect(result.content?.[0]).toMatchObject({ text: 'ab', agentId: 'agent-a', groupId: 2 });
      expect(previousPart).toEqual({ type: ContentTypes.TEXT, text: 'a' });
    });
  });

  describe('reasoning deltas', () => {
    it('streams reasoning then text into consecutive slots', () => {
      const think = messageStep('step-think', 0);
      const text = messageStep('step-text', 1);
      let result = createResponse();
      for (const chunk of ['Let me ', 'think']) {
        result = applyReasoningDelta(result, think, thinkDelta(think.id, chunk), 0).message;
      }
      result = streamText(result, text, ['Answer']);

      expect(result.content?.[0]).toMatchObject({
        type: ContentTypes.THINK,
        think: 'Let me think',
        reasoning_label_step_id: think.id,
      });
      expectStepPositions(result, [
        [think, ContentTypes.THINK],
        [text, ContentTypes.TEXT],
      ]);
    });

    it('resets the label domain when a different step reuses a THINK slot', () => {
      const labelled = createResponse([
        {
          type: ContentTypes.THINK,
          think: 'old',
          reasoning_label: 'Planning',
          reasoning_label_revision: 3,
          reasoning_label_step_id: 'step-old',
        } as TMessageContentParts,
      ]);

      const result = applyReasoningDelta(
        labelled,
        messageStep('step-new', 0),
        thinkDelta('step-new', ' more'),
        0,
      ).message;

      expect(result.content?.[0]).toStrictEqual({
        type: ContentTypes.THINK,
        think: 'old more',
        reasoning_label_step_id: 'step-new',
      });
    });

    it('stamps a THINK slot streamed on the message channel once it exists', () => {
      const step = messageStep('step-think', 0);
      const delta = (think: string): Agents.MessageDeltaEvent => ({
        id: step.id,
        delta: { content: [{ type: ContentTypes.THINK, think }] },
      });
      const first = applyMessageDelta(createResponse(), step, delta('h'), 0).message;
      const second = applyMessageDelta(first, step, delta('m'), 0).message;

      expect(first.content?.[0]).toEqual({ type: ContentTypes.THINK, think: 'h' });
      expect(second.content?.[0]).toEqual({
        type: ContentTypes.THINK,
        think: 'hm',
        reasoning_label_step_id: step.id,
      });
    });
  });

  describe('edit prefix', () => {
    const prefix = [
      { type: ContentTypes.TEXT, text: 'kept' },
      { type: ContentTypes.TEXT, text: 'kept tail' },
    ] as TMessageContentParts[];
    const submission = (overrides: Partial<EventSubmission> = {}) =>
      ({
        editedContent: { index: 1, text: 'kept tail', type: ContentTypes.TEXT },
        editPrefixLength: 2,
        initialResponse: createResponse(prefix),
        ...overrides,
      }) as EventSubmission;

    it('offsets by the captured prefix length, not the live content length', () => {
      expect(getEditPrefix(submission()).editPrefixOffset).toBe(2);
      expect(
        getEditPrefix(
          submission({ editPrefixLength: undefined, initialResponse: createResponse() }),
        ).editPrefixOffset,
      ).toBe(0);
    });

    it('drops the offset once a resume sync cleared the prefix', () => {
      expect(getEditPrefix(submission({ editPrefixCleared: true }))).toEqual({
        initialContent: [],
        editPrefixOffset: 0,
      });
      expect(getEditPrefix({ initialResponse: createResponse() } as EventSubmission)).toEqual({
        initialContent: [],
        editPrefixOffset: 0,
      });
    });

    it('folds the first continued text into the last prefix part and reports it', () => {
      const step = messageStep('step-text', 0);
      const result = applyMessageDelta(createResponse(prefix), step, textDelta(step.id, '!'), 2);

      expect(result.foldedEditPrefix).toBe(true);
      expect(result.message.content).toEqual([
        { type: ContentTypes.TEXT, text: 'kept' },
        { type: ContentTypes.TEXT, text: 'kept tail!' },
      ]);
    });

    it('does not fold across a phase boundary', () => {
      expect(calculateContentIndex(0, 2, ContentTypes.TEXT, prefix, 'final_answer')).toBe(2);
      expect(calculateContentIndex(0, 2, ContentTypes.TEXT, prefix)).toBe(1);
      expect(calculateContentIndex(0, 2, ContentTypes.TOOL_CALL, prefix)).toBe(2);
    });

    it('places later steps after the prefix', () => {
      const think = messageStep('step-think', 1);
      const result = applyReasoningDelta(
        createResponse(prefix),
        think,
        thinkDelta(think.id, 'next'),
        2,
      ).message;

      expect(typesOf(result)).toEqual([
        ContentTypes.TEXT,
        ContentTypes.TEXT,
        undefined,
        ContentTypes.THINK,
      ]);
      expectStepPositions(result, [[think, ContentTypes.THINK]], 2);
    });
  });

  describe('tool calls', () => {
    const search = toolStep('step-tool', 1, [{ id: 'call-1', name: 'search', args: '' }]);

    const runToolCall = (response: TMessage) => {
      const opened = applyToolCallsStep(response, search, 0);
      let message = opened.message;
      for (const chunk of ['{"q":', '"cats"}']) {
        message = applyToolCallDelta(
          message,
          search,
          argsDelta(search.id, chunk),
          opened.toolCallId ?? '',
          0,
        ) as TMessage;
      }
      return {
        toolCallId: opened.toolCallId,
        message: applyToolCallCompleted(
          message,
          search,
          toolEnd(search.id, { id: 'call-1', name: 'search', args: '{"q":"cats"}', output: '3' }),
          0,
        ),
      };
    };

    it('opens, streams args into, and completes the step part', () => {
      const text = messageStep('step-text', 0);
      const { message, toolCallId } = runToolCall(streamText(createResponse(), text, ['Hi']));

      expect(toolCallId).toBe('call-1');
      expect(toolCallAt(message, 1)).toMatchObject({
        id: 'call-1',
        name: 'search',
        args: '{"q":"cats"}',
        output: '3',
        progress: 1,
        stepId: search.id,
      });
      expectStepPositions(message, [
        [text, ContentTypes.TEXT],
        [search, ContentTypes.TOOL_CALL],
      ]);
    });

    it('is idempotent when the completion is delivered twice', () => {
      const { message } = runToolCall(createResponse());
      const completedTwice = applyToolCallCompleted(
        message,
        search,
        toolEnd(search.id, { id: 'call-1', name: 'search', args: '{"q":"cats"}', output: '3' }),
        0,
      );

      expect(completedTwice.content).toEqual(message.content);
    });

    it('keeps streamed args when an open step is announced again', () => {
      const opened = applyToolCallsStep(createResponse(), search, 0).message;
      const streamed = applyToolCallDelta(
        opened,
        search,
        argsDelta(search.id, '{"q":'),
        'call-1',
        0,
      ) as TMessage;

      const reannounced = applyToolCallsStep(streamed, search, 0).message;

      expect(reannounced.content).toEqual(streamed.content);
    });

    it('keeps a completed call intact when its step is announced again', () => {
      const { message } = runToolCall(createResponse());
      const closed = applyRunStepClosed(
        message,
        search,
        {
          id: search.id,
          index: 1,
          type: StepTypes.TOOL_CALLS,
          status: 'completed',
          created_at: 1_000,
          closed_at: 1_250,
        },
        0,
      ) as TMessage;

      const replayed = applyToolCallsStep(closed, search, 0);

      expect(replayed.toolCallId).toBe('call-1');
      expect(replayed.message.content).toEqual(closed.content);
    });

    it('retains existing timing metadata when a delta and closure omit new timing', () => {
      const stamps = { toolPreparationStartedAt: 1_000, toolDispatchedAt: 1_100 };
      const opened = applyToolCallsStep(createResponse(), search, 0, () => stamps).message;
      const streamed = applyToolCallDelta(
        opened,
        search,
        argsDelta(search.id, '{}'),
        'call-1',
        0,
      ) as TMessage;
      const closed = applyRunStepClosed(
        streamed,
        search,
        {
          id: search.id,
          index: 1,
          type: StepTypes.TOOL_CALLS,
          status: 'completed',
          created_at: 1_000,
          closed_at: 1_250,
        },
        0,
      );
      expect(closed?.content?.[1]).toMatchObject({
        tool_call: {
          ...stamps,
          args: '{}',
          runStepStatus: 'completed',
          runStepDurationMs: 250,
          runStepClosedAt: 1_250,
        },
      });
      expect(closed?.content?.[1]).not.toHaveProperty('tool_call.toolPreparationDurationMs');
      expect(closed?.content?.[1]).not.toHaveProperty('tool_call.toolExecutionDurationMs');
    });

    it('preserves tool timing through completion and settled-step replay', () => {
      const getTiming = () => ({ toolPreparationStartedAt: 1_000, toolDispatchedAt: 1_100 });
      const opened = applyToolCallsStep(createResponse(), search, 0, getTiming).message;
      const streamed = applyToolCallDelta(
        opened,
        search,
        argsDelta(search.id, '{}'),
        'call-1',
        0,
        getTiming,
      ) as TMessage;
      const completed = applyToolCallCompleted(
        streamed,
        search,
        toolEnd(search.id, { id: 'call-1', name: 'search', output: 'done' }),
        0,
      );
      const closed = applyRunStepClosed(
        completed,
        search,
        {
          id: search.id,
          index: 1,
          type: StepTypes.TOOL_CALLS,
          status: 'completed',
          created_at: 1_000,
          closed_at: 1_250,
        },
        0,
        { toolPreparationDurationMs: 100, toolExecutionDurationMs: 150 },
      ) as TMessage;
      expect(closed.content?.[1]).toMatchObject({
        tool_call: {
          args: '{}',
          output: 'done',
          progress: 1,
          toolPreparationStartedAt: 1_000,
          toolDispatchedAt: 1_100,
          toolPreparationDurationMs: 100,
          toolExecutionDurationMs: 150,
          runStepDurationMs: 250,
        },
      });
      expect(applyToolCallsStep(closed, search, 0, getTiming).message.content).toEqual(
        closed.content,
      );
    });

    it('keeps streamed args when the completion omits them', () => {
      const opened = applyToolCallsStep(createResponse(), search, 0).message;
      const streamed = applyToolCallDelta(opened, search, argsDelta(search.id, '{}'), 'call-1', 0);
      const completed = applyToolCallCompleted(
        streamed as TMessage,
        search,
        toolEnd(search.id, { id: 'call-1', name: 'search', output: 'ok' }),
        0,
      );

      expect(toolCallAt(completed, 1)).toMatchObject({ args: '{}', output: 'ok' });
    });

    it('writes a completion into its step slot when the opening part is missing', () => {
      const completed = applyToolCallCompleted(
        createResponse(),
        search,
        toolEnd(search.id, { id: 'call-1', name: 'search', args: { q: 'cats' }, output: '3' }),
        0,
      );

      expect(completed.content?.[0]).toBeUndefined();
      expect(toolCallAt(completed, 1)).toMatchObject({ id: 'call-1', progress: 1 });
    });

    it('attaches OAuth prompts carried on an args delta', () => {
      const opened = applyToolCallsStep(createResponse(), search, 0).message;
      const result = applyToolCallDelta(
        opened,
        search,
        {
          id: search.id,
          delta: {
            type: StepTypes.TOOL_CALLS,
            tool_calls: [{ args: '' } as Agents.ToolCallChunk],
            auth: 'https://auth.example.com',
            expires_at: 123,
          },
        },
        'call-1',
        0,
      );

      expect(toolCallAt(result as TMessage, 1)).toMatchObject({
        auth: 'https://auth.example.com',
        expires_at: 123,
      });
    });

    it('ignores deltas that are not tool-call deltas', () => {
      expect(
        applyToolCallDelta(
          createResponse(),
          search,
          { id: search.id, delta: { type: StepTypes.MESSAGE_CREATION } },
          'call-1',
          0,
        ),
      ).toBeUndefined();
    });

    it('displaces a pending OAuth prompt when real content lands in its slot', () => {
      const oauth = createResponse([
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: { id: 'oauth', name: 'oauth_mcp_github', args: '', type: 'tool_call' },
        } as TMessageContentParts,
      ]);

      const result = streamText(oauth, messageStep('step-text', 0), ['resumed']);

      expect(result.content).toEqual([{ type: ContentTypes.TEXT, text: 'resumed' }]);
    });

    it('stamps the terminal status on close, and only on tool calls', () => {
      const { message } = runToolCall(createResponse());
      const closed: Agents.RunStepClosedEvent = {
        id: search.id,
        index: 1,
        type: StepTypes.TOOL_CALLS,
        status: 'cancelled',
        created_at: 1_000,
        closed_at: 1_250,
      };

      const result = applyRunStepClosed(message, search, closed, 0);
      const closedTwice = applyRunStepClosed(result as TMessage, search, closed, 0);

      expect(toolCallAt(result as TMessage, 1)).toMatchObject({
        runStepStatus: 'cancelled',
        runStepDurationMs: 250,
      });
      expect(closedTwice?.content).toEqual(result?.content);
      expect(applyRunStepClosed(createResponse(), search, closed, 0)).toBeUndefined();
      expect(
        applyRunStepClosed(
          streamText(createResponse(), messageStep('step-text', 1), ['t']),
          search,
          closed,
          0,
        ),
      ).toBeUndefined();
    });

    it('records the last non-empty tool call id announced by a step', () => {
      const parallel = toolStep('step-many', 0, [
        { id: 'call-a', name: 'a', args: '' },
        { id: '', name: 'b', args: '' },
      ]);

      expect(applyToolCallsStep(createResponse(), parallel, 0).toolCallId).toBe('call-a');
      expect(
        applyToolCallsStep(createResponse(), messageStep('step-text', 0), 0).toolCallId,
      ).toBeUndefined();
    });
  });

  describe('image parts', () => {
    it('holds an image slot without letting text overwrite it', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const image = createResponse([
        { type: ContentTypes.IMAGE_URL, image_url: { url: 'https://x/y.png' } },
      ] as TMessageContentParts[]);

      const result = updateContent(image, 0, {
        type: ContentTypes.IMAGE_URL,
        image_url: 'https://x/y.png',
      } as Agents.MessageContentComplex);
      const collided = streamText(result, messageStep('step-text', 0), ['no']);

      expect(result.content?.[0]).toEqual(image.content?.[0]);
      expect(collided).toBe(result);
      warn.mockRestore();
    });

    it('writes the URL of the first streamed image part into a new slot', () => {
      const result = updateContent(createResponse(), 0, {
        type: ContentTypes.IMAGE_URL,
        image_url: 'https://x/first.png',
      } as Agents.MessageContentComplex);
      const repeated = updateContent(result, 0, {
        type: ContentTypes.IMAGE_URL,
        image_url: 'https://x/other.png',
      } as Agents.MessageContentComplex);

      expect(result.content?.[0]).toEqual({
        type: ContentTypes.IMAGE_URL,
        image_url: 'https://x/first.png',
      });
      expect(repeated.content).toEqual(result.content);
    });
  });

  describe('agent updates', () => {
    it('writes the handoff marker at its index with default group metadata', () => {
      const event: Agents.AgentUpdate = {
        type: ContentTypes.AGENT_UPDATE,
        agent_update: { index: 1, runId: RUN_ID, agentId: 'agent-b' },
      };

      const result = applyAgentUpdate(createResponse(), event, 0);

      expect(result.content?.[1]).toEqual({
        type: ContentTypes.AGENT_UPDATE,
        agent_update: event.agent_update,
        agentId: 'agent-b',
        groupId: 1,
      });
      expect(applyAgentUpdate(result, event, 0).content).toEqual(result.content);
    });
  });

  describe('summaries', () => {
    const summarize = messageStep('step-summary', 1, {
      summary: {
        type: ContentTypes.SUMMARY,
        content: [],
        model: 'model-a',
        provider: 'provider-a',
      } as SummaryContentPart,
    });
    const summaryDelta = (text: string): Agents.SummarizeDeltaEvent => ({
      id: summarize.id,
      delta: {
        summary: {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text }],
        } as SummaryContentPart,
      },
    });

    const streamSummary = () => {
      let message = applySummaryStep(createResponse(), summarize, 0);
      for (const chunk of ['Earlier, ', 'we talked.']) {
        message = applySummarizeDelta(message, summarize, summaryDelta(chunk), 0);
      }
      return message;
    };

    it('opens, streams, and settles a summary in its step slot', () => {
      const streamed = streamSummary();
      expect(streamed.content?.[1]).toMatchObject({
        type: ContentTypes.SUMMARY,
        summarizing: true,
        content: [
          { type: ContentTypes.TEXT, text: 'Earlier, ' },
          { type: ContentTypes.TEXT, text: 'we talked.' },
        ],
      });

      const settled = finalizeSummaries(
        streamed,
        {
          id: summarize.id,
          agentId: 'a',
          summary: { type: ContentTypes.SUMMARY, content: [] } as SummaryContentPart,
        },
        1,
      );

      expect(settled?.content?.[1]).toMatchObject({ summarizing: false });
      expectStepPositions(settled as TMessage, [[summarize, ContentTypes.SUMMARY]]);
      expect(
        finalizeSummaries(settled as TMessage, { id: summarize.id, agentId: 'a' }, 1),
      ).toBeUndefined();
    });

    it('carries agent and group metadata onto the finalized summary', () => {
      const parallel = messageStep('step-summary-p', 1, {
        agentId: 'agent-b',
        groupId: 2,
        summary: summarize.summary,
      });
      const opened = applySummaryStep(createResponse(), parallel, 0);

      const settled = finalizeSummaries(
        opened,
        {
          id: parallel.id,
          agentId: 'agent-b',
          summary: {
            type: ContentTypes.SUMMARY,
            content: [{ type: ContentTypes.TEXT, text: 'done' }],
          } as SummaryContentPart,
        },
        1,
      ) as TMessage;
      const reattributed = finalizeSummaries(
        applySummaryStep(createResponse(), parallel, 0),
        {
          id: parallel.id,
          agentId: 'agent-b',
          summary: { type: ContentTypes.SUMMARY, content: [], agentId: 'agent-c', groupId: 3 },
        } as Agents.SummarizeCompleteEvent,
        1,
      ) as TMessage;

      expect(settled.content?.[1]).toMatchObject({
        summarizing: false,
        agentId: 'agent-b',
        groupId: 2,
        content: [{ type: ContentTypes.TEXT, text: 'done' }],
      });
      expect(reattributed.content?.[1]).toMatchObject({ agentId: 'agent-c', groupId: 3 });
    });

    it('keeps a failed round in its slot instead of splicing it out', () => {
      const text = messageStep('step-text', 2);
      const streamed = streamText(streamSummary(), text, ['after']);

      const failed = finalizeSummaries(
        streamed,
        { id: summarize.id, agentId: 'a', error: 'boom' },
        1,
      ) as TMessage;

      expect(failed.content?.[1]).toMatchObject({ summarizing: false, failed: true });
      expectStepPositions(failed, [
        [summarize, ContentTypes.SUMMARY],
        [text, ContentTypes.TEXT],
      ]);
    });

    it('finalizes only the owning slot when the step is known', () => {
      const newer = messageStep('step-summary-2', 3, { summary: summarize.summary });
      const both = applySummaryStep(streamSummary(), newer, 0);

      const scoped = finalizeSummaries(both, { id: summarize.id, agentId: 'a' }, 1) as TMessage;
      const global = finalizeSummaries(both, { id: 'unknown', agentId: 'a' }, -1) as TMessage;

      expect(scoped.content?.[1]).toMatchObject({ summarizing: false });
      expect(scoped.content?.[3]).toMatchObject({ summarizing: true });
      expect(global.content?.[3]).toMatchObject({ summarizing: false });
    });
  });
});
