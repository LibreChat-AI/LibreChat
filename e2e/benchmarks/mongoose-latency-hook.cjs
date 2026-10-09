const mongoose = require('mongoose');

const delayMs = Number.parseInt(process.env.E2E_LATENCY_MONGO_DELAY_MS ?? '', 10);
const patched = Symbol.for('librechat.e2e.mongooseLatencyPatched');

function patchExec(prototype) {
  if (!Number.isInteger(delayMs) || delayMs <= 0 || prototype[patched]) {
    return;
  }

  const originalExec = prototype.exec;
  Object.defineProperty(prototype, patched, { value: true });
  prototype.exec = async function delayedExec(...args) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return originalExec.apply(this, args);
  };
}

patchExec(mongoose.Query.prototype);
patchExec(mongoose.Aggregate.prototype);
