jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { logger } from '@librechat/data-schemas';
import { discardUnresolvedFile } from '../discard';

describe('discardUnresolvedFile', () => {
  beforeEach(() => jest.clearAllMocks());

  it('removes the stored object through the strategy delete', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);

    await discardUnresolvedFile({
      remove,
      userId: 'user-1',
      fileName: 'a.png',
      basePath: 'images',
    });

    expect(remove).toHaveBeenCalledWith({
      userId: 'user-1',
      fileName: 'a.png',
      basePath: 'images',
    });
  });

  it('is a no-op for strategies without a path-based delete', async () => {
    await expect(
      discardUnresolvedFile({ userId: 'user-1', fileName: 'a.png' }),
    ).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('never throws and logs no raw error text when the delete fails', async () => {
    const remove = jest.fn().mockRejectedValue(new Error('secret bucket detail'));

    await expect(
      discardUnresolvedFile({ remove, userId: 'user-1', fileName: 'a.png' }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(
      'secret bucket detail',
    );
  });
});
