import { PrincipalType, ResourceType } from 'librechat-data-provider';
import type { PermissionChange } from './types';
import type { ServerRequest } from '~/types';
import { runAuditedPermissionUpdate } from './audit';

const req = {
  user: { _id: { toString: () => 'actor-id' }, id: 'actor-id', name: 'Actor', tenantId: 't1' },
  headers: {},
} as unknown as ServerRequest;

const grantChange = (id: string, permBits = 3): PermissionChange => ({
  action: 'assigned',
  previous: null,
  written: { permBits, roleId: 'r1' },
  principal: { type: PrincipalType.USER, id },
});

const revokeChange = (type: PrincipalType, id: string | null): PermissionChange => ({
  action: 'removed',
  previous: { permBits: 1, roleId: 'r1' },
  written: null,
  principal: { type, id },
});

function setup(recordImpl?: jest.Mock) {
  const recordAuditEntry = recordImpl ?? jest.fn().mockResolvedValue(null);
  const logger = { error: jest.fn() };
  const write = jest.fn().mockResolvedValue('written');
  const run = (
    aclChanges: PermissionChange[],
    failClosed: boolean,
    options: {
      insightsChanges?: PermissionChange[];
      getAgent?: jest.Mock;
      resourceType?: ResourceType;
      r?: ServerRequest;
      resourceId?: string;
    } = {},
  ) =>
    runAuditedPermissionUpdate({
      req: options.r ?? req,
      resourceType: options.resourceType ?? ResourceType.PROMPTGROUP,
      resourceId: options.resourceId ?? 'res-1',
      failClosed,
      deps: { recordAuditEntry, logger, getAgent: options.getAgent },
      update: async (beforeWrite) => {
        await beforeWrite({ aclChanges, insightsChanges: options.insightsChanges ?? [] });
        return write();
      },
    });
  return { recordAuditEntry, logger, write, run };
}

describe('runAuditedPermissionUpdate', () => {
  test('targets an uppercase ObjectId hex by its lowercase form', async () => {
    const { recordAuditEntry, run } = setup();
    const hex = 'ABCDEF0123456789ABCDEF01';

    await run([grantChange('u1')], true, { resourceId: hex });

    expect(recordAuditEntry.mock.calls[0][0].target.id).toBe(hex.toLowerCase());
  });

  test('records grant, revoke and public entries with ids and bits only, before the write', async () => {
    const { recordAuditEntry, write, run } = setup();
    recordAuditEntry.mockImplementation(async () => {
      expect(write).not.toHaveBeenCalled();
    });

    await expect(
      run(
        [
          grantChange('u1'),
          revokeChange(PrincipalType.GROUP, 'g1'),
          revokeChange(PrincipalType.PUBLIC, null),
        ],
        true,
      ),
    ).resolves.toBe('written');

    const inputs = recordAuditEntry.mock.calls.map(([input]) => input);
    expect(inputs.map((i) => i.action)).toEqual([
      'acl.granted',
      'acl.revoked',
      'acl.public_changed',
    ]);
    expect(inputs[0]).toEqual(
      expect.objectContaining({
        outcome: 'success',
        target: { type: ResourceType.PROMPTGROUP, id: 'res-1' },
        tenantId: 't1',
        metadata: {
          principalType: 'user',
          principalId: 'u1',
          permBits: 3,
          previousPermBits: 0,
          roleId: 'r1',
          previousRoleId: '',
          resourceId: 'res-1',
        },
      }),
    );
    expect(inputs[2].metadata).toEqual(expect.objectContaining({ enabled: false }));
    expect(recordAuditEntry.mock.calls[0][1]).toEqual({ failClosed: true });
  });

  test('skips a grant that changes nothing', async () => {
    const { recordAuditEntry, write, run } = setup();
    await run([{ ...grantChange('u1'), previous: { permBits: 3, roleId: 'r1' } }], true);
    expect(recordAuditEntry).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  test('fail-closed: a failed audit write rejects the request and nothing is written', async () => {
    const record = jest.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('down'));
    const { write, run } = setup(record);

    await expect(run([grantChange('u1'), grantChange('u2')], true)).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(write).not.toHaveBeenCalled();
    /** The entry already recorded is withdrawn with a matching failure entry. */
    expect(record.mock.calls.map(([input]) => input.outcome)).toEqual([
      'success',
      'success',
      'failure',
    ]);
  });

  test('fail-closed: no authenticated actor rejects before any write', async () => {
    const { recordAuditEntry, write, run } = setup();

    await expect(
      run([grantChange('u1')], true, { r: { headers: {} } as unknown as ServerRequest }),
    ).rejects.toThrow();
    expect(recordAuditEntry).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test('opt-out: logs a failed audit write and applies the change anyway', async () => {
    const record = jest.fn().mockRejectedValue(new Error('down'));
    const { write, logger, run } = setup(record);

    await expect(run([grantChange('u1'), grantChange('u2')], false)).resolves.toBe('written');
    expect(record).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  test('an audit outage blocks a widening change but not a revocation', async () => {
    const down = jest.fn().mockRejectedValue(new Error('down'));
    const widen = setup(down);
    await expect(widen.run([grantChange('u1')], true)).rejects.toMatchObject({ statusCode: 500 });
    expect(widen.write).not.toHaveBeenCalled();

    const record = jest.fn().mockRejectedValue(new Error('down'));
    const narrow = setup(record);
    await expect(
      narrow.run(
        [revokeChange(PrincipalType.USER, 'u1'), revokeChange(PrincipalType.PUBLIC, null)],
        true,
      ),
    ).resolves.toBe('written');
    expect(narrow.write).toHaveBeenCalledTimes(1);
    /** Each entry is attempted before the write and once more after it. */
    expect(record).toHaveBeenCalledTimes(4);
    expect(narrow.logger.error).toHaveBeenCalled();
  });

  test('retries deferred revocation entries before the update returns, inside its lease', async () => {
    const record = jest.fn();
    const order: string[] = [];
    record.mockImplementation(async (input) => {
      order.push(`record:${input.action}`);
      if (order.length === 1) throw new Error('down');
    });
    const { logger } = setup(record);
    await runAuditedPermissionUpdate({
      req,
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: 'res-1',
      failClosed: true,
      deps: { recordAuditEntry: record, logger },
      update: async (beforeWrite, afterWrite) => {
        await beforeWrite({
          aclChanges: [revokeChange(PrincipalType.USER, 'u1')],
          insightsChanges: [],
        });
        order.push('write');
        await afterWrite();
        order.push('lease-released');
        return 'written';
      },
    });
    expect(order).toEqual(['record:acl.revoked', 'write', 'record:acl.revoked', 'lease-released']);
  });

  test('reports a pure bit reduction as a revocation', async () => {
    const { recordAuditEntry, run } = setup();
    const lowered = { ...grantChange('u1', 1), previous: { permBits: 3, roleId: 'r2' } };
    await run([lowered], true);
    expect(recordAuditEntry.mock.calls[0][0].action).toBe('acl.revoked');
  });

  test('an audit outage on a widening change carries a stable code', async () => {
    const { run } = setup(jest.fn().mockRejectedValue(new Error('down')));
    await expect(run([grantChange('u1')], true)).rejects.toMatchObject({
      code: 'PERMISSION_AUDIT_UNAVAILABLE',
    });
  });

  test('keeps success entries when the update fails after the write committed', async () => {
    const { recordAuditEntry } = setup();
    await expect(
      runAuditedPermissionUpdate({
        req,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: 'res-1',
        failClosed: true,
        deps: { recordAuditEntry, logger: { error: jest.fn() } },
        update: async (beforeWrite, afterWrite) => {
          await beforeWrite({ aclChanges: [grantChange('u1')], insightsChanges: [] });
          await afterWrite();
          throw new Error('cache down');
        },
      }),
    ).rejects.toThrow('cache down');
    expect(recordAuditEntry.mock.calls.map(([i]) => i.outcome)).toEqual(['success']);
  });

  test('every entry carries the database resource id, with or without the agent lookup', async () => {
    const { recordAuditEntry, run } = setup();
    await run([grantChange('u1')], true, {
      resourceType: ResourceType.AGENT,
      getAgent: jest.fn().mockRejectedValue(new Error('down')),
      insightsChanges: [grantChange('u1')],
    });
    const metas = recordAuditEntry.mock.calls.map(([i]) => i.metadata.resourceId);
    expect(metas.length).toBeGreaterThanOrEqual(2);
    expect(new Set(metas)).toEqual(new Set(['res-1']));
  });

  test('audits principals and role ids in canonical form', async () => {
    const { recordAuditEntry, run } = setup();
    const hex = 'ABCDEF0123456789ABCDEF01';
    await run([revokeChange(PrincipalType.USER, hex)], true);
    expect(recordAuditEntry.mock.calls[0][0].metadata).toEqual(
      expect.objectContaining({ principalId: hex.toLowerCase(), previousRoleId: 'r1', roleId: '' }),
    );
  });

  test('a reduced permission set is a narrowing change, an added bit is a widening one', async () => {
    const record = jest.fn().mockRejectedValue(new Error('down'));
    const { write, run } = setup(record);
    const lowered = { ...grantChange('u1', 1), previous: { permBits: 3, roleId: 'r2' } };
    await expect(run([lowered], true)).resolves.toBe('written');
    expect(write).toHaveBeenCalledTimes(1);

    const raised = { ...grantChange('u1', 3), previous: { permBits: 1, roleId: 'r2' } };
    const blocked = setup(record);
    await expect(blocked.run([raised], true)).rejects.toMatchObject({ statusCode: 500 });
    expect(blocked.write).not.toHaveBeenCalled();
  });

  test('a failed ACL write appends failure entries for the recorded changes and rethrows', async () => {
    const { recordAuditEntry } = setup();
    const writeError = new Error('acl write down');

    await expect(
      runAuditedPermissionUpdate({
        req,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: 'res-1',
        failClosed: true,
        deps: { recordAuditEntry, logger: { error: jest.fn() } },
        update: async (beforeWrite) => {
          await beforeWrite({
            aclChanges: [grantChange('u1'), revokeChange(PrincipalType.GROUP, 'g1')],
            insightsChanges: [],
          });
          throw writeError;
        },
      }),
    ).rejects.toBe(writeError);

    expect(recordAuditEntry.mock.calls.map(([input]) => [input.action, input.outcome])).toEqual([
      ['acl.granted', 'success'],
      ['acl.revoked', 'success'],
      ['acl.granted', 'failure'],
      ['acl.revoked', 'failure'],
    ]);
  });

  test('a failure entry that cannot be persisted does not mask the write error', async () => {
    const record = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('audit down'));
    const logger = { error: jest.fn() };
    const writeError = new Error('acl write down');

    await expect(
      runAuditedPermissionUpdate({
        req,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: 'res-1',
        failClosed: true,
        deps: { recordAuditEntry: record, logger },
        update: async (beforeWrite) => {
          await beforeWrite({ aclChanges: [grantChange('u1')], insightsChanges: [] });
          throw writeError;
        },
      }),
    ).rejects.toBe(writeError);
    expect(logger.error).toHaveBeenCalled();
  });

  test('audits ACL and Insights changes together, ACL entries first', async () => {
    const { recordAuditEntry, write, run } = setup();
    const getAgent = jest.fn().mockResolvedValue({ id: 'agent-logical', name: 'Agent' });

    await run([grantChange('u1')], true, {
      resourceType: ResourceType.AGENT,
      insightsChanges: [grantChange('u1')],
      getAgent,
    });

    expect(recordAuditEntry.mock.calls.map(([input]) => input.action)).toEqual([
      'acl.granted',
      'permission.insights_assigned',
    ]);
    /** Both event families name the agent by the same id. */
    expect(recordAuditEntry.mock.calls.map(([input]) => input.target.id)).toEqual([
      'agent-logical',
      'agent-logical',
    ]);
    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test.each([true, false])(
    'still audits Insights with the resource id when the agent lookup fails (failClosed=%p)',
    async (failClosed) => {
      const { recordAuditEntry, logger, run } = setup();

      await run([], failClosed, {
        resourceType: ResourceType.AGENT,
        insightsChanges: [grantChange('u1')],
        getAgent: jest.fn().mockRejectedValue(new Error('lookup down')),
      });

      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'permission.insights_assigned',
          target: { type: ResourceType.AGENT, id: 'res-1', name: 'res-1' },
        }),
        { failClosed },
      );
      expect(logger.error).toHaveBeenCalled();
    },
  );
});
