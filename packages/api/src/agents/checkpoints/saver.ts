import { createMongoCheckpointRepository } from '@librechat/data-schemas';
import { BaseCheckpointSaver, WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  CheckpointListOptions,
  CheckpointPendingWrite,
  PendingWrite,
  SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import type {
  CheckpointRepository,
  CheckpointIdentity,
  SerializedCheckpoint,
  MongoCheckpointRepositoryOptions,
} from '@librechat/data-schemas';
import type { MongoDBSaverParams } from '@langchain/langgraph-checkpoint-mongodb';
import type { RunnableConfig } from '@langchain/core/runnables';
import { LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY } from './storage';

export const LIBRECHAT_CHECKPOINT_OWNER_KEY = '__librechat_checkpoint_owner';
export const LIBRECHAT_LEGACY_CHECKPOINT_KEY = '__librechat_legacy_checkpoint_id';

export type OwnedCheckpointSaverOptions = (
  | MongoDBSaverParams
  | { repository: CheckpointRepository; client?: never }
) & {
  conversationId?: string;
  serde?: SerializerProtocol;
};

function ownerOf(config: RunnableConfig): string | undefined {
  const owner = config.configurable?.[LIBRECHAT_CHECKPOINT_OWNER_KEY];
  return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
}
function identity(config: RunnableConfig): CheckpointIdentity {
  const threadId = config.configurable?.thread_id;
  const checkpointNs = config.configurable?.checkpoint_ns ?? '';
  const checkpointId = config.configurable?.checkpoint_id;
  if (
    typeof threadId !== 'string' ||
    typeof checkpointNs !== 'string' ||
    (checkpointId != null && typeof checkpointId !== 'string')
  )
    throw new Error('Invalid owned checkpoint identity');
  return {
    threadId,
    checkpointNs,
    checkpointId,
    owner: ownerOf(config),
    legacyCheckpointId: config.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY],
  };
}

/** LangGraph serialization and logical identity mapping, independent of the storage engine. */
export class OwnedMongoSaver extends BaseCheckpointSaver {
  readonly repository: CheckpointRepository;
  private readonly conversationId?: string;
  constructor(options: OwnedCheckpointSaverOptions) {
    super(options.serde);
    this.conversationId = options.conversationId;
    this.repository =
      'repository' in options
        ? options.repository
        : createMongoCheckpointRepository({
            ...options,
            client: options.client as unknown as MongoCheckpointRepositoryOptions['client'],
          });
  }

  setup(): Promise<Error[]> {
    return this.repository.setup();
  }

  override deleteThread(threadId: string): Promise<void> {
    return this.repository.deleteThread(threadId);
  }

  private context(config: RunnableConfig): { rootConversationId?: string; storageOwner?: string } {
    const storageOwner = config.configurable?.[LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY];
    return {
      rootConversationId: this.conversationId,
      storageOwner: typeof storageOwner === 'string' ? storageOwner : undefined,
    };
  }

  private async tuple(
    doc: SerializedCheckpoint,
    requested: CheckpointIdentity,
  ): Promise<CheckpointTuple> {
    const owner = requested.owner;
    const legacy =
      owner != null &&
      requested.checkpointId != null &&
      requested.checkpointId === requested.legacyCheckpointId;
    const key = {
      thread_id: doc.identity.threadId,
      checkpoint_ns: doc.identity.checkpointNs,
      checkpoint_id: doc.identity.checkpointId,
    };
    const rows = await this.repository.readWrites({ ...requested, ...doc.identity });
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      rows.map(
        async (row) =>
          [
            row.taskId,
            row.channel,
            await this.serde.loadsTyped(row.value.type, row.value.bytes),
          ] as CheckpointPendingWrite,
      ),
    );
    return {
      config: {
        configurable: {
          ...key,
          ...(owner == null ? {} : { [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner }),
          ...(legacy ? { [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: doc.identity.checkpointId } : {}),
        },
      },
      checkpoint: (await this.serde.loadsTyped(
        doc.checkpoint.type,
        doc.checkpoint.bytes,
      )) as Checkpoint,
      metadata: (await this.serde.loadsTyped(
        doc.metadata.type,
        doc.metadata.bytes,
      )) as CheckpointMetadata,
      pendingWrites,
      ...(doc.parentCheckpointId == null
        ? {}
        : {
            parentConfig: {
              configurable: {
                ...key,
                checkpoint_id: doc.parentCheckpointId,
                ...(owner == null
                  ? {}
                  : {
                      [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
                      [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: doc.parentCheckpointId,
                    }),
              },
            },
          }),
    };
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    if (config.configurable?.thread_id === undefined) return undefined;
    const key = identity(config);
    const doc = await this.repository.get(key);
    return doc == null ? undefined : this.tuple(doc, key);
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const owner = ownerOf(config);
    const key = owner == null ? undefined : identity(config);
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns;
    const before = options?.before?.configurable?.checkpoint_id;
    if (
      (threadId != null && typeof threadId !== 'string') ||
      (checkpointNs != null && typeof checkpointNs !== 'string') ||
      (before != null && typeof before !== 'string')
    )
      throw new Error('Invalid checkpoint list boundary');
    for await (const doc of this.repository.list({
      threadId,
      checkpointNs: key?.checkpointNs ?? checkpointNs,
      owner,
      before,
      limit: options?.limit,
      metadata: options?.filter,
    })) {
      yield await this.tuple(doc, {
        ...(key ?? doc.identity),
        checkpointId: undefined,
        legacyCheckpointId: undefined,
      });
    }
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const key = identity(config);
    const [[type, bytes], [metadataType, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(checkpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    if (type !== metadataType) throw new Error('Mismatched checkpoint and metadata types');
    const stored = {
      threadId: key.threadId,
      checkpointNs: key.checkpointNs,
      checkpointId: checkpoint.id,
    };
    await this.repository.save(
      key,
      {
        identity: stored,
        parentCheckpointId: key.checkpointId,
        checkpoint: { type, bytes },
        metadata: { type: metadataType, bytes: metadataBytes },
        metadataSearch: metadata,
      },
      this.context(config),
    );
    return {
      configurable: {
        thread_id: stored.threadId,
        checkpoint_ns: stored.checkpointNs,
        checkpoint_id: stored.checkpointId,
        ...(key.owner == null ? {} : { [LIBRECHAT_CHECKPOINT_OWNER_KEY]: key.owner }),
      },
    };
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const key = identity(config);
    if (key.checkpointId == null) throw new Error('Owned writes require a checkpoint id');
    const serialized = await Promise.all(
      writes.map(async ([channel, value], index) => {
        const [type, bytes] = await this.serde.dumpsTyped(value);
        return { taskId, index: WRITES_IDX_MAP[channel] ?? index, channel, value: { type, bytes } };
      }),
    );
    await this.repository.saveWrites({ ...key, checkpointId: key.checkpointId }, serialized, {
      ...this.context(config),
      replace: writes.every(([channel]) => channel in WRITES_IDX_MAP),
    });
  }
}
