const fs = require('node:fs');
const mongoose = require('mongoose');
const { setTimeout: delay } = require('node:timers/promises');

// Only the disposable app process loads this gate. It delays a real database operation;
// it does not replace its result or any provider response.
const file = process.env.KEYCLOAK_TEST_GATE;
if (!file) throw new Error('The Keycloak query gate needs a private state file');
const original = mongoose.Query.prototype.exec;
mongoose.Query.prototype.exec = async function (...args) {
  if (this.model?.modelName !== 'ProviderSession' || this.op !== 'findOneAndUpdate') {
    return original.apply(this, args);
  }
  const filter = this.getFilter();
  const update = this.getUpdate();
  let kind = 'other';
  if (update?.$min?.revokedAt) kind = 'revoke';
  else if (this.getOptions().upsert) kind = 'establish';
  else if (filter.expiresAt?.$gt) kind = 'authorize';
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.armed && state.kind === kind && (!state.sid || state.sid === filter.sid)) {
    const pending = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(pending, JSON.stringify({ kind, sid: filter.sid, waiting: true }));
    fs.renameSync(pending, file);
    const deadline = Date.now() + 45_000;
    while (JSON.parse(fs.readFileSync(file, 'utf8')).waiting) {
      if (Date.now() > deadline) throw new Error('Keycloak query gate was not released');
      await delay(25);
    }
  }
  return original.apply(this, args);
};
