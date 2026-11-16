import mongoose from 'mongoose';
import { createMongooseTenantHarness } from './harness';

describe('tenant harness cleanup', () => {
  it('releases the engine after startup fails before connecting', async () => {
    const startupError = new Error('MongoDB startup failed');
    const release = jest.fn().mockResolvedValue(undefined);
    const harness = createMongooseTenantHarness({
      name: 'failed startup',
      connect: jest.fn().mockRejectedValue(startupError),
      release,
    });

    expect(mongoose.connection.db).toBeUndefined();
    await expect(harness.setup()).rejects.toBe(startupError);
    await expect(harness.teardown()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
