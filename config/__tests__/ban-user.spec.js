const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Types } = require('mongoose');
const api = require('@librechat/api');
const { ViolationTypes } = require('librechat-data-provider');

function evaluate(filename, modules, process, console) {
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const execute = vm.runInThisContext(
    `(function(require, module, __dirname, process, console) { ${source}\n})`,
    { filename },
  );
  execute(
    (name) => {
      if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected dependency: ${name}`);
      return modules[name];
    },
    module,
    path.dirname(filename),
    process,
    console,
  );
  return module.exports;
}

function harness({
  authentication,
  failInitialize = false,
  failRevoke = false,
  failClose = false,
} = {}) {
  const mongoId = new Types.ObjectId('507f1f77bcf86cd799439011');
  const userId = mongoId.toHexString();
  const events = [];
  const sessions = { mongo: new Set([userId]), postgres: new Set([userId]) };
  const methodsFor = (engine) => ({
    deleteAllUserSessions: jest.fn(async ({ userId: id }) => {
      events.push(`revoke:${engine}`);
      if (failRevoke) throw new Error('private revocation details');
      sessions[engine].delete(id);
      return { deletedCount: 1 };
    }),
  });
  const mongo = methodsFor('mongo');
  const postgres = methodsFor('postgres');
  const backend = {
    methods: postgres,
    initialize: jest.fn(async () => {
      events.push('backend:initialize');
      if (failInitialize) throw new Error('private connection details');
    }),
    close: jest.fn(async () => {
      events.push('backend:close');
      if (failClose) throw new Error('private shutdown details');
    }),
  };
  const factory = jest.fn(() => backend);
  const runtime = api.createAuthenticationRuntime(
    mongo,
    { BAN_USER_TEST_CONNECTION: 'unused' },
    factory,
  );
  const config = authentication
    ? {
        persistence: {
          authentication,
          postgres: { connectionStringEnv: 'BAN_USER_TEST_CONNECTION' },
        },
      }
    : undefined;
  const initializeAuthentication = jest.fn(async (deployment) => {
    await runtime.initialize(api.getPersistenceConfig(deployment));
    events.push('initialized');
  });
  const closeAuthentication = jest.fn(async () => {
    events.push('close');
    await runtime.close();
  });
  const findUser = jest.fn(async () => {
    events.push('lookup');
    return { _id: mongoId, email: 'user@example.com' };
  });
  const methods = { ...runtime.methods, findUser, initializeAuthentication, closeAuthentication };
  const disconnect = jest.fn(async () => {
    events.push('disconnect');
  });
  const connect = jest.fn(async () => {
    events.push('connect');
  });
  const loadConfig = jest.fn(async () => {
    events.push('config');
    return config;
  });
  const records = new Map();
  const banLogs = {
    opts: { ttl: 7200000 },
    set: jest.fn(async (key, value) => {
      events.push('ban');
      records.set(key, value);
    }),
  };
  const quiet = Object.fromEntries(
    ['purple', 'orange', 'red', 'error'].map((name) => [name, jest.fn()]),
  );
  const process = {
    argv: ['node', 'ban-user', 'user@example.com', '120000'],
    env: { BAN_VIOLATIONS: 'true', BAN_INTERVAL: '20' },
    on: jest.fn(),
  };
  const realBan = evaluate(
    path.resolve(__dirname, '../../api/cache/banViolation.js'),
    {
      '@librechat/data-schemas': { logger: { info: jest.fn() } },
      'librechat-data-provider': { ViolationTypes },
      '@librechat/api': api,
      '~/models': methods,
      './getLogStores': () => banLogs,
    },
    process,
    quiet,
  );
  const banViolation = jest.fn((...args) => realBan(...args));
  let silentExit;
  const completion = new Promise((resolve) => {
    silentExit = jest.fn((code) => {
      events.push('exit');
      resolve(code);
    });
  });
  const run = () => {
    evaluate(
      path.resolve(__dirname, '../ban-user.js'),
      {
        path,
        mongoose: { disconnect },
        '@librechat/api': api,
        'module-alias': () => undefined,
        './helpers': { askQuestion: jest.fn(), silentExit, coloredConsole: quiet },
        '~/models': methods,
        '~/server/services/Config/loadCustomConfig': loadConfig,
        '~/cache/banViolation': banViolation,
        './connect': connect,
      },
      process,
      quiet,
    );
    return completion;
  };
  return {
    run,
    events,
    sessions,
    mongo,
    postgres,
    backend,
    factory,
    config,
    userId,
    methods,
    disconnect,
    loadConfig,
    banLogs,
    records,
    quiet,
    realBan,
    banViolation,
  };
}

describe('ban-user authentication lifecycle', () => {
  it('reproduces the uninitialized facade failure in the real legacy ban callback', async () => {
    const h = harness();
    await expect(
      h.realBan(
        {},
        { clearCookie: jest.fn() },
        {
          type: ViolationTypes.CONCURRENT,
          user_id: h.userId,
          prev_count: 0,
          violation_count: 20,
          duration: 120000,
        },
      ),
    ).rejects.toThrow('Authentication persistence is not initialized');
    expect(h.mongo.deleteAllUserSessions).not.toHaveBeenCalled();
    expect(h.banLogs.set).not.toHaveBeenCalled();
    await h.methods.closeAuthentication();
  });

  it.each([undefined, 'postgres'])(
    'initializes selected storage (%s), revokes sessions and records the ban before cleanup/exit',
    async (authentication) => {
      const h = harness({ authentication });
      expect(await h.run()).toBe(0);
      const selected = authentication || 'mongo';
      const other = selected === 'mongo' ? 'postgres' : 'mongo';
      expect(h.loadConfig).toHaveBeenCalledWith(false, { storageSelection: true });
      expect(h.methods.initializeAuthentication).toHaveBeenCalledWith(h.config);
      expect(h.methods.findUser).toHaveBeenCalledWith({ email: 'user@example.com' });
      expect(h[selected].deleteAllUserSessions).toHaveBeenCalledWith({ userId: h.userId });
      expect(h[other].deleteAllUserSessions).not.toHaveBeenCalled();
      expect(h.sessions[selected].size).toBe(0);
      expect(h.sessions[other].size).toBe(1);
      expect(h.events).toEqual([
        'connect',
        'config',
        ...(authentication ? ['backend:initialize'] : []),
        'initialized',
        'lookup',
        `revoke:${selected}`,
        'ban',
        'close',
        'disconnect',
        ...(authentication ? ['backend:close'] : []),
        'exit',
      ]);
      expect(h.records.get(h.userId)).toEqual(
        expect.objectContaining({
          type: ViolationTypes.CONCURRENT,
          duration: 120000,
          violation_count: 20,
        }),
      );
      expect(h.banViolation.mock.calls[0][2]).toEqual(
        expect.objectContaining({
          user_id: h.userId,
          ban: true,
          ban_duration: 120000,
        }),
      );
      expect(h.methods.closeAuthentication).toHaveBeenCalledTimes(1);
      expect(h.disconnect).toHaveBeenCalledTimes(1);
    },
  );

  it('blocks lookup, revocation and ban records when selected authority initialization fails', async () => {
    const h = harness({ authentication: 'postgres', failInitialize: true });
    expect(await h.run()).toBe(1);
    expect(h.methods.findUser).not.toHaveBeenCalled();
    expect(h.mongo.deleteAllUserSessions).not.toHaveBeenCalled();
    expect(h.postgres.deleteAllUserSessions).not.toHaveBeenCalled();
    expect(h.banLogs.set).not.toHaveBeenCalled();
    expect(h.backend.close).toHaveBeenCalledTimes(1);
    expect(h.disconnect).toHaveBeenCalledTimes(1);
    expect(h.events.at(-1)).toBe('exit');
    expect(JSON.stringify(h.quiet.error.mock.calls)).not.toContain('private connection details');
  });

  it('fails closed on revocation errors and closes both connections before exit', async () => {
    const h = harness({ authentication: 'postgres', failRevoke: true });
    expect(await h.run()).toBe(1);
    expect(h.banLogs.set).not.toHaveBeenCalled();
    expect(h.sessions.postgres.size).toBe(1);
    expect(h.events.slice(-4)).toEqual(['close', 'disconnect', 'backend:close', 'exit']);
    expect(JSON.stringify(h.quiet.error.mock.calls)).not.toContain('private revocation details');
  });

  it('waits for disconnect and returns failure if selected storage cannot close', async () => {
    const h = harness({ authentication: 'postgres', failClose: true });
    expect(await h.run()).toBe(1);
    expect(h.records.has(h.userId)).toBe(true);
    expect(h.disconnect).toHaveBeenCalledTimes(1);
    expect(h.events.at(-1)).toBe('exit');
    expect(JSON.stringify(h.quiet.error.mock.calls)).not.toContain('private shutdown details');
  });
});
