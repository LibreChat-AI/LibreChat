/**
 * Records every in-memory MongoDB server or replica set a test file starts, so
 * `jest.environment.cjs` can stop whatever the file's own cleanup left running,
 * for example when `mongoose.disconnect()` rejected before `stop()` was reached.
 *
 * The classes are patched in a module factory, so a test file that never loads
 * `mongodb-memory-server` does not pay for loading it here.
 */
const key = Symbol.for('librechat.test.mongo');
const started = new Set();
globalThis[key] = started;

jest.doMock('mongodb-memory-server-core', () => {
  const actual = jest.requireActual('mongodb-memory-server-core');
  if (process.platform === 'win32') {
    const { MongoInstance } = jest.requireActual(
      'mongodb-memory-server-core/lib/util/MongoInstance',
    );
    const { prepareCommandArgs } = MongoInstance.prototype;
    MongoInstance.prototype.prepareCommandArgs = function () {
      return prepareCommandArgs.call(this).filter((arg) => arg !== '--nounixsocket');
    };
  }
  for (const Server of [actual.MongoMemoryServer, actual.MongoMemoryReplSet]) {
    const { start } = Server.prototype;
    if (start[key]) {
      continue;
    }
    const tracked = function (...args) {
      started.add(this);
      return start.apply(this, args);
    };
    tracked[key] = true;
    Server.prototype.start = tracked;
  }
  return actual;
});
