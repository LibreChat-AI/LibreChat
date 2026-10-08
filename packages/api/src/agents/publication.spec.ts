import type { IAgentEventActorContextMeta } from '@librechat/data-schemas';
import { createContextMetaPublisher, selectRunContextMetaToPublish } from './publication';

const tier = (budgetTokens: number): IAgentEventActorContextMeta => ({
  calibrationRatio: 1.2,
  encoding: 'claude',
  fading: { v: 1, budgetTokens, masked: true },
});

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const noDelay = async (): Promise<void> => undefined;

describe('createContextMetaPublisher', () => {
  it('shares one write between equal callers and skips a repeat of the latest record', async () => {
    const write = jest.fn(async () => undefined);
    const publisher = createContextMetaPublisher({ write, delay: noDelay });

    const first = publisher.publish(tier(50_000));
    const second = publisher.publish(tier(50_000));
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await publisher.publish(tier(50_000));

    expect(write).toHaveBeenCalledTimes(1);
    expect(publisher.hasPublished).toBe(true);
  });

  it('issues distinct records in order so the newest settles last', async () => {
    const gate = deferred();
    const writes: number[] = [];
    const write = jest.fn(async (contextMeta: IAgentEventActorContextMeta) => {
      writes.push(contextMeta.fading?.budgetTokens ?? 0);
      if (writes.length === 1) {
        await gate.promise;
      }
    });
    const publisher = createContextMetaPublisher({ write, delay: noDelay });

    const older = publisher.publish(tier(50_000));
    const newer = publisher.publish(tier(25_000));
    await Promise.resolve();
    expect(writes).toEqual([50_000]);

    gate.resolve();
    await Promise.all([older, newer]);
    expect(writes).toEqual([50_000, 25_000]);
  });

  it('retries a failed write before reporting it', async () => {
    const write = jest
      .fn<Promise<void>, [IAgentEventActorContextMeta]>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);
    const onFailure = jest.fn();
    const delays: number[] = [];
    const publisher = createContextMetaPublisher({
      write,
      onFailure,
      retryDelayMs: 10,
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    await publisher.publish(tier(50_000));

    expect(write).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([10]);
    expect(onFailure).not.toHaveBeenCalled();
    expect(publisher.hasPublished).toBe(true);
  });

  it('reports an exhausted publication once, never rejects, and writes again next time', async () => {
    const write = jest
      .fn<Promise<void>, [IAgentEventActorContextMeta]>()
      .mockRejectedValue(new Error('down'));
    const onFailure = jest.fn();
    const publisher = createContextMetaPublisher({
      write,
      onFailure,
      attempts: 2,
      delay: noDelay,
    });

    await expect(publisher.publish(tier(50_000))).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(publisher.hasPublished).toBe(false);

    write.mockResolvedValue(undefined);
    await publisher.publish(tier(50_000));
    expect(write).toHaveBeenCalledTimes(3);
    expect(publisher.hasPublished).toBe(true);
  });

  it('still counts an earlier committed record after a later publication is exhausted', async () => {
    const write = jest
      .fn<Promise<void>, [IAgentEventActorContextMeta]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('down'));
    const onFailure = jest.fn();
    const publisher = createContextMetaPublisher({
      write,
      onFailure,
      attempts: 2,
      delay: noDelay,
    });
    const neutral = { calibrationRatio: 1, encoding: 'claude' };

    await publisher.publish(tier(50_000));
    await publisher.publish(tier(25_000));
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(publisher.hasPublished).toBe(true);
    expect(
      selectRunContextMetaToPublish({
        live: true,
        captured: undefined,
        inherited: undefined,
        hasPublished: publisher.hasPublished,
        getEncoding: () => 'claude',
      }),
    ).toEqual(neutral);

    write.mockResolvedValue(undefined);
    await publisher.publish(neutral);
    expect(write).toHaveBeenLastCalledWith(neutral);
  });

  it('keeps a newer publication when an older one fails after it was superseded', async () => {
    const olderGate = deferred();
    const write = jest.fn(async (contextMeta: IAgentEventActorContextMeta) => {
      if (contextMeta.fading?.budgetTokens === 50_000) {
        await olderGate.promise;
      }
    });
    const publisher = createContextMetaPublisher({ write, attempts: 1, delay: noDelay });

    const older = publisher.publish(tier(50_000));
    const newer = publisher.publish(tier(25_000));
    olderGate.reject(new Error('lost'));
    await Promise.all([older, newer]);

    expect(publisher.hasPublished).toBe(true);
    expect(write).toHaveBeenLastCalledWith(tier(25_000));
  });
});

describe('selectRunContextMetaToPublish', () => {
  const getEncoding = () => 'claude';
  const inherited = tier(30_000);
  const captured = tier(20_000);

  it('prefers the captured state and falls back to the inherited seed before the run', () => {
    expect(
      selectRunContextMetaToPublish({
        live: false,
        captured,
        inherited,
        hasPublished: false,
        getEncoding,
      }),
    ).toBe(captured);
    expect(
      selectRunContextMetaToPublish({
        live: false,
        captured: undefined,
        inherited,
        hasPublished: false,
        getEncoding,
      }),
    ).toBe(inherited);
  });

  it('publishes a neutral record only for a live snapshot after an earlier publication', () => {
    const neutral = { live: true, captured: undefined, inherited, getEncoding };
    expect(selectRunContextMetaToPublish({ ...neutral, hasPublished: false })).toBeUndefined();
    expect(selectRunContextMetaToPublish({ ...neutral, hasPublished: true })).toEqual({
      calibrationRatio: 1,
      encoding: 'claude',
    });
    expect(
      selectRunContextMetaToPublish({
        live: false,
        captured: undefined,
        inherited: undefined,
        hasPublished: true,
        getEncoding,
      }),
    ).toBeUndefined();
  });
});
