import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { changedRegions } from './lines.mts';

/** Extract the `startLine-endLine` pair from a `file:L:C-L:C` mutate pattern. */
function lineSpan(pattern: string): [number, number] {
  const match = /:(\d+):\d+-(\d+):\d+$/u.exec(pattern);
  assert.ok(match, pattern);
  return [Number(match[1]), Number(match[2])];
}

test('a single changed line in a long function selects only that statement', () => {
  const source = `function aggregate(values) {
  let total = 0;
  let max = -Infinity;
  for (const value of values) {
    total += value;
    max = Math.max(max, value);
  }
  const mean = total / values.length;
  return { total, max, mean };
}
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 8, count: 1 }]);
  assert.deepEqual(regions.mutate.map(lineSpan), [[8, 8]]);
  assert.equal(regions.functions.length, 1);
  assert.equal(regions.functions[0].function, 'aggregate');
});

test('a changed line inside a multiline statement selects the whole statement', () => {
  const source = `function build() {
  const value = compute(
    1,
    2,
    3,
  );
  return value;
}
`;
  // Only the line "2," (line 4) is marked changed; the call spans lines 2-6.
  const regions = changedRegions('fixture.ts', source, [{ start: 4, count: 1 }]);
  assert.deepEqual(regions.mutate.map(lineSpan), [[2, 6]]);
});

test('a new file selects every executable line', () => {
  const source = `export function first() {
  return 1;
}
export function second() {
  return 2;
}
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 1, count: 6 }]);
  assert.deepEqual(regions.lines, [1, 2, 3, 4, 5, 6]);
  assert.equal(regions.functions.length, 2);
  assert.deepEqual(
    regions.functions.map((fn) => fn.function),
    ['first', 'second'],
  );
});

test('an added function is selected in full; an unrelated existing function is not', () => {
  const after = `function existing() {
  return 1;
}
function addedLater() {
  return 2;
}
`;
  const regions = changedRegions('fixture.ts', after, [{ start: 4, count: 3 }]);
  assert.deepEqual(regions.mutate.map(lineSpan), [[4, 6]]);
  assert.deepEqual(
    regions.functions.map((fn) => fn.function),
    ['addedLater'],
  );
});

test('a change inside a nested function does not select its unchanged parent', () => {
  const source = `function outer() {
  const unrelated = 1;
  const inner = () => {
    return unrelated + 1;
  };
  return inner();
}
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 4, count: 1 }]);
  // `inner`'s own brace lines (3 and 5) are untouched, so only the inner statement is selected,
  // not the whole block.
  assert.deepEqual(regions.mutate.map(lineSpan), [[4, 4]]);
  // `outer` owns the region (for progress labeling) but is never mutated in full: its header
  // (line 1) was not touched, so only the nested change bubbles up into its intervals.
  assert.deepEqual(
    regions.functions.map((fn) => fn.function),
    ['inner', 'outer'],
  );
});

test('a change in the parent does not pull in an unchanged nested function', () => {
  const source = `function outer() {
  const changed = 1;
  const inner = () => {
    return 'untouched';
  };
  return inner();
}
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 2, count: 1 }]);
  assert.deepEqual(regions.mutate.map(lineSpan), [[2, 2]]);
  assert.deepEqual(
    regions.functions.map((fn) => fn.function),
    ['outer'],
  );
});

test('a deletion strictly inside a multiline statement selects the enclosing statement', () => {
  const source = `function build() {
  const value = compute(
    1,
    3,
  );
  return value;
}
`;
  // The deletion point (line 3) falls strictly inside the call's line range.
  const regions = changedRegions('fixture.ts', source, [{ start: 3, count: 0 }]);
  assert.deepEqual(regions.mutate.map(lineSpan), [[2, 5]]);
  assert.deepEqual(regions.deletions, []);
});

test('a deletion exactly between two statements selects nothing, and is recorded', () => {
  const source = `function build() {
  const a = 1;
  const b = 2;
  return a + b;
}
`;
  // A statement that used to sit between "const a" and "const b" was removed.
  const regions = changedRegions('fixture.ts', source, [{ start: 2, count: 0 }]);
  assert.deepEqual(regions.mutate, []);
  assert.deepEqual(regions.deletions, [2]);
});

test('one added line in an existing aggregator function mutates only that line', () => {
  // A single changed line in a multi-statement function mutates only that line.
  const source = `function summarize(report) {
  const errors = report.filter((item) => item.level === 'error');
  const warnings = report.filter((item) => item.level === 'warning');
  const infos = report.filter((item) => item.level === 'info');
  const debugMessages = report.filter((item) => item.level === 'debug');
  return { errors, warnings, infos, debugMessages };
}
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 5, count: 1 }]);
  assert.deepEqual(regions.mutate.map(lineSpan), [[5, 5]]);
  // `summarize` owns the region; the earlier, unrelated filter lines (2-4) are untouched.
  assert.ok(regions.functions.some((fn) => fn.function === 'summarize'));
  assert.ok(regions.mutate.every((pattern) => lineSpan(pattern).every((line) => line === 5)));
});

test('no changed ranges selects nothing, matching a pure rename upstream', () => {
  const source = `function untouched() {
  return 1;
}
`;
  const regions = changedRegions('fixture.ts', source, []);
  assert.deepEqual(regions.mutate, []);
  assert.deepEqual(regions.functions, []);
  assert.deepEqual(regions.lines, []);
});

test('comment-only and blank changed lines select nothing', () => {
  const source = `function f() {
  // a comment

  return 1;
}
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 2, count: 2 }]);
  assert.deepEqual(regions.mutate, []);
  assert.deepEqual(regions.lines, []);
});

test('a suppression comment with no reason or naming all is flagged; a reasoned one is not', () => {
  const source = `// Stryker disable next-line all
const a = 1;
// Stryker disable next-line StringLiteral
const b = 'x';
// Stryker disable next-line StringLiteral: known false positive
const c = 'y';
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 1, count: 6 }]);
  assert.deepEqual(
    regions.suppressions.map((item) => ({ line: item.line, mutators: item.mutators })),
    [
      { line: 1, mutators: 'all' },
      { line: 3, mutators: 'StringLiteral' },
    ],
  );
});

test('a one-statement function body is not selected in full when only its inner line changed', () => {
  const source = `function f(a) {
  return a > 1;
}
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 2, count: 1 }]);
  assert.deepEqual(regions.mutate.map(lineSpan), [[2, 2]]);
});

test('a one-statement catch body is not selected in full when only its inner line changed', () => {
  const source = `function f() {
  try {
    g();
  } catch (e) {
    h(e);
  } finally {
    k();
  }
}
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 5, count: 1 }]);
  assert.deepEqual(regions.mutate.map(lineSpan), [[5, 5]]);
});

test('a one-statement else body is not selected in full when only its inner line changed', () => {
  const source = `function f(a) {
  if (a > 1) {
    g('x');
  } else {
    h('y');
  }
}
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 5, count: 1 }]);
  assert.deepEqual(regions.mutate.map(lineSpan), [[5, 5]]);
});

test('a one-statement method body is not selected in full when only its inner line changed', () => {
  const source = `class C {
  m(a) {
    return a + 1;
  }
}
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 3, count: 1 }]);
  assert.deepEqual(regions.mutate.map(lineSpan), [[3, 3]]);
});

test('a fully new function still selects its whole body as one mutant', () => {
  const source = `const kept = 1;
function f(a) {
  return a > 1;
}
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 2, count: 3 }]);
  assert.deepEqual(regions.mutate.map(lineSpan), [[2, 4]]);
});

test('a deletion right after the first line of a multiline statement selects it', () => {
  const source = `const x = foo(
  a,
  c,
);
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 1, count: 0 }]);
  assert.deepEqual(regions.mutate.map(lineSpan), [[1, 4]]);
  assert.deepEqual(regions.deletions, []);
});

test('a deletion at or after a single-line statement does not select it', () => {
  const source = `const a = 1;
const b = 2;
`;
  const atOwnLine = changedRegions('fixture.ts', source, [{ start: 2, count: 0 }]);
  assert.deepEqual(atOwnLine.mutate, []);
  assert.deepEqual(atOwnLine.deletions, [2]);
  const betweenStatements = changedRegions('fixture.ts', source, [{ start: 1, count: 0 }]);
  assert.deepEqual(betweenStatements.mutate, []);
  assert.deepEqual(betweenStatements.deletions, [1]);
});

test('a decorated class parses without throwing', () => {
  const source = `class C {
  @dec(1 + 2)
  m() {
    return 1;
  }
}
`;
  const regions = changedRegions('fixture.ts', source, [{ start: 4, count: 1 }]);
  assert.deepEqual(regions.mutate.map(lineSpan), [[4, 4]]);
});
