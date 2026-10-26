import type winston from 'winston';

/** Check the real logger configuration: transport-only formatter tests miss
 * Winston's implicit JSON serialization before any transport receives a record. */
describe('logger serialization boundary', () => {
  let logger: winston.Logger;
  const originalLogToFile = process.env.LOG_TO_FILE;

  beforeAll(() => {
    process.env.LOG_TO_FILE = 'false';
    jest.isolateModules(() => {
      logger = jest.requireActual<typeof import('./winston')>('./winston').default;
    });
  });

  afterAll(() => {
    logger.close();
    if (originalLogToFile === undefined) {
      delete process.env.LOG_TO_FILE;
    } else {
      process.env.LOG_TO_FILE = originalLogToFile;
    }
  });

  it('does not serialize a raw HTTP agent graph before transport sanitization', () => {
    const serializeAgent = jest.fn(() => ({ sockets: 'raw socket graph' }));
    const error = Object.assign(new Error('Request failed with status code 403'), {
      isAxiosError: true,
      config: {
        method: 'delete',
        url: 'https://example.test/files/1',
        httpAgent: { toJSON: serializeAgent },
      },
    });
    // Winston merges enumerable error metadata into the top-level info before
    // running the logger-level format, including config and request objects.
    const info: winston.Logform.TransformableInfo = {
      ...error,
      level: 'error',
      message: 'Error deleting file',
      [Symbol.for('level')]: 'error',
      [Symbol.for('splat')]: [error],
    };

    const result = logger.format.transform(info, logger.format.options);

    expect(serializeAgent).not.toHaveBeenCalled();
    expect(Object.getOwnPropertySymbols(result || {})).not.toContain(Symbol.for('message'));
  });
});
