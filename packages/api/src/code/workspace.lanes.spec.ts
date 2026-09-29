import type { WorkspaceToolRequest, WorkspaceToolResult } from './workspace';
import { fromLinkedWorktreeResult, toLinkedWorktreeRequest } from './workspace';

const base = { protocolVersion: 1, workspaceId: 'librechat' } as const;

describe('toLinkedWorktreeRequest', () => {
  it.each([
    ['read_file', { operation: 'read_file', path: '.worktrees/fix-a/src/index.ts' }],
    ['write_file', { operation: 'write_file', path: '.worktrees/fix-a/src/index.ts', content: '' }],
    ['edit_file', { operation: 'edit_file', path: '.worktrees/fix-a/src/index.ts', edits: [] }],
    [
      'preview_edit',
      { operation: 'preview_edit', path: '.worktrees/fix-a/src/index.ts', edits: [] },
    ],
  ])('routes a %s path into its worktree lane', (_operation, fields) => {
    const request = { ...base, ...fields } as WorkspaceToolRequest;
    expect(toLinkedWorktreeRequest(request)).toEqual({
      worktree: 'fix-a',
      request: { ...request, path: 'src/index.ts', worktree: 'fix-a' },
    });
  });

  it('scopes searches and listings to the worktree, omitting the path at its root', () => {
    expect(
      toLinkedWorktreeRequest({
        ...base,
        operation: 'search_text',
        query: 'TODO',
        path: '.worktrees/fix-a',
      }),
    ).toEqual({
      worktree: 'fix-a',
      request: { ...base, operation: 'search_text', query: 'TODO', worktree: 'fix-a' },
    });
    expect(
      toLinkedWorktreeRequest({
        ...base,
        operation: 'list_files',
        path: '.worktrees/fix-a/src',
        afterPath: '.worktrees/fix-a/src/a.ts',
      }),
    ).toEqual({
      worktree: 'fix-a',
      request: {
        ...base,
        operation: 'list_files',
        path: 'src',
        afterPath: 'src/a.ts',
        worktree: 'fix-a',
      },
    });
  });

  it('runs a command whose cwd is inside a worktree in that lane', () => {
    expect(
      toLinkedWorktreeRequest({
        ...base,
        operation: 'execute_command',
        command: 'npm test',
        cwd: '.worktrees/fix-a',
      }),
    ).toEqual({
      worktree: 'fix-a',
      request: { ...base, operation: 'execute_command', command: 'npm test', worktree: 'fix-a' },
    });
    expect(
      toLinkedWorktreeRequest({
        ...base,
        operation: 'execute_command',
        command: 'npx jest',
        cwd: '.worktrees/fix-a/packages/api',
      })?.request,
    ).toMatchObject({ cwd: 'packages/api', worktree: 'fix-a' });
  });

  it.each<[string, WorkspaceToolRequest]>([
    ['a root path', { ...base, operation: 'read_file', path: 'src/index.ts' }],
    ['the worktree directory itself', { ...base, operation: 'read_file', path: '.worktrees/a' }],
    ['the worktrees container', { ...base, operation: 'list_files', path: '.worktrees' }],
    ['an invalid name', { ...base, operation: 'read_file', path: '.worktrees/-bad/x.ts' }],
    ['a lock name', { ...base, operation: 'read_file', path: '.worktrees/a.lock/x.ts' }],
    [
      'an instruction read',
      {
        ...base,
        operation: 'read_file',
        path: '.worktrees/a/AGENTS.md',
        instructionSha256: 'a'.repeat(64),
      },
    ],
    [
      'a conversation instance',
      {
        ...base,
        operation: 'read_file',
        path: '.worktrees/a/x.ts',
        workspaceInstanceId: 'b'.repeat(64),
      },
    ],
    [
      'a listing cursor in another worktree',
      {
        ...base,
        operation: 'list_files',
        path: '.worktrees/a',
        afterPath: '.worktrees/b/x.ts',
      },
    ],
    [
      'a listing cursor at the worktree root',
      { ...base, operation: 'list_files', path: '.worktrees/a', afterPath: '.worktrees/a' },
    ],
    [
      'a command without cwd',
      { ...base, operation: 'execute_command', command: 'cd .worktrees/a' },
    ],
    [
      'an environment action',
      {
        ...base,
        operation: 'execute_command',
        command: 'setup',
        cwd: '.worktrees/a',
        environmentAction: { name: 'setup', fingerprint: 'c'.repeat(64) },
      },
    ],
  ])('leaves %s root-scoped', (_case, request) => {
    expect(toLinkedWorktreeRequest(request)).toBeUndefined();
  });
});

describe('fromLinkedWorktreeResult', () => {
  it('restores the worktree prefix on every reported path', () => {
    const listing: WorkspaceToolResult = {
      ...base,
      operation: 'list_files',
      paths: ['src/a.ts', 'src/b.ts'],
      truncated: true,
      nextAfterPath: 'src/b.ts',
    };
    expect(fromLinkedWorktreeResult(listing, 'fix-a')).toEqual({
      ...listing,
      paths: ['.worktrees/fix-a/src/a.ts', '.worktrees/fix-a/src/b.ts'],
      nextAfterPath: '.worktrees/fix-a/src/b.ts',
    });

    const search: WorkspaceToolResult = {
      ...base,
      operation: 'search_text',
      matches: [{ path: 'src/a.ts', line: 3, column: 1, text: 'TODO' }],
      truncated: false,
    };
    expect(fromLinkedWorktreeResult(search, 'fix-a')).toEqual({
      ...search,
      matches: [{ path: '.worktrees/fix-a/src/a.ts', line: 3, column: 1, text: 'TODO' }],
    });

    const written: WorkspaceToolResult = {
      ...base,
      operation: 'write_file',
      path: 'src/a.ts',
      created: true,
      bytesWritten: 1,
    };
    expect(fromLinkedWorktreeResult(written, 'fix-a')).toEqual({
      ...written,
      path: '.worktrees/fix-a/src/a.ts',
    });
  });

  it('returns command results unchanged', () => {
    const result: WorkspaceToolResult = {
      ...base,
      operation: 'execute_command',
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      truncated: false,
    };
    expect(fromLinkedWorktreeResult(result, 'fix-a')).toBe(result);
  });
});
