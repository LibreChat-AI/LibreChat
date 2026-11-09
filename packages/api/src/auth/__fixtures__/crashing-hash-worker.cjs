const { parentPort } = require('node:worker_threads');

/** Stands in for a hash worker that dies mid-job. */
parentPort.on('message', () => {
  process.exit(1);
});
