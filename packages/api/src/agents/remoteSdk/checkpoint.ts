import { BaseCheckpointSaver } from '@librechat/agents';
import type { SdkRpc } from './peer';

type Saver = BaseCheckpointSaver;
function checkpointConfig(
  config: Parameters<Saver['getTuple']>[0],
): Parameters<Saver['getTuple']>[0] {
  return {
    configurable: Object.fromEntries(
      Object.entries(config.configurable ?? {}).filter(
        ([key, value]) =>
          (['thread_id', 'checkpoint_ns', 'checkpoint_id'].includes(key) ||
            key.startsWith('__librechat_')) &&
          (typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean' ||
            value == null),
      ),
    ),
  };
}
/** The host retains its durable saver; the worker never receives database credentials. */
export class RemoteSdkCheckpointer extends BaseCheckpointSaver {
  constructor(private readonly call: SdkRpc) {
    super();
  }

  async getTuple(...args: Parameters<Saver['getTuple']>): ReturnType<Saver['getTuple']> {
    return (await this.call('checkpoint.getTuple', [checkpointConfig(args[0])])) as Awaited<
      ReturnType<Saver['getTuple']>
    >;
  }

  async *list(...args: Parameters<Saver['list']>): ReturnType<Saver['list']> {
    const tuples = (await this.call('checkpoint.list', [
      checkpointConfig(args[0]),
      args[1] && {
        ...args[1],
        before: args[1].before ? checkpointConfig(args[1].before) : undefined,
      },
    ])) as Awaited<ReturnType<Saver['getTuple']>>[];
    for (const tuple of tuples) if (tuple != null) yield tuple;
  }

  async put(...args: Parameters<Saver['put']>): ReturnType<Saver['put']> {
    return (await this.call('checkpoint.put', [
      checkpointConfig(args[0]),
      ...args.slice(1),
    ])) as Awaited<ReturnType<Saver['put']>>;
  }

  async putWrites(...args: Parameters<Saver['putWrites']>): ReturnType<Saver['putWrites']> {
    await this.call('checkpoint.putWrites', [checkpointConfig(args[0]), ...args.slice(1)]);
  }

  async deleteThread(): Promise<void> {
    throw new Error('Runtime checkpoint deletion is not permitted');
  }
}
