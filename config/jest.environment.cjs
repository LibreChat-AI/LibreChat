/**
 * Node test environment that stops any in-memory MongoDB server a test file
 * left running, after every hook of that file has finished. Teardown in a spec
 * stops at its first rejected step, so without this a failed disconnect leaks
 * the `mongod` process and its temporary data directory for the rest of the run.
 * Servers are recorded by `jest.setup.mongo.cjs`.
 */
const path = require('path');

/** `jest-environment-node` ships with `jest` and is not hoisted to the root. */
const { TestEnvironment } = require(
  require.resolve('jest-environment-node', {
    paths: [path.dirname(require.resolve('jest/package.json'))],
  }),
);

const key = Symbol.for('librechat.test.mongo');

class MongoEnvironment extends TestEnvironment {
  async teardown() {
    const started = this.global[key];
    /** Replica sets first: stopping a set also stops its member servers. */
    const servers = [...(started ?? [])].sort(
      (a, b) => Number(Array.isArray(b.servers)) - Number(Array.isArray(a.servers)),
    );
    for (const server of servers) {
      if (server.state === 'new' || server.state === 'stopped') {
        continue;
      }
      try {
        await server.stop();
      } catch (error) {
        process.stderr.write(`Failed to stop an in-memory MongoDB server: ${error}\n`);
      }
    }
    started?.clear();
    await super.teardown();
  }
}

module.exports = MongoEnvironment;
