import type { Connection } from 'mongoose';
import { migrateLegacyAgentOfficialStatus } from './agentOfficialStatus';

describe('migrateLegacyAgentOfficialStatus', () => {
  it('copies existing official agents without removing the legacy field', async () => {
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 2 });
    const connection = {
      db: { collection: jest.fn().mockReturnValue({ updateMany }) },
    } as unknown as Connection;

    await expect(migrateLegacyAgentOfficialStatus(connection)).resolves.toBe(2);
    expect(connection.db!.collection).toHaveBeenCalledWith('agents');
    expect(updateMany).toHaveBeenCalledWith(
      { is_certified: true, is_official: { $ne: true } },
      { $set: { is_official: true } },
    );
  });
});
