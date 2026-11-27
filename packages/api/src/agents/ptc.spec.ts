import type { StructuredToolInterface } from '@librechat/agents/langchain/tools';
import type { PtcToolCallEvent } from 'librechat-data-provider';
import { instrumentPtcToolMap, summarizePtcArgs } from './ptc';

/**
 * Minimal stand-in for a loaded tool: `executeTools` in `@librechat/agents`
 * only resolves a tool by name, reads `schema`/`mcp`, and calls `invoke` — so
 * the wrapper must leave all of that intact.
 */
function createTool(
  name: string,
  invoke: (input: unknown, config?: unknown) => Promise<unknown>,
  extra: Record<string, unknown> = {},
): StructuredToolInterface {
  return { name, invoke, ...extra } as unknown as StructuredToolInterface;
}

describe('summarizePtcArgs', () => {
  it('renders an object input as a key=value line', () => {
    expect(summarizePtcArgs({ query: 'librechat', limit: 5 })).toBe('query=librechat, limit=5');
  });

  it('drops empty and nullish values', () => {
    expect(summarizePtcArgs({ path: 'a.ts', cursor: null, filter: '' })).toBe('path=a.ts');
  });

  it('collapses whitespace so a multi-line value stays one line', () => {
    expect(summarizePtcArgs({ code: 'a\n  b' })).toBe('code=a b');
  });

  it('clips a long value without dropping the keys after it', () => {
    const summary = summarizePtcArgs({ body: 'x'.repeat(200), path: 'a.ts' });
    expect(summary).toContain('…');
    expect(summary).toContain('path=a.ts');
  });

  it('bounds the whole preview', () => {
    const summary = summarizePtcArgs(
      Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key${i}`, `value${i}`])),
    );
    expect(summary.length).toBeLessThanOrEqual(97);
  });

  it('stops once the preview budget is spent instead of visiting every key', () => {
    const seen: string[] = [];
    const probe: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      Object.defineProperty(probe, `key${i}`, {
        enumerable: true,
        get() {
          seen.push(`key${i}`);
          return `value${i}`;
        },
      });
    }

    summarizePtcArgs(probe);

    expect(seen.length).toBeLessThan(40);
  });

  it('does not rewrite the whole of an oversized value to build a short preview', () => {
    const huge = 'a b '.repeat(500_000);
    const started = Date.now();
    const summary = summarizePtcArgs({ content: huge, path: 'a.ts' });

    expect(summary).toContain('path=a.ts');
    expect(summary.length).toBeLessThanOrEqual(97);
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('falls back to the raw string for a non-object input', () => {
    expect(summarizePtcArgs('ls -la')).toBe('ls -la');
  });

  it('returns an empty preview for an absent input', () => {
    expect(summarizePtcArgs(undefined)).toBe('');
    expect(summarizePtcArgs({})).toBe('');
  });
});

describe('instrumentPtcToolMap', () => {
  const collect = () => {
    const events: PtcToolCallEvent[] = [];
    return { events, emit: (event: PtcToolCallEvent) => events.push(event) };
  };

  it('emits a running event and a success event around an inner call', async () => {
    const { events, emit } = collect();
    const toolMap = new Map([['read_file', createTool('read_file', async () => 'file contents')]]);

    const instrumented = instrumentPtcToolMap({ toolMap, toolCallId: 'call_1', emit });
    const result = await instrumented.get('read_file')?.invoke({ path: 'a.ts' });

    expect(result).toBe('file contents');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      tool_call_id: 'call_1',
      name: 'read_file',
      status: 'running',
      args: 'path=a.ts',
    });
    expect(events[1]).toMatchObject({
      tool_call_id: 'call_1',
      call_id: events[0].call_id,
      status: 'success',
    });
    expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a failed inner call and rethrows so the sandbox still sees the error', async () => {
    const { events, emit } = collect();
    const toolMap = new Map([
      [
        'write_file',
        createTool('write_file', async () => {
          throw new Error('Permission denied');
        }),
      ],
    ]);

    const instrumented = instrumentPtcToolMap({ toolMap, toolCallId: 'call_1', emit });

    await expect(instrumented.get('write_file')?.invoke({ path: '/etc/x' })).rejects.toThrow(
      'Permission denied',
    );
    expect(events[1]).toMatchObject({ status: 'error', error: 'Permission denied' });
  });

  it('gives each inner call its own id so concurrent calls do not collide', async () => {
    const { events, emit } = collect();
    const toolMap = new Map([['search', createTool('search', async () => 'ok')]]);

    const instrumented = instrumentPtcToolMap({ toolMap, toolCallId: 'call_1', emit });
    const search = instrumented.get('search');
    await Promise.all([search?.invoke({ q: 'a' }), search?.invoke({ q: 'b' })]);

    const startIds = events.filter((e) => e.status === 'running').map((e) => e.call_id);
    expect(new Set(startIds).size).toBe(2);
  });

  it('passes the invoke config through untouched', async () => {
    const { emit } = collect();
    const seen: unknown[] = [];
    const toolMap = new Map([
      [
        'read_file',
        createTool('read_file', async (_input, config) => {
          seen.push(config);
          return 'ok';
        }),
      ],
    ]);

    const instrumented = instrumentPtcToolMap({ toolMap, toolCallId: 'call_1', emit });
    const config = { metadata: { run_tools_with_code: true } };
    await instrumented.get('read_file')?.invoke({ path: 'a.ts' }, config);

    expect(seen[0]).toBe(config);
  });

  it('leaves every other property readable on the wrapped tool', () => {
    const { emit } = collect();
    const toolMap = new Map([
      [
        'search_code_mcp_github',
        createTool('search_code_mcp_github', async () => 'ok', {
          mcp: true,
          schema: { type: 'object' },
        }),
      ],
    ]);

    const instrumented = instrumentPtcToolMap({ toolMap, toolCallId: 'call_1', emit });
    const tool = instrumented.get('search_code_mcp_github') as StructuredToolInterface & {
      mcp?: boolean;
    };

    expect(tool.name).toBe('search_code_mcp_github');
    expect(tool.mcp).toBe(true);
    expect(tool.schema).toEqual({ type: 'object' });
  });

  it('omits argument and failure previews when tool-argument filtering is on', async () => {
    const { events, emit } = collect();
    const toolMap = new Map([
      [
        'write_file',
        createTool('write_file', async () => {
          throw new Error('rejected value 555-01-0000');
        }),
      ],
    ]);

    const instrumented = instrumentPtcToolMap({
      toolMap,
      toolCallId: 'call_1',
      includePreviews: false,
      emit,
    });

    await expect(instrumented.get('write_file')?.invoke({ ssn: '555-01-0000' })).rejects.toThrow();

    /** Name, status and duration still report; nothing derived from the
     *  arguments or the failure text reaches the stream. */
    expect(events[0].args).toBeUndefined();
    expect(events[1].error).toBeUndefined();
    expect(events.map((e) => e.status)).toEqual(['running', 'error']);
    expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toContain('555-01-0000');
  });

  it('emits nothing at all for a tool whose name the policy filters', async () => {
    const { events, emit } = collect();
    const toolMap = new Map([
      ['ok_tool', createTool('ok_tool', async () => 'ok')],
      ['blocked_name_tool', createTool('blocked_name_tool', async () => 'ok')],
    ]);

    const instrumented = instrumentPtcToolMap({
      toolMap,
      toolCallId: 'call_1',
      traceExclusions: new Set(['blocked_name_tool']),
      emit,
    });

    /** Excluded tools still execute — only their telemetry is suppressed. */
    await expect(instrumented.get('blocked_name_tool')?.invoke({ a: 1 })).resolves.toBe('ok');
    await instrumented.get('ok_tool')?.invoke({ a: 1 });

    expect(events.map((e) => e.name)).toEqual(['ok_tool', 'ok_tool']);
    expect(JSON.stringify(events)).not.toContain('blocked_name_tool');
  });

  it('runs the inner call even when the emitter throws', async () => {
    const toolMap = new Map([['read_file', createTool('read_file', async () => 'ok')]]);
    const instrumented = instrumentPtcToolMap({
      toolMap,
      toolCallId: 'call_1',
      emit: () => {
        throw new Error('stream closed');
      },
    });

    await expect(instrumented.get('read_file')?.invoke({ path: 'a.ts' })).resolves.toBe('ok');
  });
});
