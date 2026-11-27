import { getTenantId, SYSTEM_TENANT_ID, tenantStorage } from '@librechat/data-schemas';
import type { AgentTriggerDeadLetter } from '@librechat/data-schemas';
import type { DeadLetterDeps } from './dead';
import { AgentTriggerServiceUnavailableError } from './service';
import { createDeadLetters } from './dead';

const letter: AgentTriggerDeadLetter = {
  id: 'a'.repeat(24),
  deliveryKey: 'trigger_1',
  user: 'b'.repeat(24),
  attempts: 1,
  requeues: 0,
  requeueable: true,
  dismissable: true,
  createdAt: new Date('2026-11-23T12:00:00.000Z'),
};

/** Records the tenant context each store call ran in, to show none ran as the caller. */
function setup(overrides: Partial<DeadLetterDeps['methods']> = {}) {
  const contexts: Array<string | undefined> = [];
  const seen = <T>(value: T) => {
    contexts.push(getTenantId());
    return value;
  };
  const methods: DeadLetterDeps['methods'] = {
    listAgentTriggerDeadLetterPage: jest.fn(async () => seen({ letters: [letter], total: 1 })),
    getAgentTriggerDeadLetter: jest.fn(async () => seen(letter)),
    dismissAgentTriggerDeadLetter: jest.fn(async () => seen(true)),
    ...overrides,
  };
  const requeue = jest.fn<
    ReturnType<DeadLetterDeps['requeue']>,
    Parameters<DeadLetterDeps['requeue']>
  >(async () => null);
  return { contexts, methods, requeue, letters: createDeadLetters({ methods, requeue }) };
}

describe('createDeadLetters', () => {
  it('reads and removes as the system while passing the named partition to the store', async () => {
    const { contexts, methods, letters } = setup();

    await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
      await expect(letters.list('tenant-a', { limit: 5, offset: 10 })).resolves.toEqual({
        letters: [letter],
        total: 1,
      });
      await expect(letters.get('tenant-a', letter.id)).resolves.toBe(letter);
      await expect(letters.dismiss(undefined, letter.id)).resolves.toEqual({ ok: true });
    });

    expect(contexts).toEqual([SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, SYSTEM_TENANT_ID]);
    expect(methods.listAgentTriggerDeadLetterPage).toHaveBeenCalledWith('tenant-a', {
      limit: 5,
      offset: 10,
    });
    expect(methods.getAgentTriggerDeadLetter).toHaveBeenCalledWith('tenant-a', letter.id);
    expect(methods.dismissAgentTriggerDeadLetter).toHaveBeenCalledWith(undefined, letter.id);
  });

  it('describes a schedule occurrence as not requeueable, and any other source as stored', async () => {
    const occurrence = { ...letter, id: 'c'.repeat(24), source: 'schedule' };
    const event = { ...letter, id: 'd'.repeat(24), source: 'remote_api_key' };
    const { methods, letters } = setup({
      listAgentTriggerDeadLetterPage: jest.fn(async () => ({
        letters: [occurrence, event, letter],
        total: 3,
      })),
      getAgentTriggerDeadLetter: jest.fn(async () => occurrence),
    });

    await expect(letters.list('tenant-a', { limit: 5, offset: 0 })).resolves.toEqual({
      letters: [{ ...occurrence, requeueable: false }, event, letter],
      total: 3,
    });
    await expect(letters.get('tenant-a', occurrence.id)).resolves.toEqual({
      ...occurrence,
      requeueable: false,
    });
    (methods.getAgentTriggerDeadLetter as jest.Mock).mockResolvedValueOnce(null);
    await expect(letters.get('tenant-a', occurrence.id)).resolves.toBeNull();
  });

  it('reports a dead letter the store left in place as a conflict', async () => {
    const { letters } = setup({ dismissAgentTriggerDeadLetter: jest.fn(async () => false) });

    await expect(letters.dismiss('tenant-a', letter.id)).resolves.toEqual({
      ok: false,
      error: { code: 'conflict' },
    });
  });

  it('requeues through the service within the named partition', async () => {
    const { requeue, letters } = setup();
    requeue.mockResolvedValueOnce({ id: letter.id } as never);

    await expect(letters.requeue('tenant-a', letter.id)).resolves.toEqual({ ok: true });
    expect(requeue).toHaveBeenLastCalledWith(letter.id, undefined, {
      tenantId: 'tenant-a',
      except: ['schedule'],
    });

    await expect(letters.requeue(undefined, letter.id)).resolves.toEqual({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(requeue).toHaveBeenLastCalledWith(letter.id, undefined, {
      tenantId: undefined,
      except: ['schedule'],
    });
  });

  it('reports a queue that is not running as unavailable and rethrows anything else', async () => {
    const { requeue, letters } = setup();
    requeue.mockRejectedValueOnce(new AgentTriggerServiceUnavailableError('not ready'));

    await expect(letters.requeue('tenant-a', letter.id)).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable' },
    });

    requeue.mockRejectedValueOnce(new Error('connection reset'));
    await expect(letters.requeue('tenant-a', letter.id)).rejects.toThrow('connection reset');
  });
});
