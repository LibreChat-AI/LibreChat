const { parentPort } = require('node:worker_threads');

parentPort.on('message', ({ content }) => {
  if (content === 'wait') return;
  if (content === 'crash') throw new Error('PRIVATE-WORKER-DIAGNOSTIC');
  parentPort.postMessage({ ok: true, result: { content, strategies: [] } });
});
