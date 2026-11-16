// Jest's moduleNameMapper is importer-blind, so `~/` cannot mean two directories at once. This
// resolver picks api/ or packages/api/src by the importing file's own directory.
//
// It also keeps two copies of packages/api/src apart, as the built bundle does in normal CI. The
// `@librechat/api` alias loads packages/api/src under its real path. A relative request from
// api/ into packages/api/src (a spec's `jest.mock`, `requireActual` or `require`) resolves under
// a symlinked mirror instead, and the mirror's own relative imports stay in the mirror. Jest keys
// modules and explicit mocks by resolved path, so a spec that mocks a packages/api/src file no
// longer replaces that file inside `jest.requireActual('@librechat/api')`.
//
// `--listTests` resolves without the mirror: related-test selection walks Jest's file map, which
// has no mirror files, so a spec that imports packages/api/src directly stays related to it.
const path = require('path');

/** The mirror symlink, under the checkout's ignored `coverage/` directory. Istanbul instruments
 * only files inside Jest's `rootDir`, so the mirror cannot live outside the checkout. */
function mirrorDir(root) {
  return path.join(root, 'coverage/source-alias/src');
}

const inside = (file, dir) => file === dir || file.startsWith(dir + path.sep);

function resolve(request, options) {
  const ROOT = process.cwd();
  const API = path.join(ROOT, 'api');
  const SRC = path.join(ROOT, 'packages/api/src');
  const MIRROR = mirrorDir(ROOT);
  const fromMirror = inside(options.basedir, MIRROR);
  const fromSrc = fromMirror || inside(options.basedir, SRC);
  const basedir = fromMirror ? SRC + options.basedir.slice(MIRROR.length) : options.basedir;
  const tilde = request.startsWith('~/');
  let target = request;
  if (tilde) {
    target =
      !fromSrc && request === '~/data/auth.json'
        ? path.join(API, '__mocks__/auth.mock.json')
        : path.join(fromSrc ? SRC : API, request.slice(2));
  }
  const resolved = options.defaultResolver(target, { ...options, basedir });
  const relative = tilde || request.startsWith('./') || request.startsWith('../');
  const mirrored =
    relative &&
    (fromMirror || !fromSrc) &&
    inside(resolved, SRC) &&
    !process.argv.includes('--listTests');
  return mirrored ? MIRROR + resolved.slice(SRC.length) : resolved;
}

module.exports = resolve;
module.exports.mirrorDir = mirrorDir;
