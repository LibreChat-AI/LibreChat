import type { NativeSignatures } from 'librechat-data-provider';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { NativeMediaUsageSink } from './native';
import type { MediaRuntime } from './runtime';
import { collectModelUsage, createSubagentUsageSink, recordCollectedUsage } from '~/agents/usage';
import { resolveNativeMediaFactory as resolveFactory, buildNativeMediaFactory } from './request';
import { runWithDetachedSubagentUsage } from '~/agents/subagentTaskContext';

function resolveNativeMediaFactory(
  request: Parameters<typeof resolveFactory>[0],
  conversationId: string,
  messageId: string,
  collectedUsage?: UsageMetadata[],
  usageOptions?: Parameters<typeof resolveFactory>[4],
) {
  return resolveFactory(
    request,
    conversationId,
    messageId,
    collectedUsage,
    usageOptions,
    request.app.locals.mediaRuntime,
  );
}

function fixture(retention?: { expiredAt: string | null; isTemporary?: boolean }) {
  const nativeFactory = jest.fn(
    async (..._args: Parameters<MediaRuntime['nativeFactory']>) => undefined,
  );
  const request = {
    app: { locals: { mediaRuntime: { nativeFactory } } },
    body: { text: 'Draw', isTemporary: false },
    config: { interfaceConfig: { retentionMode: 'all', generalChatRetention: 48 } },
    ...(retention ? { resolvedConversation: retention } : {}),
  } as unknown as Parameters<typeof resolveNativeMediaFactory>[0];
  return { request, nativeFactory };
}

it('reuses the original saved conversation deadline and preserves explicit permanent history', async () => {
  for (const expiredAt of ['2030-01-01T00:00:00.000Z', null]) {
    const { request, nativeFactory } = fixture({ expiredAt });
    await resolveNativeMediaFactory(request, 'conversation', 'message');
    expect(nativeFactory.mock.calls[0][1]).toEqual({
      conversationId: 'conversation',
      messageId: 'message',
      prompt: 'Draw',
      temporary: false,
      ...(expiredAt ? { expiresAt: expiredAt } : {}),
    });
  }
});

it('gives new saved media the shared ALL retention deadline', async () => {
  const { request, nativeFactory } = fixture();
  const before = Date.now();
  await resolveNativeMediaFactory(request, 'new-conversation', 'message');
  const source = nativeFactory.mock.calls[0][1] as { expiresAt: string };
  expect(Date.parse(source.expiresAt)).toBeGreaterThanOrEqual(before + 48 * 3_600_000);
  expect(Date.parse(source.expiresAt)).toBeLessThanOrEqual(Date.now() + 48 * 3_600_000);
});

it.each(['failure-first', 'completion-first'] as const)(
  'accounts for a provider call once when native failure and model-end usage overlap: %s',
  async (order) => {
    const { request, nativeFactory } = fixture();
    const collected: UsageMetadata[] = [];
    await resolveNativeMediaFactory(request, 'conversation', 'message', collected);
    const onUsage = nativeFactory.mock.calls[0][2] as NativeMediaUsageSink;
    const usage = {
      input_tokens: 20,
      output_tokens: 3,
      total_tokens: 23,
      input_token_details: { cache_read: 10 },
    };
    const completed = {
      ...usage,
      modelRunId: 'call-one',
      provider: 'google',
      model: 'gemini-image',
      agentId: 'agent',
    };
    if (order === 'completion-first') collectModelUsage(collected, completed, 'call-one');
    onUsage({
      modelRunId: 'call-one',
      usage,
      provider: 'google',
      model: 'gemini-image',
      agentId: 'agent',
    });
    if (order === 'failure-first') collectModelUsage(collected, completed, 'call-one');
    expect(collected).toEqual([completed]);
    onUsage({
      modelRunId: 'call-two',
      usage,
      provider: 'google',
      model: 'gemini-image',
      agentId: 'agent',
    });
    expect(collected).toHaveLength(2);
  },
);

it.each(['subagent', 'sequential'] as const)(
  'bills hidden native %s failures without adding their output to the parent',
  async (usageType) => {
    const { request, nativeFactory } = fixture();
    const collected: UsageMetadata[] = [{ input_tokens: 10, output_tokens: 2, model: 'parent' }];
    await resolveNativeMediaFactory(request, 'conversation', 'message', collected);
    const onUsage = nativeFactory.mock.calls[0][2] as NativeMediaUsageSink;
    await onUsage({
      modelRunId: 'child-call',
      usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
      model: 'gemini-image',
      provider: 'google',
      agentId: 'child',
      usageType,
    });
    const spendTokens = jest.fn().mockResolvedValue(undefined);
    const resolveEndpointTokenConfig = jest.fn(() => undefined);
    const result = await recordCollectedUsage(
      { spendTokens, spendStructuredTokens: jest.fn().mockResolvedValue(undefined) },
      {
        user: 'owner',
        conversationId: 'conversation',
        collectedUsage: collected,
        resolveEndpointTokenConfig,
      },
    );
    expect(result).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect(spendTokens).toHaveBeenLastCalledWith(
      expect.objectContaining({ context: usageType, model: 'gemini-image' }),
      { promptTokens: 30, completionTokens: 8 },
    );
    expect(resolveEndpointTokenConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentId: 'child',
        usage_type: usageType,
        modelRunId: 'child-call',
      }),
    );
  },
);

it.each(['failure-first', 'completion-first'] as const)(
  'awaits one detached native debit after the parent has flushed: %s',
  async (order) => {
    const { request, nativeFactory } = fixture();
    const collected: UsageMetadata[] = [];
    const detached: UsageMetadata[] = [];
    let release!: () => void;
    const billing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recordDetachedUsage = jest.fn(() => billing);
    const emitted = jest.fn();
    await resolveNativeMediaFactory(request, 'conversation', 'message', collected, {
      recordDetachedUsage,
      onUsage: emitted,
    });
    const onFailure = nativeFactory.mock.calls[0][2] as NativeMediaUsageSink;
    const onCompletion = createSubagentUsageSink(collected, emitted, recordDetachedUsage);
    const usage = {
      input_tokens: 30,
      output_tokens: 8,
      total_tokens: 38,
      input_token_details: { cache_read: 12 },
    };
    await runWithDetachedSubagentUsage(detached, async () => {
      const fail = () =>
        onFailure({
          modelRunId: 'child-call',
          usage,
          model: 'gemini-image',
          provider: 'google',
          agentId: 'child',
          usageType: 'subagent',
        });
      const complete = () =>
        onCompletion({
          modelRunId: 'child-call',
          usage,
          model: 'gemini-image',
          provider: 'google',
          subagentType: 'artist',
          subagentRunId: 'child-run',
          subagentAgentId: 'child',
          runId: 'parent-run',
        });
      let settled = false;
      const first = order === 'failure-first' ? fail() : complete();
      const second = order === 'failure-first' ? complete() : fail();
      const pending = Promise.all([first, second]).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(recordDetachedUsage).toHaveBeenCalledTimes(1);
      expect(emitted).toHaveBeenCalledTimes(1);
      expect(collected).toEqual([]);
      expect(detached).toEqual([
        expect.objectContaining({
          ...usage,
          agentId: 'child',
          modelRunId: 'child-call',
          usage_type: 'subagent',
        }),
      ]);
      release();
      await pending;
    });
  },
);

it('retains a detached native failure in its task collector if billing rejects', async () => {
  const { request, nativeFactory } = fixture();
  const collected: UsageMetadata[] = [];
  const detached: UsageMetadata[] = [];
  await resolveNativeMediaFactory(request, 'conversation', 'message', collected, {
    recordDetachedUsage: async () => {
      throw new Error('billing unavailable');
    },
  });
  const onFailure = nativeFactory.mock.calls[0][2] as NativeMediaUsageSink;
  await runWithDetachedSubagentUsage(detached, async () => {
    await expect(
      onFailure({
        modelRunId: 'child-call',
        usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
        model: 'gemini-image',
        provider: 'google',
        agentId: 'child',
        usageType: 'subagent',
      }),
    ).rejects.toThrow('billing unavailable');
  });
  expect(collected).toEqual([]);
  expect(detached).toEqual([
    expect.objectContaining({ modelRunId: 'child-call', input_tokens: 30, usage_type: 'subagent' }),
  ]);
});

it('does not mistake retained usage for a billing acknowledgement', async () => {
  const { request, nativeFactory } = fixture();
  const collected: UsageMetadata[] = [];
  const detached: UsageMetadata[] = [
    { modelRunId: 'child-call', input_tokens: 30, output_tokens: 8 },
  ];
  const recordDetachedUsage = jest.fn().mockResolvedValue(undefined);
  await resolveNativeMediaFactory(request, 'conversation', 'message', collected, {
    recordDetachedUsage,
  });
  const onFailure = nativeFactory.mock.calls[0][2] as NativeMediaUsageSink;
  await runWithDetachedSubagentUsage(detached, async () => {
    await onFailure({
      modelRunId: 'child-call',
      usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
      model: 'gemini-image',
      provider: 'google',
      agentId: 'child',
      usageType: 'subagent',
    });
  });
  expect(recordDetachedUsage).toHaveBeenCalledTimes(1);
  expect(detached).toHaveLength(1);
  expect(collected).toEqual([]);
});

it('takes the runtime from injected client wiring for initial and resumed runs', async () => {
  const { request, nativeFactory } = fixture();
  const client = {
    options: { req: request, mediaRuntime: { nativeFactory } },
    conversationId: 'conversation',
    responseMessageId: 'message',
    collectedUsage: [],
  };
  await buildNativeMediaFactory(client, {});
  expect(nativeFactory).toHaveBeenCalledTimes(1);
  await expect(
    Promise.resolve(resolveFactory(request, 'conversation', 'message')),
  ).resolves.toBeUndefined();
  expect(nativeFactory).toHaveBeenCalledTimes(1);
});

it('serializes private native snapshots onto the same generation before streamed parts return', async () => {
  const { request, nativeFactory } = fixture();
  request._resumableStreamId = 'stream';
  const client = {
    options: { req: request, mediaRuntime: { nativeFactory } },
    conversationId: 'conversation',
    responseMessageId: 'message',
    collectedUsage: [],
    jobCreatedAt: 123,
  };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const updateMetadata = jest.fn(async () => {
    await blocked;
  });
  await buildNativeMediaFactory(client, {}, { updateMetadata });
  const source = nativeFactory.mock.calls[0][1];
  const signatures: NativeSignatures = { '0': { text: 'First', thoughtSignature: 'private-0' } };
  const first = source.onSignatures!(signatures);
  signatures['1'] = { mimeType: 'image/png', thoughtSignature: 'private-1' };
  const second = source.onSignatures!(signatures);
  await Promise.resolve();
  expect(updateMetadata).toHaveBeenCalledTimes(1);
  expect(updateMetadata).toHaveBeenNthCalledWith(
    1,
    'stream',
    { nativeSignatures: { '0': signatures['0'] } },
    123,
  );
  release();
  await Promise.all([first, second]);
  expect(updateMetadata).toHaveBeenNthCalledWith(
    2,
    'stream',
    { nativeSignatures: signatures },
    123,
  );
});

it('publishes later native signatures after one metadata write fails', async () => {
  const { request, nativeFactory } = fixture();
  request._resumableStreamId = 'stream';
  const client = {
    options: { req: request, mediaRuntime: { nativeFactory } },
    conversationId: 'conversation',
    responseMessageId: 'message',
    collectedUsage: [],
    jobCreatedAt: 123,
  };
  const updateMetadata = jest
    .fn<Promise<void>, unknown[]>()
    .mockRejectedValueOnce(new Error('job store unavailable'))
    .mockResolvedValue(undefined);
  await buildNativeMediaFactory(client, {}, { updateMetadata });
  const source = nativeFactory.mock.calls[0][1];
  const signatures: NativeSignatures = { '0': { text: 'First', thoughtSignature: 'private-0' } };
  await expect(source.onSignatures!(signatures)).rejects.toThrow('job store unavailable');
  signatures['1'] = { mimeType: 'image/png', thoughtSignature: 'private-1' };
  await expect(source.onSignatures!(signatures)).resolves.toBeUndefined();
  expect(updateMetadata).toHaveBeenLastCalledWith('stream', { nativeSignatures: signatures }, 123);
});
