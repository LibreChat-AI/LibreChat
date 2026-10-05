#!/usr/bin/env node
/**
 * Smart Reinstall for LibreChat
 *
 * Combines cached dependency installation with Turborepo-powered builds.
 *
 * Dependencies (npm ci):
 *   Hashes the package manifest, lockfile and postinstall patches.
 *   Skips npm ci when those installation inputs have not changed.
 *
 * Package builds (Turborepo):
 *   Turbo hashes each package's source/config inputs (including the
 *   lockfile), caches build outputs (dist/), and restores from cache
 *   when inputs match. This script delegates entirely to turbo for builds.
 *
 * Usage:
 *   npm run smart-reinstall                  # Smart cached mode
 *   npm run smart-reinstall -- --force       # Full clean reinstall, bust all caches
 *   npm run smart-reinstall -- --skip-client # Skip frontend (Vite) build
 *   npm run smart-reinstall -- --clean-cache # Wipe turbo build cache
 *   npm run smart-reinstall -- --verbose     # Turbo verbose output
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { hashDependencies } = require('./dependencies.cjs');

require('./helpers');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEPS_HASH_MARKER = path.join(ROOT_DIR, 'node_modules', '.librechat-deps-hash');

const flags = {
  force: process.argv.includes('--force'),
  cleanCache: process.argv.includes('--clean-cache'),
  skipClient: process.argv.includes('--skip-client'),
  verbose: process.argv.includes('--verbose'),
};

const NODE_MODULES_DIRS = [
  ROOT_DIR,
  path.join(ROOT_DIR, 'packages', 'data-provider'),
  path.join(ROOT_DIR, 'packages', 'data-schemas'),
  path.join(ROOT_DIR, 'packages', 'client'),
  path.join(ROOT_DIR, 'packages', 'api'),
  path.join(ROOT_DIR, 'client'),
  path.join(ROOT_DIR, 'api'),
];

function exec(cmd, opts = {}) {
  execSync(cmd, { cwd: ROOT_DIR, stdio: 'inherit', ...opts });
}

function checkDeps() {
  const lockfile = path.join(ROOT_DIR, 'package-lock.json');
  if (!fs.existsSync(lockfile)) {
    return { needsInstall: true, hash: 'missing' };
  }

  const hash = hashDependencies(ROOT_DIR);

  if (!fs.existsSync(path.join(ROOT_DIR, 'node_modules'))) {
    return { needsInstall: true, hash };
  }
  if (!fs.existsSync(DEPS_HASH_MARKER)) {
    return { needsInstall: true, hash };
  }

  const stored = fs.readFileSync(DEPS_HASH_MARKER, 'utf-8').trim();
  return { needsInstall: stored !== hash, hash };
}

function installDeps(hash) {
  const { deleteNodeModules } = require('./helpers');
  NODE_MODULES_DIRS.forEach(deleteNodeModules);

  console.purple('Cleaning npm cache...');
  exec('npm cache clean --force');

  console.purple('Installing dependencies (npm ci)...');
  exec('npm ci');

  fs.writeFileSync(DEPS_HASH_MARKER, hash, 'utf-8');
}

function runTurboBuild() {
  const args = ['npx', 'turbo', 'run', 'build'];

  if (flags.skipClient) {
    args.push('--filter=!@librechat/frontend');
  }
  if (flags.force) {
    args.push('--force');
  }
  if (flags.verbose) {
    args.push('--verbosity=2');
  }

  const cmd = args.join(' ');
  console.gray(`      ${cmd}\n`);
  exec(cmd);
}

function cleanTurboCache() {
  console.purple('Clearing Turborepo cache...');
  try {
    exec('npx turbo daemon stop', { stdio: 'pipe' });
  } catch {
    // daemon may not be running
  }

  const localTurboCache = path.join(ROOT_DIR, '.turbo');
  if (fs.existsSync(localTurboCache)) {
    fs.rmSync(localTurboCache, { recursive: true });
  }

  try {
    exec('npx turbo clean', { stdio: 'pipe' });
    console.green('Turbo cache cleared.');
  } catch {
    console.gray('Could not clear global turbo cache (may not exist yet).');
  }
}

(async () => {
  const startTime = Date.now();

  console.green('\n Smart Reinstall — LibreChat');
  console.green('─'.repeat(45));

  if (flags.cleanCache) {
    cleanTurboCache();
    if (!flags.force) {
      return;
    }
  }

  // Step 1: Dependencies
  console.purple('\n[1/2] Checking dependencies...');

  if (flags.force) {
    console.orange('      Force mode — reinstalling all dependencies');
    const hash = hashDependencies(ROOT_DIR);
    installDeps(hash);
    console.green('      Dependencies installed.');
  } else {
    const { needsInstall, hash } = checkDeps();
    if (needsInstall) {
      console.orange('      Dependency inputs changed or node_modules missing');
      installDeps(hash);
      console.green('      Dependencies installed.');
    } else {
      console.green('      Dependencies up to date — skipping npm ci');
    }
  }

  // Step 2: Build via Turborepo
  console.purple('\n[2/2] Building packages...');
  runTurboBuild();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.green('─'.repeat(45));
  console.green(`  Done (${elapsed}s)`);
  console.green('  Start the app with:  npm run backend');
  console.green('─'.repeat(45));
})().catch((err) => {
  console.red(`\nError: ${err.message}`);
  if (flags.verbose) {
    console.red(err.stack);
  }
  console.gray('  Tip: run with --force to clean all caches and reinstall from scratch');
  console.gray('  Tip: run with --verbose for detailed output');
  process.exit(1);
});
