import { buildApprovalPreview, buildApprovalPreviews } from '../preview';

describe('buildApprovalPreview', () => {
  test('shows named action arguments instead of an empty command', () => {
    const preview = buildApprovalPreview({
      name: 'bash_tool',
      source: 'librechat_code',
      tool_call_id: 'action-1',
      arguments: { environmentAction: 'typecheck', timeoutMs: 120000 },
    });
    expect(preview.kind).toBe('generic');
    expect(JSON.parse(preview.body)).toEqual({ environmentAction: 'typecheck', timeoutMs: 120000 });
  });
  test('shows the exact effective command and reveals bidi control characters', () => {
    const preview = buildApprovalPreview({
      name: 'bash_tool',
      source: 'librechat_code',
      tool_call_id: 'call-1',
      arguments: { command: 'git status\u202etest' },
    });

    expect(preview).toMatchObject({
      kind: 'command',
      toolName: 'bash_tool',
      body: 'git status\\u202etest',
      truncated: false,
    });
  });

  test('renders ordered edit replacements as proposals', () => {
    const preview = buildApprovalPreview({
      name: 'edit_file',
      source: 'librechat_code',
      tool_call_id: 'call-1',
      arguments: {
        path: 'src/index.ts',
        edits: [
          { old_text: 'one', new_text: 'two' },
          { old_text: '', new_text: 'three' },
        ],
      },
    });

    expect(preview.target).toBe('src/index.ts');
    expect(JSON.parse(preview.body)).toEqual([
      { old_text: 'one', new_text: 'two' },
      { old_text: '', new_text: 'three' },
    ]);
  });

  test('does not classify an MCP-qualified coding name as a built-in', () => {
    const preview = buildApprovalPreview({
      name: 'filesystem__create_file',
      tool_call_id: 'call-1',
      arguments: { path: 'outside.txt', content: 'data' },
    });

    expect(preview.kind).toBe('generic');
    expect(preview.toolName).toBe('filesystem__create_file');
    expect(preview.body).toContain('"path": "outside.txt"');
  });

  test('does not specialize a same-name tool without native server provenance', () => {
    const preview = buildApprovalPreview({
      name: 'create_file',
      tool_call_id: 'call-1',
      arguments: { path: 'outside.txt', content: 'data' },
    });

    expect(preview.kind).toBe('generic');
    expect(preview.target).toBeUndefined();
    expect(preview.body).toContain('"path": "outside.txt"');
  });

  test('bounds an initially rendered preview by line count and character count', () => {
    const preview = buildApprovalPreview({
      name: 'create_file',
      source: 'librechat_code',
      tool_call_id: 'call-1',
      arguments: { path: 'large.txt', content: `${'x'.repeat(20_000)}\n${'line\n'.repeat(250)}` },
    });

    expect(preview.truncated).toBe(true);
    expect(preview.body.length).toBeLessThanOrEqual(16 * 1024);
    expect(preview.body.split('\n')).toHaveLength(1);
  });

  test('bounds the aggregate initial preview for a large approval batch', () => {
    const previews = buildApprovalPreviews(
      Array.from({ length: 8 }, (_, index) => ({
        name: 'create_file',
        source: 'librechat_code' as const,
        tool_call_id: `call-${index}`,
        arguments: { path: `${index}.txt`, content: 'x'.repeat(16 * 1024) },
      })),
    );

    expect(
      previews.reduce(
        (total, preview) =>
          total +
          preview.toolName.length +
          (preview.description?.length ?? 0) +
          preview.body.length +
          (preview.target?.length ?? 0),
        0,
      ),
    ).toBeLessThanOrEqual(64 * 1024);
    expect(previews.at(-1)).toMatchObject({ body: '', truncated: true });
  });

  test('applies the visible cap after expanding hidden control characters', () => {
    const preview = buildApprovalPreview({
      name: 'create_file',
      source: 'librechat_code',
      tool_call_id: 'call-1',
      arguments: { path: 'controls.txt', content: '\u202e'.repeat(16 * 1024) },
    });

    expect(preview.body.length).toBeLessThanOrEqual(16 * 1024);
    expect(preview.truncated).toBe(true);
  });

  test('reveals and bounds hostile file targets inside the total preview budget', () => {
    const preview = buildApprovalPreview({
      name: 'create_file',
      source: 'librechat_code',
      tool_call_id: 'call-1',
      arguments: {
        path: `spoof\nname\u202ets/${'nested/'.repeat(300)}`,
        content: 'x'.repeat(16 * 1024),
      },
    });

    expect(preview.target).not.toContain('\n');
    expect(preview.target).toContain('\\u000a');
    expect(preview.target?.length).toBeLessThanOrEqual(1024);
    expect((preview.target?.length ?? 0) + preview.body.length).toBeLessThanOrEqual(16 * 1024);
    expect(preview.truncated).toBe(true);
  });

  test('reveals and bounds generic tool labels and descriptions', () => {
    const preview = buildApprovalPreview({
      name: `run\nspoof\u061c\u200e\u200f\u206a${'x'.repeat(500)}`,
      description: `explain\r\u0085${'y'.repeat(2000)}`,
      tool_call_id: 'call-1',
      arguments: { value: 'safe' },
    });

    expect(preview.toolName).toContain('\\u000a');
    expect(preview.toolName).toContain('\\u061c');
    expect(preview.toolName).toContain('\\u200e');
    expect(preview.toolName).toContain('\\u200f');
    expect(preview.toolName).toContain('\\u206a');
    expect(preview.toolName).not.toContain('\n');
    expect(preview.toolName.length).toBeLessThanOrEqual(256);
    expect(preview.description).toContain('\\u000d');
    expect(preview.description).toContain('\\u0085');
    expect(preview.description?.length).toBeLessThanOrEqual(1024);
    expect(preview.truncated).toBe(true);
  });
});
