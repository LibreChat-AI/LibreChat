import { extname } from 'node:path';
import { parse } from '@babel/parser';
import { isClass, isFunction, VISITOR_KEYS } from '@babel/types';
import type { Class as ClassLike, Comment, Function as FunctionLike, Node } from '@babel/types';
import type { ParserPlugin } from '@babel/parser';
import type { ChangedRange } from './changes.mts';
import { literalGlob } from './changes.mts';

export interface Point {
  line: number;
  column: number;
}

export interface ChangedFunction {
  line: number;
  column: number;
  function: string;
  location: { start: Point; end: Point };
}

export interface Suppression {
  line: number;
  mutators: string;
  reason?: string;
}

export interface ChangedRegions {
  /** Stryker mutate ranges (`file:L:C-L:C`), mutually disjoint. */
  mutate: string[];
  /** Function-like nodes that own at least one selected region, for progress labeling. */
  functions: ChangedFunction[];
  /** New-side executable (non-blank, non-comment) lines the diff marked as changed. */
  lines: number[];
  /** Deletion points (new-side line after which content was removed) that selected nothing. */
  deletions: number[];
  /** `// Stryker disable` comments with no reason, or naming `all`. Advisory, never a failure. */
  suppressions: Suppression[];
}

// Mirrors Stryker's own directive comment grammar (directive-bookkeeper.ts), so a flagged
// comment is one Stryker itself would also recognize.
const DIRECTIVE = /^\s?Stryker disable(?: next-line)? ([a-zA-Z, ]+)(?::(.+)?)?/u;

function findSuppressions(comments: readonly Comment[]): Suppression[] {
  const suppressions: Suppression[] = [];
  for (const comment of comments) {
    const match = DIRECTIVE.exec(comment.value);
    if (!match) continue;
    const mutators = match[1].trim();
    const reason = match[2]?.trim() || undefined;
    const wildcard = mutators.split(',').some((name) => name.trim().toLowerCase() === 'all');
    if (wildcard || !reason) suppressions.push({ line: comment.loc!.start.line, mutators, reason });
  }
  return suppressions;
}

interface Span {
  start: number;
  end: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

interface Result {
  full: boolean;
  intervals: Span[];
}

function parserPlugins(file: string): ParserPlugin[] {
  const ext = extname(file).toLowerCase();
  if (ext === '.tsx') return ['typescript', 'jsx'];
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return ['typescript', 'decorators-legacy'];
  return [
    'doExpressions',
    'exportDefaultFrom',
    'functionBind',
    'functionSent',
    'importMeta',
    ['pipelineOperator', { proposal: 'fsharp' }],
    'throwExpressions',
    'v8intrinsic',
    'partialApplication',
    'decorators',
    'jsx',
  ];
}

/** A line is executable when some character on it is not inside a comment. */
function executableLines(source: string, comments: readonly Comment[]): Set<number> {
  const executable = new Set<number>();
  const lineBreak = /\r\n|[\n\r\u2028\u2029]/gu;
  let lineStart = 0;
  let line = 1;
  const markIfExecutable = (start: number, end: number) => {
    const text = source.slice(start, end);
    if (!text.trim()) return;
    // Compare the line's non-whitespace content, not its full span: an indented comment's own
    // offset starts after the indentation, so the raw line bounds never sit inside the comment.
    const contentStart = start + (text.length - text.trimStart().length);
    const contentEnd = end - (text.length - text.trimEnd().length);
    const covered = comments.some(
      (comment) => comment.start! <= contentStart && contentEnd <= comment.end!,
    );
    if (!covered) executable.add(line);
  };
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = lineBreak.exec(source))) {
    markIfExecutable(lineStart, match.index);
    lineStart = match.index + match[0].length;
    line += 1;
  }
  markIfExecutable(lineStart, source.length);
  return executable;
}

function spanOf(node: Node): Span {
  const loc = node.loc!;
  return {
    start: node.start!,
    end: node.end!,
    startLine: loc.start.line,
    startColumn: loc.start.column,
    endLine: loc.end.line,
    endColumn: loc.end.column,
  };
}

function full(node: Node): Result {
  return { full: true, intervals: [spanOf(node)] };
}

const empty: Result = { full: false, intervals: [] };

function containerBody(node: Node): Node[] | undefined {
  switch (node.type) {
    case 'Program':
      return node.body;
    case 'BlockStatement':
      return node.body;
    case 'ClassBody':
      return node.body;
    case 'StaticBlock':
      return node.body;
    case 'TSModuleBlock':
      return node.body;
    default:
      return undefined;
  }
}

function isNode(value: unknown): value is Node {
  return !!value && typeof value === 'object' && 'type' in (value as object);
}

function present<T>(value: T): value is NonNullable<T> {
  return value !== null && value !== undefined;
}

/** Header/body children of a compound statement. All must be full for the statement to be full. */
function compoundChildren(node: Node): Node[] | undefined {
  switch (node.type) {
    case 'IfStatement':
      return [node.test, node.consequent, node.alternate].filter(present);
    case 'WhileStatement':
    case 'DoWhileStatement':
      return [node.test, node.body];
    case 'ForStatement':
      return [node.init, node.test, node.update, node.body].filter(present);
    case 'ForInStatement':
    case 'ForOfStatement':
      return [node.left, node.right, node.body];
    case 'SwitchStatement':
      return [node.discriminant, ...node.cases];
    case 'SwitchCase':
      return [...(node.test ? [node.test] : []), ...node.consequent];
    case 'TryStatement':
      return [node.block, node.handler, node.finalizer].filter(present);
    case 'CatchClause':
      return [...(node.param ? [node.param] : []), node.body];
    case 'LabeledStatement':
      return [node.body];
    default:
      return undefined;
  }
}

function childFields(node: Node): Node[] {
  const keys = VISITOR_KEYS[node.type] ?? [];
  const children: Node[] = [];
  for (const key of keys) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) children.push(item);
    } else if (isNode(value)) {
      children.push(value);
    }
  }
  return children;
}

interface Boundary {
  node: Node;
  parent: Node;
}

/** Nested function/class-like nodes, without descending into them (they are handled on their own). */
function findBoundaries(node: Node, parent: Node, boundaries: Boundary[]): void {
  for (const child of childFields(node)) {
    if (isFunction(child) || isClass(child)) boundaries.push({ node: child, parent: node });
    else findBoundaries(child, node, boundaries);
  }
}

function nameOf(node: FunctionLike | ClassLike, parent: Node): string {
  if (node.type === 'FunctionDeclaration' && node.id) return node.id.name;
  if (node.type === 'ClassMethod' || node.type === 'ObjectMethod') {
    const key = node.key;
    const name =
      key.type === 'Identifier'
        ? key.name
        : key.type === 'StringLiteral'
          ? key.value
          : '<computed>';
    return node.kind !== 'method' ? `${node.kind} ${name}` : name;
  }
  if (node.type === 'ClassPrivateMethod') {
    const name = `#${node.key.id.name}`;
    return node.kind !== 'method' ? `${node.kind} ${name}` : name;
  }
  if (node.type === 'ClassDeclaration' && node.id) return node.id.name;
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier')
    return parent.id.name;
  if (parent.type === 'AssignmentExpression' && parent.left.type === 'Identifier')
    return parent.left.name;
  if (parent.type === 'ObjectProperty' && parent.key.type === 'Identifier') return parent.key.name;
  if (parent.type === 'ClassProperty' && parent.key.type === 'Identifier') return parent.key.name;
  return '<anonymous>';
}

/** Gaps of `node` outside every boundary, each a candidate mutate span on its own. */
function gaps(node: Node, boundaries: Node[]): Span[] {
  const sorted = [...boundaries].sort((a, b) => a.start! - b.start!);
  const spans: Span[] = [];
  let cursor = { offset: node.start!, line: node.loc!.start.line, column: node.loc!.start.column };
  for (const boundary of sorted) {
    if (cursor.offset < boundary.start!) {
      spans.push({
        start: cursor.offset,
        end: boundary.start!,
        startLine: cursor.line,
        startColumn: cursor.column,
        endLine: boundary.loc!.start.line,
        endColumn: boundary.loc!.start.column,
      });
    }
    cursor = {
      offset: boundary.end!,
      line: boundary.loc!.end.line,
      column: boundary.loc!.end.column,
    };
  }
  if (cursor.offset < node.end!) {
    spans.push({
      start: cursor.offset,
      end: node.end!,
      startLine: cursor.line,
      startColumn: cursor.column,
      endLine: node.loc!.end.line,
      endColumn: node.loc!.end.column,
    });
  }
  return spans;
}

export function changedRegions(
  file: string,
  source: string,
  ranges: ChangedRange[],
): ChangedRegions {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: parserPlugins(file),
    allowReturnOutsideFunction: true,
    errorRecovery: false,
  });
  const execLines = executableLines(source, ast.comments ?? []);
  const changedLines = new Set<number>();
  for (const range of ranges) {
    if (range.count === 0) continue;
    for (let line = range.start; line < range.start + range.count; line++) {
      if (execLines.has(line)) changedLines.add(line);
    }
  }
  const deletionPoints = ranges.filter((range) => range.count === 0).map((range) => range.start);
  const consumed = new Set<number>();
  const functions: ChangedFunction[] = [];

  /** A line range is selected when it covers a changed executable line, or strictly contains a deletion point. */
  const selectedLines = (startLine: number, endLine: number): boolean => {
    let hit = false;
    for (const line of changedLines) {
      if (startLine <= line && line <= endLine) hit = true;
    }
    for (const point of deletionPoints) {
      if (startLine <= point && point < endLine) {
        consumed.add(point);
        hit = true;
      }
    }
    return hit;
  };

  /** Every executable line in `[startLine, endLine]`, braces included, is a changed line. */
  const fullyChanged = (startLine: number, endLine: number): boolean => {
    for (let line = startLine; line <= endLine; line++) {
      if (execLines.has(line) && !changedLines.has(line)) return false;
    }
    return true;
  };

  function regionsOfLeaf(node: Node): Result {
    const boundaries: Boundary[] = [];
    findBoundaries(node, node, boundaries);
    if (!boundaries.length) {
      return selectedLines(node.loc!.start.line, node.loc!.end.line) ? full(node) : empty;
    }
    const boundaryNodes = boundaries.map((boundary) => boundary.node);
    // Gaps carry their own line bounds, so a boundary sharing a line with leftover text does not
    // swallow that line's "changed" status away from the leftover text.
    const gapSpans = gaps(node, boundaryNodes);
    const restSelected = gapSpans
      .map((span) => selectedLines(span.startLine, span.endLine))
      .some(Boolean);
    const nestedResults = boundaries.map((boundary) =>
      regionsOfNode(boundary.node, boundary.parent),
    );
    if (restSelected && nestedResults.every((result) => result.full)) return full(node);
    const intervals: Span[] = [];
    if (restSelected) intervals.push(...gapSpans);
    for (const result of nestedResults) intervals.push(...result.intervals);
    return { full: false, intervals };
  }

  function combine(node: Node, children: Node[]): Result {
    if (!children.length) return empty;
    const results = children.map((child) => regionsOfNode(child, node));
    if (results.every((result) => result.full)) return full(node);
    return { full: false, intervals: results.flatMap((result) => result.intervals) };
  }

  /** Like `combine`, but for a brace-delimited body: its own brace lines must be changed too. */
  function combineBody(node: Node, children: Node[]): Result {
    if (!children.length) return empty;
    const results = children.map((child) => regionsOfNode(child, node));
    const full_ =
      results.every((result) => result.full) &&
      fullyChanged(node.loc!.start.line, node.loc!.end.line);
    if (full_) return full(node);
    return { full: false, intervals: results.flatMap((result) => result.intervals) };
  }

  function headerSpan(node: Node, body: Node): Span {
    return {
      ...spanOf(node),
      end: body.start!,
      endLine: body.loc!.start.line,
      endColumn: body.loc!.start.column,
    };
  }

  function regionsOfFunction(node: FunctionLike, parent: Node): Result {
    const headerFull = selectedLines(node.loc!.start.line, node.body.loc!.start.line);
    const body = regionsOfNode(node.body, node);
    const result: Result =
      headerFull && body.full
        ? full(node)
        : {
            full: false,
            intervals: [...(headerFull ? [headerSpan(node, node.body)] : []), ...body.intervals],
          };
    if (result.intervals.length) {
      functions.push({
        line: node.loc!.start.line,
        column: node.loc!.start.column + 1,
        function: nameOf(node, parent),
        location: {
          start: { line: node.loc!.start.line, column: node.loc!.start.column + 1 },
          end: { line: node.loc!.end.line, column: node.loc!.end.column + 1 },
        },
      });
    }
    return result;
  }

  function regionsOfClass(node: ClassLike): Result {
    const headerFull = selectedLines(node.loc!.start.line, node.body.loc!.start.line);
    const body = regionsOfNode(node.body, node);
    if (headerFull && body.full) return full(node);
    return {
      full: false,
      intervals: [...(headerFull ? [headerSpan(node, node.body)] : []), ...body.intervals],
    };
  }

  function regionsOfNode(node: Node, parent: Node): Result {
    const body = containerBody(node);
    if (body) return combineBody(node, body);
    if (isFunction(node)) return regionsOfFunction(node, parent);
    if (isClass(node)) return regionsOfClass(node);
    const children = compoundChildren(node);
    if (children) return combine(node, children);
    return regionsOfLeaf(node);
  }

  const result = regionsOfNode(ast.program, ast.program);
  const deletions = deletionPoints.filter((point) => !consumed.has(point));
  return {
    mutate: result.intervals.map(
      (span) =>
        `${literalGlob(file)}:${span.startLine}:${span.startColumn}-${span.endLine}:${span.endColumn}`,
    ),
    functions,
    lines: [...changedLines].sort((a, b) => a - b),
    deletions,
    suppressions: findSuppressions(ast.comments ?? []),
  };
}
