import type { Response as ServerResponse } from 'express';
import type { OpenAIStreamHandlerConfig, OpenAIStreamWriterConfig } from './handlers';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { OpenAIResponseContext } from './types';
import {
  sendFinalChunk,
  buildCompletionUsage,
  OpenAIModelEndHandler,
  createOpenAIStreamTracker,
  createOpenAIContentAggregator,
  createOpenAIHandlers,
  createChunk,
  writeSSE,
} from './handlers';

describe('OpenAI-compatible agent stream handlers', () => {
  const context: OpenAIResponseContext = {
    requestId: 'chatcmpl-test',
    created: 1778317637,
    model: 'anthropic/claude-sonnet-4.6',
  };

  it('projects the same ordered frames through a plain writer and the legacy res option', () => {
    const replay = (legacy: boolean): string[] => {
      const frames: string[] = [];
      const writer = {
        write: (frame: string): void => {
          frames.push(frame);
        },
      };
      const tracker = createOpenAIStreamTracker();
      const config: OpenAIStreamHandlerConfig | OpenAIStreamWriterConfig = legacy
        ? { res: writer, context, tracker }
        : { writer, context, tracker };
      const handlers = createOpenAIHandlers(config);
      writeSSE(writer, createChunk(context, { role: 'assistant' }));
      handlers.on_message_delta.handle('on_message_delta', {
        delta: { content: [{ type: 'text', text: 'hello' }] },
      });
      handlers.on_reasoning_delta.handle('on_reasoning_delta', {
        delta: { content: [{ type: 'think', think: 'reasoning' }] },
      });
      handlers.on_model_response.handle('on_model_response', {
        type: 'model_response',
        id: 'accepted-1',
        agentId: 'agent',
        messageId: 'message-1',
        toolCalls: [{ id: 'call-1', name: 'lookup', args: { city: 'Madrid' } }],
        toolCallDispositions: ['client'],
        invalidToolCalls: [],
      });
      expect(frames).toHaveLength(3);
      sendFinalChunk(
        config,
        'stop',
        {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
          primary: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          subagent: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        },
        true,
      );
      return frames;
    };

    const current = replay(false);
    expect(current).toEqual(replay(true));
    const chunks = current.slice(0, -1).map((frame) => JSON.parse(frame.slice(6)));
    expect(chunks.map((chunk) => chunk.choices[0].delta)).toEqual([
      { role: 'assistant' },
      { content: 'hello' },
      { reasoning: 'reasoning' },
      { tool_calls: [expect.objectContaining({ id: 'call-1', index: 0 })] },
      {
        tool_calls: [
          expect.objectContaining({ index: 0, function: { arguments: '{"city":"Madrid"}' } }),
        ],
      },
      {},
    ]);
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('tool_calls');
    expect(chunks[chunks.length - 1].usage).toMatchObject({
      total_tokens: 15,
      subagent: { total_tokens: 3 },
    });
    expect(current[current.length - 1]).toBe('data: [DONE]\n\n');
  });

  it.each(['sdk', 'provider'] as const)(
    'does not project %s-owned calls from accepted results',
    (disposition) => {
      const frames: string[] = [];
      const tracker = createOpenAIStreamTracker();
      const config: OpenAIStreamWriterConfig = {
        writer: { write: (frame): void => void frames.push(frame) },
        context,
        tracker,
      };
      const handlers = createOpenAIHandlers(config);
      handlers.on_model_response.handle('on_model_response', {
        type: 'model_response',
        id: 'accepted-internal',
        agentId: 'agent',
        toolCalls: [{ id: 'internal', name: 'lookup', args: { city: 'Madrid' } }],
        toolCallDispositions: [disposition],
        invalidToolCalls: [],
      });
      sendFinalChunk(config);
      expect(tracker.toolCalls.size).toBe(0);
      expect(frames.some((frame) => frame.includes('tool_calls'))).toBe(false);
      expect(handlers.on_run_step).toBeUndefined();
      expect(handlers.on_run_step_delta).toBeUndefined();
    },
  );

  it('projects explicit client delegation into non-streaming output', () => {
    const aggregator = createOpenAIContentAggregator();
    const handlers = createOpenAIHandlers({ aggregator });
    handlers.on_model_response.handle('on_model_response', {
      type: 'model_response',
      id: 'accepted-client',
      agentId: 'agent',
      toolCalls: [{ id: 'client', name: 'lookup', args: { city: 'Madrid' } }],
      toolCallDispositions: ['client'],
      invalidToolCalls: [],
    });
    aggregator.finishToolCalls?.();
    expect(aggregator.toolCalls.get(0)).toEqual({
      id: 'client',
      type: 'function',
      function: { name: 'lookup', arguments: '{"city":"Madrid"}' },
    });
  });

  it('propagates a synchronous transport failure instead of claiming completion', () => {
    const writer = {
      write: (): never => {
        throw new Error('connection closed');
      },
    };
    expect(() => writeSSE(writer, createChunk(context, { content: 'hello' }))).toThrow(
      'connection closed',
    );
  });

  it('preserves reasoning token usage from model end metadata', () => {
    const tracker = createOpenAIStreamTracker();
    const write = jest.fn();
    const handler = new OpenAIModelEndHandler({
      context,
      tracker,
      res: { write } as unknown as ServerResponse,
    });

    handler.handle('on_chat_model_end', {
      output: {
        usage_metadata: {
          input_tokens: 64,
          output_tokens: 3315,
          output_token_details: {
            reasoning: 641,
          },
        },
      },
    });

    expect(tracker.usage).toEqual({
      promptTokens: 64,
      completionTokens: 3315,
      reasoningTokens: 641,
    });
  });

  it('includes reasoning token details in the final streamed usage chunk', () => {
    const tracker = createOpenAIStreamTracker();
    tracker.usage.promptTokens = 64;
    tracker.usage.completionTokens = 3315;
    tracker.usage.reasoningTokens = 641;

    const writes: string[] = [];
    const res = {
      write: (chunk: string) => {
        writes.push(chunk);
      },
    } as unknown as ServerResponse;

    sendFinalChunk({ context, tracker, res });

    const finalChunk = JSON.parse(writes[0].replace(/^data: /, '').trim());
    expect(finalChunk.usage).toEqual({
      prompt_tokens: 64,
      completion_tokens: 3315,
      total_tokens: 3379,
      completion_tokens_details: {
        reasoning_tokens: 641,
      },
    });
  });

  it('streams the collected primary and subagent usage override', () => {
    const tracker = createOpenAIStreamTracker();
    const writes: string[] = [];
    const res = {
      write: (chunk: string) => {
        writes.push(chunk);
      },
    } as unknown as ServerResponse;
    const usage = buildCompletionUsage([
      { input_tokens: 100, output_tokens: 40, provider: 'openai' },
      {
        input_tokens: 25,
        output_tokens: 10,
        provider: 'openai',
        usage_type: 'subagent',
      },
    ]);

    sendFinalChunk({ context, tracker, res }, 'stop', usage);

    const finalChunk = JSON.parse(writes[0].replace(/^data: /, '').trim());
    expect(finalChunk.usage).toEqual({
      prompt_tokens: 125,
      completion_tokens: 50,
      total_tokens: 175,
      primary: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      subagent: { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 },
    });
  });

  it('snapshots completed response usage before later detached calls arrive', () => {
    const collectedUsage: UsageMetadata[] = [
      { input_tokens: 100, output_tokens: 40, provider: 'openAI' },
    ];
    const completedUsage = buildCompletionUsage(collectedUsage);

    collectedUsage.push({
      input_tokens: 25,
      output_tokens: 10,
      provider: 'openAI',
      usage_type: 'subagent',
    });

    expect(completedUsage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      primary: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      subagent: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });
});
