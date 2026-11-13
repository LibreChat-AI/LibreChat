import type { ToolCompleteEvent } from '@librechat/agents';
import type { Response as HttpResponse } from 'express';
import type { Response } from './types';
import {
  buildAggregatedResponse,
  createResponseAggregator,
  createResponsesEventHandlers,
  createAggregatorEventHandlers,
} from './service';
import { createResponseTracker } from './handlers';

const context = { responseId: 'resp_completion', model: 'agent', createdAt: 1 };
function setup(stream: boolean, announceArguments = true) {
  const events: Array<{ type: string; response?: Response; call_id?: string; arguments?: string }> =
    [];
  const res = {
    write: (chunk: string) => {
      if (chunk.startsWith('data: ') && !chunk.includes('[DONE]'))
        events.push(JSON.parse(chunk.slice(6)));
    },
  } as HttpResponse;
  const streaming = createResponsesEventHandlers({
    res,
    tracker: createResponseTracker(),
    context,
  });
  const aggregator = createResponseAggregator();
  const handlers = stream ? streaming.handlers : createAggregatorEventHandlers(aggregator);
  handlers.on_run_step.handle('on_run_step', {
    id: 'step-a',
    stepDetails: {
      type: 'tool_calls',
      tool_calls: [{ id: 'call-a', name: 'protected_lookup' }],
    },
  });
  if (announceArguments)
    handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: { tool_calls: [{ id: 'call-a', args: {} }] },
    });
  return {
    handlers,
    events,
    finish: () => {
      if (!stream) return buildAggregatedResponse(context, aggregator);
      streaming.finalizeStream();
      return events.find((event) => event.type === 'response.completed')!.response!;
    },
  };
}
function completed(output: string, id = 'call-a') {
  return {
    result: {
      id: 'step-a',
      index: 0,
      type: 'tool_call',
      tool_call: { id, name: 'protected_lookup', args: '{}', output, progress: 1 },
    },
  } satisfies { result: ToolCompleteEvent };
}

describe.each([false, true])('authoritative SDK tool completion (stream=%s)', (stream) => {
  it('finishes eager calls with exact arguments and ignores fragments that arrive after completion', () => {
    const f = setup(stream, false);
    f.handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step-a',
      delta: {
        type: 'tool_calls',
        tool_calls: [{ id: 'call-a', args: '{"org":' }],
      },
    });
    const event = completed('actual-result');
    event.result.tool_call.args = '{"org":"a"}';
    f.handlers.on_run_step_completed.handle('on_run_step_completed', event);
    const countAfterCompletion = f.events.length;
    f.handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step-a',
      delta: {
        type: 'tool_calls',
        tool_calls: [{ id: 'call-a', args: '"a"}' }],
      },
    });
    f.handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: { tool_calls: [{ id: 'call-a', args: { org: 'a' } }] },
    });
    expect(f.events).toHaveLength(countAfterCompletion);
    expect(f.finish().output.find((item) => item.type === 'function_call')).toMatchObject({
      arguments: '{"org":"a"}',
      status: 'completed',
    });
    if (stream)
      expect(
        f.events.find((entry) => entry.type === 'response.function_call_arguments.done'),
      ).toMatchObject({ call_id: 'call-a', arguments: '{"org":"a"}' });
  });

  it.each(['{"result":[1,2]}', ''])(
    'retains the actual result including empty output: %s',
    (output) => {
      const f = setup(stream);
      const event = completed(output);
      f.handlers.on_run_step_completed.handle('on_run_step_completed', event);
      f.handlers.on_run_step_completed.handle('on_run_step_completed', event);
      const response = f.finish();
      expect(response.output.filter((item) => item.type === 'function_call_output')).toEqual([
        expect.objectContaining({ type: 'function_call_output', call_id: 'call-a', output }),
      ]);
      expect(response.output.find((item) => item.type === 'function_call')).toMatchObject({
        status: 'completed',
        arguments: '{}',
      });
    },
  );

  it('does not copy unrelated completion, summary or raw artifacts into the response', () => {
    const f = setup(stream);
    f.handlers.on_run_step_completed.handle(
      'on_run_step_completed',
      completed('unrelated-secret', 'unknown-call'),
    );
    f.handlers.on_run_step_completed.handle('on_run_step_completed', {
      result: { type: 'summary', summary: 'private-summary' },
    });
    f.handlers.on_run_step_completed.handle('on_run_step_completed', {
      result: { tool_call: { id: 'call-a', output: { artifact: { token: 'private-token' } } } },
    });
    expect(f.finish().output.some((item) => item.type === 'function_call_output')).toBe(false);
    expect(JSON.stringify(f.events)).not.toMatch(/unrelated-secret|private-summary|private-token/);
  });

  it('keeps compatibility with legacy flat completions without emitting a second result', () => {
    const f = setup(stream);
    f.handlers.on_tool_end.handle('on_tool_end', {
      tool_call_id: 'call-a',
      output: 'first-result',
    });
    f.handlers.on_run_step_completed.handle('on_run_step_completed', completed('first-result'));
    expect(f.finish().output.filter((item) => item.type === 'function_call_output')).toEqual([
      expect.objectContaining({ call_id: 'call-a', output: 'first-result' }),
    ]);
  });
});
