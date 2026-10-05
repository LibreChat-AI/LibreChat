import test from 'node:test';
import ts from 'typescript';
import * as prettier from 'prettier';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { compactTypeImports } from './compact.mts';
import { readPrintWidth } from './config.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compact = (source: string, width = 60): string =>
  compactTypeImports(source, 'consumer.tsx', width);
const header = "import type { Message, Conversation, Agent as Assistant } from './models';\n";

function diagnostics(
  content: string,
  model = 'export interface Message { text: string } export interface Conversation { title: string } export interface Agent { name: string }',
): readonly ts.Diagnostic[] {
  const files = new Map([
    ['/consumer.tsx', content],
    ['/models.ts', model],
  ]);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      const text = files.get(name);
      return text === undefined
        ? undefined
        : ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    },
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name),
  };
  const program = ts.createProgram(
    ['/consumer.tsx'],
    {
      noLib: true,
      strict: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    host,
  );
  const source = program.getSourceFile('/consumer.tsx');
  assert.ok(source);
  return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
}

test('compacts named types, resolves aliases, and preserves typechecking', () => {
  const source =
    header +
    'type Row = [Message, Conversation, Assistant];\ninterface Props extends Message { agent: Assistant }\n';
  const output = compact(source);
  assert.equal(
    output,
    "import type * as t from './models';\ntype Row = [t.Message, t.Conversation, t.Agent];\ninterface Props extends t.Message { agent: t.Agent }\n",
  );
  assert.equal(diagnostics(source).length, 0);
  assert.equal(diagnostics(output).length, 0);
  assert.equal(compact(output), output);
});

test('respects printWidth rather than existing line breaks', () => {
  const source =
    "import type {\n  Message,\n  Conversation,\n} from './models';\ntype Row = [Message, Conversation];\n";
  assert.equal(compact(source, 100), source);
  assert.match(compact(source, 40), /import type \* as t/);
  assert.equal(compact(header, header.trimEnd().length), header);
});

test('leaves values, inline types, defaults, and existing namespaces untouched', () => {
  for (const source of [
    "import { Message, Conversation, Agent } from './models';\n",
    "import { type Message, type Conversation, Agent } from './models';\n",
    "import type Models from './models';\n",
    "import type * as models from './models';\n",
    "import type { Message } from 'a-very-long-module-specifier-that-exceeds-the-width';\n",
  ])
    assert.equal(compact(source, 20), source);
});

test('does not rewrite shadowed names, property keys, strings, or ordinary comments', () => {
  const source =
    header +
    'type Box<Message> = { Message: Message; agent: Assistant };\ntype Original = Message;\nconst label = "Message";\n// Message stays a comment\n';
  assert.equal(
    compact(source),
    'import type * as t from \'./models\';\ntype Box<Message> = { Message: Message; agent: t.Agent };\ntype Original = t.Message;\nconst label = "Message";\n// Message stays a comment\n',
  );
});

test('avoids capture by identifiers in nested scopes and imported aliases', () => {
  const source = header + 'type Box<t, t2> = [Message, t, t2];\n';
  assert.equal(
    compact(source),
    "import type * as t3 from './models';\ntype Box<t, t2> = [t3.Message, t, t2];\n",
  );
});

test('handles multiple modules with distinct namespaces', () => {
  const source =
    header +
    "import type { Widget, WidgetConfiguration } from './widgets';\ntype Row = [Message, Widget];\n";
  assert.equal(
    compact(source, 40),
    "import type * as t from './models';\nimport type * as t2 from './widgets';\ntype Row = [t.Message, t2.Widget];\n",
  );
});

test('preserves comments and resolution attributes around the import clause', () => {
  const source = '// leading\n' + header.trimEnd() + ' // trailing\ntype Row = Message;\n';
  assert.equal(
    compact(source),
    "// leading\nimport type * as t from './models'; // trailing\ntype Row = t.Message;\n",
  );
  const attributed =
    header.replace(';', " with { 'resolution-mode': 'import' };") + 'type Row = Message;\n';
  assert.match(
    compact(attributed),
    /import type \* as t from '\.\/models' with \{ 'resolution-mode': 'import' \};/,
  );
  const commented = header.replace('Message,', 'Message, /* retained */');
  assert.equal(compact(commented), commented);
});

test('measures complete attributed imports and preserves their syntax at the width boundary', async () => {
  for (const keyword of ['with', 'assert']) {
    for (const mode of ['import', 'require']) {
      const suffix = ` ${keyword} { 'resolution-mode': '${mode}' };\n`;
      const declaration = header.trimEnd().slice(0, -1) + suffix;
      const source = declaration + 'type Row = [Message, Conversation, Assistant];\n';
      const width = declaration.trimEnd().length;
      assert.ok(header.trimEnd().length <= 100 && width > 100);
      assert.equal(compact(source, width), source);
      const output = compact(source, width - 1);
      assert.equal(
        output,
        `import type * as t from './models'${suffix}type Row = [t.Message, t.Conversation, t.Agent];\n`,
      );
      assert.equal(compact(source, 100), output);
      const multiline = source
        .replace("{ 'resolution-mode':", "{\n  'resolution-mode':")
        .replace(/ };/, '\n};');
      assert.notEqual(compact(multiline, 100), multiline);
      const formatted = await prettier.format(output, {
        parser: 'typescript',
        printWidth: 100,
        singleQuote: true,
      });
      assert.equal(compact(formatted, 100), formatted);
    }
  }
});

test('formatter, dependency and tooling inputs select the same local and CI gate', async () => {
  const workflow = (
    await readFile(join(ROOT, '.github/workflows/static-checks.yml'), 'utf8')
  ).replace(/\r\n?/g, '\n');
  const filter = workflow.match(/^ {12}import_tools:\n((?: {14}- [^\n]+\n)+)/m);
  assert.ok(filter, 'import_tools filter exists');
  const paths = [...filter[1].matchAll(/- '([^']+)'/g)].map((match) => match[1]);
  for (const manifest of [
    'package.json',
    'package-lock.json',
    '.prettierrc',
    'scripts/static-checks.mts',
    'scripts/sort-imports.mts',
  ]) {
    assert.ok(
      paths.includes(manifest),
      `${manifest} selects tooling checks without a source change`,
    );
  }
  const trigger = workflow.slice(
    workflow.indexOf('    paths:'),
    workflow.indexOf('\npermissions:'),
  );
  assert.ok(trigger.includes("- '.prettierrc'"), 'formatter-only changes start the workflow');
  assert.match(
    workflow,
    /name: Test and typecheck import cleanup tooling\n {8}if: always\(\) && steps\.paths\.outputs\.import_tools == 'true'/,
  );
  assert.ok(
    workflow.includes(
      'run: node scripts/static-checks.mts scripts/imports/compact.mts --only import-tools',
    ),
  );
  for (const input of [
    ...paths.filter((path) => !path.includes('*')),
    'scripts/imports/compact.mts',
    'scripts/imports/tsconfig.json',
  ]) {
    const result = spawnSync(
      process.execPath,
      ['scripts/static-checks.mts', input, '--list', '--only', 'import-tools'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Import tooling \(import-tools\)\s+would run/, input);
  }
  const unrelated = spawnSync(
    process.execPath,
    ['scripts/static-checks.mts', 'client/src/common/types.ts', '--list', '--only', 'import-tools'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.match(unrelated.stdout, /Import tooling \(import-tools\)\s+not affected/);
});

test('rewrites documentation types and qualified type queries', () => {
  const source =
    header +
    '/** @param {Message} message */\nfunction show(message: Message): void {}\ntype Field = typeof Message.field;\n';
  assert.equal(
    compact(source),
    "import type * as t from './models';\n/** @param {t.Message} message */\nfunction show(message: t.Message): void {}\ntype Field = typeof t.Message.field;\n",
  );
});

test('skips re-exported bindings rather than producing invalid export syntax', () => {
  for (const statement of [
    'export type { Message };',
    'export type { Message as PublicMessage };',
    'export { Message as PublicMessage };',
  ]) {
    const source = header + statement + '\ntype Row = Conversation;\n';
    assert.equal(compact(source), source);
  }
});

test('skips unsafe value uses and malformed input', () => {
  for (const use of ['const row = { Message };', 'const row = Message;', 'type Row = ;']) {
    const source = header + use + '\n';
    assert.equal(compact(source), source);
  }
  const stringExport = "import type { 'strange-name' as Message, Conversation } from './models';\n";
  assert.equal(compact(stringExport, 20), stringExport);
});

test('skips conflicting declarations and documentation links', () => {
  for (const suffix of [
    'interface Message {}\ntype Row = Message;\n',
    "import type { Message } from './other';\ntype Row = Message;\n",
    '/** {@link Message} */\ntype Row = Conversation;\n',
  ])
    assert.equal(compact(header + suffix), header + suffix);
});

test('preserves synthetic default aliases and their type namespaces', () => {
  const source =
    "import type { default as Message, Conversation } from './models';\ntype Row = [Message, Conversation, Message.Conversation];\n";
  const model =
    'declare class Message { text: string } declare namespace Message { interface Conversation { title: string } } export = Message;';
  assert.equal(diagnostics(source, model).length, 0);
  const output = compact(source);
  assert.equal(output, source);
  assert.equal(diagnostics(output, model).length, 0);
});

test('qualifies namespace members of ordinary named aliases', () => {
  const source = header + 'type Row = [Message, Assistant.Options];\n';
  assert.equal(
    compact(source),
    "import type * as t from './models';\ntype Row = [t.Message, t.Agent.Options];\n",
  );
});

test('compacts consistently with Windows, POSIX, and relative filenames', () => {
  const source = header + 'type Row = [Message, Conversation, Assistant];\n';
  const expected = compact(source);
  assert.notEqual(expected, source);
  for (const file of [
    'C:\\repo\\consumer.tsx',
    'C:/repo/consumer.tsx',
    '/repo/consumer.tsx',
    'src\\consumer.tsx',
    'src/consumer.tsx',
  ])
    assert.equal(compactTypeImports(source, file, 60), expected, file);
});

test('output stays compact after Prettier formats it', async () => {
  const source = await prettier.format(
    header + 'type Row = [Message, Conversation, Assistant];\n',
    { parser: 'typescript', printWidth: 60, singleQuote: true },
  );
  const output = compact(source);
  assert.ok(
    await prettier.check(output, { parser: 'typescript', printWidth: 60, singleQuote: true }),
  );
  assert.equal(
    compact(
      await prettier.format(output, { parser: 'typescript', printWidth: 60, singleQuote: true }),
    ),
    output,
  );
});

test('normal CLI and pre-commit cleanup compact types, and checks reject eligible imports', async () => {
  const directory = await mkdtemp(join(ROOT, 'client/src/.compact-imports-test-'));
  const file = join(directory, 'fixture.ts');
  const width = await readPrintWidth(join(ROOT, '.prettierrc'));
  let names = 'Message, Conversation, AgentConfiguration, AgentPermission, AgentCapability';
  for (let index = 0; `import type { ${names} } from './models';`.length <= width; index++) {
    names += `, ExtraType${index}`;
  }
  const source = `import { useState } from 'react';\nimport type { ${names} } from './models';\n\ntype Row = Message;\n`;
  const run = (...flags: string[]) =>
    spawnSync(process.execPath, ['scripts/sort-imports.mts', ...flags, file], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  try {
    await writeFile(file, source);
    const check = run('--check');
    assert.equal(check.status, 1, check.stderr);
    assert.equal(await readFile(file, 'utf8'), source);
    const staticCheck = (): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, ['scripts/static-checks.mts', '--only', 'imports', file], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    const rejected = staticCheck();
    assert.equal(rejected.status, 1, String(rejected.stderr));
    assert.equal(await readFile(file, 'utf8'), source);
    const converted = run();
    assert.equal(converted.status, 0, converted.stderr);
    const output = await readFile(file, 'utf8');
    assert.equal(
      output,
      "import { useState } from 'react';\nimport type * as t from './models';\n\ntype Row = t.Message;\n",
    );
    assert.equal(run('--check').status, 0);
    const accepted = staticCheck();
    assert.equal(accepted.status, 0, String(accepted.stderr));
    assert.equal(run().status, 0);
    assert.equal(await readFile(file, 'utf8'), output);

    await writeFile(file, source);
    const hooks: { '*.{js,jsx,ts,tsx}': string[] } = createRequire(import.meta.url)(
      join(ROOT, '.husky/lint-staged.config.js'),
    );
    const [command, ...args] = hooks['*.{js,jsx,ts,tsx}'][0].split(' ');
    assert.equal(command, 'node');
    const hook = spawnSync(process.execPath, [...args, file], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(await readFile(file, 'utf8'), output);

    await writeFile(file, '// sort-imports-ignore\n' + source);
    assert.equal(run('--check').status, 0);
    assert.equal(run().status, 0);
    assert.equal(await readFile(file, 'utf8'), '// sort-imports-ignore\n' + source);

    const longImport = source.split('\n')[1] + '\n';
    let attributedNames = 'Message, Conversation, Agent as Assistant';
    for (
      let index = 0;
      `import type { ${attributedNames} } from './models' with { 'resolution-mode': 'import' };`
        .length <= width;
      index++
    ) {
      attributedNames += `, AttributeType${index}`;
    }
    const attributed = `import type { ${attributedNames} } from './models' with { 'resolution-mode': 'import' };\ntype Row = Message;\n`;
    await writeFile(file, attributed);
    assert.equal(run('--check').status, 1);
    assert.equal(staticCheck().status, 1);
    assert.equal(await readFile(file, 'utf8'), attributed);
    const attributedHook = spawnSync(process.execPath, [...args, file], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(attributedHook.status, 0, attributedHook.stderr);
    assert.equal(
      await readFile(file, 'utf8'),
      "import type * as t from './models' with { 'resolution-mode': 'import' };\ntype Row = t.Message;\n",
    );
    assert.equal(run('--check').status, 0);
    assert.equal(staticCheck().status, 0);

    for (const exempt of [
      longImport + 'export type { Message };\n',
      longImport.replace('Message,', 'Message, /* retained */'),
      "import type { default as Message, Conversation, AgentConfiguration, AgentPermission } from './models';\n",
      "import { Message, Conversation, AgentConfiguration, AgentPermission, AgentCapability } from './models';\n",
      "import type { Message, Conversation } from './models';\n",
    ]) {
      await writeFile(file, exempt);
      assert.equal(run('--check').status, 0, exempt);
      assert.equal(run().status, 0, exempt);
      assert.equal(await readFile(file, 'utf8'), exempt);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('validates the real formatter width and rejects missing or mistyped cleanup policy', async () => {
  assert.ok((await readPrintWidth(join(ROOT, '.prettierrc'))) > 0);
  const directory = await mkdtemp(join(ROOT, 'scripts/imports/.width-'));
  const file = join(directory, '.prettierrc');
  try {
    for (const width of [80, 100, 140]) {
      await writeFile(file, JSON.stringify({ printWidth: width }));
      assert.equal(await readPrintWidth(file), width);
    }
    for (const config of [
      {},
      { printWidth: '100' },
      { printWidth: null },
      { printWidth: 0 },
      { printWidth: -1 },
      { printWidth: 10.5 },
    ]) {
      await writeFile(file, JSON.stringify(config));
      await assert.rejects(readPrintWidth(file), /positive integer printWidth/);
    }
    await writeFile(file, '{ invalid');
    await assert.rejects(readPrintWidth(file), SyntaxError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the shared tooling gate fails on tests, types and formatting instead of reporting an empty pass', async () => {
  const directory = await mkdtemp(join(ROOT, 'scripts/imports/.gate-'));
  const tooling = join(directory, 'scripts/imports');
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      types: ['node'],
    },
    include: ['*.mts'],
  };
  const cleanTest = "import test from 'node:test';\ntest('fixture', () => {});\n";
  const cleanType = "export const value: string = 'ok';\n";
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
  const run = () =>
    spawnSync(
      process.execPath,
      ['scripts/static-checks.mts', '.prettierrc', '--only', 'import-tools', '--verbose'],
      { cwd: directory, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
  try {
    await mkdir(tooling, { recursive: true });
    await symlink(
      join(ROOT, 'node_modules'),
      join(directory, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await copyFile(
      join(ROOT, 'scripts/static-checks.mts'),
      join(directory, 'scripts/static-checks.mts'),
    );
    await copyFile(join(ROOT, 'scripts/i18n.mts'), join(directory, 'scripts/i18n.mts'));
    await writeFile(
      join(directory, '.prettierrc'),
      JSON.stringify({ printWidth: 100, singleQuote: true }),
    );
    await writeFile(
      join(tooling, 'tsconfig.json'),
      await prettier.format(JSON.stringify(config), { parser: 'json' }),
    );
    await writeFile(join(directory, 'scripts/sort-imports.mts'), 'export {};\n');
    await writeFile(join(tooling, 'compact.test.mts'), cleanTest);
    await writeFile(join(tooling, 'fixture.mts'), cleanType);
    const green = run();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /tests 1/);
    assert.match(green.stdout, /All matched files use Prettier code style/);
    assert.match(green.stdout, /Import tooling/);

    await writeFile(
      join(tooling, 'compact.test.mts'),
      "import test from 'node:test';\ntest('fixture', () => { throw new Error('gate-test-failure'); });\n",
    );
    const failedTest = run();
    assert.equal(failedTest.status, 1);
    assert.match(failedTest.stdout, /gate-test-failure/);
    await writeFile(join(tooling, 'compact.test.mts'), cleanTest);

    await writeFile(join(tooling, 'fixture.mts'), 'export const value: string = 1;\n');
    const failedType = run();
    assert.equal(failedType.status, 1);
    assert.match(failedType.stdout, /TS2322/);
    await writeFile(join(tooling, 'fixture.mts'), cleanType);

    await writeFile(join(tooling, 'fixture.mts'), 'export  const value:string="ok";\n');
    const failedFormat = run();
    assert.equal(failedFormat.status, 1);
    assert.match(failedFormat.stdout, /Code style issues/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('changed-file CI checks compare the synthetic merge against its tested dev parent', async () => {
  const workflow = (
    await readFile(join(ROOT, '.github/workflows/static-checks.yml'), 'utf8')
  ).replace(/\r\n?/g, '\n');
  assert.equal(
    (workflow.match(/git diff -z --name-only --diff-filter=ACMRTUXB HEAD\^1 HEAD/g) ?? []).length,
    3,
  );
  const directory = await mkdtemp(join(ROOT, 'scripts/imports/.merge-selection-'));
  const git = (...args: string[]): string => {
    const result = spawnSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'rerere.enabled=false',
        ...args,
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '--initial-branch=dev');
    await mkdir(join(directory, 'client'), { recursive: true });
    await mkdir(join(directory, 'scripts'), { recursive: true });
    await writeFile(join(directory, 'client/upstream.ts'), 'export const value = 1;\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('switch', '-c', 'feature');
    await writeFile(join(directory, 'scripts/tooling.mts'), 'export const tool = 1;\n');
    git('add', '.');
    git('commit', '-m', 'tooling change');
    git('switch', 'dev');
    await writeFile(join(directory, 'client/upstream.ts'), 'export const value = 2;\n');
    git('add', '.');
    git('commit', '-m', 'new upstream source');
    git('merge', '--no-ff', 'feature', '-m', 'synthetic PR merge');
    assert.ok(git('diff', '--name-only', base, 'HEAD').includes('client/upstream.ts'));
    assert.equal(git('diff', '--name-only', 'HEAD^1', 'HEAD'), 'scripts/tooling.mts');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
