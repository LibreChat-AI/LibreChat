import { emptyCheckpoint, INTERRUPT } from '@langchain/langgraph-checkpoint';
import type { CheckpointRepository } from '@librechat/data-schemas';
import {
  LazyMongoSaver,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
} from '../checkpointer';

function storage(): CheckpointRepository {
  return {
    setup: jest.fn(async () => []),
    setupOwnershipIndexes: jest.fn(async () => {}),
    get: jest.fn(async () => null),
    list: jest.fn(async function* () {}),
    readWrites: jest.fn(async () => []),
    save: jest.fn(async () => {}),
    saveWrites: jest.fn(async () => {}),
    measureMetadata: jest.fn(() => 0),
    deleteThread: jest.fn(async () => {}),
    captureGeneration: jest.fn(async () => []),
    deleteGeneration: jest.fn(async () => {}),
    deleteReference: jest.fn(async () => {}),
    deleteReferences: jest.fn(async () => {}),
    deleteOwnedScope: jest.fn(async () => {}),
    deleteOwned: jest.fn(async () => {}),
  };
}
const metadata = { source: 'input' as const, step: -1, writes: null, parents: {} };

test('ordinary clean chat never reaches the repository or serializes metadata', async () => {
  const repository = storage();
  const saver = new LazyMongoSaver({ repository, conversationId: 'root' });
  await saver.put({ configurable: { thread_id: 'root' } }, emptyCheckpoint(), metadata);
  expect(repository.save).not.toHaveBeenCalled();
  expect(repository.saveWrites).not.toHaveBeenCalled();
  expect(repository.measureMetadata).not.toHaveBeenCalled();
});

test.each([true, false])(
  'child persistence is injected byte storage with writes-first=%s',
  async (writesFirst) => {
    const repository = storage();
    const saver = new LazyMongoSaver({ repository, conversationId: 'trusted-root' });
    const checkpoint = emptyCheckpoint();
    const config = {
      configurable: {
        thread_id: 'subagent:not-the-root',
        checkpoint_ns: '',
        checkpoint_id: checkpoint.id,
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'generation',
        [LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY]: 'owner',
        [LIBRECHAT_CHECKPOINT_OWNER_KEY]: 'owner',
      },
    };
    const put = () => saver.put(config, checkpoint, metadata);
    const writes = () => saver.putWrites(config, [[INTERRUPT, { id: 'pause' }]], 'task');
    if (writesFirst) {
      await writes();
      await put();
    } else {
      await put();
      await writes();
    }
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'subagent:not-the-root',
        checkpointNs: 'generation',
        owner: 'owner',
      }),
      expect.objectContaining({
        checkpoint: { type: expect.any(String), bytes: expect.any(Uint8Array) },
        metadata: { type: expect.any(String), bytes: expect.any(Uint8Array) },
      }),
      { rootConversationId: 'trusted-root', storageOwner: 'owner' },
    );
    expect(repository.saveWrites).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: checkpoint.id, checkpointNs: 'generation' }),
      [
        expect.objectContaining({
          taskId: 'task',
          channel: INTERRUPT,
          value: { type: expect.any(String), bytes: expect.any(Uint8Array) },
        }),
      ],
      { replace: true, rootConversationId: 'trusted-root', storageOwner: 'owner' },
    );
  },
);

test('failed interrupt persistence unanchors an ordinary checkpoint through the injected boundary', async () => {
  const repository = storage();
  const saver = new LazyMongoSaver({ repository });
  const checkpoint = emptyCheckpoint();
  const config = { configurable: { thread_id: 'root', checkpoint_id: checkpoint.id } };
  jest.mocked(repository.saveWrites).mockRejectedValueOnce(new Error('unavailable'));
  await expect(saver.putWrites(config, [[INTERRUPT, 'pause']], 'task')).rejects.toThrow(
    'unavailable',
  );
  await saver.put(config, checkpoint, metadata);
  expect(repository.save).not.toHaveBeenCalled();
});
