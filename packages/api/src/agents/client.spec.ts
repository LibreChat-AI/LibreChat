import { Tokenizer as AiTokenizer } from 'ai-tokenizer';
import { Providers, StandardGraph } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { ContentTypes, DEFAULT_MAX_RETAINED_TOOL_COUNT_CHARS } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import {
  collectToolCallIds,
  countRetainedToolTokens,
  createCachedTokenCounter,
  payloadParser,
  prependQuotes,
  prependFileContext,
  applyAttachmentOnlyText,
  type FormattedMessageWithContent,
} from './client';
import { ATTACHMENT_ONLY_TEXT } from '~/files/context';

describe('createCachedTokenCounter', () => {
  it('enables stable-message reuse in the agents runtime', async () => {
    const getTokenCount = jest.spyOn(AiTokenizer.prototype, 'count');
    try {
      const tokenCounter = await createCachedTokenCounter('o200k_base');
      const graph = new StandardGraph({
        runId: 'token-cache-integration',
        agents: [
          {
            agentId: 'primary',
            provider: Providers.OPENAI,
            instructions: 'Test instructions',
          },
        ],
        tokenCounter,
      });
      const agentContext = graph.agentContexts.get('primary');
      await agentContext?.tokenCalculationPromise;
      getTokenCount.mockClear();
      const message = new HumanMessage('Stable retained context');

      agentContext?.contextPressureTokenCounts?.count(message);
      const callsAfterFirstCount = getTokenCount.mock.calls.length;
      agentContext?.contextPressureTokenCounts?.count(message);

      expect(callsAfterFirstCount).toBeGreaterThan(0);
      expect(getTokenCount).toHaveBeenCalledTimes(callsAfterFirstCount);
    } finally {
      getTokenCount.mockRestore();
    }
  });
});

describe('countRetainedToolTokens', () => {
  const toolPart = (id: string, name: string, output?: string) => ({
    type: ContentTypes.TOOL_CALL,
    tool_call: { id, name, args: '{"path":"a"}', ...(output != null && { output }) },
  });
  /** Stands in for the run's tokenizer: one token per four characters, so every
   *  expectation below is a plain arithmetic consequence of what was counted. */
  const countExact = (text: string) => Math.ceil(text.length / 4);

  it('counts only the results of calls the snapshot had not seen', () => {
    const contentParts = [
      toolPart('call_1', 'grep', 'x'.repeat(4000)),
      { type: ContentTypes.TEXT, text: 'calling the tool' },
      toolPart('call_2', 'read_file', 'the retained result'),
    ];

    /** The earlier call is already inside the snapshot's own message tokens;
     *  counting it again would double the whole loop. */
    expect(
      countRetainedToolTokens({
        contentParts,
        priorToolCallIds: new Set(['call_1']),
        countExact,
      }),
    ).toBe(countExact('the retained result'));
  });

  it('follows the call ids through a reshaped content array', () => {
    /** Completion unshifts skill cards and can filter hidden sequential output,
     *  so the retained call moves; its id does not. */
    const retained = toolPart('call_2', 'read_file', 'the retained result');
    const reshaped = [
      { type: ContentTypes.TOOL_CALL, tool_call: { id: 'skill_card', name: 'prime' } },
      retained,
    ];
    expect(
      countRetainedToolTokens({
        contentParts: reshaped,
        priorToolCallIds: new Set(['call_1']),
        countExact,
      }),
    ).toBe(countExact('the retained result'));
  });

  it('ignores the model-authored call and everything that is not a tool result', () => {
    /** Name and arguments are output tokens the snapshot's `completedOutputTokens`
     *  already carries, and assistant text is output too. An id-less call cannot be
     *  placed against the boundary at all. */
    const contentParts = [
      toolPart('call_1', 'read_file'),
      { type: ContentTypes.TEXT, text: 'a long assistant explanation of the call' },
      { type: ContentTypes.THINK, think: 'reasoning that never re-enters context' },
      { type: ContentTypes.TOOL_CALL, tool_call: { name: 'read_file', output: 'unplaceable' } },
    ];
    expect(countRetainedToolTokens({ contentParts, priorToolCallIds: new Set(), countExact })).toBe(
      0,
    );
    expect(
      countRetainedToolTokens({ contentParts: undefined, priorToolCallIds: null, countExact }),
    ).toBe(0);
  });

  it('applies the Claude framing correction, matching the counter the snapshot used', () => {
    const contentParts = [toolPart('call_1', 'read_file', 'r'.repeat(500))];
    const base = countRetainedToolTokens({
      contentParts,
      priorToolCallIds: new Set(),
      countExact,
    });
    expect(
      countRetainedToolTokens({
        contentParts,
        priorToolCallIds: new Set(),
        countExact,
        isClaude: true,
      }),
    ).toBe(Math.ceil((base ?? 0) * 1.1));
  });

  it('reports nothing rather than an estimate when a result cannot be counted', () => {
    /** A gauge missing the retained result is better than exact provider figures
     *  with a guess folded in, so one uncountable result withdraws the whole value. */
    expect(
      countRetainedToolTokens({
        contentParts: [
          toolPart('call_1', 'read_file', 'countable'),
          toolPart('call_2', 'grep', 'uncountable'),
        ],
        priorToolCallIds: new Set(),
        countExact: (text) => (text === 'uncountable' ? undefined : countExact(text)),
      }),
    ).toBeUndefined();
  });

  it('withdraws once the turn exhausts its tokenization budget', () => {
    /** Tokenizing costs ~60 ms/MB, so the deployment's ceiling covers the whole
     *  turn: a final call requesting several tools cannot multiply it per result. */
    const counted = jest.fn(countExact);
    expect(
      countRetainedToolTokens({
        contentParts: [
          toolPart('call_1', 'grep', 'a'.repeat(60)),
          toolPart('call_2', 'read_file', 'b'.repeat(60)),
        ],
        priorToolCallIds: new Set(),
        countExact: counted,
        maxCountChars: 100,
      }),
    ).toBeUndefined();
    /** It stops at the budget rather than counting the rest for nothing. */
    expect(counted).toHaveBeenCalledTimes(1);
  });

  it('defaults the budget to the shipped ceiling', () => {
    const output = 'a'.repeat(1024);
    expect(
      countRetainedToolTokens({
        contentParts: [toolPart('call_1', 'grep', output)],
        priorToolCallIds: new Set(),
        countExact,
      }),
    ).toBe(countExact(output));
    expect(DEFAULT_MAX_RETAINED_TOOL_COUNT_CHARS).toBe(8 * 1024 * 1024);
  });
});

describe('collectToolCallIds', () => {
  it('collects the ids a snapshot has seen and skips everything else', () => {
    expect(
      collectToolCallIds([
        { type: ContentTypes.TOOL_CALL, tool_call: { id: 'call_1', name: 'grep' } },
        { type: ContentTypes.TEXT, text: 'text carries no call' },
        { type: ContentTypes.TOOL_CALL, tool_call: { name: 'no id' } },
        undefined,
      ]),
    ).toEqual(new Set(['call_1']));
    expect(collectToolCallIds(undefined)).toEqual(new Set());
  });
});
describe('payloadParser reasoning override persistence', () => {
  it('returns the base value while the runtime endpoint option uses the override', () => {
    const req = {
      body: {
        endpointOption: {
          model_parameters: { model: 'gpt-5.1', reasoning_effort: 'high' },
        },
      },
      reasoningOverrideBase: {
        key: 'reasoning_effort',
        hadValue: true,
        value: 'low',
      },
    } as unknown as ServerRequest;

    expect(payloadParser({ req, endpoint: 'openAI' })).toEqual({
      model: 'gpt-5.1',
      reasoning_effort: 'low',
    });
    expect(req.body.endpointOption?.model_parameters?.reasoning_effort).toBe('high');
  });

  it('omits a transient override when no base value existed', () => {
    const req = {
      body: {
        endpointOption: {
          model_parameters: { model: 'gpt-5.1', reasoning_effort: 'high' },
        },
      },
      reasoningOverrideBase: {
        key: 'reasoning_effort',
        hadValue: false,
      },
    } as unknown as ServerRequest;

    expect(payloadParser({ req, endpoint: 'openAI' })).toEqual({ model: 'gpt-5.1' });
    expect(req.body.endpointOption?.model_parameters?.reasoning_effort).toBe('high');
  });

  it('restores the conversation thinking switch after a coupled Claude override', () => {
    const req = {
      body: {
        endpointOption: {
          model_parameters: { model: 'claude-sonnet-4-6', effort: 'max', thinking: true },
        },
      },
      reasoningOverrideBase: {
        key: 'effort',
        hadValue: true,
        value: 'low',
        thinkingHadValue: true,
        thinkingValue: false,
      },
    } as unknown as ServerRequest;

    expect(payloadParser({ req, endpoint: 'anthropic' })).toEqual({
      model: 'claude-sonnet-4-6',
      effort: 'low',
      thinking: false,
    });
  });
});

describe('prependFileContext', () => {
  it('prepends file context to string content', () => {
    const message: FormattedMessageWithContent = { content: 'Answer this question.' };

    prependFileContext(message, 'Attached file text');

    expect(message.content).toBe('Attached file text\nAnswer this question.');
  });

  it('prepends file context to the first text content part', () => {
    const message: FormattedMessageWithContent = {
      content: [
        { type: ContentTypes.IMAGE_URL, image_url: { url: 'data:image/png;base64,abc' } },
        { type: ContentTypes.TEXT, text: 'Answer this question.' },
      ],
    };

    prependFileContext(message, 'Attached file text');

    expect(Array.isArray(message.content)).toBe(true);
    if (!Array.isArray(message.content)) {
      throw new Error('Expected array content');
    }
    expect(message.content[1].text).toBe('Attached file text\nAnswer this question.');
    expect(message.content[0]).toEqual({
      type: ContentTypes.IMAGE_URL,
      image_url: { url: 'data:image/png;base64,abc' },
    });
  });

  it('adds a text content part when an array has no text part', () => {
    const message: FormattedMessageWithContent = {
      content: [{ type: ContentTypes.IMAGE_URL, image_url: { url: 'data:image/png;base64,abc' } }],
    };

    prependFileContext(message, 'Attached file text');

    expect(message.content).toEqual([
      { type: ContentTypes.TEXT, text: 'Attached file text' },
      { type: ContentTypes.IMAGE_URL, image_url: { url: 'data:image/png;base64,abc' } },
    ]);
  });

  it('replaces array content instead of editing the array the stored row shares', () => {
    const shared = [
      { type: ContentTypes.TEXT, text: 'Answer this question.' },
      { type: ContentTypes.IMAGE_URL, image_url: { url: 'data:image/png;base64,AAA' } },
    ];
    const message: FormattedMessageWithContent = { content: shared };
    prependFileContext(message, 'Attached file text');
    expect(shared[0]).toEqual({ type: ContentTypes.TEXT, text: 'Answer this question.' });
    expect(message.content).not.toBe(shared);
    if (!Array.isArray(message.content)) {
      throw new Error('Expected array content');
    }
    expect(message.content[0].text).toBe('Attached file text\nAnswer this question.');
    expect(message.content[1]).toBe(shared[1]);
  });

  it('leaves content unchanged when file context is empty', () => {
    const message: FormattedMessageWithContent = { content: 'Answer this question.' };

    prependFileContext(message, '');

    expect(message.content).toBe('Answer this question.');
  });
});

describe('prependQuotes', () => {
  it('prepends a single quote as a blockquote to string content', () => {
    const message: FormattedMessageWithContent = { content: 'Explain this.' };

    prependQuotes(message, ['the selected text']);

    expect(message.content).toBe('> the selected text\n\nExplain this.');
  });

  it('separates multiple quotes with a blank line', () => {
    const message: FormattedMessageWithContent = { content: 'Compare these.' };

    prependQuotes(message, ['first', 'second']);

    expect(message.content).toBe('> first\n\n> second\n\nCompare these.');
  });

  it('prepends to the first text part of array content, leaving other parts intact', () => {
    const message: FormattedMessageWithContent = {
      content: [
        { type: ContentTypes.IMAGE_URL, image_url: { url: 'data:image/png;base64,abc' } },
        { type: ContentTypes.TEXT, text: 'Explain this.' },
      ],
    };

    prependQuotes(message, ['excerpt']);

    if (!Array.isArray(message.content)) {
      throw new Error('Expected array content');
    }
    expect(message.content[1].text).toBe('> excerpt\n\nExplain this.');
    expect(message.content[0]).toEqual({
      type: ContentTypes.IMAGE_URL,
      image_url: { url: 'data:image/png;base64,abc' },
    });
  });

  it('adds a text part when an array has none', () => {
    const message: FormattedMessageWithContent = {
      content: [{ type: ContentTypes.IMAGE_URL, image_url: { url: 'data:image/png;base64,abc' } }],
    };

    prependQuotes(message, ['excerpt']);

    expect(message.content).toEqual([
      { type: ContentTypes.TEXT, text: '> excerpt' },
      { type: ContentTypes.IMAGE_URL, image_url: { url: 'data:image/png;base64,abc' } },
    ]);
  });

  it('leaves content unchanged when there are no quotes', () => {
    const message: FormattedMessageWithContent = { content: 'Explain this.' };

    prependQuotes(message, []);
    expect(message.content).toBe('Explain this.');

    prependQuotes(message, null);
    expect(message.content).toBe('Explain this.');
  });
});

describe('applyAttachmentOnlyText', () => {
  const withFiles = [{ file_id: 'f1' }] as TMessage['files'];

  it('substitutes text for an empty user turn that carries files', () => {
    const message: FormattedMessageWithContent = { role: 'user', content: '' };

    applyAttachmentOnlyText(message, withFiles);

    expect(message.content).toBe(ATTACHMENT_ONLY_TEXT);
  });

  it('leaves a user turn that already has text alone', () => {
    const message: FormattedMessageWithContent = { role: 'user', content: 'Summarize it' };

    applyAttachmentOnlyText(message, withFiles);

    expect(message.content).toBe('Summarize it');
  });

  it('leaves content that quotes or file context already filled alone', () => {
    const message: FormattedMessageWithContent = {
      role: 'user',
      content: [{ type: ContentTypes.TEXT, text: 'Attached file text' }],
    };

    applyAttachmentOnlyText(message, withFiles);

    expect(message.content).toEqual([{ type: ContentTypes.TEXT, text: 'Attached file text' }]);
  });

  it('ignores turns without files', () => {
    const message: FormattedMessageWithContent = { role: 'user', content: '' };

    applyAttachmentOnlyText(message, []);
    expect(message.content).toBe('');

    applyAttachmentOnlyText(message, null);
    expect(message.content).toBe('');
  });

  it('ignores non-user turns', () => {
    const message: FormattedMessageWithContent = { role: 'assistant', content: '' };

    applyAttachmentOnlyText(message, withFiles);

    expect(message.content).toBe('');
  });
});
