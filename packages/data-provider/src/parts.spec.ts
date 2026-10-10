import type { UIMappingOptions, MappableContentPart, UIMessagePart, UIToolPart } from './parts';
import type { TMessageContentParts, PartMetadata } from './types/content';
import type { TAttachment, TMessage } from './schemas';
import type { Agents } from './types/agents';
import {
  fromUIMessage,
  isUIToolPart,
  isUIDataPart,
  toUIMessage,
  fromUIParts,
  fromUIPart,
  toUIParts,
  toUIPart,
} from './parts';
import { ContentTypes } from './types/runs';
import { Tools } from './types/tools';

/** One representative part per content type; the `Record` makes a missing member a type error. */
const samples: Record<ContentTypes, MappableContentPart> = {
  [ContentTypes.TEXT]: {
    type: ContentTypes.TEXT,
    text: 'Hello',
    tool_call_ids: ['call-1'],
    phase: 'final_answer',
    agentId: 'agent-a',
    groupId: 1,
  },
  [ContentTypes.THINK]: {
    type: ContentTypes.THINK,
    think: 'Considering',
    reasoning_label: 'Planning',
    reasoning_label_status: 'complete',
  },
  [ContentTypes.TEXT_DELTA]: { type: ContentTypes.TEXT_DELTA, text_delta: 'chunk' },
  [ContentTypes.TOOL_CALL]: {
    type: ContentTypes.TOOL_CALL,
    tool_call: {
      id: 'call-1',
      name: 'search',
      args: '{"q":"cats"}',
      output: '3',
      progress: 1,
      type: 'tool_call',
    },
  },
  [ContentTypes.IMAGE_FILE]: {
    type: ContentTypes.IMAGE_FILE,
    image_file: {
      file_id: 'file-1',
      filename: 'cat.png',
      filepath: '/images/cat.png',
      height: 10,
      width: 20,
      type: 'image/png',
      user: 'user-1',
      bytes: 42,
      embedded: false,
      object: 'file',
      usage: 0,
    },
  },
  [ContentTypes.IMAGE_URL]: {
    type: ContentTypes.IMAGE_URL,
    image_url: { url: 'https://x/cat.png', detail: 'high' },
  },
  [ContentTypes.VIDEO_URL]: { type: ContentTypes.VIDEO_URL, video_url: { url: 'https://x/v.mp4' } },
  [ContentTypes.INPUT_AUDIO]: {
    type: ContentTypes.INPUT_AUDIO,
    input_audio: { data: 'AAAA', format: 'wav' },
  },
  [ContentTypes.AGENT_UPDATE]: {
    type: ContentTypes.AGENT_UPDATE,
    agent_update: { index: 1, runId: 'run-1', agentId: 'agent-b' },
    agentId: 'agent-b',
    groupId: 1,
  },
  [ContentTypes.SUMMARY]: {
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text: 'Earlier, we talked.' }],
    summarizing: false,
  },
  [ContentTypes.ACTIVITY_LABEL]: {
    type: ContentTypes.ACTIVITY_LABEL,
    activity_label: 'Searched the web',
    tool_call_ids: ['call-1'],
    status: 'ok',
  },
  [ContentTypes.STEER]: { type: ContentTypes.STEER, steer: 'Focus on cats', steerId: 's-1' },
  [ContentTypes.ERROR]: { type: ContentTypes.ERROR, error: 'Rate limited' },
};

const expectedUITypes: Record<ContentTypes, string> = {
  [ContentTypes.TEXT]: 'text',
  [ContentTypes.THINK]: 'reasoning',
  [ContentTypes.TEXT_DELTA]: 'text',
  [ContentTypes.TOOL_CALL]: 'tool-search',
  [ContentTypes.IMAGE_FILE]: 'file',
  [ContentTypes.IMAGE_URL]: 'file',
  [ContentTypes.VIDEO_URL]: 'file',
  [ContentTypes.INPUT_AUDIO]: 'file',
  [ContentTypes.AGENT_UPDATE]: 'data-agent-update',
  [ContentTypes.SUMMARY]: 'data-summary',
  [ContentTypes.ACTIVITY_LABEL]: 'data-activity-label',
  [ContentTypes.STEER]: 'data-steer',
  [ContentTypes.ERROR]: 'data-error',
};

const lossless = Object.values(ContentTypes).filter((type) => type !== ContentTypes.TEXT_DELTA);

/** A content array of `length` slots with only `slots` written, as the reducers leave it. */
const sparse = (length: number, slots: Record<number, TMessageContentParts>) => {
  const content: TMessageContentParts[] = new Array(length);
  for (const [index, part] of Object.entries(slots)) {
    content[Number(index)] = part;
  }
  return content;
};

/**
 * Content arrays recorded from the stream reducers in
 * `client/src/hooks/SSE/__tests__/steps.spec.ts` (text, tool calls, reasoning, handoff, summary,
 * image scenarios), captured by running those reducers. Holes are where a later step arrived
 * before an earlier one.
 */
const recorded: Record<string, TMessageContentParts[]> = {
  toolCompleted: [
    { type: ContentTypes.TEXT, text: 'Hi' },
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'call-1',
        name: 'search',
        args: '{"q":"cats"}',
        stepId: 'step-tool',
        type: 'tool_call',
        progress: 1,
        output: '3',
      },
    },
  ],
  toolStreaming: [
    { type: ContentTypes.TEXT, text: 'Hi' },
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'call-1',
        name: 'search',
        args: '{"q":',
        stepId: 'step-tool',
        type: 'tool_call',
      },
    },
  ],
  toolCancelled: [
    { type: ContentTypes.TEXT, text: 'Hi' },
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'call-1',
        name: 'search',
        args: '{"q":"cats"}',
        stepId: 'step-tool',
        type: 'tool_call',
        runStepStatus: 'cancelled',
        runStepDurationMs: 250,
      },
    },
  ],
  outOfOrder: sparse(3, {
    0: { type: ContentTypes.TEXT, text: 'first' },
    2: { type: ContentTypes.TEXT, text: 'second' },
  }),
  reasoning: [
    {
      type: ContentTypes.THINK,
      think: 'Let me think',
      agentId: 'agent-a',
      groupId: 2,
      reasoning_label_step_id: 'step-think',
    },
    { type: ContentTypes.TEXT, text: 'Answer', agentId: 'agent-a', groupId: 2 },
  ],
  agentUpdate: [
    { type: ContentTypes.TEXT, text: 'Hi' },
    {
      type: ContentTypes.AGENT_UPDATE,
      agent_update: { index: 1, runId: 'response-1', agentId: 'agent-b' },
      agentId: 'agent-b',
      groupId: 1,
    },
  ],
  summaryFailed: [
    { type: ContentTypes.TEXT, text: 'Hi' },
    {
      type: ContentTypes.SUMMARY,
      content: [
        { type: ContentTypes.TEXT, text: 'Earlier, ' },
        { type: ContentTypes.TEXT, text: 'we talked.' },
      ],
      summarizing: false,
      failed: true,
    },
    { type: ContentTypes.TEXT, text: 'after' },
  ],
  imageUrl: [{ type: ContentTypes.IMAGE_URL, image_url: 'https://x/first.png' }],
};

const toolPartAt = (content: TMessageContentParts[], index: number) =>
  toUIParts(content)[index] as UIToolPart;

/** Deterministic PRNG so a failing generated case reproduces. */
const createRandom = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
};

const createMessage = (overrides: Partial<TMessage>): TMessage => ({
  messageId: 'response-1',
  conversationId: 'convo-1',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  text: '',
  ...overrides,
});

type ResolveToolFailure = NonNullable<UIMappingOptions['resolveToolFailure']>;

describe('parts', () => {
  describe('toUIPart', () => {
    it.each(Object.values(ContentTypes))('maps %s to its UI part', (type) => {
      expect(toUIPart(samples[type]).type).toBe(expectedUITypes[type]);
    });

    it.each(lossless)('round-trips %s', (type) => {
      expect(fromUIPart(toUIPart(samples[type]))).toStrictEqual(samples[type]);
    });

    it('maps a streamed text delta to a streaming text part', () => {
      expect(toUIPart(samples[ContentTypes.TEXT_DELTA])).toEqual({
        type: 'text',
        text: 'chunk',
        state: 'streaming',
      });
    });

    it('keeps the object form of text and its annotations', () => {
      const part: TMessageContentParts = {
        type: ContentTypes.TEXT,
        text: {
          value: 'See file',
          annotations: [
            {
              type: 'file_path',
              text: 'file',
              start_index: 4,
              end_index: 8,
              file_path: { file_id: 'f' },
            },
          ],
        },
      };
      const uiPart = toUIPart(part);

      expect(uiPart).toMatchObject({ type: 'text', text: 'See file' });
      expect(fromUIPart(uiPart)).toStrictEqual(part);
    });

    it('maps an untyped lane placeholder to step-start', () => {
      const placeholder = { type: '' } as unknown as MappableContentPart;
      const content = [
        { type: ContentTypes.TEXT, text: 'a' },
        placeholder,
      ] as TMessageContentParts[];

      expect(toUIPart(placeholder)).toEqual({ type: 'step-start' });
      expect(toUIMessage(createMessage({ content })).parts).toEqual([
        { type: 'text', text: 'a' },
        { type: 'step-start' },
      ]);
    });

    it('maps a tool call slot whose call has not arrived to step-start', () => {
      const placeholder = { type: ContentTypes.TOOL_CALL } as unknown as MappableContentPart;
      const content = [
        { type: ContentTypes.TEXT, text: 'a' },
        placeholder,
      ] as TMessageContentParts[];

      expect(toUIPart(placeholder)).toEqual({ type: 'step-start' });
      expect(toUIMessage(createMessage({ content })).parts).toEqual([
        { type: 'text', text: 'a' },
        { type: 'step-start' },
      ]);
    });

    it('maps a missing slot to step-start and step-start back to nothing', () => {
      expect(toUIPart(undefined)).toEqual({ type: 'step-start' });
      expect(fromUIPart({ type: 'step-start' })).toBeUndefined();
    });

    it('exposes the AI SDK fields of a file part', () => {
      expect(toUIPart(samples[ContentTypes.IMAGE_FILE])).toMatchObject({
        type: 'file',
        mediaType: 'image/png',
        filename: 'cat.png',
        url: '/images/cat.png',
      });
      expect(toUIPart(samples[ContentTypes.INPUT_AUDIO])).toMatchObject({
        mediaType: 'audio/wav',
        url: 'data:audio/wav;base64,AAAA',
      });
    });

    it('builds an agents tool call from a hand-made tool part', () => {
      const part: UIToolPart = {
        type: 'tool-search',
        toolCallId: 'call-9',
        state: 'output-available',
        input: { q: 'dogs' },
        output: '5',
      };

      expect(fromUIPart(part)).toEqual({
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          type: 'tool_call',
          name: 'search',
          id: 'call-9',
          args: '{"q":"dogs"}',
          output: '5',
          runStepStatus: 'completed',
        },
      });
    });

    it('names legacy assistants tool calls by their kind', () => {
      const code = toUIPart({
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'ci-1',
          type: 'code_interpreter',
          code_interpreter: { input: 'print(1)', outputs: [{ logs: '1' }] },
        },
      });
      const fn = toUIPart({
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'fn-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"id":1}', output: null },
        },
      });

      expect(code).toMatchObject({
        type: 'tool-code_interpreter',
        toolCallId: 'ci-1',
        state: 'output-available',
        input: 'print(1)',
        output: [{ logs: '1' }],
      });
      expect(fn).toMatchObject({
        type: 'tool-lookup',
        toolCallId: 'fn-1',
        state: 'input-available',
        input: { id: 1 },
      });
    });
  });

  describe('tool states from recorded streams', () => {
    it('reports a completed call as output-available with parsed input', () => {
      expect(toolPartAt(recorded.toolCompleted, 1)).toMatchObject({
        type: 'tool-search',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { q: 'cats' },
        output: '3',
      });
    });

    it('reports partial arguments as input-streaming', () => {
      expect(toolPartAt(recorded.toolStreaming, 1)).toMatchObject({
        state: 'input-streaming',
        input: '{"q":',
      });
    });

    it('reports a cancelled step as output-error', () => {
      expect(toolPartAt(recorded.toolCancelled, 1)).toMatchObject({
        state: 'output-error',
        errorText: 'cancelled',
        input: { q: 'cats' },
      });
    });
  });

  describe('recorded reducer output', () => {
    it.each(Object.entries(recorded))('%s keeps positions and round-trips', (_name, content) => {
      const parts = toUIParts(content);

      expect(parts).toHaveLength(content.length);
      for (let i = 0; i < content.length; i++) {
        const part = content[i] as MappableContentPart | undefined;
        expect(parts[i].type).toBe(part ? expectedUITypes[part.type] : 'step-start');
      }
      expect(fromUIParts(parts)).toStrictEqual(content);
    });
  });

  describe('generated content', () => {
    const pool = lossless.map((type) => samples[type]);

    it('preserves order, holes and every part over random content arrays', () => {
      const random = createRandom(7);
      for (let run = 0; run < 250; run++) {
        const length = Math.floor(random() * 12);
        const content: TMessageContentParts[] = new Array(length);
        for (let i = 0; i < length; i++) {
          if (random() < 0.2) {
            continue;
          }
          content[i] = pool[Math.floor(random() * pool.length)] as TMessageContentParts;
        }

        const parts = toUIParts(content);
        expect(parts).toHaveLength(length);
        for (let i = 0; i < length; i++) {
          const part = content[i] as MappableContentPart | undefined;
          expect(parts[i].type).toBe(part ? expectedUITypes[part.type] : 'step-start');
        }
        expect(fromUIParts(parts)).toStrictEqual(content);
      }
    });
  });

  describe('toUIMessage', () => {
    it('views a response with content, metadata, files and sources', () => {
      const attachment = {
        conversationId: 'convo-1',
        messageId: 'response-1',
        toolCallId: 'call-1',
        type: Tools.web_search,
        [Tools.web_search]: {
          organic: [{ link: 'https://a.example', title: 'A' }],
          topStories: [{ link: 'https://b.example' }],
        },
      } as TAttachment;
      const content: TMessageContentParts[] = [
        samples[ContentTypes.STEER] as TMessageContentParts,
        ...recorded.reasoning,
        samples[ContentTypes.AGENT_UPDATE] as TMessageContentParts,
        samples[ContentTypes.ACTIVITY_LABEL] as TMessageContentParts,
        samples[ContentTypes.SUMMARY] as TMessageContentParts,
      ];
      const message = createMessage({
        content,
        sender: 'Agent',
        model: 'agent-a',
        unfinished: true,
        files: [{ filepath: '/files/report.pdf', filename: 'report.pdf', type: 'application/pdf' }],
        attachments: [attachment],
      });

      const view = toUIMessage(message);

      expect(view.id).toBe('response-1');
      expect(view.role).toBe('assistant');
      expect(view.parts.map((part) => part.type)).toEqual([
        'data-steer',
        'reasoning',
        'text',
        'data-agent-update',
        'data-activity-label',
        'data-summary',
        'file',
        'source-url',
        'source-url',
      ]);
      expect(view.parts.slice(-3)).toEqual([
        {
          type: 'file',
          mediaType: 'application/pdf',
          filename: 'report.pdf',
          url: '/files/report.pdf',
          providerMetadata: {
            librechat: { source: 'attachment', filepath: '/files/report.pdf', index: 0 },
          },
        },
        { type: 'source-url', sourceId: 'call-1-0', url: 'https://a.example', title: 'A' },
        { type: 'source-url', sourceId: 'call-1-1', url: 'https://b.example' },
      ]);
      expect(view.metadata).toEqual({
        conversationId: 'convo-1',
        parentMessageId: 'user-1',
        sender: 'Agent',
        model: 'agent-a',
        unfinished: true,
        text: '',
        attachments: [attachment],
        agentIds: ['agent-a', 'agent-b'],
        groupIds: [2, 1],
        steers: [{ steer: 'Focus on cats', steerId: 's-1' }],
        activityLabels: [
          { activity_label: 'Searched the web', tool_call_ids: ['call-1'], status: 'ok' },
        ],
        summaries: [
          {
            content: [{ type: ContentTypes.TEXT, text: 'Earlier, we talked.' }],
            summarizing: false,
          },
        ],
      });
      expect(fromUIMessage(view, message)).toStrictEqual(message);
    });

    it('views a contentless user message as its text and files', () => {
      const message = createMessage({
        messageId: 'user-1',
        parentMessageId: null,
        isCreatedByUser: true,
        text: 'Describe this',
        files: [{ filepath: '/images/cat.png', filename: 'cat.png', type: 'image/png' }],
      });

      const view = toUIMessage(message);

      expect(view).toEqual({
        id: 'user-1',
        role: 'user',
        metadata: { conversationId: 'convo-1', parentMessageId: null, contentless: true },
        parts: [
          { type: 'text', text: 'Describe this' },
          {
            type: 'file',
            mediaType: 'image/png',
            filename: 'cat.png',
            url: '/images/cat.png',
            providerMetadata: {
              librechat: { source: 'attachment', filepath: '/images/cat.png', index: 0 },
            },
          },
        ],
      });
      expect(fromUIMessage(view)).toEqual(message);
    });

    it('writes edited parts back onto the stored message', () => {
      const message = createMessage({ content: recorded.toolCompleted, text: 'Hi' });
      const view = toUIMessage(message);
      const parts: UIMessagePart[] = [{ type: 'text', text: 'Hello' }, ...view.parts.slice(1)];

      const next = fromUIMessage({ ...view, parts }, message);

      expect(next.content?.[0]).toEqual({ type: ContentTypes.TEXT, text: 'Hello' });
      expect(next.content?.[1]).toStrictEqual(recorded.toolCompleted[1]);
      expect(next.parentMessageId).toBe('user-1');
    });
  });

  describe('fromUIMessage', () => {
    it('views an empty content array with text as contentless', () => {
      const message = createMessage({ content: [], text: 'Legacy answer' });

      const view = toUIMessage(message);

      expect(view.parts).toEqual([{ type: 'text', text: 'Legacy answer' }]);
      expect(view.metadata?.contentless).toBe(true);
      expect(fromUIMessage(view, message)).toStrictEqual(message);
    });

    it('keeps an empty streaming placeholder as content', () => {
      const message = createMessage({ content: [] });

      const view = toUIMessage(message);

      expect(view.parts).toEqual([]);
      expect(fromUIMessage(view, message)).toStrictEqual(message);
    });

    it('updates the stored text when a text part is edited', () => {
      const message = createMessage({
        text: 'old',
        content: [{ type: ContentTypes.TEXT, text: 'old' }],
      });
      const view = toUIMessage(message);

      const next = fromUIMessage({ ...view, parts: [{ type: 'text', text: 'new' }] }, message);

      expect(next.text).toBe('new');
      expect(next.content).toEqual([{ type: ContentTypes.TEXT, text: 'new' }]);
    });

    it('keeps stored text that the parts do not derive', () => {
      const message = createMessage({
        text: 'stored summary',
        content: [{ type: ContentTypes.TEXT, text: 'Answer' }],
      });

      expect(fromUIMessage(toUIMessage(message), message).text).toBe('stored summary');
    });

    it('applies removed and added attachments to a stored message', () => {
      const kept = {
        file_id: 'a',
        filepath: '/files/a.pdf',
        filename: 'a.pdf',
        type: 'application/pdf',
      };
      const removed = {
        file_id: 'b',
        filepath: '/files/b.pdf',
        filename: 'b.pdf',
        type: 'application/pdf',
      };
      const unlisted = { file_id: 'c' };
      const message = createMessage({
        isCreatedByUser: true,
        text: 'Files',
        files: [kept, removed, unlisted],
      });
      const view = toUIMessage(message);
      const parts: UIMessagePart[] = [
        view.parts[0],
        view.parts[1],
        { type: 'file', mediaType: 'image/png', filename: 'new.png', url: '/images/new.png' },
      ];

      const next = fromUIMessage({ ...view, parts }, message);

      expect(next.files).toEqual([
        kept,
        { filepath: '/images/new.png', filename: 'new.png', type: 'image/png' },
        unlisted,
      ]);
    });

    it('restores metadata fields when no stored message exists', () => {
      const message = createMessage({
        sender: 'Agent',
        model: 'gpt-5',
        endpoint: 'agents',
        error: true,
        unfinished: true,
        createdAt: '2026-09-25T00:00:00.000Z',
        content: [{ type: ContentTypes.TEXT, text: 'Partial' }],
      });

      expect(fromUIMessage(toUIMessage(message))).toStrictEqual(message);
    });
  });

  describe('stored shapes', () => {
    const toolCall = (fields: Partial<Agents.ToolCall> & PartMetadata): TMessageContentParts => ({
      type: ContentTypes.TOOL_CALL,
      tool_call: { type: 'tool_call', name: 'search', args: '{"q":"cats"}', ...fields },
    });

    it('falls back from an empty tool call id to the host step id', () => {
      expect(toUIPart(toolCall({ id: '', stepId: 'step-7' }), 3)).toMatchObject({
        toolCallId: 'step-7',
      });
      expect(toUIPart(toolCall({ id: '' }), 3)).toMatchObject({ toolCallId: 'tool_call-3' });
    });

    it('reports durable failure markers as output-error', () => {
      const cancelled = toolCall({
        id: 'call-1',
        output: 'partial',
        progress: 1,
        backgroundTask: {
          version: 1,
          taskId: 't',
          toolName: 'search',
          status: 'completed',
          cancelled: true,
          settledAt: new Date(0),
        },
      });
      const rejected = toolCall({ id: 'call-2', progress: 1, inputValidationError: true });

      expect(toUIPart(cancelled)).toMatchObject({ state: 'output-error', errorText: 'cancelled' });
      expect(toUIPart(rejected)).toMatchObject({
        state: 'output-error',
        errorText: 'input-validation-error',
      });
    });

    it('reports a call paused for review as approval-requested', () => {
      const paused = toolCall({
        id: 'call-1',
        approval: { actionId: 'action-1', allowed_decisions: ['approve'], description: 'Run it?' },
      });

      expect(toUIPart(paused)).toMatchObject({
        state: 'approval-requested',
        approval: { id: 'action-1', requestReason: 'Run it?' },
      });
      expect(fromUIPart(toUIPart(paused))).toStrictEqual(paused);
    });

    it('treats an empty legacy function output as submitted', () => {
      const part = toUIPart({
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'fn-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{}', output: '' },
        },
      });

      expect(part).toMatchObject({ state: 'output-available', output: '' });
    });

    it('views persisted reasoning without its think tags and restores them', () => {
      const part = {
        type: ContentTypes.THINK,
        think: '<think>\nWeighing options\n</think>',
      } as TMessageContentParts;
      const bare = { type: ContentTypes.THINK, think: 'No tags' } as TMessageContentParts;

      expect(toUIPart(part)).toMatchObject({ type: 'reasoning', text: 'Weighing options' });
      expect(fromUIPart(toUIPart(part))).toStrictEqual(part);
      expect(fromUIPart(toUIPart(bare))).toStrictEqual(bare);
    });

    it('keeps a text or think part without its text field', () => {
      const text = { type: ContentTypes.TEXT } as TMessageContentParts;
      const think = { type: ContentTypes.THINK } as TMessageContentParts;

      expect(fromUIPart(toUIPart(text))).toStrictEqual(text);
      expect(fromUIPart(toUIPart(think))).toStrictEqual(think);
    });

    it('persists the failure of a hand-built error tool part', () => {
      const part: UIToolPart = {
        type: 'tool-search',
        toolCallId: 'call-9',
        state: 'output-error',
        input: { q: 'dogs' },
        errorText: 'Timed out',
      };

      expect(toUIPart(fromUIPart(part))).toMatchObject({
        state: 'output-error',
        errorText: 'Timed out',
      });
    });

    it('collects agents that own only a nested tool call', () => {
      const message = createMessage({ content: [toolCall({ id: 'call-1', agentId: 'agent-z' })] });

      expect(toUIMessage(message).metadata?.agentIds).toEqual(['agent-z']);
    });
  });

  describe('sources', () => {
    const search = (toolCallId: string, links: string[]) =>
      ({
        conversationId: 'convo-1',
        messageId: 'response-1',
        toolCallId,
        type: Tools.web_search,
        [Tools.web_search]: {
          organic: links.map((link) => ({ link })),
          references: [
            { link: 'https://ref.example', type: 'link', title: 'Ref' },
            { link: 'https://img.example/a.png', type: 'image' },
          ],
        },
      }) as TAttachment;

    it('gives distinct sources distinct ids when tool call ids repeat', () => {
      const message = createMessage({
        content: [{ type: ContentTypes.TEXT, text: 'Found' }],
        attachments: [
          search('call_0', ['https://a.example']),
          search('call_0', ['https://b.example']),
        ],
      });

      const sources = toUIMessage(message).parts.filter((part) => part.type === 'source-url');

      expect(sources).toEqual([
        { type: 'source-url', sourceId: 'call_0-0', url: 'https://a.example' },
        { type: 'source-url', sourceId: 'call_0-1', url: 'https://ref.example', title: 'Ref' },
        { type: 'source-url', sourceId: 'call_0-2', url: 'https://b.example' },
      ]);
    });
  });

  describe('edits through the view', () => {
    it('writes image file edits back while keeping the stored record', () => {
      const part = samples[ContentTypes.IMAGE_FILE] as TMessageContentParts;
      const edited: UIMessagePart = {
        ...(toUIPart(part) as Extract<UIMessagePart, { type: 'file' }>),
        url: '/images/dog.png',
        filename: 'dog.png',
      };

      expect(fromUIPart(edited)).toMatchObject({
        type: ContentTypes.IMAGE_FILE,
        image_file: { file_id: 'file-1', filepath: '/images/dog.png', filename: 'dog.png' },
      });
    });

    it('writes attachment renames onto the matched stored file', () => {
      const stored = {
        file_id: 'a',
        filepath: '/files/a.pdf',
        filename: 'a.pdf',
        type: 'application/pdf',
      };
      const message = createMessage({ isCreatedByUser: true, text: 'File', files: [stored] });
      const view = toUIMessage(message);
      const parts: UIMessagePart[] = [
        view.parts[0],
        {
          type: 'file',
          mediaType: 'application/pdf',
          filename: 'renamed.pdf',
          url: '/files/a.pdf',
        },
      ];

      expect(fromUIMessage({ ...view, parts }, message).files).toEqual([
        { ...stored, filename: 'renamed.pdf' },
      ]);
    });

    it('keeps an explicit null parent instead of the stored one', () => {
      const message = createMessage({
        text: 'Hi',
        content: [{ type: ContentTypes.TEXT, text: 'Hi' }],
      });
      const view = toUIMessage(message);

      const next = fromUIMessage(
        {
          ...view,
          metadata: { ...view.metadata, conversationId: 'convo-1', parentMessageId: null },
        },
        message,
      );

      expect(next.parentMessageId).toBeNull();
    });

    it('keeps stored text that the parts do not derive without a base', () => {
      const message = createMessage({
        text: 'stored summary',
        content: [samples[ContentTypes.THINK] as TMessageContentParts],
      });

      expect(fromUIMessage(toUIMessage(message)).text).toBe('stored summary');
    });
  });

  describe('legacy and edited shapes', () => {
    it('keeps a null model through a base-less rebuild', () => {
      const message = createMessage({
        model: null,
        text: 'Hi',
        content: [{ type: ContentTypes.TEXT, text: 'Hi' }],
      });

      expect(fromUIMessage(toUIMessage(message))).toStrictEqual(message);
    });

    it('takes the audio format from an edited media type', () => {
      const view = toUIPart(samples[ContentTypes.INPUT_AUDIO]) as Extract<
        UIMessagePart,
        { type: 'file' }
      >;

      expect(
        fromUIPart({ ...view, mediaType: 'audio/mp3', url: 'data:audio/mp3;base64,BBBB' }),
      ).toEqual({ type: ContentTypes.INPUT_AUDIO, input_audio: { data: 'BBBB', format: 'mp3' } });
    });

    it('gives sources and attachments no content slot', () => {
      const parts: UIMessagePart[] = [
        { type: 'text', text: 'a' },
        { type: 'source-url', sourceId: 's', url: 'https://a.example' },
        { type: 'file', mediaType: 'image/png', url: '/x.png' },
        { type: 'text', text: 'b' },
        { type: 'step-start' },
        { type: 'text', text: 'c' },
      ];

      expect(fromUIParts(parts)).toStrictEqual(
        sparse(4, {
          0: { type: ContentTypes.TEXT, text: 'a' },
          1: { type: ContentTypes.TEXT, text: 'b' },
          3: { type: ContentTypes.TEXT, text: 'c' },
        }),
      );
    });

    it('reports a legacy retrieval output as submitted', () => {
      const part = toUIPart({
        type: ContentTypes.TOOL_CALL,
        tool_call: { id: 'r-1', type: 'retrieval', retrieval: {}, output: 'found' },
      } as TMessageContentParts);

      expect(part).toMatchObject({ state: 'output-available', output: 'found' });
    });

    it('reports an error-prefixed output as output-error', () => {
      const part = toUIPart({
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'call-1',
          type: 'tool_call',
          name: 'search',
          args: '{}',
          output: 'Error processing tool search: boom',
        },
      });

      expect(part).toMatchObject({
        state: 'output-error',
        errorText: 'Error processing tool search: boom',
      });
    });

    it('matches an attachment whose url was edited to its stored file', () => {
      const stored = {
        file_id: 'a',
        filepath: '/files/a.pdf',
        filename: 'a.pdf',
        type: 'application/pdf',
      };
      const message = createMessage({ isCreatedByUser: true, text: 'File', files: [stored] });
      const view = toUIMessage(message);
      const attachment = view.parts[1] as Extract<UIMessagePart, { type: 'file' }>;
      const parts: UIMessagePart[] = [view.parts[0], { ...attachment, url: '/files/moved.pdf' }];

      expect(fromUIMessage({ ...view, parts }, message).files).toEqual([
        { ...stored, filepath: '/files/moved.pdf' },
      ]);
    });
  });

  describe('rebuilds without a stored base', () => {
    it('keeps a successful hand-built tool part successful', () => {
      const part: UIToolPart = {
        type: 'tool-search',
        toolCallId: 'call-9',
        state: 'output-available',
        input: { q: 'dogs' },
      };

      expect(toUIPart(fromUIPart(part))).toMatchObject({ state: 'output-available' });
    });

    it('keeps an array output from a hand-built tool part', () => {
      const part: UIToolPart = {
        type: 'tool-code_interpreter',
        toolCallId: 'ci-9',
        state: 'output-available',
        input: 'print(1)',
        output: [{ logs: 'done' }],
      };

      expect(toUIPart(fromUIPart(part))).toMatchObject({
        type: 'tool-code_interpreter',
        state: 'output-available',
        output: [{ logs: 'done' }],
      });
    });

    it('keeps attachments and an empty content array', () => {
      const attachment = {
        conversationId: 'convo-1',
        messageId: 'response-1',
        toolCallId: 'call-1',
        filename: 'notes.txt',
        filepath: '/files/notes.txt',
      } as TAttachment;
      const message = createMessage({ content: [], text: 'Legacy', attachments: [attachment] });

      expect(fromUIMessage(toUIMessage(message))).toStrictEqual(message);
    });

    it('keeps hidden files in their stored positions', () => {
      const hidden = { file_id: 'h' };
      const visible = {
        file_id: 'v',
        filepath: '/files/v.pdf',
        filename: 'v.pdf',
        type: 'application/pdf',
      };
      const message = createMessage({
        isCreatedByUser: true,
        text: 'Files',
        files: [hidden, visible],
      });

      expect(fromUIMessage(toUIMessage(message), message).files).toEqual([hidden, visible]);
    });
  });

  describe('caller-supplied tool outcomes', () => {
    it('keeps ownership metadata on a streamed text delta', () => {
      const part = {
        type: ContentTypes.TEXT_DELTA,
        text_delta: 'chunk',
        agentId: 'agent-a',
        groupId: 2,
      } as MappableContentPart;

      expect(toUIPart(part)).toEqual({
        type: 'text',
        text: 'chunk',
        state: 'streaming',
        providerMetadata: { librechat: { agentId: 'agent-a', groupId: 2 } },
      });
    });

    it('keeps the object form and annotations of a streamed text delta', () => {
      const annotations = [
        {
          type: 'file_citation',
          text: 'cite',
          start_index: 4,
          end_index: 8,
          file_citation: { file_id: 'f', quote: 'q' },
        },
      ];
      const part = {
        type: ContentTypes.TEXT_DELTA,
        text_delta: { value: 'See cite', annotations },
      } as MappableContentPart;
      const uiPart = toUIPart(part);

      expect(uiPart).toMatchObject({ type: 'text', text: 'See cite', state: 'streaming' });
      expect(fromUIPart(uiPart)).toStrictEqual({
        type: ContentTypes.TEXT,
        text: { value: 'See cite', annotations },
      });
    });

    it('marks an empty hand-built array output completed', () => {
      const part: UIToolPart = {
        type: 'tool-code_interpreter',
        toolCallId: 'ci-9',
        state: 'output-available',
        input: 'print()',
        output: [],
      };

      expect(toUIPart(fromUIPart(part))).toMatchObject({ state: 'output-available' });
    });

    it('applies a failure the caller resolves from its own rules', () => {
      const memory: TMessageContentParts = {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'mem-1',
          type: 'tool_call',
          name: 'set_memory',
          args: '{}',
          output: 'Invalid key',
        },
      };
      const message = createMessage({ content: [memory] });
      const resolveToolFailure = jest.fn<string | undefined, Parameters<ResolveToolFailure>>(
        (toolCall) =>
          'name' in toolCall && toolCall.name === 'set_memory' && toolCall.output !== 'Memory set'
            ? toolCall.output
            : undefined,
      );

      expect(toUIMessage(message).parts[0]).toMatchObject({ state: 'output-available' });
      expect(toUIMessage(message, { resolveToolFailure }).parts[0]).toMatchObject({
        state: 'output-error',
        errorText: 'Invalid key',
      });
      expect(resolveToolFailure).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'mem-1' }),
        message,
      );
    });
  });

  describe('failure reasons', () => {
    const dispatchHandle = JSON.stringify({ taskId: 't-1', status: 'running' });
    const detached = (fields: Partial<Agents.ToolCall> & PartMetadata): TMessageContentParts => ({
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'bg-1',
        type: 'tool_call',
        name: 'bash',
        args: '{}',
        output: dispatchHandle,
        progress: 1,
        ...fields,
      },
    });

    it('reports a cancelled background task by its reason, not its dispatch handle', () => {
      const part = detached({
        backgroundTask: {
          version: 1,
          taskId: 't-1',
          toolName: 'bash',
          status: 'completed',
          cancelled: true,
          settledAt: new Date(0),
        },
      });

      expect(toUIPart(part)).toMatchObject({ state: 'output-error', errorText: 'cancelled' });
    });

    it('reports a caller-resolved failure by the reason the caller returns', () => {
      const message = createMessage({ content: [detached({})] });
      const resolveToolFailure: ResolveToolFailure = () => 'Task exited with code 1';

      expect(toUIMessage(message, { resolveToolFailure }).parts[0]).toMatchObject({
        state: 'output-error',
        errorText: 'Task exited with code 1',
      });
    });

    it('keeps a failed step output as the error text', () => {
      const part = detached({ output: 'partial', runStepStatus: 'failed' });

      expect(toUIPart(part)).toMatchObject({ state: 'output-error', errorText: 'partial' });
    });
  });

  describe('identity and additions', () => {
    it('keeps two stored files that share a path distinct', () => {
      const first = {
        file_id: 'a',
        filepath: '/files/same.pdf',
        filename: 'first.pdf',
        type: 'application/pdf',
      };
      const second = {
        file_id: 'b',
        filepath: '/files/same.pdf',
        filename: 'second.pdf',
        type: 'application/pdf',
      };
      const message = createMessage({
        isCreatedByUser: true,
        text: 'Files',
        files: [first, second],
      });

      expect(fromUIMessage(toUIMessage(message), message)).toStrictEqual(message);
    });

    it('writes content added to a contentless message', () => {
      const message = createMessage({ isCreatedByUser: false, text: 'Plain' });
      const view = toUIMessage(message);
      const tool: UIToolPart = {
        type: 'tool-search',
        toolCallId: 'call-1',
        state: 'input-available',
        input: { q: 'x' },
      };

      const next = fromUIMessage({ ...view, parts: [...view.parts, tool] }, message);

      expect(next.content?.map((part) => part.type)).toEqual([
        ContentTypes.TEXT,
        ContentTypes.TOOL_CALL,
      ]);
      expect(next.text).toBe('Plain');
    });

    it('keeps primitive JSON arguments as their string', () => {
      const part = toUIPart({
        type: ContentTypes.TOOL_CALL,
        tool_call: { id: 'call-1', type: 'tool_call', name: 'count', args: '42' },
      });

      expect(part).toMatchObject({ input: '42', state: 'input-available' });
    });
  });

  describe('stable identities', () => {
    it('derives a fallback tool call id from the streamed index', () => {
      const part = {
        type: ContentTypes.TOOL_CALL,
        streamedIndex: 3,
        tool_call: { type: 'tool_call', name: 'search', args: '{}' },
      } as TMessageContentParts;

      expect(toUIPart(part, 2)).toMatchObject({ toolCallId: 'tool_call-3' });
    });

    it('drops annotations once their text is edited', () => {
      const annotations = [
        {
          type: 'file_path' as const,
          text: 'file',
          start_index: 4,
          end_index: 8,
          file_path: { file_id: 'f' },
        },
      ];
      const part = {
        type: ContentTypes.TEXT,
        text: { value: 'See file', annotations },
      } as TMessageContentParts;
      const view = toUIPart(part) as Extract<UIMessagePart, { type: 'text' }>;

      expect(fromUIPart(view)).toStrictEqual(part);
      expect(fromUIPart({ ...view, text: 'Rewritten' })).toEqual({
        type: ContentTypes.TEXT,
        text: { value: 'Rewritten' },
      });
    });
  });

  it('narrows tool and data parts', () => {
    const parts = toUIParts(recorded.agentUpdate.concat(recorded.toolCompleted[1]));

    expect(parts.filter(isUIDataPart).map((part) => part.type)).toEqual(['data-agent-update']);
    expect(parts.filter(isUIToolPart).map((part) => part.toolCallId)).toEqual(['call-1']);
  });
});
