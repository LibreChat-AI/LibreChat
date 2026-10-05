import { logger } from '@librechat/data-schemas';
import type { CodeBridgeFetch } from './bridge';
import { createAttachedWorkspaceBashTool } from './command';
import { createLaneGitRecorder } from './lane';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

const head = 'a'.repeat(40);
const laneGit = { branch: 'feat/pr-chip', head };

describe('createLaneGitRecorder', () => {
  it('writes the reported state for the owner and conversation', async () => {
    const setConvoLaneGit = jest.fn().mockResolvedValue(true);
    const record = createLaneGitRecorder({ user: 'u1', conversationId: 'c1', setConvoLaneGit });
    await expect(record?.(laneGit)).resolves.toBe(true);
    expect(setConvoLaneGit).toHaveBeenCalledWith({ user: 'u1', conversationId: 'c1', laneGit });
  });

  it.each([
    ['a missing user', { user: undefined, conversationId: 'c1' }],
    ['an empty user', { user: '', conversationId: 'c1' }],
    ['a missing conversation', { user: 'u1', conversationId: undefined }],
    ['an empty conversation', { user: 'u1', conversationId: '' }],
  ])('does not record with %s', (_label, ids) => {
    const setConvoLaneGit = jest.fn();
    expect(createLaneGitRecorder({ ...ids, setConvoLaneGit })).toBeUndefined();
    expect(setConvoLaneGit).not.toHaveBeenCalled();
  });

  it('stores a plain owner/name repository with the lane', async () => {
    const setConvoLaneGit = jest.fn().mockResolvedValue(true);
    const record = createLaneGitRecorder({
      user: 'u1',
      conversationId: 'c1',
      repo: 'LibreChat-AI/LibreChat',
      setConvoLaneGit,
    });
    await record?.(laneGit);
    expect(setConvoLaneGit).toHaveBeenCalledWith({
      user: 'u1',
      conversationId: 'c1',
      laneGit,
      repo: 'LibreChat-AI/LibreChat',
    });
  });

  it.each(['../x', 'o/..', 'a b/c', 'owner', 'o/r/extra', 'x'.repeat(300)])(
    'drops the unsafe repository %s but still records the lane',
    async (repo) => {
      const setConvoLaneGit = jest.fn().mockResolvedValue(true);
      const record = createLaneGitRecorder({
        user: 'u1',
        conversationId: 'c1',
        repo,
        setConvoLaneGit,
      });
      await record?.(laneGit);
      expect(setConvoLaneGit).toHaveBeenCalledWith({
        user: 'u1',
        conversationId: 'c1',
        laneGit,
      });
    },
  );

  it('swallows a database failure and logs only safe metadata', async () => {
    const setConvoLaneGit = jest.fn().mockRejectedValue(new Error('mongodb://user:secret@host'));
    const record = createLaneGitRecorder({ user: 'u1', conversationId: 'c1', setConvoLaneGit });
    await expect(record?.(laneGit)).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('secret');
  });
});

describe('attached bash tool lane reporting', () => {
  const response = (extra: Record<string, unknown> = {}) =>
    Response.json({
      protocolVersion: 1,
      operation: 'execute_command',
      workspaceId: 'project-a',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      truncated: false,
      timedOut: false,
      ...extra,
    });
  const build = (fetchImpl: CodeBridgeFetch, onLaneGit?: jest.Mock) =>
    createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      onLaneGit,
      fetchImpl,
    });

  it('hands the reported branch and head to the recorder', async () => {
    const onLaneGit = jest.fn();
    await build(
      jest.fn(async () => response({ laneGit })),
      onLaneGit,
    ).invoke({ command: 'git status' });
    expect(onLaneGit).toHaveBeenCalledWith(laneGit);
  });

  it('hands over a detached lane as nulls, not as unknown', async () => {
    const onLaneGit = jest.fn();
    const detached = { branch: null, head: null };
    await build(
      jest.fn(async () => response({ laneGit: detached })),
      onLaneGit,
    ).invoke({ command: 'git status' });
    expect(onLaneGit).toHaveBeenCalledWith(detached);
  });

  it('does not call the recorder when the worker sent no laneGit', async () => {
    const onLaneGit = jest.fn();
    await build(
      jest.fn(async () => response()),
      onLaneGit,
    ).invoke({ command: 'ls' });
    expect(onLaneGit).not.toHaveBeenCalled();
  });

  it('still returns the command output when no recorder is configured', async () => {
    const output = await build(jest.fn(async () => response({ laneGit }))).invoke({
      command: 'ls',
    });
    expect(String(output)).toContain('ok');
  });
});

describe('createLaneGitRecorder write order', () => {
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  function controlledWriter() {
    const events: string[] = [];
    const releases: Array<(ok?: boolean) => void> = [];
    const fail: Array<() => void> = [];
    const setConvoLaneGit = jest.fn(
      ({ laneGit: reported }: { laneGit: { branch: string | null } }) =>
        new Promise<boolean>((resolve, reject) => {
          events.push(`start:${reported.branch}`);
          releases.push((ok = true) => {
            events.push(`end:${reported.branch}`);
            resolve(ok);
          });
          fail.push(() => reject(new Error('db down')));
        }),
    );
    return { events, releases, fail, setConvoLaneGit };
  }

  it('starts a later write only after the earlier one has finished', async () => {
    const { events, releases, setConvoLaneGit } = controlledWriter();
    const record = createLaneGitRecorder({
      user: 'u1',
      conversationId: 'order-1',
      setConvoLaneGit,
    });
    const first = record?.({ branch: 'a', head });
    const second = record?.({ branch: 'b', head });
    await flush();
    expect(events).toEqual(['start:a']);
    releases[0]();
    await first;
    await flush();
    expect(events).toEqual(['start:a', 'end:a', 'start:b']);
    releases[1]();
    await second;
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('orders writes across recorders built for the same conversation', async () => {
    const { events, releases, setConvoLaneGit } = controlledWriter();
    const make = () =>
      createLaneGitRecorder({ user: 'u1', conversationId: 'order-2', setConvoLaneGit });
    const first = make()?.({ branch: 'a', head });
    const second = make()?.({ branch: 'b', head });
    await flush();
    expect(events).toEqual(['start:a']);
    releases[0]();
    await first;
    await flush();
    releases[1]();
    await second;
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('does not make one conversation wait for another', async () => {
    const { events, setConvoLaneGit } = controlledWriter();
    const one = createLaneGitRecorder({ user: 'u1', conversationId: 'order-3', setConvoLaneGit });
    const other = createLaneGitRecorder({ user: 'u1', conversationId: 'order-4', setConvoLaneGit });
    void one?.({ branch: 'a', head });
    void other?.({ branch: 'b', head });
    await flush();
    expect(events).toEqual(['start:a', 'start:b']);
  });

  it('does not make one user wait for another on the same conversation id', async () => {
    const { events, setConvoLaneGit } = controlledWriter();
    const make = (user: string) =>
      createLaneGitRecorder({ user, conversationId: 'order-5', setConvoLaneGit });
    void make('u1')?.({ branch: 'a', head });
    void make('u2')?.({ branch: 'b', head });
    await flush();
    expect(events).toEqual(['start:a', 'start:b']);
  });

  it('still runs the next write after one fails', async () => {
    const { events, releases, fail, setConvoLaneGit } = controlledWriter();
    const record = createLaneGitRecorder({
      user: 'u1',
      conversationId: 'order-6',
      setConvoLaneGit,
    });
    const first = record?.({ branch: 'a', head });
    const second = record?.({ branch: 'b', head });
    await flush();
    fail[0]();
    await expect(first).resolves.toBe(false);
    await flush();
    expect(events).toEqual(['start:a', 'start:b']);
    releases[1]();
    await expect(second).resolves.toBe(true);
  });
});
