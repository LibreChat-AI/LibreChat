import { waitForGenerationPersistence } from './persistence';

test('waits for the captured terminal epoch to finish persistence', async () => {
  const read = jest
    .fn()
    .mockResolvedValueOnce({ createdAt: 1, metadata: { terminalPersistencePending: true } })
    .mockResolvedValueOnce({ createdAt: 1, metadata: { terminalPersistencePending: false } });
  await waitForGenerationPersistence('run', 1, read, { pollMs: 1 });
  expect(read).toHaveBeenCalledTimes(2);
});

test('fails closed on a replacement epoch', async () => {
  const read = jest
    .fn()
    .mockResolvedValue({ createdAt: 2, metadata: { terminalPersistencePending: true } });
  await expect(waitForGenerationPersistence('run', 1, read)).rejects.toThrow('Generation replaced');
  expect(read).toHaveBeenCalledTimes(1);
});

test.each(['terminalPersistencePending', 'terminalHostActionPending'])(
  'fails closed on %s and lookup errors',
  async (marker) => {
    const read = jest.fn().mockResolvedValue({ createdAt: 1, metadata: { [marker]: true } });
    await expect(waitForGenerationPersistence('run', 1, read, { timeoutMs: 0 })).rejects.toThrow(
      'Timed out',
    );
    read.mockRejectedValue(new Error('unavailable'));
    await expect(waitForGenerationPersistence('run', 1, read)).rejects.toThrow('unavailable');
  },
);

test('waits for terminal host actions after provider persistence has cleared', async () => {
  const read = jest
    .fn()
    .mockResolvedValueOnce({
      createdAt: 1,
      metadata: { terminalHostActionPending: true, terminalPersistencePending: false },
    })
    .mockResolvedValueOnce({ createdAt: 1, metadata: { terminalHostActionPending: false } });
  await waitForGenerationPersistence('run', 1, read, { pollMs: 1 });
  expect(read).toHaveBeenCalledTimes(2);
});
