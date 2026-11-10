import { Linter } from 'eslint';
import { readFileSync } from 'node:fs';
import sonarjs from 'eslint-plugin-sonarjs';
import { basename, resolve } from 'node:path';
import parser from '@typescript-eslint/parser';

import type { Rule } from 'eslint';

import type { ChangedFile } from './changes.mts';

import { git, literalGlob, overlaps } from './changes.mts';
import { createReport, measureFunctions } from '../crap.mts';

interface FunctionLocation {
  line: number;
  column: number;
  start: number;
  end: number;
  range: [number, number];
  nodeRange: [number, number];
  tokens: { start: number; end: number; value: string }[];
  cognitiveComplexity: number;
}

/** Run SonarJS itself. Zero is a measured score; a parse or rule failure is an error. */
export function cognitiveFunctions(file: string, source: string): FunctionLocation[] {
  const functions: FunctionLocation[] = [];
  const linter = new Linter();
  const messages = linter.verify(
    source,
    {
      files: ['**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts}'],
      languageOptions: {
        parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      linterOptions: { noInlineConfig: true },
      plugins: {
        sonarjs,
        locations: {
          rules: {
            functions: {
              create(context: Rule.RuleContext) {
                return {
                  'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression'(
                    node: Rule.Node,
                  ) {
                    if (!node.loc || !node.range) throw new Error('Missing function location');
                    const parent = node.parent;
                    const declaration =
                      parent?.type === 'VariableDeclarator' ||
                      parent?.type === 'MethodDefinition' ||
                      parent?.type === 'Property' ||
                      parent?.type === 'PropertyDefinition'
                        ? parent
                        : node;
                    if (!declaration.range || !declaration.loc)
                      throw new Error('Missing declaration location');
                    functions.push({
                      line: node.loc.start.line,
                      column: node.loc.start.column + 1,
                      start: declaration.loc.start.line,
                      end: node.loc.end.line,
                      range: [declaration.range[0], node.range[1]],
                      nodeRange: [node.range[0], node.range[1]],
                      tokens: context.sourceCode
                        .getTokens(declaration)
                        .filter((token) => token.range[1] <= node.range![1])
                        .map((token) => ({
                          start: token.range[0],
                          end: token.range[1],
                          value: JSON.stringify([token.type, token.value]),
                        })),
                      cognitiveComplexity: 0,
                    });
                  },
                };
              },
            },
          },
        },
      },
      rules: {
        'locations/functions': 'error',
        'sonarjs/cognitive-complexity': ['error', 0],
      },
    },
    { filename: basename(file) },
  );
  const sourceCode = linter.getSourceCode();
  for (const message of messages) {
    if (message.severity !== 2 && !message.fatal) continue;
    if (message.ruleId !== 'sonarjs/cognitive-complexity' || message.fatal) {
      throw new Error(`${file}:${message.line}: ${message.message}`);
    }
    const score = /Cognitive Complexity from (\d+) to/u.exec(message.message)?.[1];
    const offset = sourceCode.getIndexFromLoc({ line: message.line, column: message.column - 1 });
    const owner = functions
      .filter((fn) => fn.range[0] <= offset && offset < fn.range[1])
      .sort((a, b) => a.range[1] - a.range[0] - (b.range[1] - b.range[0]))[0];
    if (!owner || score === undefined)
      throw new Error(`Unrecognized SonarJS diagnostic: ${message.message}`);
    owner.cognitiveComplexity = Number(score);
  }
  return functions;
}

function children(fn: FunctionLocation, functions: FunctionLocation[]): FunctionLocation[] {
  return functions
    .filter(
      (child) =>
        child !== fn &&
        fn.nodeRange[0] <= child.nodeRange[0] &&
        child.nodeRange[1] <= fn.nodeRange[1],
    )
    .filter(
      (child, _index, nested) =>
        !nested.some(
          (parent) =>
            parent !== child &&
            parent.nodeRange[0] <= child.nodeRange[0] &&
            child.nodeRange[1] <= parent.nodeRange[1],
        ),
    );
}

/** Compare a function's own tokens. Editing a child does not select its unchanged parent. */
export function selectedFunctions(
  file: string,
  source: string,
  ranges: ChangedFile['ranges'],
  before?: string,
) {
  const functions = cognitiveFunctions(file, source);
  const fingerprint = (fn: FunctionLocation, all: FunctionLocation[]) => {
    const nested = children(fn, all);
    return fn.tokens
      .flatMap((token) => {
        const child = nested.find(
          (item) => item.nodeRange[0] <= token.start && token.end <= item.nodeRange[1],
        );
        return child ? (token.start === child.nodeRange[0] ? ['<function>'] : []) : [token.value];
      })
      .join('\n');
  };
  const prior = before === undefined ? [] : cognitiveFunctions(file, before);
  const remaining = new Map<string, number>();
  for (const fn of prior) {
    const key = fingerprint(fn, prior);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  // Match unchanged locations first, so inserting a duplicate does not select the old copy.
  const ordered = [...functions].sort(
    (a, b) => Number(overlaps(a.start, a.end, ranges)) - Number(overlaps(b.start, b.end, ranges)),
  );
  const selected = new Set<FunctionLocation>();
  for (const fn of ordered) {
    const key = fingerprint(fn, functions);
    const count = remaining.get(key) ?? 0;
    if (count) remaining.set(key, count - 1);
    else if (before !== undefined || overlaps(fn.start, fn.end, ranges)) selected.add(fn);
  }
  return functions.map((fn) => ({
    ...fn,
    selected: selected.has(fn),
    children: children(fn, functions),
  }));
}

function previousSource(base: string | undefined, file: string): string | undefined {
  if (!base || !git(['ls-tree', '--name-only', '-z', base, '--', file])) return undefined;
  return git(['show', `${base}:${file}`]);
}

export function mutationTarget(
  file: string,
  source: string,
  ranges: ChangedFile['ranges'],
  before?: string,
) {
  const functions = selectedFunctions(file, source, ranges, before);
  const names = measureFunctions(file, source);
  const intervals: [number, number][] = [];
  for (const fn of functions.filter((item) => item.selected)) {
    let start = fn.nodeRange[0];
    for (const child of fn.children.sort((a, b) => a.nodeRange[0] - b.nodeRange[0])) {
      if (start < child.nodeRange[0]) intervals.push([start, child.nodeRange[0]]);
      start = child.nodeRange[1];
    }
    if (start < fn.nodeRange[1]) intervals.push([start, fn.nodeRange[1]]);
  }
  const merged: [number, number][] = [];
  for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  const point = (offset: number) => {
    const lines = source.slice(0, offset).split(/\r\n|[\n\r\u2028\u2029]/u);
    return { line: lines.length, column: lines.at(-1)!.length + 1 };
  };
  const position = (offset: number) => `${point(offset).line}:${point(offset).column - 1}`;
  return {
    file,
    functions: functions
      .filter((fn) => fn.selected)
      .map(({ line, column, nodeRange }) => ({
        line,
        column,
        function: names.find((fn) => fn.line === line && fn.column === column)!.function,
        location: {
          start: { line, column },
          end: point(nodeRange[1]),
        },
      })),
    // Match the exclusive node ends used by Stryker's Babel range comparison.
    mutate: merged.map(
      ([start, end]) => `${literalGlob(file)}:${position(start)}-${position(end)}`,
    ),
  };
}

export function mutationSelection(files: ChangedFile[], base: string) {
  return files
    .map(({ file, ranges }) =>
      mutationTarget(file, readFileSync(file, 'utf8'), ranges, previousSource(base, file)),
    )
    .filter(({ mutate }) => mutate.length);
}

export function riskReport(coverageFile: string, files: ChangedFile[], base?: string) {
  const report = createReport(
    coverageFile,
    files.map(({ file }) => file),
    process.cwd(),
  );
  const selected = new Map(
    files.map(({ file, ranges }) => [
      resolve(file),
      {
        ranges,
        functions: selectedFunctions(
          file,
          readFileSync(file, 'utf8'),
          ranges,
          previousSource(base, file),
        ),
      },
    ]),
  );
  const functions = report.functions.flatMap((row) => {
    const selection = selected.get(resolve(row.file));
    const fn = selection?.functions.find(
      (item) => item.line === row.line && item.column === row.column,
    );
    if (!selection || !fn)
      throw new Error(`Function metrics disagree at ${row.file}:${row.line}:${row.column}`);
    if (!fn.selected) return [];
    return [{ ...row, cognitiveComplexity: fn.cognitiveComplexity }];
  });
  functions.sort(
    (a, b) => (b.crap ?? -1) - (a.crap ?? -1) || b.cognitiveComplexity - a.cognitiveComplexity,
  );
  return { ...report, cognitiveMetric: 'sonarjs/cognitive-complexity', functions };
}

export function riskMarkdown(report: ReturnType<typeof riskReport>): string {
  const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const rows = report.functions.map((row) =>
    [
      `${cell(row.file)}:${row.line}:${row.column}`,
      cell(row.function),
      row.complexity,
      row.cognitiveComplexity,
      row.statementCoverage === null ? 'N/A' : `${(row.statementCoverage * 100).toFixed(1)}%`,
      row.crap?.toFixed(2) ?? 'N/A',
    ].join(' | '),
  );
  return [
    '## Change risk (advisory)',
    '',
    'CRAP uses ESLint classic complexity and per-function statement coverage. Nested functions own their statements.',
    'Cognitive complexity uses SonarJS. N/A means coverage is unavailable, not zero risk.',
    '',
    '| Function location | Name | Cyclomatic | Cognitive | Statement coverage | CRAP |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...rows.map((row) => `| ${row} |`),
    ...(rows.length ? [] : ['No added or edited functions.']),
    '',
  ].join('\n');
}
