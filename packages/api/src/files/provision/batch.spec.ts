import type { FileStorageUploadObserver } from '../operations';
import { createUploadBatch } from './batch';

type Joined = Array<{ entry: string; onUploadStart: FileStorageUploadObserver }>;

const fulfilled = (joined: Joined): Array<PromiseSettledResult<string>> =>
  joined.map(({ entry }) => ({ status: 'fulfilled', value: `stored ${entry}` }));

describe('createUploadBatch', () => {
  it('sends one request once every member has joined, in entry order', async () => {
    const dispatch = jest.fn(async (joined: Joined) => fulfilled(joined));
    const [a, b, c] = createUploadBatch(['a', 'b', 'c'], dispatch);

    const third = c.upload(jest.fn());
    const first = a.upload(jest.fn());
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    const second = b.upload(jest.fn());

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      'stored a',
      'stored b',
      'stored c',
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].map(({ entry }) => entry)).toEqual(['a', 'b', 'c']);
  });

  it('does not wait for a member that finished without uploading', async () => {
    const dispatch = jest.fn(async (joined: Joined) => fulfilled(joined));
    const [a, b] = createUploadBatch(['a', 'b'], dispatch);

    const first = a.upload(jest.fn());
    b.release();

    await expect(first).resolves.toBe('stored a');
    expect(dispatch.mock.calls[0][0].map(({ entry }) => entry)).toEqual(['a']);
  });

  it('sends nothing when no member uploads', async () => {
    const dispatch = jest.fn(async (joined: Joined) => fulfilled(joined));
    const members = createUploadBatch(['a', 'b'], dispatch);
    for (const member of members) member.release();
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('ignores a release after the member joined', async () => {
    const dispatch = jest.fn(async (joined: Joined) => fulfilled(joined));
    const [a, b] = createUploadBatch(['a', 'b'], dispatch);
    const first = a.upload(jest.fn());
    a.release();
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    const second = b.upload(jest.fn());
    await expect(Promise.all([first, second])).resolves.toEqual(['stored a', 'stored b']);
  });

  it('settles each member with its own outcome and hands over its observer', async () => {
    const refused = new Error('refused');
    const observers = [jest.fn(), jest.fn()];
    const [a, b] = createUploadBatch(['a', 'b'], async (joined) => {
      for (const { onUploadStart } of joined) onUploadStart();
      return [
        { status: 'fulfilled', value: 'stored a' },
        { status: 'rejected', reason: refused },
      ];
    });

    const first = a.upload(observers[0]);
    const second = b.upload(observers[1]);

    await expect(first).resolves.toBe('stored a');
    await expect(second).rejects.toBe(refused);
    expect(observers[0]).toHaveBeenCalledTimes(1);
    expect(observers[1]).toHaveBeenCalledTimes(1);
  });

  it('fails every member when the request itself fails or answers short', async () => {
    const failure = new Error('rate limited');
    const failing = createUploadBatch(['a', 'b'], async () => {
      throw failure;
    });
    const uploads = failing.map((member) => member.upload(jest.fn()));
    await expect(uploads[0]).rejects.toBe(failure);
    await expect(uploads[1]).rejects.toBe(failure);

    const [short] = createUploadBatch(['a'], async () => []);
    await expect(short.upload(jest.fn())).rejects.toThrow('Upload batch returned no result');
  });

  it('refuses a second upload from the same member', async () => {
    const [a] = createUploadBatch(['a'], async (joined: Joined) => fulfilled(joined));
    await expect(a.upload(jest.fn())).resolves.toBe('stored a');
    await expect(a.upload(jest.fn())).rejects.toThrow('already settled');
  });
});
