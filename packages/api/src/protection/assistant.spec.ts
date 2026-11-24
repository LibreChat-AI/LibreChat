import { once } from 'node:events';
import { createServer } from 'node:http';
import { AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import {
  FileSources,
  outputProtectionSchema,
  setPiiRegexProgramSizer,
} from 'librechat-data-provider';
import {
  GraphEvents,
  Providers,
  createContentAggregator,
  formatAgentMessages,
} from '@librechat/agents';
import type { MessageDeltaEvent, RunStep, TPayload } from '@librechat/agents';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  admitAssistantRequest,
  isInteractiveAssistantRequest,
  allowsAssistantSideEffects,
  runAssistantSideEffect,
  createAssistantProtection,
  inspectAssistantHistory,
} from './assistant';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { createModelBoundChatModelCallback } from '~/middleware/modelBoundContent';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { getUserFacingGenerationError } from '~/agents/failures/terminal';
import { getPiiRegexProgramSize } from './programSize';
import { createRun } from '~/agents/run';

const marker = 'private phrase example';
const config = {
  outputProtection: {
    version: 1 as const,
    assistantText: {
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'Private phrase', regex: marker }],
      timeoutMs: 5_000,
    },
  },
};
const allowed = 'This is an approved answer.';
const writeChunk = (res: ServerResponse, delta: object, reason: string | null = null) => {
  res.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, delta, finish_reason: reason }],
    })}\n\n`,
  );
};

beforeAll(() => setPiiRegexProgramSizer(getPiiRegexProgramSize));

async function fixture(parts: (string | Record<string, unknown>)[], hold?: Promise<void>) {
  const outbound: string[] = [];
  let started!: () => void;
  const firstChunk = new Promise<void>((resolve) => {
    started = resolve;
  });
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    outbound.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [index, content] of parts.entries()) {
      writeChunk(res, {
        ...(index === 0 && { role: 'assistant' }),
        ...(typeof content === 'string' ? { content } : content),
      });
      if (index === 0) {
        started();
        await hold;
      }
    }
    writeChunk(res, {}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const agent = {
    id: 'agent_text',
    name: 'Text agent',
    description: '',
    created_at: 0,
    avatar: null,
    provider: Providers.OPENAI,
    model: 'gpt-4o-mini',
    model_parameters: {
      model: 'gpt-4o-mini',
      temperature: null,
      maxContextTokens: null,
      max_context_tokens: null,
      max_output_tokens: null,
      top_p: null,
      frequency_penalty: null,
      presence_penalty: null,
      apiKey: 'test-key',
      configuration: { baseURL: `http://127.0.0.1:${address.port}/v1` },
      useResponsesApi: false,
    },
  };
  return {
    firstChunk,
    outbound,
    agent,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function setup(
  agent: Awaited<ReturnType<typeof fixture>>['agent'],
  {
    reasoning,
    ...options
  }: Partial<Parameters<typeof createRun>[0]> & { reasoning?: jest.Mock } = {},
  manager?: GenerationJobManagerClass,
) {
  const { contentParts, aggregateContent } = createContentAggregator();
  const streamId = 'assistant-output';
  if (manager != null) {
    const job = await manager.createJob(streamId, 'owner', streamId);
    // The chat controller registers the same mutable aggregation array on its job.
    manager.setContentParts(
      streamId,
      contentParts as NonNullable<(typeof contentParts)[number]>[],
      job.createdAt,
    );
  }
  const delta = jest.fn(async (_event: string, data: unknown) => {
    aggregateContent({ event: GraphEvents.ON_MESSAGE_DELTA, data: data as MessageDeltaEvent });
    await manager?.emitChunk(streamId, {
      event: GraphEvents.ON_MESSAGE_DELTA,
      data: { ...(data as MessageDeltaEvent) },
    });
  });
  const controller = new AbortController();
  const messages = options.messages ?? [new HumanMessage('Please explain.')];
  const run = await createRun({
    agents: [agent],
    signal: controller.signal,
    interactiveAssistant: true,
    tokenCounter: () => 1,
    messages,
    appConfig: { config, fileStrategy: FileSources.local, imageOutputType: 'png' },
    customHandlers: {
      [GraphEvents.ON_RUN_STEP]: {
        handle: (_event, data) =>
          aggregateContent({ event: GraphEvents.ON_RUN_STEP, data: data as RunStep }),
      },
      [GraphEvents.ON_MESSAGE_DELTA]: { handle: delta },
      ...(reasoning && { [GraphEvents.ON_REASONING_DELTA]: { handle: reasoning } }),
    },
    ...options,
  });
  return {
    run,
    contentParts,
    delta,
    resume: () => manager?.getResumeState(streamId),
    controller,
    stream: () => run.processStream({ messages }, { version: 'v2', signal: controller.signal }),
  };
}

function jobManager() {
  const manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: new InMemoryJobStore(),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  manager.initialize();
  return manager;
}

it('validates only the implemented output scope', () => {
  expect(outputProtectionSchema.safeParse(config.outputProtection).success).toBe(true);
  for (const output of [
    { ...config.outputProtection, version: 2 },
    { ...config.outputProtection, toolText: {} },
    { version: 1, assistantText: { timeoutMs: 0 } },
    { version: 1, assistantText: { timeoutMs: 10, starterPatterns: [] } },
    { version: 1, assistantText: { timeoutMs: 10, action: 'redact' } },
  ]) {
    expect(outputProtectionSchema.safeParse(output).success).toBe(false);
  }
});

it('only marks requests admitted by the authenticated interactive router', () => {
  const next = jest.fn();
  const json = jest.fn();
  const response = { status: jest.fn(() => ({ json })) };
  const request = { method: 'POST', path: '/', body: { text: 'Hello' }, config: { config } };
  const admit = (value: object) =>
    admitAssistantRequest(
      value as Parameters<typeof admitAssistantRequest>[0],
      response as unknown as Parameters<typeof admitAssistantRequest>[1],
      next,
    );
  expect(isInteractiveAssistantRequest(request)).toBe(false);
  admit(request);
  expect(next).toHaveBeenCalledTimes(1);
  expect(isInteractiveAssistantRequest(request)).toBe(true);
  for (const rejected of [
    { ...request, path: '/resume' },
    { ...request, _isAgentTrigger: true },
    { ...request, _isScheduledFire: true },
    { ...request, body: { text: 'Hello', files: ['file'] } },
  ]) {
    admit(rejected);
    expect(isInteractiveAssistantRequest(rejected)).toBe(false);
  }
  expect(json).toHaveBeenCalledTimes(4);
  expect(json).toHaveBeenLastCalledWith(
    expect.objectContaining({ code: 'assistant_output_unsupported' }),
  );
});

it('suppresses auxiliary producers only when protection is required', () => {
  const start = jest.fn(() => 'started');
  expect(allowsAssistantSideEffects({ config })).toBe(false);
  expect(runAssistantSideEffect({ config }, start)).toBeUndefined();
  expect(start).not.toHaveBeenCalled();
  expect(allowsAssistantSideEffects(undefined, false)).toBe(false);
  expect(runAssistantSideEffect(undefined, start)).toBe('started');
  expect(start).toHaveBeenCalledTimes(1);
});

describe('assistant history inspection', () => {
  const text = (value: string) => ({ type: 'text' as const, text: value });

  it('inspects each nonempty assistant message once and leaves user text to the input policy', () => {
    const policy = createAssistantProtection(config.outputProtection.assistantText);
    const inspect = jest.fn(policy.inspect);
    const messages = [
      new HumanMessage(marker),
      new HumanMessage({ content: [text(marker), text('more user text')] }),
      new AIMessage(''),
      new AIMessage({ content: [text(''), text('')] }),
      new AIMessage('plain text'),
      new AIMessage({ content: [text('single block')] }),
      new AIMessage({ content: [text(''), text('two '), text(''), text('blocks')] }),
    ];

    inspectAssistantHistory({ ...policy, inspect }, messages, new AbortController().signal);

    expect(inspect.mock.calls.map(([input]) => input.content)).toEqual([
      'plain text',
      'single block',
      'two blocks',
    ]);
  });

  it('charges multipart and plain assistant text to the same history budget', () => {
    const policy = createAssistantProtection(config.outputProtection.assistantText);
    const inspect = jest.fn(policy.inspect);
    const messages = [
      new AIMessage('abc'),
      new HumanMessage({ content: [text('not charged to the assistant budget')] }),
      new AIMessage({ content: [text('de'), text('f')] }),
    ];
    const signal = new AbortController().signal;

    inspectAssistantHistory({ ...policy, inspect, maxAttemptBytes: 24 }, messages, signal);
    expect(inspect.mock.calls.map(([input]) => input.content)).toEqual(['abc', 'def']);

    inspect.mockClear();
    expect(() =>
      inspectAssistantHistory({ ...policy, inspect, maxAttemptBytes: 23 }, messages, signal),
    ).toThrow(expect.objectContaining({ code: 'overflow' }));
    expect(inspect.mock.calls.map(([input]) => input.content)).toEqual(['abc']);
  });

  it('rejects non-text user history without running the assistant detector', () => {
    const policy = createAssistantProtection(config.outputProtection.assistantText);
    const inspect = jest.fn(policy.inspect);
    const history = new HumanMessage({
      content: [
        text('user text'),
        { type: 'image_url', image_url: 'https://example.invalid/image' },
      ],
    });

    expect(() =>
      inspectAssistantHistory({ ...policy, inspect }, [history], new AbortController().signal),
    ).toThrow(expect.objectContaining({ code: 'unsupported' }));
    expect(inspect).not.toHaveBeenCalled();
  });
});

it('withholds a match spanning provider chunks from deltas and run content', async () => {
  const provider = await fixture(['Here is the private ', 'phrase example.']);
  const manager = jobManager();
  try {
    const { contentParts, delta, resume, stream } = await setup(provider.agent, {}, manager);
    const error = await stream().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'blocked' });
    expect(delta).not.toHaveBeenCalled();
    expect(JSON.stringify(contentParts)).not.toContain('private ');
    expect(JSON.stringify(await resume())).not.toContain('private ');
    expect(getUserFacingGenerationError(error, { config }, 'fallback')).toBe(
      '{"type":"assistant_output_withheld"}',
    );
    expect(provider.outbound).toHaveLength(1);
  } finally {
    await Promise.all([provider.close(), manager.destroy()]);
  }
});

it('rejects a non-text provider payload before emitting any chat content', async () => {
  const provider = await fixture([{ reasoning: 'Unapproved control text' }, allowed]);
  const manager = jobManager();
  const reasoning = jest.fn();
  try {
    const { delta, resume, stream } = await setup(provider.agent, { reasoning }, manager);
    await expect(stream()).rejects.toMatchObject({ code: 'unsupported' });
    expect(reasoning).not.toHaveBeenCalled();
    expect(delta).not.toHaveBeenCalled();
    expect(JSON.stringify(await resume())).not.toContain('Unapproved control text');
    expect(provider.outbound).toHaveLength(1);
  } finally {
    await Promise.all([provider.close(), manager.destroy()]);
  }
});

it('emits approved text and sends it back as assistant history on the next turn', async () => {
  const provider = await fixture(['This is an ', 'approved answer.']);
  const manager = jobManager();
  try {
    const first = await setup(provider.agent, {}, manager);
    await first.stream();
    expect(JSON.stringify(first.delta.mock.calls)).toContain(allowed);
    expect(JSON.stringify(first.contentParts)).toContain(allowed);
    expect(JSON.stringify(await first.resume())).toContain(allowed);
    const saved = JSON.parse(JSON.stringify(first.contentParts)) as TPayload[number]['content'];
    const { messages } = formatAgentMessages([
      { role: 'user', content: 'First question.' },
      { role: 'assistant', content: saved },
      { role: 'user', content: 'Follow up.' },
    ]);
    const second = await setup(provider.agent, { messages });
    await second.stream();
    expect(provider.outbound).toHaveLength(2);
    expect(JSON.parse(provider.outbound[1]).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: allowed }] }),
      ]),
    );
  } finally {
    await Promise.all([provider.close(), manager.destroy()]);
  }
});

it('admits no provider call from an unsupported caller or unchecked history', async () => {
  const provider = await fixture([allowed]);
  try {
    await expect(setup(provider.agent, { interactiveAssistant: false })).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(
      setup(provider.agent, { messages: [new AIMessage(marker)] }),
    ).rejects.toMatchObject({ code: 'blocked' });
    const multipart = new AIMessage({
      content: [
        { type: 'text', text: 'private ' },
        { type: 'text', text: 'phrase example' },
      ],
    });
    await expect(setup(provider.agent, { messages: [multipart] })).rejects.toMatchObject({
      code: 'blocked',
    });
    expect(provider.outbound).toHaveLength(0);
  } finally {
    await provider.close();
  }
});

it('still applies the existing native model-input policy before provider execution', async () => {
  const provider = await fixture([allowed]);
  try {
    const { stream } = await setup(provider.agent, {
      messages: [new HumanMessage(marker)],
      modelCallbacks: [
        createModelBoundChatModelCallback({
          filters: {
            messages: {
              pii: {
                fields: ['text'],
                starterPatterns: [],
                customPatterns: [{ id: 'private', label: 'Private phrase', regex: marker }],
              },
            },
          },
        }),
      ],
    });
    await expect(stream()).rejects.toBeDefined();
    expect(provider.outbound).toHaveLength(0);
  } finally {
    await provider.close();
  }
});

it('does not release a pending reply after Stop', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = await fixture(['This is an ', 'approved answer.'], held);
  try {
    const { controller, contentParts, delta, stream } = await setup(provider.agent);
    const pending = stream().catch((error: unknown) => error);
    await provider.firstChunk;
    controller.abort();
    release();
    await pending;
    expect(delta).not.toHaveBeenCalled();
    expect(JSON.stringify(contentParts)).not.toContain('This is an');
  } finally {
    release();
    await provider.close();
  }
});

it('does not inspect a reply when the policy is absent', async () => {
  const provider = await fixture([marker]);
  try {
    const { delta, stream } = await setup(provider.agent, { appConfig: undefined });
    await stream();
    expect(JSON.stringify(delta.mock.calls)).toContain(marker);
  } finally {
    await provider.close();
  }
});
