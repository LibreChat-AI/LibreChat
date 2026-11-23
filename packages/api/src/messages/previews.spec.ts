import { ContentTypes, toolCallPreviewsConfigSchema } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import {
  previewToolCall,
  previewOutputText,
  previewToolCallArgs,
  wantsToolCallPreviews,
  containsToolCallPreviews,
  prepareToolCallPreviews,
  previewMessagesToolCalls,
  previewContentToolCalls,
  prepareResultToolCallPreviews,
  rejectToolCallPreviewWrites,
  withToolCallPreviews,
  withMessageToolCallPreviews,
  TOOL_CALL_PREVIEW_ELISION,
  findSubagentAttachmentCalls,
} from './previews';

const limits = { outputChars: 1_024, argsChars: 1_024 };

type TestToolCall = {
  type?: string;
  id?: string;
  name?: string;
  args?: unknown;
  output?: string;
  executor?: string;
  progress?: number;
  runStepStatus?: string;
  stepId?: string;
  approval?: unknown;
  subagent_content?: unknown[];
  outputTruncated?: true;
  argsTruncated?: true;
  subagentContentOmitted?: true;
  subagentAttachmentCalls?: Array<{ id: string; agentId?: string; stepId?: string }>;
  agentId?: string;
  subagentIdentity?: { subagentKind?: string; subagentAgentId?: string };
  function?: unknown;
};

type TestMessage = { messageId?: string; content?: unknown[]; updatedAt?: Date };

const toolPart = (toolCall: TestToolCall) => ({
  type: ContentTypes.TOOL_CALL,
  tool_call: { type: 'tool_call', id: 'call_1', name: 'bash_tool', ...toolCall } as TestToolCall,
});

const longOutput = (head: string, tail: string, fill = 'x'.repeat(20_000)) =>
  `${head}${fill}${tail}`;

describe('attachment matching work configuration', () => {
  it('defaults to a bounded budget and accepts overrides', () => {
    expect(toolCallPreviewsConfigSchema.parse({}).attachmentWorkLimit).toBe(100_000);
    expect(toolCallPreviewsConfigSchema.parse({ attachmentWorkLimit: 2 }).attachmentWorkLimit).toBe(
      2,
    );
  });

  it.each([0, -1, 1.5, 1_000_001, Infinity, '100'])('rejects invalid budget %p', (value) => {
    expect(toolCallPreviewsConfigSchema.safeParse({ attachmentWorkLimit: value }).success).toBe(
      false,
    );
  });
});

describe('previewOutputText', () => {
  it('keeps short output untouched', () => {
    expect(previewOutputText('done', 1_024)).toBe('done');
  });

  it('keeps the start and the end within the bound', () => {
    const output = longOutput('stdout:\nhello', '\n[exit code: 2]');
    const preview = previewOutputText(output, 1_024);
    expect(preview.length).toBeLessThanOrEqual(1_024);
    expect(preview.startsWith('stdout:\nhello')).toBe(true);
    expect(preview.endsWith('\n[exit code: 2]')).toBe(true);
    expect(preview).toContain(TOOL_CALL_PREVIEW_ELISION);
  });

  it('never splits a surrogate pair at either cut', () => {
    const output = '😀'.repeat(5_000);
    const preview = previewOutputText(output, 1_024);
    const [head, tail] = preview.split(TOOL_CALL_PREVIEW_ELISION);
    expect(head).toBe('😀'.repeat(head.length / 2));
    expect(tail).toBe('😀'.repeat(tail.length / 2));
  });
});

describe('previewToolCallArgs', () => {
  it('returns nothing for arguments within the bound', () => {
    expect(previewToolCallArgs('{"command":"ls"}', 1_024)).toBeUndefined();
    expect(previewToolCallArgs({ command: 'ls' }, 1_024)).toBeUndefined();
  });

  it('keeps JSON string arguments parseable, with every field still present', () => {
    const args = JSON.stringify({
      command: 'cat big.log',
      intent: 'Reading the build log',
      content: 'y'.repeat(50_000),
    });
    const preview = previewToolCallArgs(args, 1_024);
    expect(preview?.length).toBe(args.length);
    expect(typeof preview?.args).toBe('string');
    const parsed = JSON.parse(preview?.args as string);
    expect(parsed.command).toBe('cat big.log');
    expect(parsed.intent).toBe('Reading the build log');
    expect(parsed.content.startsWith('yyy')).toBe(true);
    expect(parsed.content.endsWith('…')).toBe(true);
    expect((preview?.args as string).length).toBeLessThanOrEqual(1_024);
  });

  it('shortens only the longest strings, keeping every short field exact', () => {
    const args = JSON.stringify({
      intent: 'Patch the route so the part endpoint reuses the ownership probe',
      path: 'api/server/routes/messages.js',
      replace: 'r'.repeat(4_000),
      search: 's'.repeat(3_000),
      flags: { dryRun: false, count: 3 },
      tags: ['a', 'b'],
    });
    const parsed = JSON.parse(previewToolCallArgs(args, 512)?.args as string);
    expect(parsed.intent).toBe('Patch the route so the part endpoint reuses the ownership probe');
    expect(parsed.path).toBe('api/server/routes/messages.js');
    expect(parsed.flags).toEqual({ dryRun: false, count: 3 });
    expect(parsed.tags).toEqual(['a', 'b']);
    expect(parsed.replace.length).toBe(parsed.search.length);
  });

  it('keeps object arguments as objects', () => {
    const args = { path: 'src/index.ts', content: 'z'.repeat(10_000) };
    const preview = previewToolCallArgs(args, 1_024);
    expect(preview?.args).toEqual({ path: 'src/index.ts', content: expect.any(String) });
    expect(preview?.length).toBe(JSON.stringify(args).length);
  });

  it('falls back to a bounded prefix for text that is not JSON', () => {
    const args = 'q'.repeat(5_000);
    const preview = previewToolCallArgs(args, 1_024);
    expect(preview).toEqual({ args: 'q'.repeat(1_024), length: 5_000 });
  });

  it('falls back to a bounded prefix when even short strings cannot fit', () => {
    const args = JSON.stringify(
      Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, i])),
    );
    const preview = previewToolCallArgs(args, 1_024);
    expect((preview?.args as string).length).toBe(1_024);
  });
});

describe('previewToolCall', () => {
  it('shortens a settled call and records what it shortened', () => {
    const output = longOutput('Error: failed', '\n Please fix your mistakes.');
    const args = JSON.stringify({ command: 'run', content: 'a'.repeat(5_000) });
    const toolCall = toolPart({ output, args, progress: 1 }).tool_call;
    const preview = previewToolCall(toolCall, limits);

    expect(preview).not.toBe(toolCall);
    expect(preview).toMatchObject({
      id: 'call_1',
      name: 'bash_tool',
      progress: 1,
      outputTruncated: true,
      outputLength: output.length,
      argsTruncated: true,
      argsLength: args.length,
    });
    expect(preview.output).toMatch(/^Error: failed/);
    expect(preview.output).toMatch(/\n Please fix your mistakes\.$/);
    expect(toolCall.output).toBe(output);
  });

  it('keeps JSON output parseable, so result cards still read their fields', () => {
    const output = JSON.stringify({
      status: 'completed',
      task_id: 'task_1',
      output: 'line\n'.repeat(5_000),
    });
    const preview = previewToolCall(
      toolPart({ name: 'check_background_task', output }).tool_call,
      limits,
    );
    expect(preview.outputTruncated).toBe(true);
    const parsed = JSON.parse(preview.output as string);
    expect(parsed).toMatchObject({ status: 'completed', task_id: 'task_1' });
    expect((preview.output as string).length).toBeLessThanOrEqual(limits.outputChars);
  });

  it('keeps an attached-workspace exit trailer whole even past half the bound', () => {
    const trailer =
      '\n[exit code: 1][timed out]\nCommand reached timeoutMs: 120000. ' +
      'r'.repeat(300) +
      '\n[directory hint: ' +
      'h'.repeat(300) +
      ']';
    const output = `[starting directory: "workspace/"]\nstdout:\n${'o'.repeat(20_000)}\n${trailer}`;
    const attached = previewToolCall(
      toolPart({ output, executor: 'attached_workspace' }).tool_call,
      limits,
    );
    expect(attached.output?.endsWith(trailer)).toBe(true);
    expect(attached.output?.startsWith('[starting directory: "workspace/"]\nstdout:\n')).toBe(true);

    const sandbox = previewToolCall(toolPart({ output }).tool_call, limits);
    expect(sandbox.output?.length).toBeLessThanOrEqual(limits.outputChars);
    expect(sandbox.output?.endsWith(trailer)).toBe(false);
  });

  it('leaves a call without an id whole, since it could not be fetched back by identity', () => {
    const anonymous = toolPart({ id: '', output: 'o'.repeat(5_000) }).tool_call;
    expect(previewToolCall(anonymous, limits)).toBe(anonymous);
    const missing = { ...toolPart({ output: 'o'.repeat(5_000) }).tool_call, id: undefined };
    expect(previewToolCall(missing, limits)).toBe(missing);
  });

  it('returns the same object when nothing exceeds the bounds', () => {
    const toolCall = toolPart({ output: 'ok', args: '{}' }).tool_call;
    expect(previewToolCall(toolCall, limits)).toBe(toolCall);
  });

  it('leaves calls without output untouched, pending approvals included', () => {
    const args = JSON.stringify({ command: 'rm -rf build', content: 'a'.repeat(5_000) });
    const pending = toolPart({
      args,
      approval: { actionId: 'a1', allowed_decisions: ['edit'] },
    }).tool_call;
    expect(previewToolCall(pending, limits)).toBe(pending);
    const running = toolPart({ args, output: '' }).tool_call;
    expect(previewToolCall(running, limits)).toBe(running);
  });

  it('omits a settled subagent transcript and counts its parts', () => {
    const transcript = [
      { type: ContentTypes.TEXT, text: 'child says hi' },
      toolPart({ id: 'child_call', output: 'done' }),
    ];
    const toolCall = toolPart({
      name: 'subagent',
      args: '{"prompt":"look"}',
      output: 'summary',
      subagent_content: transcript,
    }).tool_call;
    const preview = previewToolCall(toolCall, limits);
    expect(preview).not.toHaveProperty('subagent_content');
    expect(preview).toMatchObject({ subagentContentOmitted: true, subagentContentParts: 2 });
    expect(preview.output).toBe('summary');
  });

  it('keeps a subagent transcript that still holds an unresolved approval', () => {
    const transcript = [
      toolPart({
        id: 'child_call',
        args: '{}',
        approval: { actionId: 'a1', allowed_decisions: ['approve'] },
      }),
    ];
    const toolCall = toolPart({
      name: 'subagent',
      output: 'partial',
      subagent_content: transcript,
    }).tool_call;
    expect(previewToolCall(toolCall, limits)).toBe(toolCall);
  });

  it('omits the transcript of a subagent that finished without final text', () => {
    const transcript = [{ type: ContentTypes.TEXT, text: 'searched and found nothing' }];
    for (const finished of [{ progress: 1 }, { runStepStatus: 'completed' }]) {
      const toolCall = toolPart({
        name: 'subagent',
        subagent_content: transcript,
        ...finished,
      }).tool_call;
      const preview = previewToolCall(toolCall, limits);
      expect(preview).toMatchObject({ subagentContentOmitted: true, subagentContentParts: 1 });
      expect(preview).not.toHaveProperty('outputTruncated');
    }
  });

  it('keeps a subagent transcript while the subagent is still running', () => {
    const transcript = [{ type: ContentTypes.TEXT, text: 'working' }];
    const toolCall = toolPart({ name: 'subagent', subagent_content: transcript }).tool_call;
    expect(previewToolCall(toolCall, limits)).toBe(toolCall);
  });

  it('leaves image cards whole, since their details dialog shows the prompt directly', () => {
    for (const name of ['image_gen_oai', 'image_edit_oai', 'gemini_image_gen']) {
      const image = toolPart({
        name,
        args: JSON.stringify({ prompt: 'p'.repeat(4_000) }),
        output: 'o'.repeat(4_000),
      }).tool_call;
      expect(previewToolCall(image, limits)).toBe(image);
    }
  });

  it('sends a background-task result whole when no valid JSON preview fits', () => {
    const tasks = Array.from({ length: 200 }, (_, i) => ({
      task_id: `task_${i}`,
      status: i === 7 ? 'error' : 'completed',
      tool: 'bash_tool',
    }));
    const output = JSON.stringify({
      tasks,
      partial: true,
      warning: 'Some tasks are still running',
    });
    const check = toolPart({ name: 'check_background_task', output }).tool_call;
    expect(previewToolCall(check, limits).output).toBe(output);

    const other = toolPart({ name: 'list_issues_mcp_linear', output }).tool_call;
    const otherPreview = previewToolCall(other, limits);
    expect(otherPreview.outputTruncated).toBe(true);
    expect(otherPreview.output?.length).toBeLessThanOrEqual(limits.outputChars);
  });

  it('keeps a legacy web-search error whole, since its card reads the phrase anywhere', () => {
    const output = `${'result '.repeat(500)}Error processing request${' tail'.repeat(500)}`;
    const search = toolPart({ name: 'web_search', output }).tool_call;
    expect(previewToolCall(search, limits).output).toBe(output);
    const plain = toolPart({ name: 'web_search', output: 'result '.repeat(2_000) }).tool_call;
    expect(previewToolCall(plain, limits).outputTruncated).toBe(true);
  });

  it('leaves the question-and-answer record and legacy Assistants calls whole', () => {
    const ask = toolPart({ name: 'ask_user_question', output: 'a'.repeat(5_000) }).tool_call;
    expect(previewToolCall(ask, limits)).toBe(ask);
    const legacy = { type: 'function', function: { name: 'x', output: 'a'.repeat(5_000) } };
    expect(previewToolCall(legacy, limits)).toBe(legacy);
  });
});

describe('wide or unusual JSON', () => {
  it('falls back to text for a wide array without cloning it', () => {
    const output = JSON.stringify(Array.from({ length: 200_000 }, (_, i) => i));
    const stringify = jest.spyOn(JSON, 'stringify');
    const preview = previewToolCall(toolPart({ output }).tool_call, limits);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    expect(preview.outputTruncated).toBe(true);
    expect(preview.output?.length).toBeLessThanOrEqual(limits.outputChars);
  });

  it('falls back to text for an oversized property name without cloning it', () => {
    const output = `{"${'k'.repeat(200_000)}":1}`;
    const stringify = jest.spyOn(JSON, 'stringify');
    const preview = previewToolCall(toolPart({ output }).tool_call, limits);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    expect(preview.outputTruncated).toBe(true);
    expect(preview.output?.length).toBeLessThanOrEqual(limits.outputChars);
  });

  it('refuses a wide array without queueing its elements', () => {
    const output = JSON.stringify(Array.from({ length: 300_000 }, () => 1));
    const push = jest.spyOn(Array.prototype, 'push');
    const preview = previewToolCall(toolPart({ output }).tool_call, limits);
    const pushes = push.mock.calls.length;
    push.mockRestore();
    expect(pushes).toBeLessThan(1_000);
    expect(preview.outputTruncated).toBe(true);
  });

  it('keeps a __proto__ key as ordinary data', () => {
    const args = `{"__proto__":{"mode":"x"},"pad":"${'p'.repeat(4_000)}"}`;
    const preview = previewToolCallArgs(args, 512);
    const parsed = JSON.parse(preview?.args as string);
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(parsed.__proto__).toEqual({ mode: 'x' });
    expect(Object.prototype.hasOwnProperty.call(parsed, 'mode')).toBe(false);
  });
});

describe('JSON numbers in previews', () => {
  const pad = 'p'.repeat(5_000);

  it.each([
    ['an integer past 2^53', '9007199254740993'],
    ['an exponent past the double range', '1e400'],
    ['a decimal finer than a double holds', '0.1000000000000000000001'],
    ['an underflowing exponent', '1e-400'],
  ])('falls back to text rather than change %s', (_label, token) => {
    const args = `{"id":${token},"pad":"${pad}"}`;
    const preview = previewToolCallArgs(args, 1_024);
    expect(preview?.args).toBe(args.slice(0, 1_024));
    expect(preview?.args).toContain(token);

    const output = `{"id":${token},"items":[${token}],"pad":"${pad}"}`;
    const call = previewToolCall(toolPart({ name: 'list_issues_mcp', output }).tool_call, limits);
    expect(call.output).toContain(token);
    expect(call.output).toContain(TOOL_CALL_PREVIEW_ELISION);
  });

  it('keeps the structure for numbers a double holds exactly, however they are written', () => {
    const args = `{"a":1.50,"b":15e-1,"c":-0,"d":9007199254740991,"e":"1e400","pad":"${pad}"}`;
    const preview = previewToolCallArgs(args, 1_024);
    const parsed = JSON.parse(preview?.args as string);
    expect(parsed).toMatchObject({ a: 1.5, b: 1.5, c: 0, d: 9007199254740991, e: '1e400' });
  });

  it.each([20_000, 40_000, 80_000])(
    'previews a finite decimal with %i internal zeros without stalling',
    (zeros) => {
      const output = `{"n":1.${'0'.repeat(zeros)}1}`;
      const part = toolPart({ output, args: output });
      const messages = [{ content: [part] }];
      const budget = { outputChars: 512, argsChars: 512 };
      expect(JSON.parse(output)).toEqual({ n: 1 });

      const start = performance.now();
      const [message] = previewMessagesToolCalls(messages, budget);
      const elapsed = performance.now() - start;

      expect(message.content[0].tool_call).toMatchObject({
        output: previewOutputText(output, budget.outputChars),
        outputTruncated: true,
        outputLength: output.length,
        args: output.slice(0, budget.argsChars),
        argsTruncated: true,
        argsLength: output.length,
      });
      expect(part.tool_call.output).toBe(output);
      expect(part.tool_call.args).toBe(output);
      // Generous headroom for CI; the suffix regex takes seconds on this input.
      expect(elapsed).toBeLessThan(1_000);
    },
  );

  it.each([
    ['1.', '', 1],
    ['-1.', 'e+3', -1_000],
    ['0.', '', 0],
  ])('keeps exact values with long trailing zeros (%s…%s)', (prefix, suffix, value) => {
    const output = `{"n":${prefix}${'0'.repeat(80_000)}${suffix}}`;
    const preview = previewToolCall(toolPart({ output, args: output }).tool_call, limits);
    expect(JSON.parse(preview.output as string)).toEqual({ n: value });
    expect(JSON.parse(preview.args as string)).toEqual({ n: value });
  });

  it('sends a background-task result whole rather than as unparseable text', () => {
    const output = `{"status":"completed","task_id":"task_1","bytes":9007199254740993,"output":"${pad}"}`;
    const check = toolPart({ name: 'check_background_task', output }).tool_call;
    expect(previewToolCall(check, limits).output).toBe(output);
  });
});

describe('deeply nested JSON output', () => {
  it('falls back to a bounded text preview instead of exhausting the stack', () => {
    const output = `${'['.repeat(20_000)}${']'.repeat(20_000)}`;
    const preview = previewToolCall(toolPart({ output }).tool_call, limits);
    expect(preview.outputTruncated).toBe(true);
    expect(preview.output?.length).toBeLessThanOrEqual(limits.outputChars);
  });
});

describe('previewMessagesToolCalls', () => {
  it('copies only the messages and parts that change, keeping content positions', () => {
    const untouched = { messageId: 'm1', content: [{ type: ContentTypes.TEXT, text: 'hello' }] };
    const textPart = { type: ContentTypes.TEXT, text: 'before' };
    const bigPart = toolPart({ output: 'o'.repeat(10_000) });
    const smallPart = toolPart({ id: 'call_2', output: 'small' });
    const changed = { messageId: 'm2', content: [textPart, bigPart, smallPart] };
    const messages: TestMessage[] = [untouched, changed, { messageId: 'm3' }];

    const result = previewMessagesToolCalls(messages, limits);
    expect(result).not.toBe(messages);
    expect(result[0]).toBe(untouched);
    expect(result[2]).toBe(messages[2]);
    expect(result[1].content).toHaveLength(3);
    expect(result[1].content?.[0]).toBe(textPart);
    expect(result[1].content?.[2]).toBe(smallPart);
    expect(result[1].content?.[1]).toMatchObject({ tool_call: { outputTruncated: true } });
    expect(bigPart.tool_call.output).toHaveLength(10_000);
  });

  it('keeps the nested tool call ids an omitted transcript saved attachments under', () => {
    const transcript = [
      toolPart({
        id: 'child_image',
        stepId: 'step_child',
        agentId: 'agent_on_call',
        output: 'Image generated',
      }),
      toolPart({
        id: 'child_subagent',
        name: 'subagent',
        output: 'done',
        subagent_content: [
          {
            ...toolPart({ id: 'grandchild_image', output: 'Image generated' }),
            agentId: 'agent_grandchild',
          },
          toolPart({ id: 'grandchild_search', output: 'found' }),
        ],
      }),
    ];
    const subagent = toolPart({
      name: 'subagent',
      output: 'summary',
      subagent_content: transcript,
    });
    const attachments = [
      { file_id: 'f1', toolCallId: 'child_image' },
      { file_id: 'f2', toolCallId: 'grandchild_image' },
      { file_id: 'f3', toolCallId: 'unrelated' },
    ];
    const [message] = previewMessagesToolCalls([{ content: [subagent], attachments }], limits);
    const [part] = message.content as Array<{ tool_call: TestToolCall }>;
    expect(part.tool_call).not.toHaveProperty('subagent_content');
    expect(part.tool_call.subagentAttachmentCalls).toEqual(
      expect.arrayContaining([
        { id: 'child_image', stepId: 'step_child', agentId: 'agent_on_call' },
        { id: 'grandchild_image', agentId: 'agent_grandchild' },
      ]),
    );
    expect(part.tool_call.subagentAttachmentCalls).toHaveLength(2);

    const [bare] = previewMessagesToolCalls([{ content: [subagent] }], limits);
    const [barePart] = bare.content as Array<{ tool_call: TestToolCall }>;
    expect(barePart.tool_call).toMatchObject({ subagentContentOmitted: true });
    expect(barePart.tool_call).not.toHaveProperty('subagentAttachmentCalls');
  });

  it('keeps one hint per owning identity when a provider reuses a child id', () => {
    const reused = Array.from({ length: 50 }, (_, index) =>
      toolPart({ id: 'call_0', stepId: `step_${index}`, output: 'done' }),
    );
    const subagent = toolPart({ name: 'subagent', output: 'summary', subagent_content: reused });
    const [message] = previewMessagesToolCalls(
      [{ content: [subagent], attachments: [{ toolCallId: 'call_0', stepId: 'step_7' }] }],
      limits,
    );
    const [part] = message.content as Array<{ tool_call: TestToolCall }>;
    expect(part.tool_call.subagentAttachmentCalls).toEqual([{ id: 'call_0', stepId: 'step_7' }]);
  });

  it('keeps one hint for an unscoped attachment whatever the id reuse', () => {
    const reused = Array.from({ length: 50 }, (_, index) =>
      toolPart({ id: 'call_0', stepId: `step_${index}`, output: 'done' }),
    );
    const subagent = toolPart({ name: 'subagent', output: 'summary', subagent_content: reused });
    const [message] = previewMessagesToolCalls(
      [{ content: [subagent], attachments: [{ toolCallId: 'call_0' }] }],
      limits,
    );
    const [part] = message.content as Array<{ tool_call: TestToolCall }>;
    expect(part.tool_call.subagentAttachmentCalls).toHaveLength(1);
  });

  it('deduplicates repeated attachment tuples before charging the matching budget', () => {
    const subagent = toolPart({
      name: 'subagent',
      output: 'done',
      subagent_content: Array.from({ length: 10_000 }, () => toolPart({ id: 'x' })),
    });
    const attachments = Array.from({ length: 30_000 }, () => ({ toolCallId: 'x' }));
    const messages = [{ content: [subagent], attachments }];
    expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(3 * 1024 * 1024);
    const [message] = previewMessagesToolCalls(messages, {
      ...limits,
      attachmentWorkLimit: 10_001,
    });
    expect(message.content[0].tool_call).toMatchObject({
      subagentContentOmitted: true,
      subagentAttachmentCalls: [{ id: 'x' }],
    });
    expect(subagent.tool_call.subagent_content).toHaveLength(10_000);
  });

  it('looks up each distinct scope once rather than scanning it for every reused child id', () => {
    const scopes = Array.from({ length: 300 }, (_, i) => ({ agentId: `agent_${i}` }));
    let visits = 0;
    const originalIterator = scopes[Symbol.iterator].bind(scopes);
    scopes[Symbol.iterator] = () => {
      const iterator = originalIterator();
      const next = iterator.next.bind(iterator);
      iterator.next = () => {
        const entry = next();
        if (!entry.done && ++visits > scopes.length) {
          throw new Error('Attachment scope scanned more than once');
        }
        return entry;
      };
      return iterator;
    };
    const subagent = toolPart({
      name: 'subagent',
      output: 'done',
      subagent_content: Array.from({ length: 300 }, (_, i) =>
        toolPart({ id: 'x', agentId: `agent_${i}` }),
      ),
    });
    const [part] = previewContentToolCalls(
      [subagent],
      limits,
      '',
      new Map([['x', scopes]]),
    ) as Array<{ tool_call: TestToolCall }>;
    expect(part.tool_call.subagentContentOmitted).toBe(true);
    expect(part.tool_call.subagentAttachmentCalls).toHaveLength(300);
    expect(visits).toBe(300);
  });

  it('shares the work budget across parent calls and keeps incomplete transcripts in full', () => {
    const parent = (id: string) =>
      toolPart({
        id,
        name: 'subagent',
        output: 'done',
        subagent_content: [toolPart({ id: 'x' })],
      });
    const content = [parent('first'), parent('second')];
    const [message] = previewMessagesToolCalls([{ content, attachments: [{ toolCallId: 'x' }] }], {
      ...limits,
      attachmentWorkLimit: 3,
    });
    expect(message.content[0].tool_call.subagentContentOmitted).toBe(true);
    expect(message.content[1]).toBe(content[1]);
    expect(message.content[1].tool_call).not.toHaveProperty('subagentAttachmentCalls');
    expect(message.content[1].tool_call.subagent_content).toHaveLength(1);
  });

  it('keeps the full transcript when the node budget is exhausted before a later match', () => {
    const subagent = toolPart({
      output: 'done',
      subagent_content: [{ type: ContentTypes.TEXT, text: 'first' }, toolPart({ id: 'x' })],
    });
    const [message] = previewMessagesToolCalls(
      [{ content: [subagent], attachments: [{ toolCallId: 'x' }] }],
      { ...limits, attachmentWorkLimit: 1 },
    );
    expect(message.content[0]).toBe(subagent);
    expect(message.content[0].tool_call).not.toHaveProperty('subagentContentOmitted');
  });

  it('scopes hints to the agent a stored subagent call ran', () => {
    const subagent = toolPart({
      name: 'subagent',
      output: 'summary',
      subagentIdentity: { subagentKind: 'agent', subagentAgentId: 'agent_child' },
      subagent_content: [toolPart({ id: 'call_0', output: 'done' })],
    });
    const [message] = previewMessagesToolCalls(
      [{ content: [subagent], attachments: [{ toolCallId: 'call_0', agentId: 'agent_child' }] }],
      limits,
    );
    const [part] = message.content as Array<{ tool_call: TestToolCall }>;
    expect(part.tool_call.subagentAttachmentCalls).toEqual([
      { id: 'call_0', agentId: 'agent_child' },
    ]);
  });

  it('keeps hints for a mutation response that leaves its attachments out', () => {
    const subagent = toolPart({
      name: 'subagent',
      output: 'summary',
      subagent_content: [toolPart({ id: 'child_image', output: 'Image generated' })],
    });
    const req = { query: { toolPreviews: '1' }, config: {} } as unknown as Parameters<
      typeof withMessageToolCallPreviews
    >[0];
    const response = { conversationId: 'c1', content: [subagent], text: '' };
    const previewed = withMessageToolCallPreviews(req, response, [{ toolCallId: 'child_image' }]);
    const [part] = previewed.content as Array<{ tool_call: TestToolCall }>;
    expect(part.tool_call.subagentAttachmentCalls).toEqual([{ id: 'child_image' }]);
    expect(previewed).not.toHaveProperty('attachments');
  });

  it('previews a call only when its identity is unique in the message', () => {
    const repeated = (agentId: string) => ({
      ...toolPart({ id: 'call_dup', stepId: 'step_1', output: 'o'.repeat(10_000) }),
      agentId,
    });
    const content = [repeated('a'), repeated('a'), repeated('a'), repeated('b')];
    const [message] = previewMessagesToolCalls([{ content }], limits);
    const parts = message.content as Array<{ tool_call: TestToolCall }>;
    expect(parts[0]).toBe(content[0]);
    expect(parts[1]).toBe(content[1]);
    expect(parts[2]).toBe(content[2]);
    expect(parts[3].tool_call.outputTruncated).toBe(true);
  });

  it('stamps each preview with when its message last changed', () => {
    const updatedAt = new Date('2026-10-05T01:00:00Z');
    const [message] = previewMessagesToolCalls(
      [
        {
          updatedAt,
          content: [toolPart({ output: 'o'.repeat(10_000) }), toolPart({ id: 'b', output: 'ok' })],
        },
      ],
      limits,
    );
    const parts = message.content as Array<{ tool_call: Record<string, unknown> }>;
    expect(parts[0].tool_call.previewRevision).toBe(String(updatedAt.getTime()));
    expect(parts[1].tool_call).not.toHaveProperty('previewRevision');
  });

  it('returns the same array when nothing needs shortening', () => {
    const messages: TestMessage[] = [{ content: [toolPart({ output: 'ok' })] }];
    expect(previewMessagesToolCalls(messages, limits)).toBe(messages);
  });
});

describe('prepareToolCallPreviews', () => {
  const messages: TestMessage[] = [{ content: [toolPart({ output: 'o'.repeat(10_000) })] }];
  const config = (toolCallPreviews: Partial<AppConfig['toolCallPreviews']>) =>
    ({
      toolCallPreviews: toolCallPreviewsConfigSchema.parse(toolCallPreviews),
    }) as AppConfig;

  it('sends the full payload to a client that did not ask, without reading config', async () => {
    const getAppConfig = jest.fn();
    const preview = prepareToolCallPreviews({ query: {} }, { getAppConfig });
    await expect(preview(messages)).resolves.toBe(messages);
    expect(getAppConfig).not.toHaveBeenCalled();
  });

  it('ignores an unknown preview version', () => {
    expect(wantsToolCallPreviews({ toolPreviews: '2' })).toBe(false);
    expect(wantsToolCallPreviews({ toolPreviews: ['1'] })).toBe(false);
    expect(wantsToolCallPreviews({ toolPreviews: '1' })).toBe(true);
  });

  it('starts the config read immediately and applies its bounds', async () => {
    const getAppConfig = jest.fn().mockResolvedValue(config({ outputChars: 512 }));
    const preview = prepareToolCallPreviews(
      { query: { toolPreviews: '1' }, user: { id: 'u1', role: 'USER', tenantId: 't1' } },
      { getAppConfig },
    );
    expect(getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', role: 'USER', tenantId: 't1' }),
    );
    const [message] = await preview(messages);
    const part = message.content?.[0] as ReturnType<typeof toolPart>;
    expect(part.tool_call.output?.length).toBeLessThanOrEqual(512);
  });

  it('sends in full when the deployment turned previews off', async () => {
    const getAppConfig = jest.fn().mockResolvedValue(config({ enabled: false }));
    const preview = prepareToolCallPreviews({ query: { toolPreviews: '1' } }, { getAppConfig });
    await expect(preview(messages)).resolves.toBe(messages);
  });

  it('uses the default bounds when config cannot be read', async () => {
    const getAppConfig = jest.fn().mockRejectedValue(new Error('config down'));
    const preview = prepareToolCallPreviews({ query: { toolPreviews: '1' } }, { getAppConfig });
    const [message] = await preview(messages);
    expect(message.content?.[0]).toMatchObject({ tool_call: { outputTruncated: true } });
  });
});

describe('prepareResultToolCallPreviews', () => {
  const result = () => ({
    conversation: { conversationId: 'fork-1' },
    messages: [{ messageId: 'm1', content: [toolPart({ output: 'o'.repeat(10_000) })] }],
  });
  const config = (enabled: boolean) =>
    ({ toolCallPreviews: toolCallPreviewsConfigSchema.parse({ enabled }) }) as AppConfig;

  it("reads the requester's bounds, ignoring the config the route resolved", async () => {
    const getAppConfig = jest.fn().mockResolvedValue(config(true));
    const req = {
      query: { toolPreviews: '1' },
      user: { id: 'viewer', role: 'USER', tenantId: 'tenant-viewer' },
      config: config(false),
    };
    const preview = prepareResultToolCallPreviews(req, { getAppConfig });
    expect(getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'viewer', tenantId: 'tenant-viewer' }),
    );
    const original = result();
    const previewed = await preview(original);
    expect(previewed.conversation).toBe(original.conversation);
    expect(previewed.messages[0].content[0]).toMatchObject({
      tool_call: { outputTruncated: true },
    });
  });

  it('returns the result untouched when the requester opted out or did not ask', async () => {
    const original = result();
    const optedOut = prepareResultToolCallPreviews(
      { query: { toolPreviews: '1' } },
      { getAppConfig: jest.fn().mockResolvedValue(config(false)) },
    );
    await expect(optedOut(original)).resolves.toBe(original);

    const getAppConfig = jest.fn();
    const notAsked = prepareResultToolCallPreviews({ query: {} }, { getAppConfig });
    await expect(notAsked(original)).resolves.toBe(original);
    expect(getAppConfig).not.toHaveBeenCalled();
  });
});

describe('withToolCallPreviews', () => {
  const result = () => ({
    conversation: { conversationId: 'fork-1' },
    messages: [{ messageId: 'm1', content: [toolPart({ output: 'o'.repeat(10_000) })] }],
  });
  const config = (toolCallPreviews: Partial<AppConfig['toolCallPreviews']> = {}) => ({
    toolCallPreviews: toolCallPreviewsConfigSchema.parse(toolCallPreviews),
  });

  it('previews a fork or duplicate response for a client that asked', () => {
    const original = result();
    const previewed = withToolCallPreviews(
      { query: { toolPreviews: '1' }, config: config() },
      original,
    );
    expect(previewed).not.toBe(original);
    expect(previewed.conversation).toBe(original.conversation);
    expect(previewed.messages[0].content[0]).toMatchObject({
      tool_call: { outputTruncated: true },
    });
    expect(original.messages[0].content[0].tool_call.output).toHaveLength(10_000);
  });

  it('returns the response untouched otherwise', () => {
    const original = result();
    expect(withToolCallPreviews({ query: {}, config: config() }, original)).toBe(original);
    expect(
      withToolCallPreviews(
        { query: { toolPreviews: '1' }, config: config({ enabled: false }) },
        original,
      ),
    ).toBe(original);
    const noMessages: { conversation: object; messages?: TestMessage[] } = {
      conversation: { conversationId: 'x' },
    };
    expect(withToolCallPreviews({ query: { toolPreviews: '1' } }, noMessages)).toBe(noMessages);
  });
});

describe('withMessageToolCallPreviews', () => {
  it('previews one returned message for a client that asked, and only then', () => {
    const message = {
      conversationId: 'c1',
      text: '',
      content: [toolPart({ output: 'o'.repeat(10_000) })],
    };
    const config = { toolCallPreviews: toolCallPreviewsConfigSchema.parse({}) };
    const previewed = withMessageToolCallPreviews(
      { query: { toolPreviews: '1' }, config },
      message,
    );
    expect(previewed).toMatchObject({ conversationId: 'c1', text: '' });
    expect(previewed.content[0]).toMatchObject({ tool_call: { outputTruncated: true } });
    expect(withMessageToolCallPreviews({ query: {}, config }, message)).toBe(message);
  });
});

describe('rejectToolCallPreviewWrites', () => {
  const run = (content: unknown) => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const next = jest.fn();
    rejectToolCallPreviewWrites({ body: { content } }, { status }, next);
    return { status, json, next };
  };

  it('refuses content carrying a preview, nested transcripts included', () => {
    const top = run([toolPart({ output: 'x', outputTruncated: true })]);
    expect(top.status).toHaveBeenCalledWith(400);
    expect(top.next).not.toHaveBeenCalled();

    const nested = run([
      toolPart({ name: 'subagent', subagent_content: [toolPart({ argsTruncated: true })] }),
    ]);
    expect(nested.status).toHaveBeenCalledWith(400);
    expect(containsToolCallPreviews([toolPart({ subagentContentOmitted: true })])).toBe(true);
  });

  it('passes full content through', () => {
    const result = run([toolPart({ output: 'x'.repeat(10_000) })]);
    expect(result.next).toHaveBeenCalled();
    expect(result.status).not.toHaveBeenCalled();
  });
});

describe('findSubagentAttachmentCalls', () => {
  const call = (id: string, extra: Record<string, unknown> = {}) => ({
    type: ContentTypes.TOOL_CALL,
    ...extra,
    tool_call: { id, name: 'bash_tool', args: '{}', output: 'ok', progress: 1 },
  });
  const subagent = (id: string, transcript: unknown[], extra: Record<string, unknown> = {}) => ({
    type: ContentTypes.TOOL_CALL,
    ...extra,
    tool_call: {
      id,
      name: 'subagent',
      args: '{}',
      output: 'done',
      progress: 1,
      subagent_content: transcript,
    },
  });

  it('names the subagent whose transcript holds the scoped call, not one reusing the id unscoped', () => {
    const content = [
      call('call_0'),
      subagent('sub_a', [call('call_0')]),
      subagent('sub_b', [call('call_0', { agentId: 'illustrator' })], { agentId: 'host' }),
    ];
    const found = findSubagentAttachmentCalls(content, [
      { toolCallId: 'call_0', agentId: 'illustrator' },
    ]);
    expect(found).toEqual([
      { toolCallId: 'sub_a', calls: [{ id: 'call_0' }] },
      {
        toolCallId: 'sub_b',
        agentId: 'host',
        calls: [{ id: 'call_0', agentId: 'illustrator' }],
      },
    ]);
  });

  it('preserves first exact and first agreeing matches for every partial scope', () => {
    const values = [undefined, '', 'a', 'b'];
    const scopes = values.flatMap((agentId) => values.map((stepId) => ({ agentId, stepId })));
    const calls = scopes.map((scope) => ({ id: 'x', ...scope }));
    // Rotate traversal order so an unscoped fallback does not always precede an exact match.
    for (let offset = 0; offset < calls.length; offset++) {
      const ordered = [...calls.slice(offset), ...calls.slice(0, offset)];
      for (const file of scopes) {
        const exact = ordered.find(
          (candidate) =>
            (file.agentId == null || candidate.agentId === file.agentId) &&
            (file.stepId == null || candidate.stepId === file.stepId),
        );
        const agreeing = ordered.find(
          (candidate) =>
            (file.agentId == null ||
              candidate.agentId == null ||
              candidate.agentId === file.agentId) &&
            (file.stepId == null || candidate.stepId == null || candidate.stepId === file.stepId),
        );
        const expected = ordered.filter(
          (candidate) => candidate === exact || candidate === agreeing,
        );
        const transcript = ordered.map(({ id, agentId, stepId }) =>
          toolPart({ id, agentId, stepId }),
        );
        expect(
          findSubagentAttachmentCalls(
            [subagent('parent', transcript)],
            [
              { toolCallId: 'x', ...file },
              { toolCallId: 'x', ...file },
            ],
          ),
        ).toEqual([{ toolCallId: 'parent', calls: expected }]);
      }
    }
  });

  it('walks nested runs and ignores calls no queried file names', () => {
    const content = [
      subagent('outer', [subagent('inner', [call('deep'), call('other')])]),
      { type: ContentTypes.TEXT, text: 'done' },
    ];
    expect(findSubagentAttachmentCalls(content, [{ toolCallId: 'deep' }])).toEqual([
      { toolCallId: 'outer', calls: [{ id: 'deep' }] },
    ]);
    expect(findSubagentAttachmentCalls(content, [])).toEqual([]);
  });
});
