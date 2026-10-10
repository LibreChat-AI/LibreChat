import { logger } from '@librechat/data-schemas';
import type { CodeBridgeFetch } from './bridge';
import { createLaneGitRecorder as createRecorder } from './lane';
import { createAttachedWorkspaceBashTool } from './command';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

type RecorderOptions = Parameters<typeof createRecorder>[0];

/** Places the recorder once, as the tool does, then reports through it in call order. */
const createLaneGitRecorder = (options: Omit<RecorderOptions, 'enabled'>) => {
  const ready = createRecorder({ enabled: true, ...options });
  return (laneGit: Parameters<NonNullable<Awaited<typeof ready>>>[0]) =>
    ready.then((record) => (record ? record(laneGit) : false));
};

const head = 'a'.repeat(40);
const laneGit = { branch: 'feat/pr-chip', head };

/** A reserver that hands out 1, 2, 3 ... like the database counter does. */
const counter = () => {
  let next = 0;
  return jest.fn(async () => ++next);
};

describe('createLaneGitRecorder', () => {
  const make = (overrides: Record<string, unknown> = {}) => {
    const setConvoLaneGit = jest.fn().mockResolvedValue(true);
    const reserveConvoLaneGitSeq = counter();
    const record = createLaneGitRecorder({
      user: 'u1',
      conversationId: 'c1',
      reserveConvoLaneGitSeq,
      setConvoLaneGit,
      ...overrides,
    });
    return { record, setConvoLaneGit, reserveConvoLaneGitSeq };
  };

  it('writes the reported state with a reserved sequence number', async () => {
    const { record, setConvoLaneGit, reserveConvoLaneGitSeq } = make();
    await expect(record?.(laneGit)).resolves.toBe(true);
    expect(reserveConvoLaneGitSeq).toHaveBeenCalledWith('u1', 'c1');
    expect(setConvoLaneGit).toHaveBeenCalledWith({
      user: 'u1',
      conversationId: 'c1',
      laneGit,
      seq: 1,
    });
  });

  it.each([
    ['a missing user', { user: undefined, conversationId: 'c1' }],
    ['an empty user', { user: '', conversationId: 'c1' }],
    ['a missing conversation', { user: 'u1', conversationId: undefined }],
    ['an empty conversation', { user: 'u1', conversationId: '' }],
  ])('does not record with %s', async (_label, ids) => {
    const setConvoLaneGit = jest.fn();
    const record = await createRecorder({
      enabled: true,
      ...ids,
      reserveConvoLaneGitSeq: counter(),
      setConvoLaneGit,
    } as RecorderOptions);
    expect(record).toBeUndefined();
    expect(setConvoLaneGit).not.toHaveBeenCalled();
  });

  it('stores a plain owner/name repository with the lane', async () => {
    const { record, setConvoLaneGit } = make({ repo: 'LibreChat-AI/LibreChat' });
    await record?.(laneGit);
    expect(setConvoLaneGit).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'LibreChat-AI/LibreChat' }),
    );
  });

  it.each(['../x', 'o/..', 'a b/c', 'owner', 'o/r/extra', 'x'.repeat(300)])(
    'drops the unsafe repository %s but still records the lane',
    async (repo) => {
      const { record, setConvoLaneGit } = make({ repo });
      await record?.(laneGit);
      expect(setConvoLaneGit).toHaveBeenCalledTimes(1);
      expect(setConvoLaneGit.mock.calls[0][0]).not.toHaveProperty('repo');
    },
  );

  it('swallows a write failure and logs only safe metadata', async () => {
    const setConvoLaneGit = jest.fn().mockRejectedValue(new Error('mongodb://user:secret@host'));
    const { record } = make({ setConvoLaneGit });
    await expect(record?.(laneGit)).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('secret');
  });

  it('swallows a reservation failure and writes nothing', async () => {
    const reserveConvoLaneGitSeq = jest.fn().mockRejectedValue(new Error('mongodb://u:secret@h'));
    const { record, setConvoLaneGit } = make({ reserveConvoLaneGitSeq });
    await expect(record?.(laneGit)).resolves.toBe(false);
    expect(setConvoLaneGit).not.toHaveBeenCalled();
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('secret');
  });

  it('writes nothing when the conversation is not saved yet', async () => {
    const { record, setConvoLaneGit } = make({
      reserveConvoLaneGitSeq: jest.fn().mockResolvedValue(null),
    });
    await expect(record?.(laneGit)).resolves.toBe(false);
    expect(setConvoLaneGit).not.toHaveBeenCalled();
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

describe('createLaneGitRecorder ordering', () => {
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('takes sequence numbers in report order and writes each with its own', async () => {
    const setConvoLaneGit = jest.fn().mockResolvedValue(true);
    const record = createLaneGitRecorder({
      user: 'u1',
      conversationId: 'order-1',
      reserveConvoLaneGitSeq: counter(),
      setConvoLaneGit,
    });
    await Promise.all([record?.({ branch: 'a', head }), record?.({ branch: 'b', head })]);
    const writes = setConvoLaneGit.mock.calls.map(([call]) => [call.laneGit.branch, call.seq]);
    expect(writes.sort()).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('gives a later report the higher number even when the first reservation is slow', async () => {
    let issued = 0;
    const releases: Array<() => void> = [];
    /** The first reservation takes longer than any later one, as a slow replica round trip can. */
    const reserve = jest.fn(
      () =>
        new Promise<number>((resolve) => {
          const slow = issued === 0;
          issued += 1;
          const number = issued;
          if (slow) releases.push(() => resolve(number));
          else resolve(number);
        }),
    );
    const setConvoLaneGit = jest.fn().mockResolvedValue(true);
    const record = createLaneGitRecorder({
      user: 'u1',
      conversationId: 'order-slow',
      reserveConvoLaneGitSeq: reserve,
      setConvoLaneGit,
    });
    const first = record?.({ branch: 'first', head });
    const second = record?.({ branch: 'second', head });
    await flush();
    expect(reserve).toHaveBeenCalledTimes(1);
    releases[0]();
    await Promise.all([first, second]);
    const bySeq = setConvoLaneGit.mock.calls
      .map(([call]) => [call.seq, call.laneGit.branch])
      .sort();
    expect(bySeq).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
  });

  it('does not wait for one write to finish before reserving the next report', async () => {
    const reserve = counter();
    const releases: Array<() => void> = [];
    const setConvoLaneGit = jest.fn(
      () => new Promise<boolean>((resolve) => releases.push(() => resolve(true))),
    );
    const record = createLaneGitRecorder({
      user: 'u1',
      conversationId: 'order-2',
      reserveConvoLaneGitSeq: reserve,
      setConvoLaneGit,
    });
    void record?.({ branch: 'a', head });
    void record?.({ branch: 'b', head });
    await flush();
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(setConvoLaneGit).toHaveBeenCalledTimes(2);
    releases.forEach((release) => release());
  });

  it('orders reservations across recorders built for the same conversation', async () => {
    const reserve = counter();
    const setConvoLaneGit = jest.fn().mockResolvedValue(true);
    const make = () =>
      createLaneGitRecorder({
        user: 'u1',
        conversationId: 'order-3',
        reserveConvoLaneGitSeq: reserve,
        setConvoLaneGit,
      });
    await Promise.all([make()?.({ branch: 'a', head }), make()?.({ branch: 'b', head })]);
    const bySeq = setConvoLaneGit.mock.calls
      .map(([call]) => [call.seq, call.laneGit.branch])
      .sort();
    expect(bySeq).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });

  it('does not make one conversation or one user wait for another', async () => {
    const releases: Array<() => void> = [];
    const reserve = jest.fn(
      () => new Promise<number>((resolve) => releases.push(() => resolve(1))),
    );
    const make = (user: string, conversationId: string) =>
      createLaneGitRecorder({
        user,
        conversationId,
        reserveConvoLaneGitSeq: reserve,
        setConvoLaneGit: jest.fn().mockResolvedValue(true),
      });
    void make('u1', 'order-4')?.({ branch: 'a', head });
    void make('u1', 'order-5')?.({ branch: 'b', head });
    void make('u2', 'order-4')?.({ branch: 'c', head });
    await flush();
    expect(reserve).toHaveBeenCalledTimes(3);
    releases.forEach((release) => release());
  });

  it('keeps reserving after one reservation fails', async () => {
    const reserve = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(7);
    const setConvoLaneGit = jest.fn().mockResolvedValue(true);
    const record = createLaneGitRecorder({
      user: 'u1',
      conversationId: 'order-6',
      reserveConvoLaneGitSeq: reserve,
      setConvoLaneGit,
    });
    await expect(record?.({ branch: 'a', head })).resolves.toBe(false);
    await expect(record?.({ branch: 'b', head })).resolves.toBe(true);
    expect(setConvoLaneGit.mock.calls[0][0]).toMatchObject({ seq: 7 });
  });

  it('reports a write the database rejected as not applied, so a stale report is not remembered', async () => {
    const setConvoLaneGit = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const record = createLaneGitRecorder({
      user: 'u1',
      conversationId: 'order-7',
      reserveConvoLaneGitSeq: counter(),
      setConvoLaneGit,
    });
    await expect(record?.(laneGit)).resolves.toBe(false);
    await expect(record?.(laneGit)).resolves.toBe(true);
    expect(setConvoLaneGit).toHaveBeenCalledTimes(2);
  });

  it('does not skip a report that repeats the last one, since another writer may have changed the lane', async () => {
    const reserve = counter();
    const setConvoLaneGit = jest.fn().mockResolvedValue(true);
    const record = createLaneGitRecorder({
      user: 'u1',
      conversationId: 'order-8',
      reserveConvoLaneGitSeq: reserve,
      setConvoLaneGit,
    });
    await record?.(laneGit);
    await record?.(laneGit);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(setConvoLaneGit).toHaveBeenCalledTimes(2);
  });

  it('lets a recorder restore its state after another recorder changed the same conversation', async () => {
    const written: string[] = [];
    const setConvoLaneGit = jest.fn(
      async ({ laneGit: reported }: { laneGit: { branch: string | null } }) => {
        written.push(String(reported.branch));
        return true;
      },
    );
    const reserve = counter();
    const make = () =>
      createLaneGitRecorder({
        user: 'u1',
        conversationId: 'order-shared',
        reserveConvoLaneGitSeq: reserve,
        setConvoLaneGit,
      });
    const first = make();
    const second = make();
    await first?.({ branch: 'x', head });
    await second?.({ branch: 'y', head });
    await first?.({ branch: 'x', head });
    expect(written).toEqual(['x', 'y', 'x']);
  });

  it('writes again once the state changes, including back to an earlier one', async () => {
    const setConvoLaneGit = jest.fn().mockResolvedValue(true);
    const record = createLaneGitRecorder({
      user: 'u1',
      conversationId: 'order-9',
      reserveConvoLaneGitSeq: counter(),
      setConvoLaneGit,
    });
    await record?.({ branch: 'a', head });
    await record?.({ branch: 'b', head });
    await record?.({ branch: 'a', head });
    expect(setConvoLaneGit.mock.calls.map(([call]) => call.laneGit.branch)).toEqual([
      'a',
      'b',
      'a',
    ]);
  });

  it('orders reservations by the visible conversation two subagent threads share', async () => {
    const releases: Array<() => void> = [];
    const reserve = jest.fn(
      () => new Promise<number>((resolve) => releases.push(() => resolve(releases.length))),
    );
    const getConvoLaneContext = jest
      .fn()
      .mockResolvedValue({ subagentThread: { rootConversationId: 'shared-root' } });
    const make = (conversationId: string) =>
      createLaneGitRecorder({
        user: 'u1',
        conversationId,
        workspace: { environmentId: 'code-mac', workspaceId: 'primary' },
        getConvoLaneContext,
        reserveConvoLaneGitSeq: reserve,
        setConvoLaneGit: jest.fn().mockResolvedValue(true),
      });
    void make('child-a')?.({ branch: 'a', head });
    void make('child-b')?.({ branch: 'b', head });
    await flush();
    expect(reserve).toHaveBeenCalledTimes(1);
    releases[0]();
    await flush();
    expect(reserve).toHaveBeenCalledTimes(2);
    releases[1]();
  });

  it('does not make threads of different visible conversations wait for each other', async () => {
    const releases: Array<() => void> = [];
    const reserve = jest.fn(
      () => new Promise<number>((resolve) => releases.push(() => resolve(1))),
    );
    const getConvoLaneContext = jest.fn(async (_user: string, id: string) => ({
      subagentThread: { rootConversationId: id === 'child-a' ? 'root-a' : 'root-b' },
    }));
    const make = (conversationId: string) =>
      createLaneGitRecorder({
        user: 'u1',
        conversationId,
        workspace: { environmentId: 'code-mac', workspaceId: 'primary' },
        getConvoLaneContext,
        reserveConvoLaneGitSeq: reserve,
        setConvoLaneGit: jest.fn().mockResolvedValue(true),
      });
    void make('child-a')?.({ branch: 'a', head });
    void make('child-b')?.({ branch: 'b', head });
    await flush();
    expect(reserve).toHaveBeenCalledTimes(2);
    releases.forEach((release) => release());
  });
});

describe('createLaneGitRecorder target conversation', () => {
  const workspace = { environmentId: 'code-mac', workspaceId: 'primary' };
  const build = (overrides: Record<string, unknown> = {}) => {
    const setConvoLaneGit = jest.fn().mockResolvedValue(true);
    const reserveConvoLaneGitSeq = counter();
    const record = createLaneGitRecorder({
      user: 'u1',
      conversationId: 'target-1',
      workspace,
      reserveConvoLaneGitSeq,
      setConvoLaneGit,
      ...overrides,
    });
    return { record, setConvoLaneGit, reserveConvoLaneGitSeq };
  };
  const written = (setConvoLaneGit: jest.Mock) => setConvoLaneGit.mock.calls.map(([call]) => call);

  it('passes the workspace it ran in, so a stale writer can be fenced', async () => {
    const { record, setConvoLaneGit } = build();
    await record(laneGit);
    expect(written(setConvoLaneGit)[0]).toMatchObject({
      conversationId: 'target-1',
      workspace: { ...workspace },
    });
    expect(written(setConvoLaneGit)[0].workspace.required).not.toBe(true);
  });

  it('records a subagent thread on the visible conversation, and requires its workspace to match', async () => {
    const getConvoLaneContext = jest.fn().mockResolvedValue({
      subagentThread: { rootConversationId: 'visible-root', parentConversationId: 'mid' },
      codeAttachmentEpoch: 0,
    });
    const { record, setConvoLaneGit, reserveConvoLaneGitSeq } = build({
      conversationId: 'child-thread',
      getConvoLaneContext,
    });
    await record(laneGit);
    expect(getConvoLaneContext).toHaveBeenCalledWith('u1', 'child-thread');
    expect(reserveConvoLaneGitSeq).toHaveBeenCalledWith('u1', 'visible-root');
    expect(written(setConvoLaneGit)[0]).toMatchObject({
      conversationId: 'visible-root',
      workspace: { ...workspace, required: true },
    });
  });

  it('records an ordinary conversation on itself', async () => {
    const getConvoLaneContext = jest.fn().mockResolvedValue({ codeAttachmentEpoch: 0 });
    const { record, setConvoLaneGit } = build({ conversationId: 'plain', getConvoLaneContext });
    await record(laneGit);
    expect(written(setConvoLaneGit)[0].conversationId).toBe('plain');
  });

  it('looks the conversation up once however many reports follow', async () => {
    const getConvoLaneContext = jest.fn().mockResolvedValue({
      subagentThread: { rootConversationId: 'visible-root' },
      codeAttachmentEpoch: 0,
    });
    const { record, setConvoLaneGit } = build({ conversationId: 'child-2', getConvoLaneContext });
    await record({ branch: 'a', head });
    await record({ branch: 'b', head });
    expect(getConvoLaneContext).toHaveBeenCalledTimes(1);
    expect(written(setConvoLaneGit).map((call) => call.conversationId)).toEqual([
      'visible-root',
      'visible-root',
    ]);
  });

  it('records nothing when it cannot place the conversation, rather than guess', async () => {
    const getConvoLaneContext = jest
      .fn()
      .mockRejectedValue(new Error('mongodb://user:secret@host'));
    const setConvoLaneGit = jest.fn();
    const record = await createRecorder({
      enabled: true,
      user: 'u1',
      conversationId: 'child-3',
      workspace,
      getConvoLaneContext,
      reserveConvoLaneGitSeq: counter(),
      setConvoLaneGit,
    });
    expect(record).toBeUndefined();
    expect(setConvoLaneGit).not.toHaveBeenCalled();
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('secret');
  });

  it('does not write a subagent lane to the parent without a workspace to verify it against', async () => {
    const getConvoLaneContext = jest.fn().mockResolvedValue({
      subagentThread: { rootConversationId: 'visible-root' },
      codeAttachmentEpoch: 0,
    });
    const setConvoLaneGit = jest.fn();
    const record = await createRecorder({
      enabled: true,
      user: 'u1',
      conversationId: 'child-4',
      getConvoLaneContext,
      reserveConvoLaneGitSeq: counter(),
      setConvoLaneGit,
    });
    expect(record).toBeUndefined();
    expect(setConvoLaneGit).not.toHaveBeenCalled();
  });

  it('places a conversation that is not saved yet on itself at epoch 0', async () => {
    const getConvoLaneContext = jest.fn().mockResolvedValue(null);
    const { record, setConvoLaneGit } = build({ getConvoLaneContext });
    await record(laneGit);
    expect(written(setConvoLaneGit)[0]).toMatchObject({
      conversationId: 'target-1',
      workspace: { ...workspace, epoch: 0 },
    });
  });
});

describe('createLaneGitRecorder placement timing', () => {
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const workspace = { environmentId: 'code-mac', workspaceId: 'primary' };

  it('settles placement before any report, so a slow lookup cannot reorder reports', async () => {
    let release: () => void = () => undefined;
    const getConvoLaneContext = jest.fn(
      () =>
        new Promise<{ codeAttachmentEpoch: number }>((resolve) => {
          release = () => resolve({ codeAttachmentEpoch: 0 });
        }),
    );
    const reserve = counter();
    const pending = createRecorder({
      enabled: true,
      user: 'u1',
      conversationId: 'slow-lookup',
      workspace,
      getConvoLaneContext,
      reserveConvoLaneGitSeq: reserve,
      setConvoLaneGit: jest.fn().mockResolvedValue(true),
    });
    await flush();
    expect(reserve).not.toHaveBeenCalled();
    release();
    const record = await pending;
    expect(record).toBeDefined();
    await record?.({ branch: 'a', head });
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('carries the epoch read at creation into every write, even if the chat moves later', async () => {
    const getConvoLaneContext = jest.fn().mockResolvedValue({ codeAttachmentEpoch: 3 });
    const setConvoLaneGit = jest.fn().mockResolvedValue(true);
    const record = await createRecorder({
      enabled: true,
      user: 'u1',
      conversationId: 'epoch-1',
      workspace,
      getConvoLaneContext,
      reserveConvoLaneGitSeq: counter(),
      setConvoLaneGit,
    });
    await record?.({ branch: 'a', head });
    await record?.({ branch: 'b', head });
    expect(setConvoLaneGit.mock.calls.map(([call]) => call.workspace.epoch)).toEqual([3, 3]);
    expect(getConvoLaneContext).toHaveBeenCalledTimes(1);
  });
});

describe('createLaneGitRecorder when pull requests are off', () => {
  it('reads and records nothing', async () => {
    const getConvoLaneContext = jest.fn();
    const reserveConvoLaneGitSeq = counter();
    const setConvoLaneGit = jest.fn();
    const record = await createRecorder({
      enabled: false,
      user: 'u1',
      conversationId: 'off-1',
      workspace: { environmentId: 'code-mac', workspaceId: 'primary' },
      getConvoLaneContext,
      reserveConvoLaneGitSeq,
      setConvoLaneGit,
    });
    expect(record).toBeUndefined();
    expect(getConvoLaneContext).not.toHaveBeenCalled();
    expect(reserveConvoLaneGitSeq).not.toHaveBeenCalled();
  });
});
