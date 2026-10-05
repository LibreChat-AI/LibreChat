const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Installation output depends on both npm's graph and the patches applied by postinstall. */
function hashDependencies(root) {
  const patchRoot = path.join(root, 'patches');
  const patches = fs.existsSync(patchRoot)
    ? fs
        .readdirSync(patchRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.patch'))
        .map((entry) => `patches/${entry.name}`)
    : [];
  const inputs = ['package.json', 'package-lock.json', ...patches].sort();
  const hash = crypto.createHash('sha256');
  for (const relative of inputs) {
    const location = path.join(root, relative);
    hash.update(relative).update('\0');
    hash.update(fs.existsSync(location) ? fs.readFileSync(location) : '<missing>');
    hash.update('\0');
  }
  return hash.digest('hex');
}

module.exports = { hashDependencies };
