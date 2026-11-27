/**
 * Calibrates the conformance tests: applies each mutant in formal/authz/mutants.json (a one-line
 * change that disables a security check), runs the test it names, and expects it to fail.
 * A mutant that survives means the tests cannot see that check. Files are restored afterwards,
 * including on SIGINT/SIGTERM. Usage: node formal/authz/scripts/mutants.mjs [--only <id>]
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { tests, mutants } = JSON.parse(
  readFileSync(join(root, 'formal/authz/mutants.json'), 'utf8'),
);
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];

const proofs = join(root, 'formal/authz/Authz');
const theorems = new Set(
  readdirSync(proofs).flatMap((name) =>
    Array.from(readFileSync(join(proofs, name), 'utf8').matchAll(/^theorem (\S+)/gm), (m) => m[1]),
  ),
);

let child = null;
/** The mutant currently written to disk, so an interrupt can put the file back. */
let applied = null;

const run = (command, cwd) =>
  new Promise((done) => {
    child = spawn(command, { cwd: join(root, cwd), shell: true, stdio: 'inherit' });
    child.on('close', (code) => {
      child = null;
      done(code === 0);
    });
  });
const passes = (name) => run(`npx jest ${tests[name].file}`, tests[name].cwd);

const restore = () => {
  if (applied === null) {
    return true;
  }
  const { mutant, file, original } = applied;
  applied = null;
  writeFileSync(file, original);
  return (
    !mutant.build ||
    spawnSync(mutant.build, { cwd: root, shell: true, stdio: 'inherit' }).status === 0
  );
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child?.kill(signal);
    if (!restore()) {
      console.error('rebuild after restore failed; rerun the mutant build step by hand');
    }
    process.exit(130);
  });
}

const failures = [];
const files = [...new Set(mutants.map((mutant) => mutant.file))];
if (spawnSync('git', ['diff', '--quiet', 'HEAD', '--', ...files], { cwd: root }).status !== 0) {
  failures.push(
    `files under mutation differ from HEAD; restore them (git checkout -- ${files.join(' ')}) ` +
      'or commit intended changes first',
  );
}
if (only !== null && !mutants.some((mutant) => mutant.id === only)) {
  failures.push(`--only ${only}: no such mutant`);
}
for (const mutant of mutants) {
  if (!theorems.has(mutant.property)) {
    failures.push(`${mutant.id}: property ${mutant.property} is not a theorem in Authz/`);
  }
}
for (const name of failures.length === 0 ? Object.keys(tests) : []) {
  if (!(await passes(name))) {
    failures.push(`baseline: ${name} fails with no mutant applied`);
  }
}

const verdicts = [];
for (const mutant of failures.length === 0 ? mutants : []) {
  if (only !== null && mutant.id !== only) {
    continue;
  }
  const file = join(root, mutant.file);
  const original = readFileSync(file, 'utf8');
  const occurrences = original.split(mutant.find).length - 1;
  if (occurrences !== 1) {
    failures.push(`${mutant.id}: anchor occurs ${occurrences} times in ${mutant.file}`);
    continue;
  }
  let verdict = 'killed';
  applied = { mutant, file, original };
  writeFileSync(
    file,
    original.replace(mutant.find, () => mutant.replace),
  );
  try {
    if (mutant.build && !(await run(mutant.build, '.'))) {
      verdict = 'did not build';
    } else if (await passes(mutant.test)) {
      verdict = 'survived';
    }
  } finally {
    if (!restore()) {
      failures.push(`${mutant.id}: rebuild after restore failed`);
    }
  }
  verdicts.push(`${mutant.id}: ${verdict} (${mutant.property})`);
  console.log(verdicts.at(-1));
  if (verdict !== 'killed') {
    failures.push(verdicts.at(-1));
  }
}

if (spawnSync('git', ['diff', '--quiet', 'HEAD', '--', ...files], { cwd: root }).status !== 0) {
  failures.push('a mutated file differs from HEAD after the run');
}

console.log(`\n${verdicts.join('\n')}`);
const killed = verdicts.filter((line) => line.includes(': killed (')).length;
console.log(`${killed}/${verdicts.length} mutants killed`);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
