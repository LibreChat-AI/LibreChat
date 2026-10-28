import winston from 'winston';
import {
  debugTraverse,
  jsonTruncateFormat,
  redactFormat,
  redactMessage,
  stripHeavyErrorFields,
} from './parsers';

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
    expect(redactMessage('https://example.test/?input=x&appid=secretvalue&limit=1')).toBe(
      'https://example.test/?input=x&appid=[REDACTED]&limit=1',
    );
  });

  it('masks email addresses in messages', () => {
    expect(redactMessage('login for jane.doe+tag@example.co.uk | ok')).toBe(
      'login for [REDACTED_EMAIL] | ok',
    );
    expect(redactMessage('a@b.com and c@d.org')).toBe('[REDACTED_EMAIL] and [REDACTED_EMAIL]');
    expect(redactMessage('user jöhn@example.com ok')).toBe('user [REDACTED_EMAIL] ok');
    expect(redactMessage('user 用户@例子.公司 ok')).toBe('user [REDACTED_EMAIL] ok');
    expect(redactMessage('user user@bücher.de ok')).toBe('user [REDACTED_EMAIL] ok');
    expect(redactMessage('a@b and user@localhost')).toBe('a@b and user@localhost');
    expect(redactMessage('mention @handle and v1.2.3')).toBe('mention @handle and v1.2.3');
  });

  it('masks the whole token for apostrophes, long local parts and combining-mark domains', () => {
    expect(redactMessage("mary.jane'o_connor@example.com")).toBe('[REDACTED_EMAIL]');
    expect(redactMessage(`${'a'.repeat(100)}@example.com ok`)).toBe('[REDACTED_EMAIL] ok');
    expect(redactMessage('user@उदाहरण.भारत ok')).toBe('[REDACTED_EMAIL] ok');
  });

  it('masks address-literal domains without eating the closing bracket of a label', () => {
    expect(redactMessage('user@[192.0.2.1] ok')).toBe('[REDACTED_EMAIL] ok');
    expect(redactMessage('[Email: a@b.com]')).toBe('[Email: [REDACTED_EMAIL]]');
  });

  it('does not let a truncated address slip past the matcher', () => {
    const lead = `${'x '.repeat(4090)}`;
    const input = `${lead}janedoe123@example.com and more`;
    const out = String(runRedactFormat({ level: 'info', message: input }).message);
    expect(out).not.toContain('janedoe');
    expect(out).toContain('truncated');
  });

  it('keeps both entries when a redacted key collides with an unchanged one, and masks object Map keys', () => {
    const mapInfo = runRedactFormat({
      level: 'info',
      message: 'm',
      [SPLAT_SYMBOL]: [new Map<unknown, unknown>([[{ contact: 'jane@example.com' }, 'failed']])],
    });
    const [mapOut] = mapInfo[SPLAT_SYMBOL] as Map<unknown, unknown>[];
    expect(JSON.stringify([...mapOut.keys()])).not.toContain('jane');

    const info = runRedactFormat({
      level: 'info',
      message: 'm',
      [SPLAT_SYMBOL]: [{ 'jane@example.com': 'a', '[REDACTED_EMAIL]': 'b' }],
    });
    const out = JSON.stringify(info[SPLAT_SYMBOL]);
    expect(out).not.toContain('jane');
    expect(out).toContain('"a"');
    expect(out).toContain('"b"');
  });

  it('masks a quoted address whose space sits on the truncation boundary', () => {
    const input = `${' '.repeat(8187)}"jane doe"@example.com;${'x'.repeat(2000)}`;
    const out = String(runRedactFormat({ level: 'info', message: input }).message);
    expect(out).not.toMatch(/jane/);
  });

  it('masks serialized quoted addresses and many colliding keys in linear time', () => {
    expect(redactMessage(JSON.stringify({ email: '"jane doe"@example.com' }))).not.toMatch(/jane/);
    const keys = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => [`u${index}@example.com`, index]),
    );
    const started = Date.now();
    const info = runRedactFormat({ level: 'info', message: 'm', ...keys });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(JSON.stringify(info)).not.toContain('example.com');
  });

  it('masks serialized escaped-quote locals and long-scheme credential URLs', () => {
    expect(redactMessage(JSON.stringify({ email: '"jane\\"doe"@example.com' }))).not.toMatch(
      /jane/,
    );
    expect(
      redactMessage('company-specific-connection-protocol://alice:s3cr3t@localhost'),
    ).not.toContain('s3cr3t');
  });

  it('redacts every secret shape in long strings, inside and straddling the cap', () => {
    const secrets = [
      'sk-secretcanary123',
      'Bearer secretcanary123',
      'api_key=secretcanary123',
      'Authorization: secretcanary123',
      'Cookie: sid=secretcanary123',
      'postgresql://user:secretcanary123@example.test/app',
      'eyJsecretcanary.eyJsecretcanary.secretcanary',
      'secretcanary@example.com',
    ];
    for (const secret of secrets) {
      for (const offset of [0, 4000, 8100, 8192 - secret.length / 2]) {
        const input = `${'x '.repeat(Math.floor(offset / 2))}${secret} ${'y '.repeat(3000)}`;
        const out = String(runRedactFormat({ level: 'info', message: input }).message);
        expect(out).not.toContain('secretcanary');
      }
    }
  });

  it('masks one-character final labels, direct Error stacks and tokens crossing the window edge', () => {
    expect(redactMessage('user@example.c ok')).toBe('[REDACTED_EMAIL] ok');
    const error = new Error('failed for jane@example.com');
    void error.stack;
    const info = runRedactFormat(error as unknown as RedactInfo);
    expect(String((info as unknown as Error).stack)).not.toContain('jane');
    const long = `${' '.repeat(8000)}sk-${'a'.repeat(1500)}${' '.repeat(10)}`;
    const out = String(runRedactFormat({ level: 'info', message: `${long}tail` }).message);
    expect(out).not.toContain('aaaa');
    const edge = `${' '.repeat(8100)}postgresql://user:${'p'.repeat(1300)}@host/db end`;
    expect(String(runRedactFormat({ level: 'info', message: edge }).message)).not.toContain('pppp');
  });

  it('masks delimiter-bearing identifiers and keeps a complete 8.5k input intact', () => {
    expect(redactMessage('user(comment)@blocked.example ok')).toBe('[REDACTED_EMAIL] ok');
    const input = `${'a'.repeat(8500)}`;
    const out = String(runRedactFormat({ level: 'info', message: input }).message);
    expect(out).toContain('aaaa');
  });

  it('masks a quoted local part of any length', () => {
    expect(redactMessage(`"${'a'.repeat(200)}"@blocked.example ok`)).toBe('[REDACTED_EMAIL] ok');
  });

  it('keeps the uncapped matcher linear on quote and escape floods', () => {
    for (const input of ['\\"'.repeat(50000), '"\\"'.repeat(30000), '"a'.repeat(50000)]) {
      const started = Date.now();
      redactMessage(input);
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  it('drops an unfinished quoted address that outruns the window', () => {
    const input = `${' '.repeat(8180)}"jane ${'x'.repeat(2000)}"@example.com tail`;
    const out = String(runRedactFormat({ level: 'info', message: input }).message);
    expect(out).not.toContain('jane');
  });

  it('drops a quoted address whose window edge falls on an inner space', () => {
    const input = `${' '.repeat(8180)}"jane ${'x'.repeat(1030)} doe"@example.com tail`;
    const out = String(runRedactFormat({ level: 'info', message: input }).message);
    expect(out).not.toContain('jane');
  });

  it('keeps a completed quoted address redacted when a stray quote precedes the edge', () => {
    const input = `note: " ${' '.repeat(8172)}"jane doe"@example.com ${'x'.repeat(2000)}`;
    const out = String(runRedactFormat({ level: 'info', message: input }).message);
    expect(out).not.toContain('jane');
  });

  it('keeps text after a completed quoted address', () => {
    const input = `prefix "jane doe"@example.com diagnostic-code ${'x'.repeat(10000)}`;
    const out = String(runRedactFormat({ level: 'info', message: input }).message);
    expect(out).toContain('diagnostic-code');
    expect(out).not.toContain('jane');
  });

  it('has no residual caps and masks credential URIs after scheme punctuation', () => {
    expect(
      redactMessage(JSON.stringify({ email: `"${'a'.repeat(65)}"@example.com` })),
    ).not.toContain('aaaa');
    expect(redactMessage(`u@[${'a'.repeat(64)}.x] ok`)).toBe('[REDACTED_EMAIL] ok');
    expect(redactMessage('-redis://:pw0rd@redis:6379')).not.toContain('pw0rd');
    expect(redactMessage('...postgresql://user:pw0rd@db/database')).not.toContain('pw0rd');
    for (const input of ['a-'.repeat(50000), '\\"a'.repeat(30000), 'u@['.repeat(30000)]) {
      const started = Date.now();
      redactMessage(input);
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  it('masks empty quoted locals and survives read-only error properties', () => {
    expect(redactMessage('""@blocked.example ok')).toBe('[REDACTED_EMAIL] ok');
    class DetailError extends Error {
      get detail() {
        return 'jane@example.com';
      }
    }
    const error = new DetailError('boom');
    Object.defineProperty(error, 'detail', {
      enumerable: true,
      configurable: false,
      get: () => 'jane@example.com',
    });
    const out = runRedactFormat(error as unknown as RedactInfo) as unknown as { detail: string };
    expect(out.detail).not.toContain('jane');
  });

  it('sanitizes a copy when a stack or key cannot be replaced in place', () => {
    const error = new Error('failed for jane@example.com');
    Object.defineProperty(error, 'stack', { value: 'at jane@example.com', writable: false });
    const out = runRedactFormat(error as unknown as RedactInfo) as unknown as { stack: string };
    expect(out.stack).not.toContain('jane');
    const frozen = { level: 'info', message: 'm' } as RedactInfo;
    Object.defineProperty(frozen, 'jane@example.com', { value: 1, enumerable: true });
    expect(JSON.stringify(runRedactFormat(frozen))).not.toContain('jane');
  });

  it('masks serialized escaped-backslash locals and skips heavy error graphs', () => {
    expect(redactMessage(JSON.stringify({ email: '"jane\\\\doe"@example.com' }))).not.toContain(
      'jane',
    );
    let graph: Record<string, unknown> = { leaf: 'x' };
    for (let depth = 0; depth < 6; depth++) {
      graph = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`k${index}`, graph]));
    }
    const started = Date.now();
    runRedactFormat({
      level: 'error',
      message: 'm',
      config: graph,
      isAxiosError: true,
    } as RedactInfo);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('masks serialized locals with a lone escaped backslash and stays linear on backslash runs', () => {
    expect(redactMessage(JSON.stringify({ email: '"jane\\doe"@example.com' }))).not.toContain(
      'jane',
    );
    for (const input of ['\\"' + '\\'.repeat(60000), '\\"\\\\'.repeat(20000)]) {
      const started = Date.now();
      redactMessage(input);
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  it('redacts compact request info, splat errors and comma-edged URIs', () => {
    const axiosError = Object.assign(new Error('boom'), {
      isAxiosError: true,
      config: { method: 'get', url: 'https://user@example.com/?api_key=secret' },
    });
    const wrapped = winston.format.combine(redactFormat(), stripHeavyErrorFields());
    const out = wrapped.transform(
      { level: 'error', message: 'm', [SPLAT_SYMBOL]: [axiosError] },
      {},
    );
    expect(JSON.stringify(out)).not.toMatch(/secret|user@example/);
    const topLevel = wrapped.transform(Object.assign(axiosError, { level: 'error' }) as never, {});
    expect(JSON.stringify(topLevel)).not.toMatch(/secret|user@example/);
    const edge = `${' '.repeat(8100)}postgresql://user:${'p'.repeat(1050)},${'q'.repeat(60)}@host/db end`;
    expect(String(runRedactFormat({ level: 'info', message: edge }).message)).not.toContain('pppp');
  });

  it('does not clone heavy graphs of splat errors', () => {
    let graph: Record<string, unknown> = { leaf: 'x' };
    for (let depth = 0; depth < 6; depth++) {
      graph = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`k${index}`, graph]));
    }
    const error = Object.assign(new Error('boom'), {
      isAxiosError: true,
      config: { method: 'get', url: 'https://example.test/', graph },
      request: graph,
    });
    const started = Date.now();
    runRedactFormat({ level: 'error', message: 'm', [SPLAT_SYMBOL]: [error] });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('redacts address keys on nested Error objects', () => {
    const error = Object.assign(new Error('lookup failed'), { 'jane@example.com': 'missing' });
    const info = runRedactFormat({ level: 'info', message: 'm', [SPLAT_SYMBOL]: [error] });
    const [out] = info[SPLAT_SYMBOL] as Array<Record<string, unknown>>;
    expect(Object.keys(out).join()).not.toContain('jane');
    expect(out['[REDACTED_EMAIL]']).toBe('missing');
  });

  it('redacts enumerable getter values on nested Error objects', () => {
    const error = new Error('boom');
    Object.defineProperty(error, 'detail', { enumerable: true, get: () => 'jane@example.com' });
    const info = runRedactFormat({ level: 'info', message: 'm', [SPLAT_SYMBOL]: [error] });
    const [out] = info[SPLAT_SYMBOL] as Array<{ detail: string }>;
    expect(out.detail).not.toContain('jane');
  });

  it('survives throwing top-level getters and redacts heavy-named fields on plain records', () => {
    const error = new Error('boom');
    Object.defineProperty(error, 'detail', {
      enumerable: true,
      get: () => {
        throw new Error('nope');
      },
    });
    expect(() => runRedactFormat(error as unknown as RedactInfo)).not.toThrow();
    const out = runRedactFormat({
      level: 'error',
      message: 'failed',
      socket: { note: 'Bearer secretcanary' },
    } as RedactInfo);
    expect(JSON.stringify(out)).not.toContain('secretcanary');
  });

  it('drops an unfinished serialized quoted address at the window edge', () => {
    const input = `${' '.repeat(8170)}${JSON.stringify({ email: `"jane ${'x'.repeat(2000)}"@example.com` })}`;
    const out = String(runRedactFormat({ level: 'info', message: input }).message);
    expect(out).not.toContain('jane');
  });

  it('masks JSON control escapes in serialized quoted locals and bounds wide payloads', () => {
    expect(redactMessage(JSON.stringify({ email: '"jane\tdoe"@example.com' }))).not.toContain(
      'jane',
    );
    let tree: Record<string, unknown> = { leaf: 'x' };
    for (let depth = 0; depth < 5; depth++) {
      tree = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`k${index}`, tree]));
    }
    const started = Date.now();
    runRedactFormat({
      level: 'info',
      message: 'm',
      a: tree,
      b: tree,
      c: { x: tree },
    } as RedactInfo);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('masks credentials after a scheme of any length', () => {
    expect(redactMessage(`${'a'.repeat(300)}://alice:secretcanary@localhost`)).not.toContain(
      'secretcanary',
    );
  });

  it('counts strings against the budget and survives nested throwing getters', () => {
    const strings = Object.fromEntries(
      Array.from({ length: 50000 }, (_, index) => [`s${index}`, 'x'.repeat(8000)]),
    );
    const started = Date.now();
    runRedactFormat({ level: 'info', message: 'm', payload: strings } as RedactInfo);
    expect(Date.now() - started).toBeLessThan(500);
    const payload = {};
    Object.defineProperty(payload, 'bad', {
      enumerable: true,
      get: () => {
        throw new Error('nope');
      },
    });
    expect(() =>
      runRedactFormat({ level: 'info', message: 'm', payload } as RedactInfo),
    ).not.toThrow();
  });

  it('rebuilds the record when an accessor ignores writes', () => {
    const error = new Error('boom');
    Object.defineProperty(error, 'detail', {
      enumerable: true,
      configurable: true,
      get: () => 'jane@example.com',
      set: () => undefined,
    });
    const out = runRedactFormat(error as unknown as RedactInfo) as unknown as { detail: string };
    expect(out.detail).not.toContain('jane');
  });

  it('rebuilds the record when a stack accessor ignores writes', () => {
    const error = new Error('boom');
    Object.defineProperty(error, 'stack', {
      get: () => 'at jane@example.com',
      set: () => undefined,
      configurable: true,
    });
    const out = runRedactFormat(error as unknown as RedactInfo) as unknown as { stack: string };
    expect(out.stack).not.toContain('jane');
  });

  it('survives a throwing stack accessor', () => {
    const error = new Error('boom');
    Object.defineProperty(error, 'stack', {
      get: () => {
        throw new Error('nope');
      },
      configurable: true,
    });
    expect(() => runRedactFormat(error as unknown as RedactInfo)).not.toThrow();
  });

  it('masks serialized locals with an escaped solidus', () => {
    expect(redactMessage(JSON.stringify({ email: '"a/b"@example.com' }).replace('/', '\\/'))).toBe(
      '{"email":"[REDACTED_EMAIL]"}',
    );
  });

  it('survives a throwing isAxiosError marker', () => {
    const record = { level: 'info', message: 'm' } as RedactInfo;
    Object.defineProperty(record, 'isAxiosError', {
      enumerable: true,
      get: () => {
        throw new Error('nope');
      },
    });
    expect(() => runRedactFormat(record)).not.toThrow();
  });

  it('masks URL-encoded addresses, drops fields past the budget and never keeps raw heavy fields', () => {
    expect(redactMessage('GET /v1?email=jane%40example.com&x=1')).toBe(
      'GET /v1?email=[REDACTED_EMAIL]&x=1',
    );
    const started = Date.now();
    redactMessage('a'.repeat(100000));
    redactMessage('a%40'.repeat(30000));
    expect(Date.now() - started).toBeLessThan(500);
    const wide = Object.fromEntries(
      Array.from({ length: 20000 }, (_, index) => [`n${index}`, index]),
    );
    const out = runRedactFormat({ level: 'info', message: 'm', ...wide } as RedactInfo);
    expect(Object.keys(out).length).toBeLessThan(6000);
    const config = {
      method: 'get',
      url: 'https://example.test/',
      headers: { authorization: 'Bearer secretcanary' },
    };
    Object.defineProperty(config, 'method', {
      enumerable: false,
      get: () => {
        throw new Error('nope');
      },
    });
    const axiosRecord = {
      level: 'error',
      message: 'm',
      isAxiosError: true,
      config,
      request: { a: 1 },
    };
    const result = runRedactFormat(axiosRecord as RedactInfo);
    expect(JSON.stringify(result)).not.toContain('secretcanary');
  });

  it('redacts encoded address keys and survives throwing nested Axios configs', () => {
    const out = runRedactFormat({
      level: 'info',
      message: 'm',
      'jane%40example.com': 1,
    } as RedactInfo);
    expect(JSON.stringify(out)).not.toContain('jane');
    const config = { url: 'https://example.test/' };
    Object.defineProperty(config, 'method', {
      enumerable: true,
      get: () => {
        throw new Error('nope');
      },
    });
    const error = Object.assign(new Error('boom'), { isAxiosError: true, config });
    expect(() =>
      runRedactFormat({ level: 'error', message: 'm', [SPLAT_SYMBOL]: [error] }),
    ).not.toThrow();
  });

  it('redacts URL objects in compact request info', () => {
    const error = Object.assign(new Error('boom'), {
      isAxiosError: true,
      config: {
        method: 'get',
        url: new URL('https://user:secretcanary@example.test/?e=jane@example.com'),
      },
    });
    const wrapped = winston.format.combine(redactFormat(), stripHeavyErrorFields());
    const out = wrapped.transform({ level: 'error', message: 'm', [SPLAT_SYMBOL]: [error] }, {});
    expect(JSON.stringify(out)).not.toMatch(/secretcanary|jane/);
  });

  it('masks long encoded addresses linearly and strips serializer hooks', () => {
    expect(redactMessage(`?e=${'a'.repeat(400)}%40${'b'.repeat(300)}.com&x=1`)).toBe(
      '?e=[REDACTED_EMAIL]&x=1',
    );
    const started = Date.now();
    redactMessage('a%40'.repeat(50000));
    redactMessage('a'.repeat(100000));
    expect(Date.now() - started).toBeLessThan(500);
    const out = runRedactFormat({
      level: 'info',
      message: 'm',
      payload: { email: 'jane@example.com', toJSON: () => ({ email: 'jane@example.com' }) },
    } as RedactInfo);
    expect(JSON.stringify(out)).not.toContain('jane');
  });

  it('strips serializer hooks from Error clones and top-level records', () => {
    const error = Object.assign(new Error('boom'), {
      toJSON: () => ({ email: 'jane@example.com' }),
    });
    const info = runRedactFormat({ level: 'info', message: 'm', [SPLAT_SYMBOL]: [error] });
    expect(JSON.stringify(info[SPLAT_SYMBOL])).not.toContain('jane');
    const top = runRedactFormat({
      level: 'info',
      message: 'm',
      toJSON: () => 'jane@example.com',
    } as RedactInfo);
    expect(JSON.stringify(top)).not.toContain('jane');
  });

  it('neutralizes inherited serializer hooks', () => {
    class Hooked extends Error {
      toJSON() {
        return { email: 'jane@example.com' };
      }
    }
    const direct = runRedactFormat(new Hooked('boom') as unknown as RedactInfo);
    expect(JSON.stringify(direct)).not.toContain('jane');
    const nested = runRedactFormat({
      level: 'info',
      message: 'm',
      [SPLAT_SYMBOL]: [new Hooked('x')],
    });
    expect(JSON.stringify(nested[SPLAT_SYMBOL])).not.toContain('jane');
  });

  it('survives a throwing toJSON getter', () => {
    const record = { level: 'info', message: 'm' } as RedactInfo;
    Object.defineProperty(record, 'toJSON', {
      get: () => {
        throw new Error('nope');
      },
      configurable: false,
    });
    expect(() => runRedactFormat(record)).not.toThrow();
  });

  it('replaces function values so their serializers never run', () => {
    const fn = Object.assign(() => undefined, { toString: () => 'jane@example.com' });
    const out = runRedactFormat({ level: 'info', message: fn as unknown as string });
    expect(String(out.message)).not.toContain('jane');
  });

  it('masks encoded domain separators', () => {
    expect(redactMessage('GET /v1?email=jane%40example%2Ecom&x=1')).toBe(
      'GET /v1?email=[REDACTED_EMAIL]&x=1',
    );
  });

  it('keeps encoded-email matching linear at repeated URL boundaries', () => {
    const started = Date.now();
    redactMessage('?a%40'.repeat(30000));
    redactMessage('&a%40'.repeat(30000));
    redactMessage('/a%40'.repeat(30000));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('shadows an inherited throwing serializer getter on nested errors', () => {
    class Throwing extends Error {
      get toJSON(): never {
        throw new Error('nope');
      }
    }
    const info = runRedactFormat({
      level: 'info',
      message: 'm',
      [SPLAT_SYMBOL]: [new Throwing('x')],
    });
    expect(() => JSON.stringify(info[SPLAT_SYMBOL])).not.toThrow();
  });

  it('rebuilds records with accessor messages and masks doubly encoded addresses', () => {
    const record = { level: 'info' } as RedactInfo;
    Object.defineProperty(record, 'message', {
      enumerable: true,
      get: () => 'jane@example.com',
      set: () => undefined,
    });
    expect(JSON.stringify(runRedactFormat(record))).not.toContain('jane');
    expect(
      redactMessage('redirect_uri=https%3A%2F%2Fx%3Femail%3Djane%2540example.com&a=1'),
    ).not.toContain('jane');
  });

  it('redacts multiply encoded address keys', () => {
    const out = runRedactFormat({
      level: 'info',
      message: 'm',
      'jane%2540example.com': 1,
    } as RedactInfo);
    expect(JSON.stringify(out)).not.toContain('jane');
  });

  it('survives throwing message getters and nested serializer getters', () => {
    const record = { level: 'info' } as RedactInfo;
    Object.defineProperty(record, 'message', {
      enumerable: true,
      get: () => {
        throw new Error('nope');
      },
    });
    expect(() => runRedactFormat(record)).not.toThrow();
    class Nested {
      get toJSON(): never {
        throw new Error('nope');
      }
    }
    expect(() =>
      runRedactFormat({ level: 'info', message: 'm', payload: new Nested() } as RedactInfo),
    ).not.toThrow();
  });

  it('survives revoked proxies and redacts the compact request method', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() =>
      runRedactFormat({ level: 'info', message: 'm', payload: proxy } as RedactInfo),
    ).not.toThrow();
    const config = { method: 'Bearer secretcanary', url: 'https://example.test/' };
    const out = runRedactFormat({
      level: 'error',
      message: 'm',
      isAxiosError: true,
      config,
    } as RedactInfo);
    expect(JSON.stringify(out)).not.toContain('secretcanary');
  });

  it('stays fast on adversarial 100k inputs for every redaction path', () => {
    const inputs = [
      'a@'.repeat(50000),
      `a@${'a.'.repeat(50000)}`,
      '"a@'.repeat(30000),
      '\\"'.repeat(50000),
      'a'.repeat(100000),
      `${'a'.repeat(100000)}://h`,
      'Bearer '.repeat(14000),
    ];
    for (const input of inputs) {
      const started = Date.now();
      runRedactFormat({ level: 'info', message: input });
      runRedactFormat({ level: 'info', message: 'm', [input]: 1, nested: { [input]: input } });
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it('keeps redaction of a long run without an address bounded', () => {
    const started = Date.now();
    const out = String(
      runRedactFormat({ level: 'info', message: `${'a'.repeat(100000)}://host` }).message,
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(out).toContain('truncated');
  });

  it('masks quoted and bracketed addresses cut right before the at sign or inside the literal', () => {
    for (const [addr, cut] of [
      ['"jane doe"@example.com', '"jane doe"'.length],
      ['jane@[192.0.2.1]', 'jane@['.length],
    ] as const) {
      const input = `${' '.repeat(8192 - cut)}${addr} tail`;
      const out = String(runRedactFormat({ level: 'info', message: input }).message);
      expect(out).not.toMatch(/jane/);
    }
  });

  it('masks quoted local parts', () => {
    expect(redactMessage('user "jane.doe"@example.com ok')).toBe('user [REDACTED_EMAIL] ok');
    expect(redactMessage('user "jane\\"doe"@example.com ok')).toBe('user [REDACTED_EMAIL] ok');
    expect(redactMessage('user "jane doe"@example.com ok')).toBe('user [REDACTED_EMAIL] ok');
    expect(redactMessage('user customer/dept=ship@example.com ok')).toBe(
      'user [REDACTED_EMAIL] ok',
    );
  });

  it('scans long non-email text in linear time', () => {
    const inputs = ['_'.repeat(100_000), `${'_'.repeat(50_000)}@${'-'.repeat(50_000)}`];
    const start = Date.now();
    for (const input of inputs) {
      expect(redactMessage(input)).toBe(input);
    }
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('masks email addresses in metadata values and nested objects', () => {
    const info = runRedactSplatFormat({
      level: 'info',
      message: 'x',
      [SPLAT_SYMBOL]: [{ user: { contact: 'jane@example.com' }, list: ['a@b.io'] }],
    });
    const [meta] = info[SPLAT_SYMBOL] as Array<{ user: { contact: string }; list: string[] }>;
    expect(meta.user.contact).toBe('[REDACTED_EMAIL]');
    expect(meta.list).toEqual(['[REDACTED_EMAIL]']);
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
  it('masks emails in top-level fields, stack traces and metadata keys', () => {
    const info = runRedactFormat({
      level: 'error',
      message: 'lookup',
      contact: 'jane@example.com',
      stack: 'Error: failed for jane@example.com\n    at x',
      token: 'sk-abcdef',
      'top@example.net': 'missing',
      nested: { 'k@example.org': 1, 'j@example.org': 2, other: 3 },
    });
    expect(info.contact).toBe('[REDACTED_EMAIL]');
    expect(info.stack).toBe('Error: failed for [REDACTED_EMAIL]\n    at x');
    expect(info.token).toBe('[REDACTED]');
    expect(info['[REDACTED_EMAIL]']).toBe('missing');
    expect(info).not.toHaveProperty(['top@example.net']);
    expect(info.nested).toEqual({ '[REDACTED_EMAIL]': 1, '[REDACTED_EMAIL]#2': 2, other: 3 });
  });

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
      appid: 'secretvalue',
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
    expect(splat[0].appid).toBe('[REDACTED]');
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

  it('preserves transport symbols in a single enumeration of the log record', () => {
    const LEVEL = Symbol.for('level');
    const format = jsonTruncateFormat();
    const message = 'x'.repeat(300);
    const splat = [{ requestId: 'request-123' }];
    const ownKeys = jest.fn(Reflect.ownKeys);
    const info = new Proxy<winston.Logform.TransformableInfo>(
      {
        level: 'error',
        message,
        [LEVEL]: 'error',
        [MESSAGE_SYMBOL]: message,
        [SPLAT_SYMBOL]: splat,
      },
      { ownKeys },
    );

    const output = format.transform(info, format.options);
    if (typeof output !== 'object') {
      throw new Error('Expected jsonTruncateFormat to preserve the log record');
    }

    expect(ownKeys).toHaveBeenCalledTimes(1);
    expect(output[LEVEL]).toBe('error');
    expect(output[MESSAGE_SYMBOL]).toBe(message);
    expect(output[SPLAT_SYMBOL]).toBe(splat);
    expect(output.level).toBe('error');
    expect(output.message).toBe(`${message.slice(0, 255)}...`);
    expect(info.message).toBe(message);
  });

  it('preserves non-enumerable symbols without reading non-enumerable string fields', () => {
    const LEVEL = Symbol.for('level');
    const format = jsonTruncateFormat();
    const info = { level: 'error', message: 'request failed' };
    const readHidden = jest.fn(() => {
      throw new Error('Hidden string fields must not be read');
    });
    Object.defineProperties(info, {
      [LEVEL]: { value: 'error', enumerable: false },
      hidden: { get: readHidden, enumerable: false },
    });

    const output = format.transform(info, format.options);
    if (typeof output !== 'object') {
      throw new Error('Expected jsonTruncateFormat to preserve the log record');
    }

    expect(output[LEVEL]).toBe('error');
    expect(output).not.toHaveProperty('hidden');
    expect(readHidden).not.toHaveBeenCalled();
  });

  it('keeps nested values JSON-shaped while truncating strings and handling cycles', () => {
    const format = jsonTruncateFormat();
    const message = 'x'.repeat(300);
    const nested: Record<string | symbol, unknown> = {
      detail: message,
      items: [{ detail: message }],
      [SPLAT_SYMBOL]: [{ detail: message }],
    };
    nested.self = nested;
    const readHidden = jest.fn(() => {
      throw new Error('Hidden string fields must not be read');
    });
    Object.defineProperty(nested, 'hidden', { get: readHidden, enumerable: false });
    const info = { level: 'info', message: 'event', metadata: nested };

    const output = format.transform(info, format.options);
    if (typeof output !== 'object') {
      throw new Error('Expected jsonTruncateFormat to preserve the log record');
    }

    expect(output.metadata).toEqual({
      detail: `${message.slice(0, 255)}...`,
      items: [{ detail: `${message.slice(0, 255)}...` }],
      self: '[Circular]',
    });
    expect(nested.detail).toBe(message);
    expect(nested.self).toBe(nested);
    expect(readHidden).not.toHaveBeenCalled();
  });
});
