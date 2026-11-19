import { Constants, GraphEvents } from '@librechat/agents';
import { AIMessage } from '@librechat/agents/langchain/messages';
import { serverProductFactSchema } from 'librechat-data-provider';
import type { ChatGeneration } from '@langchain/core/outputs';
import type { ProductTrackingRequest } from './product';
import {
  createProductModelCallback,
  createProductRemoteModelHandlers,
  observeProductRun,
  observeProductRunSetup,
} from './product';

const trackers: jest.Mock[] = [];
afterEach(() => {
  for (const tracker of trackers.splice(0)) {
    for (const [fact] of tracker.mock.calls) {
      serverProductFactSchema.parse(fact);
    }
  }
});

function request() {
  const productTracker = jest.fn();
  trackers.push(productTracker);
  const req: ProductTrackingRequest = {
    productTracker,
    productTracking: { enabled: true },
    productTrackingContext: { submissionId: 'aef33490-7e1a-4786-9ac6-d45dd28ca281' },
  };
  return { req, track: productTracker };
}

function generation(message: AIMessage): ChatGeneration {
  return { text: '', message };
}

const context = { runId: 'generation', conversationId: 'conversation', agentId: 'agent_root' };

describe('product execution facts', () => {
  it('does not install callbacks when tracking is disabled', () => {
    const { req } = request();
    expect(
      createProductModelCallback(
        { ...req, productTracking: undefined },
        context,
        new AbortController().signal,
      ),
    ).toBeUndefined();
  });

  it('records actual call attribution and measured zero without inventing missing usage', async () => {
    const { req, track } = request();
    const callback = createProductModelCallback(req, context, new AbortController().signal)!;
    await callback.handleChatModelStart?.(
      { id: [], lc: 1, type: 'not_implemented' },
      [],
      'call',
      'parent-call',
      undefined,
      undefined,
      {
        ls_model_name: 'fallback-model',
        [Constants.INVOKED_PROVIDER]: 'anthropic',
        agentId: 'agent_nested',
      },
    );
    await callback.handleLLMEnd?.(
      {
        generations: [
          [
            generation(
              new AIMessage({
                content: 'private response',
                usage_metadata: {
                  input_tokens: 0,
                  output_tokens: 5,
                  total_tokens: 5,
                  input_token_details: { cache_read: 0 },
                },
              }),
            ),
          ],
        ],
      },
      'call',
    );
    expect(track).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: 'librechat.chat.model.usage.recorded',
        model: 'custom',
        provider: 'anthropic',
        agentId: 'agent_nested',
        input_tokens: 0,
        output_tokens: 5,
        parentCallId: 'parent-call',
      }),
      req.productTrackingContext,
    );
    await callback.handleLLMEnd?.(
      {
        generations: [[generation(new AIMessage('private'))]],
      },
      'missing',
    );
    expect(track.mock.calls[1][0].input_tokens).toBeUndefined();
    expect(JSON.stringify(track.mock.calls)).not.toContain('private');
  });

  it('does not treat a paused run as a response completion; resume finishes once', async () => {
    const { req, track } = request();
    let interrupted = true;
    const run = observeProductRun(
      {
        processStream: async () => 'result',
        getInterrupt: () => (interrupted ? {} : undefined),
        getHaltReason: () => undefined,
      },
      req,
      context,
      new AbortController().signal,
    );
    await run.processStream();
    expect(track).not.toHaveBeenCalled();
    interrupted = false;
    await run.processStream();
    await run.processStream();
    expect(track.mock.calls.map(([fact]) => fact.name)).toEqual([
      'librechat.chat.response.finished',
    ]);
  });

  it('observes a remote resume even when it bypasses processStream', async () => {
    const { req, track } = request();
    const run = observeProductRun(
      {
        processStream: async () => 'start',
        resume: async () => 'resumed',
        getInterrupt: () => undefined,
        getHaltReason: () => undefined,
      },
      req,
      context,
      new AbortController().signal,
    );
    expect(await run.resume()).toBe('resumed');
    expect(track.mock.calls[0][0]).toMatchObject({
      name: 'librechat.chat.response.finished',
      outcome: 'completed',
    });
  });

  it('tracks a remote model result without retaining its content', async () => {
    const { req, track } = request();
    const handlers = createProductRemoteModelHandlers(undefined, req, context)!;
    await handlers[GraphEvents.CHAT_MODEL_END].handle(
      GraphEvents.CHAT_MODEL_END,
      {
        output: new AIMessage({
          content: 'secret',
          usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        }),
      },
      { ls_model_name: 'remote-model', [Constants.INVOKED_PROVIDER]: 'openAI' },
    );
    expect(track.mock.calls[0][0]).toMatchObject({
      name: 'librechat.chat.model.usage.recorded',
      input_tokens: 2,
      model: 'custom',
    });
    expect(JSON.stringify(track.mock.calls)).not.toContain('secret');
  });
  it('reports setup failures without inventing an agent or model invocation', async () => {
    const { req, track } = request();
    const error = new Error('secret provider config');
    await expect(
      observeProductRunSetup(req, context, new AbortController().signal, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0][0]).toMatchObject({
      name: 'librechat.chat.response.finished',
      outcome: 'failed',
    });
    expect(JSON.stringify(track.mock.calls)).not.toContain('secret');
  });

  it('recognizes owned cancellation during setup and leaves successful setup open', async () => {
    const { req, track } = request();
    const abort = new AbortController();
    const result = {};
    expect(await observeProductRunSetup(req, context, abort.signal, async () => result)).toBe(
      result,
    );
    expect(track).not.toHaveBeenCalled();
    abort.abort();
    await expect(
      observeProductRunSetup(req, context, abort.signal, async () => {
        throw abort.signal.reason;
      }),
    ).rejects.toBe(abort.signal.reason);
    expect(track.mock.calls[0][0]).toMatchObject({ outcome: 'cancelled' });
  });
  it.each([false, true])(
    'waits for the outer resume boundary before reporting completion (cleanup failure: %s)',
    async (cleanupFails) => {
      const { req, track } = request();
      const failure = new Error('cleanup failure');
      const subject = {
        processStream: async () => 'stream result',
        resume: async () => {
          const result = await subject.processStream();
          expect(track).not.toHaveBeenCalled();
          if (cleanupFails) throw failure;
          return result;
        },
        getInterrupt: () => undefined,
        getHaltReason: () => undefined,
      };
      const run = observeProductRun(subject, req, context, new AbortController().signal);
      if (cleanupFails) await expect(run.resume()).rejects.toBe(failure);
      else await expect(run.resume()).resolves.toBe('stream result');
      expect(track).toHaveBeenCalledTimes(1);
      expect(track.mock.calls[0][0]).toMatchObject({
        name: 'librechat.chat.response.finished',
        outcome: cleanupFails ? 'failed' : 'completed',
      });
    },
  );
});

it('keeps execution correlation without ephemeral labels, custom models or provider names', async () => {
  const { req, track } = request();
  const callback = createProductModelCallback(
    req,
    { ...context, agentId: 'private-endpoint__private-model___private-customer' },
    new AbortController().signal,
  )!;
  await callback.handleChatModelStart?.(
    { id: [], lc: 1, type: 'not_implemented' },
    [],
    'correlated-call',
    'parent-call',
    undefined,
    undefined,
    {
      ls_model_name: 'private-model',
      [Constants.INVOKED_PROVIDER]: 'private-endpoint',
      messageId: 'private-unused-message',
    },
  );
  await callback.handleLLMEnd?.(
    { generations: [[generation(new AIMessage('private-completion'))]] },
    'correlated-call',
  );
  expect(track).toHaveBeenCalledTimes(1);
  const facts = track.mock.calls.map(([fact]) => fact);
  expect(facts[0]).toMatchObject({
    runId: context.runId,
    callId: 'correlated-call',
    parentCallId: 'parent-call',
    model: 'custom',
    provider: 'custom',
  });
  for (const fact of facts) {
    expect(fact.agentId).toBeUndefined();
    expect(fact).not.toHaveProperty('messageId');
    expect(fact).not.toHaveProperty('responseMessageId');
  }
  expect(JSON.stringify(facts)).not.toContain('private-');
});
