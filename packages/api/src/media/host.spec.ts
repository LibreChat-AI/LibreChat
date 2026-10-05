import Transport from 'winston-transport';
import { FileSources } from 'librechat-data-provider';
import { logger, baseLogFormat } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { TransformableInfo } from 'logform';
import { startMediaWorker, createMediaWorkerStop } from './lifecycle';
import { resolveMediaHostConfig } from './host';
import { mediaAccountingMode } from './service';
import { MediaProviderError } from './errors';

const base: AppConfig = { config: {}, fileStrategy: FileSources.local, imageOutputType: 'png' };

test('Studio inherits legacy balance enforcement and starting credits before freezing a job', () => {
  const config = resolveMediaHostConfig(base, { CHECK_BALANCE: 'true', START_BALANCE: '250000' });
  expect(mediaAccountingMode(config)).toBe('balance');
  expect(config.balance).toEqual({ enabled: true, startBalance: 250000 });
  expect(config.transactions).toEqual({ enabled: true });
  expect(base.balance).toBeUndefined();
});

test('explicit YAML policy takes precedence over legacy balance environment settings', () => {
  const config = resolveMediaHostConfig(
    { ...base, balance: { enabled: false, startBalance: 100 }, transactions: { enabled: false } },
    { CHECK_BALANCE: 'true', START_BALANCE: '250000' },
  );
  expect(mediaAccountingMode(config)).toBe('none');
  expect(config.balance).toEqual({ enabled: false, startBalance: 100 });
  expect(config.transactions).toEqual({ enabled: false });
});

test('an unconfigured deployment keeps ordinary transaction recording without balance enforcement', () => {
  expect(mediaAccountingMode(resolveMediaHostConfig(base, {}))).toBe('transactions');
});

test('host startup failures retain a readable message and safe provider diagnostics in Winston', async () => {
  const records: TransformableInfo[] = [];
  class Capture extends Transport {
    log(info: TransformableInfo, callback: () => void) {
      records.push(info);
      callback();
    }
  }
  const capture = new Capture({ level: 'error', format: baseLogFormat });
  logger.add(capture);
  try {
    await startMediaWorker(
      {
        start: async () => {
          throw new MediaProviderError('uncertain', 503, 'upstream_unavailable');
        },
      },
      logger,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'error',
      message: expect.stringContaining('[media] Worker is PERMANENTLY unavailable'),
      status: 503,
      reason: 'upstream_unavailable',
      certainty: 'uncertain',
      cause: expect.objectContaining({
        message: 'The media provider request could not be completed.',
      }),
      stack: expect.stringContaining('The media provider request could not be completed.'),
    });
  } finally {
    logger.remove(capture);
    capture.end();
  }
});

test('worker shutdown respects the earlier cluster deadline, including an exhausted budget', async () => {
  const stop = jest.fn(async () => undefined);
  let clock = 1_000;
  const shutdown = createMediaWorkerStop(
    { stop },
    () => 10_000,
    () => 1_500,
    () => clock,
  );
  await shutdown();
  expect(stop).toHaveBeenLastCalledWith({ budgetMs: 500 });
  clock = 2_000;
  await shutdown();
  expect(stop).toHaveBeenLastCalledWith({ budgetMs: 0 });
});
