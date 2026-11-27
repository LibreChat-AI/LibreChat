/**
 * Helper functions
 * This allows us to give the console some colour when running in a terminal
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Writable } = require('stream');
const { execSync } = require('child_process');

/** @typedef {(message: string) => void} ConsoleColor */
/** @typedef {{ orange: ConsoleColor, green: ConsoleColor, red: ConsoleColor, blue: ConsoleColor, purple: ConsoleColor, cyan: ConsoleColor, yellow: ConsoleColor, white: ConsoleColor, gray: ConsoleColor }} ColoredConsole */

const coloredConsole = /** @type {Console & ColoredConsole} */ (console);

/** @param {string} query @returns {Promise<string>} */
const askQuestion = (query) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question('\x1b[36m' + query + '\n> ' + '\x1b[0m', (ans) => {
      rl.close();
      resolve(ans);
    }),
  );
};

/**
 * @param {string} query
 * @param {NodeJS.ReadableStream} [input]
 * @param {NodeJS.WritableStream} [destination]
 * @returns {Promise<string>}
 */
const askSilentQuestion = (query, input = process.stdin, destination = process.stdout) => {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) {
        destination.write(chunk, encoding);
      }
      callback();
    },
  });
  output.isTTY = destination.isTTY;

  const rl = readline.createInterface({
    input,
    output,
    terminal: input.isTTY,
  });

  destination.write(query);
  muted = true;

  return new Promise((resolve) =>
    rl.question('', (answer) => {
      muted = false;
      destination.write('\n');
      rl.close();
      resolve(answer);
    }),
  );
};

/** @param {string} query @returns {Promise<string>} */
const askMultiLineQuestion = (query) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  coloredConsole.cyan(query);

  return new Promise((resolve) => {
    /** @type {string[]} */
    const lines = [];
    rl.on('line', (line) => {
      if (line.trim() === '.') {
        rl.close();
        resolve(lines.join('\n'));
      } else {
        lines.push(line);
      }
    });
  });
};

function isDockerRunning() {
  try {
    execSync('docker info');
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * Recursively removes a directory's node_modules.
 * Retries on transient ENOTEMPTY/EBUSY errors that fs.rmSync intermittently
 * throws on macOS (APFS) and Windows when entries are removed concurrently.
 */
/** @param {string} dir */
function deleteNodeModules(dir) {
  const nodeModulesPath = path.join(dir, 'node_modules');
  if (fs.existsSync(nodeModulesPath)) {
    coloredConsole.purple(`Deleting node_modules in ${dir}`);
    fs.rmSync(nodeModulesPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

const silentExit = (code = 0) => {
  console.log = () => {};
  process.exit(code);
};

// Set the console colours
coloredConsole.orange = (/** @type {string} */ msg) => console.log('\x1b[33m%s\x1b[0m', msg);
coloredConsole.green = (/** @type {string} */ msg) => console.log('\x1b[32m%s\x1b[0m', msg);
coloredConsole.red = (/** @type {string} */ msg) => console.log('\x1b[31m%s\x1b[0m', msg);
coloredConsole.blue = (/** @type {string} */ msg) => console.log('\x1b[34m%s\x1b[0m', msg);
coloredConsole.purple = (/** @type {string} */ msg) => console.log('\x1b[35m%s\x1b[0m', msg);
coloredConsole.cyan = (/** @type {string} */ msg) => console.log('\x1b[36m%s\x1b[0m', msg);
coloredConsole.yellow = (/** @type {string} */ msg) => console.log('\x1b[33m%s\x1b[0m', msg);
coloredConsole.white = (/** @type {string} */ msg) => console.log('\x1b[37m%s\x1b[0m', msg);
coloredConsole.gray = (/** @type {string} */ msg) => console.log('\x1b[90m%s\x1b[0m', msg);

module.exports = {
  askQuestion,
  askSilentQuestion,
  askMultiLineQuestion,
  silentExit,
  isDockerRunning,
  deleteNodeModules,
  coloredConsole,
};
