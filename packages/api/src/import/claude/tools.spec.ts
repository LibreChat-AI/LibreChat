import { ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { ClaudeContentBlock } from '~/import/types';
import { beginToolCall, orphanToolCall, completeToolCall, createToolRegistry } from './tools';
import { createSourceIndex } from './citations';

function use(id: string | null, name: string, input: object | null = {}): ClaudeContentBlock {
  return { type: 'tool_use', id, name, input };
}

function result(
  toolUseId: string | null,
  name: string,
  content: ClaudeContentBlock['content'],
  isError = false,
): ClaudeContentBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, name, content, is_error: isError };
}

describe('beginToolCall', () => {
  it('emits a finished tool_call part the renderer accepts', () => {
    const registry = createToolRegistry();

    const part = beginToolCall(registry, use('tu-1', 'bash_tool', { command: 'ls' }));

    expect(part.type).toBe(ContentTypes.TOOL_CALL);
    expect(part[ContentTypes.TOOL_CALL]).toEqual({
      name: 'bash_tool',
      args: '{"command":"ls"}',
      id: 'tu-1',
      progress: 1,
      type: ToolCallTypes.TOOL_CALL,
    });
  });

  it('omits the id and falls back to a name when the export has neither', () => {
    const registry = createToolRegistry();

    const part = beginToolCall(registry, use(null, '', null));

    expect(part[ContentTypes.TOOL_CALL].id).toBeUndefined();
    expect(part[ContentTypes.TOOL_CALL].name).toBe('tool');
    expect(part[ContentTypes.TOOL_CALL].args).toBe('');
  });
});

describe('completeToolCall', () => {
  it('joins a result to its call by tool_use_id', () => {
    const registry = createToolRegistry();
    const sources = createSourceIndex();
    const part = beginToolCall(registry, use('tu-1', 'bash_tool', { command: 'ls' }));

    const resolved = completeToolCall(
      registry,
      result('tu-1', 'bash_tool', [{ type: 'text', text: 'src' }]),
      sources,
    );

    expect(resolved.target).toBe(part[ContentTypes.TOOL_CALL]);
    expect(part[ContentTypes.TOOL_CALL].output).toBe('src');
  });

  it('falls back to the oldest open call when both ids are null', () => {
    const registry = createToolRegistry();
    const sources = createSourceIndex();
    const first = beginToolCall(registry, use(null, 'artifacts'));
    const second = beginToolCall(registry, use(null, 'artifacts'));

    completeToolCall(registry, result(null, 'artifacts', [{ type: 'text', text: 'one' }]), sources);
    completeToolCall(registry, result(null, 'artifacts', [{ type: 'text', text: 'two' }]), sources);

    expect(first[ContentTypes.TOOL_CALL].output).toBe('one');
    expect(second[ContentTypes.TOOL_CALL].output).toBe('two');
  });

  it('leaves a call without a matching result with no output', () => {
    const registry = createToolRegistry();
    const part = beginToolCall(registry, use('tu-1', 'view', { path: '/tmp/x' }));

    expect(part[ContentTypes.TOOL_CALL].output).toBeUndefined();
    expect(part[ContentTypes.TOOL_CALL].progress).toBe(1);
  });

  it('surfaces the content of an is_error result', () => {
    const registry = createToolRegistry();
    const sources = createSourceIndex();
    const part = beginToolCall(registry, use('tu-1', 'artifacts'));

    completeToolCall(
      registry,
      result('tu-1', 'artifacts', [{ type: 'text', text: 'command: Field required' }], true),
      sources,
    );

    expect(part[ContentTypes.TOOL_CALL].output).toBe('Error:\ncommand: Field required');
  });

  it('registers knowledge blocks as web sources and lists them in the output', () => {
    const registry = createToolRegistry();
    const sources = createSourceIndex();
    const part = beginToolCall(registry, use('tu-1', 'web_search', { query: 'redis' }));

    completeToolCall(
      registry,
      result('tu-1', 'web_search', [
        { type: 'knowledge', title: 'Redis Guide', url: 'https://a.example/redis' },
        { type: 'knowledge', title: null, url: 'https://b.example/env' },
      ]),
      sources,
    );

    expect(sources.sources).toEqual([
      { link: 'https://a.example/redis', title: 'Redis Guide' },
      { link: 'https://b.example/env', title: undefined },
    ]);
    expect(part[ContentTypes.TOOL_CALL].output).toBe(
      '- [Redis Guide](https://a.example/redis)\n- [https://b.example/env](https://b.example/env)',
    );
  });

  it('counts images and local resources as unavailable, and still names the resource', () => {
    const registry = createToolRegistry();
    const sources = createSourceIndex();
    beginToolCall(registry, use('tu-1', 'present_files'));

    const resolved = completeToolCall(
      registry,
      result('tu-1', 'present_files', [
        { type: 'image' },
        { type: 'image_gallery' },
        { type: 'local_resource', name: 'notes', file_path: '/mnt/out/notes.md' },
      ]),
      sources,
    );

    /** All three reference bytes the export does not ship. `local_resource`
     * renders a label, which is not the same as being available. */
    expect(resolved.unavailable).toBe(3);
    expect(resolved.output).toBe('- notes');
  });

  it('returns no target for a result that matches nothing', () => {
    const registry = createToolRegistry();
    const sources = createSourceIndex();

    const resolved = completeToolCall(
      registry,
      result('missing', 'view', [{ type: 'text', text: 'orphaned' }]),
      sources,
    );

    expect(resolved.target).toBeNull();
    expect(orphanToolCall(result('missing', 'view', []), resolved.output)).toEqual({
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        name: 'view',
        args: '',
        output: 'orphaned',
        progress: 1,
        type: ToolCallTypes.TOOL_CALL,
      },
    });
  });

  it('does not positionally match a result whose explicit id is unknown', () => {
    const registry = createToolRegistry();
    const sources = createSourceIndex();
    const first = beginToolCall(registry, use('tu-1', 'view'));
    const second = beginToolCall(registry, use('tu-2', 'view'));

    const unmatched = completeToolCall(
      registry,
      result('missing', 'view', [{ type: 'text', text: 'wrong' }]),
      sources,
    );

    expect(unmatched.target).toBeNull();
    expect(first[ContentTypes.TOOL_CALL].output).toBeUndefined();
    expect(second[ContentTypes.TOOL_CALL].output).toBeUndefined();

    completeToolCall(registry, result('tu-1', 'view', [{ type: 'text', text: 'one' }]), sources);
    completeToolCall(registry, result('tu-2', 'view', [{ type: 'text', text: 'two' }]), sources);
    expect(first[ContentTypes.TOOL_CALL].output).toBe('one');
    expect(second[ContentTypes.TOOL_CALL].output).toBe('two');
  });
});

describe('file-authoring arg aliases', () => {
  it('renames Claude create_file args to the keys FileAuthoringCall reads', () => {
    const registry = createToolRegistry();
    const part = beginToolCall(registry, {
      type: 'tool_use',
      name: 'create_file',
      id: 'tu_1',
      input: { path: 'src/app.ts', file_text: 'export const a = 1;', description: 'add file' },
    } as ClaudeContentBlock);

    const args = JSON.parse(part[ContentTypes.TOOL_CALL].args as string);
    expect(args.file_path).toBe('src/app.ts');
    expect(args.content).toBe('export const a = 1;');
    expect(args.description).toBe('add file');
    expect(args.path).toBeUndefined();
    expect(args.file_text).toBeUndefined();
  });

  it('leaves other tools’ args untouched', () => {
    const registry = createToolRegistry();
    const part = beginToolCall(registry, {
      type: 'tool_use',
      name: 'bash_tool',
      id: 'tu_2',
      input: { command: 'ls -la', path: 'keep-me' },
    } as ClaudeContentBlock);

    const args = JSON.parse(part[ContentTypes.TOOL_CALL].args as string);
    expect(args.command).toBe('ls -la');
    expect(args.path).toBe('keep-me');
    expect(args.file_path).toBeUndefined();
  });
});

/** Claude's `knowledge` blocks are the other archive-controlled URL source, and
 * they feed both the tool card's markdown link and the message's citations. */
describe('renderResult rejects unsafe knowledge urls', () => {
  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>'])(
    'drops a %s knowledge block',
    (url) => {
      const sources = createSourceIndex();
      const result = completeToolCall(
        createToolRegistry(),
        {
          type: 'tool_result',
          name: 'web_search',
          content: [{ type: 'knowledge', url, title: 'Docs' }],
        } as ClaudeContentBlock,
        sources,
      );

      expect(sources.sources).toEqual([]);
      expect(result.output).not.toContain(url);
    },
  );

  it('keeps an http knowledge block', () => {
    const sources = createSourceIndex();
    const result = completeToolCall(
      createToolRegistry(),
      {
        type: 'tool_result',
        name: 'web_search',
        content: [{ type: 'knowledge', url: 'https://good.example/x', title: 'Docs' }],
      } as ClaudeContentBlock,
      sources,
    );

    expect(sources.sources).toEqual([{ link: 'https://good.example/x', title: 'Docs' }]);
    expect(result.output).toContain('https://good.example/x');
  });
});
