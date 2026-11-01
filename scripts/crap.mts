import { Linter } from 'eslint';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import parser from '@typescript-eslint/parser';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import type { Rule } from 'eslint';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FAVORITES = join(ROOT, 'packages/data-schemas/src/methods/favorite.ts');
const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

export interface FunctionReport {
  file: string;
  function: string;
  line: number;
  column: number;
  complexity: number;
  statements: number;
  coveredStatements: number;
  /** Fraction in [0, 1], excluding nested functions; null means no instrumentation. */
  statementCoverage: number | null;
  crap: number | null;
}

type FunctionNode = Extract<
  Rule.Node,
  { type: 'FunctionDeclaration' | 'FunctionExpression' | 'ArrowFunctionExpression' }
>;

interface MeasuredFunction {
  head: number;
  start: number;
  end: number;
  report: FunctionReport;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function crapScore(complexity: number, coverage: number | null): number | null {
  if (!Number.isInteger(complexity) || complexity < 1) {
    throw new Error('Complexity must be a positive integer');
  }
  if (coverage === null) return null;
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1) {
    throw new Error('Statement coverage must be a fraction in [0, 1]');
  }
  return complexity ** 2 * (1 - coverage) ** 3 + complexity;
}

function functionName(node: FunctionNode, context: Rule.RuleContext): string {
  if ('id' in node && node.id?.type === 'Identifier') return node.id.name;
  const parent = node.parent;
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier')
    return parent.id.name;
  if (
    parent.type === 'Property' ||
    parent.type === 'MethodDefinition' ||
    parent.type === 'PropertyDefinition'
  ) {
    return context.sourceCode.getText(parent.key);
  }
  return '(anonymous)';
}

/** Uses ESLint's real classic rule, not an approximation of its branch counting. */
export function measureFunctions(
  file: string,
  source: string,
  coverage?: unknown,
): FunctionReport[] {
  const absoluteFile = resolve(file);
  const functions: MeasuredFunction[] = [];
  const lines = source.split(/\r\n|[\n\r\u2028\u2029]/u);
  const offsets = [0];
  for (const match of source.matchAll(/\r\n|[\n\r\u2028\u2029]/gu)) {
    offsets.push(match.index + match[0].length);
  }
  const offset = (position: unknown): number => {
    if (!isRecord(position)) throw new Error(`${file}: invalid coverage location`);
    const { line, column } = position;
    if (
      typeof line !== 'number' ||
      typeof column !== 'number' ||
      !Number.isInteger(line) ||
      !Number.isInteger(column) ||
      line < 1 ||
      line > lines.length ||
      column < 0 ||
      column > lines[line - 1].length
    ) {
      throw new Error(`${file}: coverage location is outside the source`);
    }
    return offsets[line - 1] + column;
  };
  const displayFile = relative(ROOT, absoluteFile);
  const name = displayFile.startsWith(`..${sep}`) ? absoluteFile : displayFile.split(sep).join('/');
  const linter = new Linter();
  const messages = linter.verify(
    source,
    {
      files: ['**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts}'],
      languageOptions: { parser, ecmaVersion: 'latest', sourceType: 'module' },
      linterOptions: { noInlineConfig: true },
      plugins: {
        metrics: {
          rules: {
            functions: {
              create(context: Rule.RuleContext) {
                return {
                  'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression'(
                    node: Rule.Node,
                  ) {
                    if (
                      node.type !== 'FunctionDeclaration' &&
                      node.type !== 'FunctionExpression' &&
                      node.type !== 'ArrowFunctionExpression'
                    )
                      return;
                    const parent = node.parent;
                    // ESLint reports methods at their property key and arrows at the => token.
                    const isMethod =
                      parent.type === 'Property' ||
                      parent.type === 'MethodDefinition' ||
                      parent.type === 'PropertyDefinition';
                    const declaration = isMethod ? parent : node;
                    const head =
                      !isMethod && node.type === 'ArrowFunctionExpression'
                        ? context.sourceCode.getTokenBefore(
                            node.body,
                            (token) => token.value === '=>',
                          )
                        : declaration;
                    if (!node.range || !node.loc || !head?.range)
                      throw new Error('Parser did not provide ranges');
                    functions.push({
                      head: head.range[0],
                      start: node.range[0],
                      end: node.range[1],
                      report: {
                        file: name,
                        function: functionName(node, context),
                        line: node.loc.start.line,
                        column: node.loc.start.column + 1,
                        complexity: 0,
                        statements: 0,
                        coveredStatements: 0,
                        statementCoverage: null,
                        crap: null,
                      },
                    });
                  },
                };
              },
            },
          },
        },
      },
      rules: {
        'metrics/functions': 'error',
        complexity: ['error', { max: 0, variant: 'classic' }],
      },
    },
    { filename: basename(absoluteFile) },
  );
  for (const message of messages) {
    if (message.fatal || (message.severity === 2 && message.ruleId !== 'complexity')) {
      throw new Error(`${file}:${message.line}: ${message.message}`);
    }
    // ESLint also measures implicit class initializers, which are not source functions.
    if (
      message.ruleId !== 'complexity' ||
      !FUNCTION_TYPES.has(message.nodeType ?? '') ||
      /^Class (?:field initializer|static block)/u.test(message.message)
    ) {
      continue;
    }
    const point = offset({ line: message.line, column: message.column - 1 });
    const owner = functions.find((fn) => fn.head === point);
    const complexity = /has a complexity of (\d+)\./u.exec(message.message)?.[1];
    if (!owner || !complexity || owner.report.complexity !== 0) {
      throw new Error(`${file}: unrecognized ESLint complexity diagnostic: ${message.message}`);
    }
    owner.report.complexity = Number(complexity);
  }
  if (functions.some(({ report }) => report.complexity === 0)) {
    throw new Error(`${file}: ESLint did not measure every function`);
  }
  if (coverage !== undefined) {
    if (
      !isRecord(coverage) ||
      typeof coverage.path !== 'string' ||
      resolve(coverage.path) !== absoluteFile ||
      !isRecord(coverage.statementMap) ||
      !isRecord(coverage.s)
    ) {
      throw new Error(`${file}: invalid coverage entry or source path mismatch`);
    }
    const statements = Object.entries(coverage.statementMap);
    if (statements.length !== Object.keys(coverage.s).length) {
      throw new Error(`${file}: statement map/counter mismatch`);
    }
    for (const [id, location] of statements) {
      const hits = coverage.s[id];
      if (
        !isRecord(location) ||
        typeof hits !== 'number' ||
        !Number.isSafeInteger(hits) ||
        hits < 0
      ) {
        throw new Error(`${file}: invalid statement or counter ${id}`);
      }
      const start = offset(location.start);
      const end = offset(location.end);
      if (start >= end) throw new Error(`${file}: invalid statement range ${id}`);
      // The declaration of a nested function belongs to its parent; its body does not.
      const owner = functions.findLast((fn) => fn.start <= start && end <= fn.end);
      if (!owner) continue;
      owner.report.statements++;
      if (hits > 0) owner.report.coveredStatements++;
    }
  }
  return functions.map(({ report }) => {
    report.statementCoverage = report.statements
      ? report.coveredStatements / report.statements
      : null;
    report.crap = crapScore(report.complexity, report.statementCoverage);
    return report;
  });
}

export function createReport(coverageFile: string, sources: string[] = [FAVORITES]) {
  const coverage: unknown = JSON.parse(readFileSync(resolve(coverageFile), 'utf8'));
  if (!isRecord(coverage)) throw new Error('Expected an Istanbul coverage object');
  const entries = new Map<string, unknown>();
  for (const [file, entry] of Object.entries(coverage)) {
    const key = resolve(file);
    if (entries.has(key)) throw new Error(`Duplicate coverage path: ${file}`);
    entries.set(key, entry);
  }
  return {
    complexityMetric: 'eslint/classic',
    coverageMetric: 'per-function statement fraction (nested functions excluded)',
    functions: [...new Set(sources.map((file) => resolve(file)))].flatMap((file) =>
      measureFunctions(file, readFileSync(file, 'utf8'), entries.get(file)),
    ),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { output: { type: 'string', short: 'o' }, help: { type: 'boolean', short: 'h' } },
    });
    if (values.help) {
      console.log(
        'Usage: node scripts/crap.mts [--output path] <coverage-final.json> [source.ts ...]',
      );
    } else {
      const [coverageFile, ...sources] = positionals;
      if (!coverageFile) throw new Error('Expected coverage-final.json; use --help for usage');
      const files = sources.length ? sources : [FAVORITES];
      const output = resolve(values.output ?? join(dirname(resolve(coverageFile)), 'crap.json'));
      if ([coverageFile, ...files].some((file) => resolve(file) === output)) {
        throw new Error('Output must not overwrite coverage or source files');
      }
      const report = createReport(coverageFile, files);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
      console.log(
        'Advisory CRAP baseline | CC: ESLint classic | Coverage: statements, excluding nested functions',
      );
      console.log('File\tFunction\tLine:Column\tCC\tStatement coverage\tCRAP');
      for (const row of report.functions) {
        const coverage =
          row.statementCoverage === null
            ? 'N/A'
            : `${(row.statementCoverage * 100).toFixed(1)}% (${row.coveredStatements}/${row.statements})`;
        console.log(
          `${row.file}\t${row.function}\t${row.line}:${row.column}\t${row.complexity}\t${coverage}\t${row.crap?.toFixed(2) ?? 'N/A'}`,
        );
      }
      console.log(`JSON: ${output}`);
    }
  } catch (error) {
    console.error(`crap: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
