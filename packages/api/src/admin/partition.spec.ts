import { getTenantId, tenantStorage, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import { runInPartition } from './partition';

/** The tenant context a read runs in. */
const readContext = jest.fn(async () => getTenantId());

const inContext = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, run);

beforeEach(() => {
  readContext.mockClear();
});

describe('runInPartition', () => {
  it("runs in the request's own context when that is the partition", async () => {
    expect(await runInPartition(undefined, readContext)).toBeUndefined();
    expect(await inContext('tenant-a', () => runInPartition('tenant-a', readContext))).toBe(
      'tenant-a',
    );
    expect(await inContext(SYSTEM_TENANT_ID, () => runInPartition(undefined, readContext))).toBe(
      SYSTEM_TENANT_ID,
    );
  });

  it('moves a read from outside a tenant into the tenant partition it names', async () => {
    expect(await runInPartition('tenant-a', readContext)).toBe('tenant-a');
    expect(await inContext(SYSTEM_TENANT_ID, () => runInPartition('tenant-a', readContext))).toBe(
      'tenant-a',
    );
  });

  it('refuses to leave an active tenant, for the platform or another tenant, without reading', async () => {
    await expect(
      inContext('tenant-a', () => runInPartition(undefined, readContext)),
    ).rejects.toThrow('cannot leave the active tenant partition');
    await expect(
      inContext('tenant-a', () => runInPartition('tenant-b', readContext)),
    ).rejects.toThrow('cannot leave the active tenant partition');
    expect(readContext).not.toHaveBeenCalled();
  });
});
