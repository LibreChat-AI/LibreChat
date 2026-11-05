const { parentPort, workerData } = require('node:worker_threads');
if (workerData === 'stall') {
  // A synchronous parser stall must be interruptible without blocking API timers.
  for (;;) {
    /* deliberate worker-only stall */
  }
}
if (workerData === 'crash') throw new Error('PRIVATE-PARSER-DETAIL /private/upload.xlsx');
if (workerData === 'exit') process.exit(0);
parentPort.postMessage({ ok: true, text: 'recovered' });
