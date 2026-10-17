import { runSkillUploadRecoveryCli, runSkillUploadRecoveryCommand } from './recoveryCli';

function harness() {
  const messages: string[] = [];
  const errors: string[] = [];
  const deps = {
    connect: jest.fn(async () => undefined),
    disconnect: jest.fn(async () => undefined),
    runAsSystem: async <T>(callback: () => Promise<T>) => callback(),
    getIntent: jest.fn(
      async (): Promise<{
        fileId: string;
        writerId: string;
        skillId: string;
        state: string;
        cleanupHoldOwner?: string;
      } | null> => ({
        fileId: 'file-1',
        writerId: 'writer-1',
        skillId: 'skill-1',
        state: 'committing',
      }),
    ),
    listIntents: jest.fn(
      async (): Promise<
        Array<{
          fileId: string;
          writerId: string;
          skillId: string;
          state: string;
          cleanupHoldOwner?: string;
        }>
      > => [
        {
          fileId: 'file-1',
          writerId: 'writer-1',
          skillId: 'skill-1',
          state: 'committing',
        },
      ],
    ),
    recoverStoppedIntent: jest.fn(async () => ({
      status: 'recovered' as const,
      state: 'committed' as const,
    })),
    recoverStoppedCleanupHold: jest.fn(
      async (): Promise<
        { status: 'missing' | 'changed' } | { status: 'recovered'; cleanup: boolean }
      > => ({
        status: 'recovered' as const,
        cleanup: true,
      }),
    ),
    write: (message: string) => messages.push(message),
    writeError: (message: string) => errors.push(message),
  };
  return { deps, messages, errors };
}

it('requires explicit writer-drain confirmation before changing an intent', async () => {
  const h = harness();
  expect(await runSkillUploadRecoveryCli(['--help'], h.deps)).toBe(0);
  expect(await runSkillUploadRecoveryCli(['recover', 'file-1', 'writer-1'], h.deps)).toBe(2);
  expect(h.deps.connect).not.toHaveBeenCalled();
  expect(h.deps.recoverStoppedIntent).not.toHaveBeenCalled();
  expect(h.errors[0]).toContain('Stop or drain all Skill upload and sync writers');
});

it('inspects and recovers a matching stopped writer through system context', async () => {
  const h = harness();
  expect(await runSkillUploadRecoveryCli(['inspect', 'file-1'], h.deps)).toBe(0);
  expect(JSON.parse(h.messages[0])).toEqual({
    fileId: 'file-1',
    writerId: 'writer-1',
    skillId: 'skill-1',
    state: 'committing',
  });
  expect(await runSkillUploadRecoveryCli(['inspect-skill', 'skill-1'], h.deps)).toBe(0);
  expect(JSON.parse(h.messages[1])).toEqual([
    { fileId: 'file-1', writerId: 'writer-1', skillId: 'skill-1', state: 'committing' },
  ]);
  expect(
    await runSkillUploadRecoveryCli(
      ['recover', 'file-1', 'writer-1', '--confirm-writers-drained'],
      h.deps,
    ),
  ).toBe(0);
  expect(h.deps.recoverStoppedIntent).toHaveBeenCalledWith('file-1', 'writer-1');
  expect(h.deps.disconnect).toHaveBeenCalledTimes(3);
});

it('shows the cleanup hold owner during inspection', async () => {
  const h = harness();
  h.deps.getIntent.mockResolvedValueOnce({
    fileId: 'file-1',
    writerId: 'original-writer',
    skillId: 'skill-1',
    state: 'committed',
    cleanupHoldOwner: 'replacement-writer',
  });
  h.deps.listIntents.mockResolvedValueOnce([
    {
      fileId: 'file-1',
      writerId: 'original-writer',
      skillId: 'skill-1',
      state: 'committed',
      cleanupHoldOwner: 'replacement-writer',
    },
  ]);
  expect(await runSkillUploadRecoveryCli(['inspect', 'file-1'], h.deps)).toBe(0);
  expect(JSON.parse(h.messages[0])).toMatchObject({
    writerId: 'original-writer',
    cleanupHoldOwner: 'replacement-writer',
  });
  expect(await runSkillUploadRecoveryCli(['inspect-skill', 'skill-1'], h.deps)).toBe(0);
  expect(JSON.parse(h.messages[1])[0]).toMatchObject({
    writerId: 'original-writer',
    cleanupHoldOwner: 'replacement-writer',
  });
});

it('requires writer-drain confirmation before recovering a cleanup hold', async () => {
  const h = harness();
  expect(await runSkillUploadRecoveryCli(['recover-cleanup', 'file-1', 'hold-1'], h.deps)).toBe(2);
  expect(
    await runSkillUploadRecoveryCli(
      ['recover-cleanup', 'file-1', 'hold-1', '--confirm-writers-active'],
      h.deps,
    ),
  ).toBe(2);
  expect(h.deps.connect).not.toHaveBeenCalled();
  expect(h.deps.recoverStoppedCleanupHold).not.toHaveBeenCalled();
});

it.each([
  [true, 'cleanup queued'],
  [false, 'file retained'],
] as const)('reports recovered cleanup hold outcome %s', async (cleanup, outcome) => {
  const h = harness();
  h.deps.recoverStoppedCleanupHold.mockResolvedValueOnce({ status: 'recovered', cleanup });
  expect(
    await runSkillUploadRecoveryCli(
      ['recover-cleanup', 'file-1', 'hold-1', '--confirm-writers-drained'],
      h.deps,
    ),
  ).toBe(0);
  expect(h.deps.recoverStoppedCleanupHold).toHaveBeenCalledWith('file-1', 'hold-1');
  expect(h.messages).toEqual([`Recovered cleanup hold file-1; ${outcome}`]);
  expect(h.deps.disconnect).toHaveBeenCalledTimes(1);
});

it.each(['missing', 'changed'] as const)(
  'does not claim recovery for a %s cleanup hold',
  async (status) => {
    const h = harness();
    h.deps.recoverStoppedCleanupHold.mockResolvedValueOnce({ status });
    expect(
      await runSkillUploadRecoveryCli(
        ['recover-cleanup', 'file-1', 'hold-1', '--confirm-writers-drained'],
        h.deps,
      ),
    ).toBe(1);
    expect(h.errors).toEqual([
      `Upload cleanup hold file-1 was ${status}; inspect it again before retrying`,
    ]);
    expect(h.deps.disconnect).toHaveBeenCalledTimes(1);
  },
);

it.each(['connect', 'getIntent', 'disconnect'] as const)(
  'reports bounded metadata when %s fails without logging driver details',
  async (step) => {
    const h = harness();
    h.deps[step].mockRejectedValueOnce(
      Object.assign(new Error('mongodb://user:secret@db.example/private'), {
        status: 503,
        query: { token: 'secret' },
      }),
    );

    expect(await runSkillUploadRecoveryCommand(['inspect', 'file-1'], h.deps)).toBe(1);
    expect(h.errors).toEqual(['{"type":"Error","status":503}']);
    expect(JSON.stringify(h.errors)).not.toContain('secret');
  },
);
