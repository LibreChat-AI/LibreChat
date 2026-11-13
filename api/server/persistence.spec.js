const { readFileSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { runInNewContext } = require('node:vm');

describe.each(['index', 'experimental'])('%s entrypoint lifecycle wiring', (entrypoint) => {
  it.each([false, true])(
    'retains the original startup error and cleans up (persistence failure: %s)',
    async (failFavorites) => {
      const file = resolve(__dirname, `${entrypoint}.js`);
      const events = [];
      const errors = [];
      const tasks = new Map();
      const bootError = new Error('boot failure');
      const noop = new Proxy(
        function () {
          return noop;
        },
        {
          get(_target, key) {
            return key === 'then' ? undefined : noop;
          },
        },
      );
      const closeFavorites = async () => {
        events.push('close');
        if (failFavorites) {
          throw new Error('close failure');
        }
      };
      const api = new Proxy(
        {
          cacheConfig: {},
          isEnabled: () => false,
          waitForKeyvRedisClient: async () => {},
          createMetrics: () => ({}),
          registerShutdownTask: (name, fn) => tasks.set(name, fn),
        },
        {
          get(target, key) {
            return Reflect.has(target, key) ? Reflect.get(target, key) : noop;
          },
        },
      );
      const models = new Proxy(
        {
          seedDatabase: async () => {},
          sweepOrphanedPreviews: async () => {},
          initializeFavorites: async (config) => {
            events.push('initialize');
            expect(config.persistence.favorites).toBe('postgres');
            if (failFavorites) {
              throw bootError;
            }
          },
          closeFavorites,
        },
        {
          get(target, key) {
            return Reflect.has(target, key) ? Reflect.get(target, key) : noop;
          },
        },
      );
      runInNewContext(
        readFileSync(file, 'utf8'),
        {
          require: (id) => {
            if (id === 'path') {
              return { resolve, dirname };
            }
            if (id === 'cluster') {
              return { isMaster: false };
            }
            if (id === 'express') {
              return () => ({ locals: {}, disable() {}, set() {}, use() {} });
            }
            if (id === '@librechat/api') {
              return api;
            }
            if (id === '@librechat/data-schemas') {
              return {
                logger: { info() {}, warn() {}, error: (...args) => errors.push(args) },
                runAsSystem: async (fn) => fn(),
              };
            }
            if (id === '~/models') {
              return models;
            }
            if (id === '~/db') {
              return { connectDb: async () => {}, indexSync: async () => {} };
            }
            if (id === './services/Config') {
              return {
                loadCustomConfig: async (print, options) => {
                  expect(print).toBe(false);
                  expect(options).toEqual({ storageSelection: true });
                  return { persistence: { favorites: 'postgres' } };
                },
                getAppConfig: async () => {
                  events.push('config');
                  throw bootError;
                },
              };
            }
            return noop;
          },
          __dirname: dirname(file),
          module: { exports: {} },
          console,
          process: {
            env: {},
            pid: 1,
            on() {},
            exit: (code) => events.push(`exit:${code}`),
          },
          setTimeout,
          clearTimeout,
          setInterval,
          clearInterval,
          Buffer,
        },
        { filename: file },
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(events[0]).toBe('initialize');
      expect(events).toContain('close');
      expect(events).toContain('exit:1');
      const last = errors[errors.length - 1];
      expect(last[last.length - 1]).toBe(bootError);
      if (failFavorites) {
        expect(events).not.toContain('config');
      } else {
        expect(tasks.get('favorites persistence')).toBe(closeFavorites);
        expect(events).toContain('config');
      }
    },
  );
});
