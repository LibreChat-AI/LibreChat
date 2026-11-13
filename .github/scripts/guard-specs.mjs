/**
 * Guard specs under codegraph test selection.
 *
 * Selection (the `codegraph_select` jobs in backend-review.yml and frontend-review.yml) narrows a
 * pull request run to the test files an import graph reaches from the change. A spec that reads
 * source with `fs` has no import edge to what it reads: toolCapabilityGates.spec.js scans four
 * source trees, was not selected when #17864 changed one of the files it counts, and then failed
 * on dev. `.github/guard-specs.json` lists every such spec with the paths it reads, and this
 * script adds them to a workspace's decision:
 *
 *   FILES  every guard of the workspace joins the selected files, unless none of the selected
 *          files exists in this checkout: the test job runs FULL on such a stale selection, and
 *          guards that do exist would hide it;
 *   NONE   the workspace runs its guards alone when the change touches a path one of them reads,
 *          renames a file, or edits the list or this script; otherwise it stays skipped.
 *
 * Usage: SELECTED="<files>" node guard-specs.mjs <FILES|NONE> <workspace> <changed.json> [ignore]
 * Run from the root of a checkout of the commit under test. Prints the workspace-relative files
 * to run, space separated; nothing means skip. Any failure exits non-zero and the caller runs
 * the workspace FULL.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, statSync } from 'node:fs';

export const MANIFEST_PATH = '.github/guard-specs.json';
const SCRIPT_PATH = '.github/scripts/guard-specs.mjs';
const MANIFEST_URL = new URL('../guard-specs.json', import.meta.url);

/** A spec file, by the suffixes jest matches in the gated workspaces. */
export const SPEC_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

/**
 * What marks a spec as reading the repository: a filesystem read or walk, together with a path
 * anchored at the spec's own location or the working directory. A spec that only uses temp
 * directories has no anchor; one that only imports has no read.
 */
const FS_READ =
  /\b(?:read(?:File|dir)(?:Sync)?|opendir(?:Sync)?|createReadStream|glob(?:Sync)?|globby)\s*\(/;
const REPO_ANCHOR =
  /__dirname|__filename|process\.cwd\(\)|import\.meta\.(?:url|dirname|filename)|require\.resolve/;

export const readsRepository = (source) => FS_READ.test(source) && REPO_ANCHOR.test(source);

/**
 * Listed paths end up unquoted in the test jobs' shell (`--runTestsByPath $KEEP`), so anything
 * that could split, glob or climb out of the repository is refused here.
 */
const SAFE_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/;
const isSafePath = (path) =>
  typeof path === 'string' && SAFE_PATH.test(path) && !path.split('/').includes('..');

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseManifest(text) {
  const { guards, exempt = {} } = JSON.parse(text);
  if (!isRecord(guards) || !isRecord(exempt)) {
    throw new Error(`${MANIFEST_PATH}: "guards" and "exempt" must be objects`);
  }
  for (const [spec, scans] of Object.entries(guards)) {
    if (!isSafePath(spec) || !SPEC_FILE.test(spec)) {
      throw new Error(`${MANIFEST_PATH}: guard is not a plain spec path: ${spec}`);
    }
    if (!Array.isArray(scans) || scans.length === 0 || !scans.every(isSafePath)) {
      throw new Error(`${MANIFEST_PATH}: ${spec} must list the repository paths it reads`);
    }
    if (spec in exempt) {
      throw new Error(`${MANIFEST_PATH}: ${spec} is both a guard and exempt`);
    }
  }
  for (const [spec, reason] of Object.entries(exempt)) {
    if (!isSafePath(spec) || typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`${MANIFEST_PATH}: exempt spec needs a plain path and a reason: ${spec}`);
    }
  }
  return { guards, exempt };
}

export const loadManifest = () => parseManifest(readFileSync(MANIFEST_URL, 'utf8'));

const covers = (scan, path) => (scan.endsWith('/') ? path.startsWith(scan) : path === scan);

/**
 * A rename reports only its new path, so one can move a file out of a scanned tree unseen; and
 * a change to the list or to this script can change which guards exist. Both count for all.
 */
const touchesEveryGuard = ({ path, status }) =>
  status === 'renamed' || path === MANIFEST_PATH || path === SCRIPT_PATH;

/**
 * @param {object} options
 * @param {{ guards: Record<string, string[]> }} options.manifest
 * @param {'FILES' | 'NONE'} options.mode The workspace's decision after the caller's own checks.
 * @param {string} options.workspace Repository-relative workspace directory, e.g. `packages/api`.
 * @param {{ path: string, status?: string }[]} options.changed The pull request's changed files.
 * @param {string[]} [options.selected] Workspace-relative files already selected (FILES only).
 * @param {(file: string) => boolean} options.exists Whether a workspace-relative file is in the
 *   checkout the tests will run against.
 * @param {string} [options.ignore] Regex of paths the workspace's own jest run excludes.
 * @returns {string[]} Workspace-relative files to run; empty means the workspace stays skipped.
 */
export function withGuards({
  manifest,
  mode,
  workspace,
  changed,
  exists,
  selected = [],
  ignore = '',
}) {
  if (mode !== 'FILES' && mode !== 'NONE') throw new Error(`Unsupported mode: ${mode}`);
  if (typeof exists !== 'function') throw new Error('An exists(file) check is required');
  if (!isSafePath(workspace) || workspace.endsWith('/')) {
    throw new Error(`Unsupported workspace: ${workspace}`);
  }
  if (!Array.isArray(changed) || !changed.every((file) => typeof file?.path === 'string')) {
    throw new Error('The changed-file list must be an array of { path }');
  }
  const prefix = `${workspace}/`;
  const excluded = ignore === '' ? null : new RegExp(ignore);
  const guards = Object.entries(manifest.guards).filter(
    ([spec]) => spec.startsWith(prefix) && !excluded?.test(spec),
  );
  const files = guards.map(([spec]) => spec.slice(prefix.length));
  if (mode === 'FILES') {
    return selected.some(exists) ? [...new Set([...selected, ...files])] : selected;
  }
  const relevant = changed.some(
    (file) =>
      touchesEveryGuard(file) ||
      guards.some(
        ([spec, scans]) => file.path === spec || scans.some((scan) => covers(scan, file.path)),
      ),
  );
  return relevant ? files : [];
}

function main([mode, workspace, changedFile, ignore = '']) {
  const files = withGuards({
    manifest: loadManifest(),
    mode,
    workspace,
    changed: JSON.parse(readFileSync(changedFile, 'utf8')),
    exists: (file) => statSync(join(workspace, file), { throwIfNoEntry: false })?.isFile() === true,
    selected: (process.env.SELECTED ?? '').split(/\s+/).filter(Boolean),
    ignore,
  });
  process.stdout.write(files.join(' '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`guard-specs: ${error.message}`);
    process.exit(1);
  }
}
