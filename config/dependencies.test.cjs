const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashDependencies } = require('./dependencies.cjs');

test('dependency cache invalidates when an applied patch changes, is renamed, or is removed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-deps-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    const base = hashDependencies(root);
    fs.mkdirSync(path.join(root, 'patches'));
    const patch = path.join(root, 'patches', 'sdk.patch');
    fs.writeFileSync(patch, 'first patch');
    const added = hashDependencies(root);
    assert.notEqual(added, base);
    assert.equal(hashDependencies(root), added);
    fs.writeFileSync(patch, 'fixed patch');
    const changed = hashDependencies(root);
    assert.notEqual(changed, added);
    const renamed = path.join(root, 'patches', 'sdk-new-version.patch');
    fs.renameSync(patch, renamed);
    assert.notEqual(hashDependencies(root), changed);
    fs.unlinkSync(renamed);
    assert.equal(hashDependencies(root), base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
