import { getSafeErrorMetadata, getSafeErrorText, isAbortError, isOwnedAbortError } from './errors';

describe('getSafeErrorMetadata', () => {
  it('keeps bounded diagnostic fields without serializing raw provider data', () => {
    const rawValue = 'PRIVATE-SUBMITTED-CONTENT';
    const error = Object.assign(new Error(`Provider echoed ${rawValue}`), {
      code: 'ERR_REMOTE',
      response: {
        status: 422,
        headers: { authorization: rawValue },
        data: { prompt: rawValue },
      },
    });

    const metadata = getSafeErrorMetadata(error);

    expect(metadata).toEqual({
      type: 'Error',
      status: 422,
    });
    expect(JSON.stringify(metadata)).not.toContain(rawValue);
  });

  it('drops attacker-controlled names and codes', () => {
    const rawValue = 'private value with spaces';
    const error = {
      name: rawValue,
      code: rawValue,
      status: '400',
      message: rawValue,
    };

    expect(getSafeErrorMetadata(error)).toEqual({ type: 'UnknownError' });
  });

  it('does not trust syntactically valid error identifiers or numeric codes', () => {
    const rawValue = 'Account123456789';

    expect(
      getSafeErrorMetadata({
        name: rawValue,
        code: rawValue,
        message: rawValue,
      }),
    ).toEqual({ type: 'UnknownError' });
    expect(
      getSafeErrorMetadata({
        code: 123456789,
        message: rawValue,
      }),
    ).toEqual({ type: 'UnknownError' });
  });
});

describe('getSafeErrorText', () => {
  const signedUrl =
    'https://minio.example.com/bucket/images/user123/photo.png?X-Amz-Credential=AKIA123&X-Amz-Signature=deadbeef';

  it('keeps the origin of a signed storage URL and drops its path and signature', () => {
    const text = getSafeErrorText(new Error(`Access denied for ${signedUrl}`));

    expect(text).toContain('https://minio.example.com/[redacted]');
    expect(text).not.toContain('X-Amz-Signature');
    expect(text).not.toContain('deadbeef');
    expect(text).not.toContain('bucket/images/user123');
  });

  it('preserves the description and stack an operator needs to place the failure', () => {
    const text = getSafeErrorText(new Error('No agent found for the requested endpoint'));

    expect(text).toContain('Error: No agent found for the requested endpoint');
    expect(text).toContain('errors.spec.ts');
  });

  it('redacts every URL an SDK error folds into its stack', () => {
    const error = new Error(`upload failed: ${signedUrl}`);
    error.stack = `Error: upload failed: ${signedUrl}\n    at send (/app/api/s3.js:1:1)`;

    const text = getSafeErrorText(error);

    expect(text).not.toContain('deadbeef');
    expect(text).toContain('at send (/app/api/s3.js:1:1)');
  });

  it('keeps file:// stack frames readable', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at run (file:///app/api/server.js:10:5)';

    expect(getSafeErrorText(error)).toContain('file:///app/api/server.js:10:5');
  });

  it('redacts bearer credentials echoed into a message', () => {
    const error = new Error('request rejected: Bearer sk-live-abcdef123456');

    const text = getSafeErrorText(error);

    expect(text).toContain('Bearer [redacted]');
    expect(text).not.toContain('sk-live-abcdef123456');
  });

  it('describes an error-like object that carries no stack', () => {
    expect(getSafeErrorText({ name: 'RestError', message: `blob read failed ${signedUrl}` })).toBe(
      'RestError: blob read failed https://minio.example.com/[redacted]',
    );
  });

  it('survives a value whose accessors throw', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('accessor exploded');
        },
      },
    );

    expect(getSafeErrorText(hostile)).toBe('UnknownError');
  });

  it('tolerates non-object values', () => {
    expect(getSafeErrorText(undefined)).toBe('UnknownError');
    expect(getSafeErrorText(42)).toBe('UnknownError');
    expect(getSafeErrorText(`failed at ${signedUrl}`)).toBe(
      'failed at https://minio.example.com/[redacted]',
    );
  });

  it('bounds the text a very long error can write into the log', () => {
    expect(getSafeErrorText(new Error('x'.repeat(9000))).length).toBeLessThanOrEqual(2000);
  });
});

describe('isAbortError', () => {
  it('recognizes the DOMException a bare abort() produces', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbortError(controller.signal.reason)).toBe(true);
  });

  it('recognizes an abort rewrapped by an intermediate layer', () => {
    const controller = new AbortController();
    controller.abort();
    const wrapped = new Error('[MCP][server][tool] tool call failed', {
      cause: controller.signal.reason,
    });
    expect(isAbortError(wrapped)).toBe(true);
  });

  it('recognizes an Axios cancellation through an upload wrapper cause', () => {
    const axiosCancellation = Object.assign(new Error('canceled'), {
      name: 'CanceledError',
      code: 'ERR_CANCELED',
    });
    const wrapped = new Error('Error uploading code environment file', {
      cause: axiosCancellation,
    });

    expect(isAbortError(wrapped)).toBe(true);
  });

  it('recognizes the SDK message shape that only stringifies the reason', () => {
    expect(
      isAbortError(new Error('MCP error -32001: AbortError: This operation was aborted')),
    ).toBe(true);
  });

  it('does not treat an unrelated failure as a cancellation', () => {
    expect(isAbortError(new Error('upstream 503 from the tool backend'))).toBe(false);
    expect(isAbortError(Object.assign(new Error('forbidden'), { code: 'EPERM' }))).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const first = new Error('first') as Error & { cause?: unknown };
    const second = new Error('second') as Error & { cause?: unknown };
    first.cause = second;
    second.cause = first;
    expect(isAbortError(first)).toBe(false);
  });

  it('tolerates non-error values', () => {
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('aborted')).toBe(false);
  });
});

describe('isOwnedAbortError', () => {
  it.each([new Error('stopped'), 'stopped'])(
    'recognizes the owning signal reason (%s)',
    (reason) => {
      const controller = new AbortController();
      controller.abort(reason);

      expect(isOwnedAbortError(reason, controller.signal)).toBe(true);
    },
  );

  it('does not hide an unrelated failure that races cancellation', () => {
    const controller = new AbortController();
    controller.abort(new Error('stopped'));

    expect(isOwnedAbortError(new Error('upstream failed'), controller.signal)).toBe(false);
  });
});
