import path from 'node:path';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import mongoose from 'mongoose';
import { createMongoAuthenticationMethods } from '@librechat/data-schemas';

const require = createRequire(import.meta.url);
const { createAuthenticationRuntime, getPersistenceConfig } = require('@librechat/api');
const source = ts.transpileModule(
  readFileSync(new URL('./setup/cleanupUser.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  },
).outputText;

for (const authority of ['mongo', 'postgres']) {
  test(`cleanup owns a fresh ${authority} authentication runtime for every call`, async () => {
    const events: string[] = [];
    const errors: unknown[] = [];
    const stores = { mongo: new Set(['first', 'second']), postgres: new Set(['first', 'second']) };
    const base = createMongoAuthenticationMethods(new mongoose.Mongoose());
    const methods = (kind: 'mongo' | 'postgres') => ({
      ...base,
      deleteAllUserSessions: async (id: string | { userId: string }) => {
        assert.equal(typeof id, 'string');
        stores[kind].delete(String(id));
        events.push(`sessions:${kind}`);
        return { deletedCount: 1 };
      },
      deleteTokens: async (query: { userId?: string | { toString(): string } }) => {
        assert.equal(typeof query.userId, 'string');
        events.push(`tokens:${kind}`);
        return { deletedCount: 1 };
      },
    });
    const mongo = methods('mongo');
    const backend = () => ({
      methods: methods('postgres'),
      initialize: async () => {
        events.push('backend:initialize');
      },
      close: async () => {
        events.push('backend:close');
      },
    });
    const model = {
      deleteMany: async () => {
        events.push('delete');
      },
      updateMany: async () => undefined,
    };
    const modules: Record<string, unknown> = {
      path,
      './runtimeEnv': { applyRuntimeEnv() {} },
      'module-alias': () => undefined,
      mongoose: new mongoose.Mongoose(),
      '@librechat/backend/db/connect': {
        connectDb: async () => ({
          connection: {
            close: async () => {
              events.push('mongo:close');
            },
          },
        }),
      },
      '@librechat/backend/models': {
        findUser: async ({ email }: { email: string }) => ({ _id: { toString: () => email } }),
        deleteConvos: async () => ({ deletedCount: 0, messages: { deletedCount: 0 } }),
        deleteMessages: async () => ({ deletedCount: 0 }),
      },
      '@librechat/backend/db/models': {
        User: model,
        Balance: model,
        Transaction: model,
        AclEntry: model,
        Group: model,
      },
      '@librechat/api': {
        getPersistenceConfig,
        createAuthenticationRuntime: () => {
          events.push('runtime:create');
          return createAuthenticationRuntime(mongo, { TEST_AUTH: 'injected' }, backend);
        },
      },
      '@librechat/data-schemas': {
        createMongoAuthenticationMethods: () => mongo,
        createPostgresAuthenticationBackend: backend,
        runAsSystem: (operation: () => Promise<unknown>) => operation(),
      },
      '@librechat/backend/server/services/Config/loadCustomConfig': async () => ({
        persistence: { authentication: authority, postgres: { connectionStringEnv: 'TEST_AUTH' } },
      }),
    };
    const load = Object.assign(
      (name: string) => {
        assert.ok(Object.hasOwn(modules, name), `Unexpected fixture dependency ${name}`);
        return modules[name];
      },
      { resolve: require.resolve },
    );
    const module = {
      exports: {} as { default?: (user: { email: string; password: string }) => Promise<void> },
    };
    runInNewContext(source, {
      module,
      exports: module.exports,
      require: load,
      process: { env: {}, on() {} },
      console: { log() {}, error: (...args: unknown[]) => errors.push(args) },
    });
    assert.equal(typeof module.exports.default, 'function');
    for (const email of ['first', 'second'])
      await module.exports.default!({ email, password: 'unused' });
    assert.deepEqual(errors, []);
    assert.equal(events.filter((event) => event === 'runtime:create').length, 2);
    assert.equal(events.filter((event) => event === 'mongo:close').length, 2);
    assert.equal(events.filter((event) => event === `sessions:${authority}`).length, 2);
    assert.equal(events.filter((event) => event === `tokens:${authority}`).length, 2);
    assert.equal(stores[authority === 'postgres' ? 'postgres' : 'mongo'].size, 0);
    assert.equal(stores[authority === 'postgres' ? 'mongo' : 'postgres'].size, 2);
    assert.equal(
      events.filter((event) => event === 'backend:close').length,
      authority === 'postgres' ? 2 : 0,
    );
  });
}
