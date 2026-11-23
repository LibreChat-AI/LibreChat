jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { logger } from '@librechat/data-schemas';
import { failUnresolvedFile } from '../discard';

const missing = 'Strategy "firebase" did not return a file URL for "a.png"';

describe('failUnresolvedFile', () => {
  beforeEach(() => jest.clearAllMocks());

  it('removes the stored object, then throws the missing URL error', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);

    await expect(
      failUnresolvedFile({
        source: 'firebase',
        remove,
        userId: 'user-1',
        fileName: 'a.png',
        basePath: 'images',
      }),
    ).rejects.toThrow(missing);
    expect(remove).toHaveBeenCalledWith({
      userId: 'user-1',
      fileName: 'a.png',
      basePath: 'images',
    });
  });

  it('only throws for strategies without a path-based delete', async () => {
    await expect(
      failUnresolvedFile({ source: 'firebase', userId: 'user-1', fileName: 'a.png' }),
    ).rejects.toThrow(missing);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the missing URL error and logs no raw text when the delete fails', async () => {
    const remove = jest.fn().mockRejectedValue(new Error('secret bucket detail'));

    await expect(
      failUnresolvedFile({ source: 'firebase', remove, userId: 'user-1', fileName: 'a.png' }),
    ).rejects.toThrow(missing);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(
      'secret bucket detail',
    );
  });
});
