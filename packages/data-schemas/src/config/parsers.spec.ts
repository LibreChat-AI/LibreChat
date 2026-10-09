import winston from 'winston';
import { debugTraverse, jsonTruncateFormat, redactFormat, redactMessage } from './parsers';

const SPLAT_SYMBOL = Symbol.for('splat');
const MESSAGE_SYMBOL = Symbol.for('message');

type FormatterInfo = Record<string | symbol, unknown> & {
  level: string;
  message: string;
  timestamp: string;
};

type RedactInfo = Record<string | symbol, unknown> & {
  level: string;
  message: unknown;
};

function runRedactFormat(info: RedactInfo): RedactInfo {
  return (redactFormat().transform(info) || info) as RedactInfo;
}

function runRedactSplatFormat(info: RedactInfo): RedactInfo {
  const format = winston.format.combine(redactFormat(), winston.format.splat());
  return (format.transform(info) || info) as RedactInfo;
}

function runFormatter(info: FormatterInfo): string {
  const transformed = debugTraverse.transform(info);
  if (transformed && typeof transformed === 'object') {
    const message = (transformed as Record<string | symbol, unknown>)[MESSAGE_SYMBOL];
    return typeof message === 'string' ? message : String(transformed);
  }
  return String(transformed);
}

function buildInfo(level: string, meta: Record<string, unknown>): FormatterInfo {
  return {
    level,
    message: 'test',
    timestamp: 'ts',
    ...meta,
    [SPLAT_SYMBOL]: [meta],
  };
}

describe('redactMessage', () => {
  it('redacts sensitive token patterns anywhere in a message', () => {
    expect(redactMessage('token: sk-abc123def')).toBe('token: sk-[REDACTED]');
    expect(redactMessage('auth Bearer secretvalue')).toBe('auth Bearer [REDACTED]');
    expect(redactMessage('api-key: secretvalue')).toBe('api-key: [REDACTED]');
    expect(redactMessage('Authorization: Basic basic-credentials')).toBe(
      'Authorization: [REDACTED]',
    );
    expect(redactMessage('https://example.test/?key=secretvalue&next=true')).toBe(
      'https://example.test/?key=[REDACTED]&next=true',
    );
    expect(redactMessage('https://example.test/?api_key=secretvalue&next=true')).toBe(
      'https://example.test/?api_key=[REDACTED]&next=true',
    );
  });

  it('does not redact ordinary words containing sensitive prefixes', () => {
    expect(redactMessage('task-runner failed')).toBe('task-runner failed');
    expect(redactMessage('mask-value computed')).toBe('mask-value computed');
    expect(redactMessage('monkey=10 bananas')).toBe('monkey=10 bananas');
  });

  it('redacts OAuth and signed URL parameters', () => {
    const message =
      'https://example.test/callback?code=auth-code&code_verifier=pkce-secret&client_secret=oauth-secret&X-Amz-Signature=aws-signature&X-Amz-Security-Token=session-token&next=true';

    expect(redactMessage(message)).toBe(
      'https://example.test/callback?code=[REDACTED]&code_verifier=[REDACTED]&client_secret=[REDACTED]&X-Amz-Signature=[REDACTED]&X-Amz-Security-Token=[REDACTED]&next=true',
    );
  });

  it('redacts OAuth secrets in JSON-formatted strings', () => {
    const message =
      'oauth failed: {"refresh_token":"refresh-json-canary","client_secret": "client-json-canary","client_assertion":"assertion-json-canary","code":"code-json-canary","safe":"visible"}';

    expect(redactMessage(message)).toBe(
      'oauth failed: {"refresh_token":"[REDACTED]","client_secret": "[REDACTED]","client_assertion":"[REDACTED]","code":"[REDACTED]","safe":"visible"}',
    );
  });

  it('redacts escaped JSON OAuth secret values through the closing quote', () => {
    const secret = 'prefix"secret-tail\\suffix';
    const message = `oauth failed: ${JSON.stringify({ refresh_token: secret, safe: 'visible' })}`;
    const redacted = redactMessage(message);

    expect(redacted).toBe('oauth failed: {"refresh_token":"[REDACTED]","safe":"visible"}');
    expect(redacted).not.toContain('secret-tail');
    expect(redacted).not.toContain('suffix');
  });

  it('redacts complete JWTs, cookies, and URI userinfo', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQtdXNlciJ9.c2lnbmF0dXJlLXNlY3JldA';
    const message =
      `token=${jwt} Cookie: session=cookie-secret; refresh=refresh-secret\n` +
      'database=postgresql://service-user:database-secret@example.test/app\n' +
      'cache=redis://:password-only-canary@example.test:6379';
    const redacted = redactMessage(message);

    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain('cookie-secret');
    expect(redacted).not.toContain('refresh-secret');
    expect(redacted).not.toContain('database-secret');
    expect(redacted).not.toContain('password-only-canary');
    expect(redacted).toContain('token=[REDACTED]');
    expect(redacted).toContain('Cookie: [REDACTED]');
    expect(redacted).toContain('postgresql://[REDACTED]@example.test/app');
    expect(redacted).toContain('redis://[REDACTED]@example.test:6379');
  });
});

describe('redactFormat', () => {
  it.each(['error', 'warn', 'info', 'debug'])('redacts info.message for %s level', (level) => {
    const info = runRedactFormat({ level, message: 'Bearer secretvalue' });
    expect(info.message).toBe('Bearer [REDACTED]');
  });

  it('redacts the winston message symbol', () => {
    const info = runRedactFormat({
      level: 'info',
      message: 'visible',
      [MESSAGE_SYMBOL]: 'token: sk-abc123def',
    });

    expect(info[MESSAGE_SYMBOL]).toBe('token: sk-[REDACTED]');
  });

  it('redacts splat arguments before winston interpolates them', () => {
    const info = runRedactSplatFormat({
      level: 'info',
      message: 'token %s',
      [SPLAT_SYMBOL]: ['sk-abc123def'],
    });

    expect(info.message).toBe('token sk-[REDACTED]');
  });

  it('redacts string values in splat metadata', () => {
    const metadata = {
      auth: 'Bearer secretvalue',
      nested: { url: 'https://example.test/?key=secretvalue&next=true' },
    };
    const info = runRedactFormat({
      level: 'info',
      message: 'visible',
      [SPLAT_SYMBOL]: [metadata],
    });
    const splat = info[SPLAT_SYMBOL] as Array<{ auth: string; nested: { url: string } }>;

    expect(splat[0].auth).toBe('Bearer [REDACTED]');
    expect(splat[0].nested.url).toBe('https://example.test/?key=[REDACTED]&next=true');
    expect(metadata.auth).toBe('Bearer secretvalue');
    expect(metadata.nested.url).toBe('https://example.test/?key=secretvalue&next=true');
  });

  it('redacts values under sensitive splat metadata keys', () => {
    const metadata = {
      apiKey: 'secretvalue',
      authorization: 'secretvalue',
      nested: { token: 'secretvalue' },
      safe: 'secretvalue',
      'x-api-key': 'secretvalue',
      cookie: 'session=secretvalue',
      code_verifier: 'secretvalue',
      connectionString: 'postgresql://user:secretvalue@example.test/db',
    };
    const info = runRedactFormat({
      level: 'info',
      message: 'visible',
      [SPLAT_SYMBOL]: [metadata],
    });
    const splat = info[SPLAT_SYMBOL] as Array<typeof metadata>;

    expect(splat[0].apiKey).toBe('[REDACTED]');
    expect(splat[0].authorization).toBe('[REDACTED]');
    expect(splat[0].nested.token).toBe('[REDACTED]');
    expect(splat[0]['x-api-key']).toBe('[REDACTED]');
    expect(splat[0].cookie).toBe('[REDACTED]');
    expect(splat[0].code_verifier).toBe('[REDACTED]');
    expect(splat[0].connectionString).toBe('[REDACTED]');
    expect(splat[0].safe).toBe('secretvalue');
    expect(metadata.apiKey).toBe('secretvalue');
    expect(metadata.nested.token).toBe('secretvalue');
  });

  it('redacts object messages before serialization', () => {
    const message = {
      apiKey: 'secretvalue',
      nested: { url: 'https://example.test/?api_key=secretvalue&next=true' },
    };
    const info = runRedactFormat({
      level: 'debug',
      message,
    });

    expect(info.message).toEqual({
      apiKey: '[REDACTED]',
      nested: { url: 'https://example.test/?api_key=[REDACTED]&next=true' },
    });
    expect(message.apiKey).toBe('secretvalue');
    expect(message.nested.url).toBe('https://example.test/?api_key=secretvalue&next=true');
  });

  it('redacts serializable non-plain splat values before interpolation', () => {
    const info = runRedactSplatFormat({
      level: 'info',
      message: 'values %s %s',
      [SPLAT_SYMBOL]: [
        new URL('https://example.test/?api_key=secretvalue&next=true'),
        Buffer.from('sk-abc123def'),
      ],
    });

    expect(info.message).toBe(
      'values https://example.test/?api_key=[REDACTED]&next=true sk-[REDACTED]',
    );
  });

  it('summarizes large buffer splats instead of scanning the whole payload', () => {
    const buffer = Buffer.concat([Buffer.alloc(9000, 'a'), Buffer.from('sk-abc123def')]);

    const info = runRedactSplatFormat({
      level: 'info',
      message: 'payload %s',
      [SPLAT_SYMBOL]: [buffer],
    });

    expect(info.message).toBe(`payload [REDACTED Buffer ${buffer.length} bytes]`);
    expect(info.message).not.toContain('sk-abc123def');
  });

  it('bounds large object and array redaction work', () => {
    const metadata: Record<string, unknown> = {};
    Array.from({ length: 60 }).forEach((_, index) => {
      metadata[`field${index}`] = index === 59 ? 'sk-abc123def' : `safe-${index}`;
    });

    const info = runRedactFormat({
      level: 'info',
      message: 'visible',
      [SPLAT_SYMBOL]: [[metadata, ...Array.from({ length: 60 }, (_, index) => `safe-${index}`)]],
    });
    const splat = info[SPLAT_SYMBOL] as Array<Array<Record<string, unknown> | string>>;
    const redactedObject = splat[0][0] as Record<string, unknown>;

    expect(Object.keys(redactedObject)).toHaveLength(51);
    expect(redactedObject.field49).toBe('safe-49');
    expect(redactedObject.field59).toBeUndefined();
    expect(redactedObject.__redaction_truncated__).toBe('Additional object properties omitted');
    expect(splat[0]).toHaveLength(51);
    expect(splat[0][50]).toBe('Additional array values omitted');
    expect(JSON.stringify(splat)).not.toContain('sk-abc123def');
  });

  it('redacts over-deep object subtrees instead of traversing indefinitely', () => {
    const root: Record<string, unknown> = {};
    let current = root;
    Array.from({ length: 12 }).forEach((_, index) => {
      current.child = { label: `level-${index}` };
      current = current.child as Record<string, unknown>;
    });
    current.apiKey = 'secretvalue';

    const info = runRedactFormat({
      level: 'info',
      message: root,
    });

    const serialized = JSON.stringify(info.message);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('secretvalue');
  });

  it('redacts error splat arguments without mutating the original error', () => {
    const error = new Error('Bearer secretvalue');
    error.stack = 'Error: Bearer secretvalue\n    at request';

    const info = runRedactFormat({
      level: 'warn',
      message: 'request failed',
      [SPLAT_SYMBOL]: [error],
    });
    const splat = info[SPLAT_SYMBOL] as Error[];

    expect(splat[0]).toBeInstanceOf(Error);
    expect(splat[0]).not.toBe(error);
    expect(splat[0].message).toBe('Bearer [REDACTED]');
    expect(splat[0].stack).toContain('Bearer [REDACTED]');
    expect(Object.prototype.propertyIsEnumerable.call(splat[0], 'message')).toBe(false);
    expect(Object.prototype.propertyIsEnumerable.call(splat[0], 'stack')).toBe(false);
    expect(error.message).toBe('Bearer secretvalue');
    expect(error.stack).toContain('Bearer secretvalue');
  });

  it('redacts JSON OAuth bodies and password-only URIs inside errors', () => {
    const error = new Error(
      'OAuth failed: {"refresh_token":"error-json-canary"} redis://:error-uri-canary@example.test',
    );

    const info = runRedactFormat({
      level: 'error',
      message: 'token refresh failed',
      [SPLAT_SYMBOL]: [error],
    });
    const redactedError = (info[SPLAT_SYMBOL] as Error[])[0];

    expect(redactedError.message).toContain('"refresh_token":"[REDACTED]"');
    expect(redactedError.message).toContain('redis://[REDACTED]@example.test');
    expect(redactedError.message).not.toContain('error-json-canary');
    expect(redactedError.message).not.toContain('error-uri-canary');
  });

  it('preserves contextual messages when redacting error splat arguments', () => {
    const error = new Error('Bearer secretvalue');

    const info = runRedactSplatFormat({
      level: 'warn',
      message: 'request failed',
      [SPLAT_SYMBOL]: [error],
    });

    expect(info.message).toBe('request failed');
  });

  it('preserves and redacts non-enumerable error causes when cloning errors', () => {
    const cause = new Error('Bearer cause-secret');
    const error = new Error('outer');
    Object.defineProperty(error, 'cause', {
      value: cause,
      writable: true,
      enumerable: false,
      configurable: true,
    });

    const info = runRedactFormat({
      level: 'warn',
      message: 'request failed',
      [SPLAT_SYMBOL]: [error],
    });
    const splat = info[SPLAT_SYMBOL] as Array<Error & { cause?: Error }>;

    expect(splat[0].cause).toBeInstanceOf(Error);
    expect(splat[0].cause).not.toBe(cause);
    expect(splat[0].cause?.message).toBe('Bearer [REDACTED]');
    expect(Object.prototype.propertyIsEnumerable.call(splat[0], 'cause')).toBe(false);
    expect(cause.message).toBe('Bearer cause-secret');
  });
});

describe('debugTraverse request context', () => {
  it('appends request context metadata for non-debug lines', () => {
    const out = runFormatter(
      buildInfo('info', {
        tenantId: 'tenant-1',
        userId: 'user-1',
        requestId: 'req-1',
      }),
    );

    expect(out).toContain('"tenantId":"tenant-1"');
    expect(out).toContain('"userId":"user-1"');
    expect(out).toContain('"requestId":"req-1"');
  });

  it('does not append the system tenant sentinel as tenantId', () => {
    const out = runFormatter(
      buildInfo('info', {
        tenantId: '__SYSTEM__',
        userId: 'user-1',
        requestId: 'req-1',
      }),
    );

    expect(out).not.toContain('__SYSTEM__');
    expect(out).not.toContain('"tenantId"');
    expect(out).toContain('"userId":"user-1"');
    expect(out).toContain('"requestId":"req-1"');
  });

  it('omits the system tenant sentinel from debug object metadata', () => {
    const out = runFormatter(
      buildInfo('debug', {
        tenantId: '__SYSTEM__',
        userId: 'user-1',
      }),
    );

    expect(out).not.toContain('__SYSTEM__');
    expect(out).not.toMatch(/tenantId:/);
    expect(out).toContain('userId');
  });

  it('preserves structured auth metadata for non-JSON warning output', () => {
    const out = runFormatter(
      buildInfo('warn', {
        event_name: 'jwt_auth_rejected',
        request_id: 'request-123',
        request_method: 'GET',
        request_path: '/api/messages',
        token_source: 'bearer',
        reason_category: 'malformed_jwt',
        recovery_classification: 'terminal_rejection',
        response_status: 401,
      }),
    );

    expect(out).toContain('"event_name":"jwt_auth_rejected"');
    expect(out).toContain('"request_id":"request-123"');
    expect(out).toContain('"reason_category":"malformed_jwt"');
    expect(out).toContain('"response_status":401');
  });

  it('does not render application metadata as request correlation context', () => {
    const out = runFormatter(
      buildInfo('warn', {
        method: 'DELETE',
        path: '/uploads/tenant-123/user-123/file.txt',
        request_method: 'POST',
        request_path: '/api/files',
      }),
    );

    expect(out).toContain('"request_method":"POST"');
    expect(out).toContain('"request_path":"/api/files"');
    expect(out).not.toContain('"method":"DELETE"');
    expect(out).not.toContain('/uploads/tenant-123/user-123/file.txt');
  });
});

describe('jsonTruncateFormat structured events', () => {
  it('preserves short auth correlation fields when the human-readable message is truncated', () => {
    const format = jsonTruncateFormat();
    const info = {
      level: 'warn',
      message: `JWT auth rejected: ${'x'.repeat(300)}`,
      event_name: 'jwt_auth_rejected',
      request_id: 'request-123',
      request_method: 'GET',
      request_path: '/api/messages',
      token_source: 'bearer',
      reason_category: 'malformed_jwt',
      recovery_classification: 'terminal_rejection',
      response_status: 401,
    } satisfies winston.Logform.TransformableInfo;

    const output = format.transform(info, format.options);
    if (typeof output !== 'object') {
      throw new Error('Expected jsonTruncateFormat to preserve the log record');
    }

    expect(output.message).toBe(`${info.message.slice(0, 255)}...`);
    expect(output).toMatchObject({
      event_name: 'jwt_auth_rejected',
      request_id: 'request-123',
      request_method: 'GET',
      request_path: '/api/messages',
      token_source: 'bearer',
      reason_category: 'malformed_jwt',
      recovery_classification: 'terminal_rejection',
      response_status: 401,
    });
  });
});
