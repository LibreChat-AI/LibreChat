import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { findCasingCollisions } from './casing.mts';

const dir = 'client/src/components/Chat/Session';

test('reports module names that differ only by case and extension', () => {
  const tracked = [`${dir}/Files.tsx`, `${dir}/files.ts`, `${dir}/Rail.tsx`];
  assert.deepEqual(findCasingCollisions(tracked, [`${dir}/files.ts`]), [
    `${dir}/Files <-> ${dir}/files`,
  ]);
});

test('reports the collision from either side of the pair', () => {
  const tracked = ['packages/chat/src/phase/Live.tsx', 'packages/chat/src/phase/live.ts'];
  assert.deepEqual(findCasingCollisions(tracked, ['packages/chat/src/phase/Live.tsx']), [
    'packages/chat/src/phase/Live <-> packages/chat/src/phase/live',
  ]);
});

test('reports a file whose name matches a directory', () => {
  const tracked = ['client/src/Row.tsx', 'client/src/row/index.ts'];
  assert.deepEqual(findCasingCollisions(tracked, ['client/src/row/index.ts']), [
    'client/src/Row <-> client/src/row',
  ]);
});

test('reports identical paths that differ only by case', () => {
  const tracked = ['docs/README.md', 'docs/readme.md'];
  assert.deepEqual(findCasingCollisions(tracked, ['docs/readme.md']), [
    'docs/README.md <-> docs/readme.md',
  ]);
});

test('accepts names that differ by more than case', () => {
  const tracked = [
    `${dir}/Files.tsx`,
    `${dir}/rows.ts`,
    `${dir}/useFiles.ts`,
    'a/index.d.ts',
    'a/index.ts',
  ];
  assert.deepEqual(findCasingCollisions(tracked, tracked), []);
});

test('accepts a case-only rename, whose old spelling the index no longer holds', () => {
  assert.deepEqual(findCasingCollisions(['a/Foo.ts'], ['a/foo.ts', 'a/Foo.ts']), []);
});

test('accepts a case-only rename of a directory', () => {
  const tracked = [`${dir}/Files.tsx`, `${dir}/rows.ts`].map((path) =>
    path.replace('/Session/', '/session/'),
  );
  const changed = [`${dir}/Files.tsx`, `${dir}/rows.ts`, ...tracked];
  assert.deepEqual(findCasingCollisions(tracked, changed), []);
});

test('ignores a deleted path that would have collided', () => {
  assert.deepEqual(findCasingCollisions(['a/Files.tsx'], ['a/files.ts']), []);
});

test('leaves a collision on the base branch to the change that touches it', () => {
  const tracked = ['a/Files.tsx', 'a/files.ts', 'b/Other.tsx'];
  assert.deepEqual(findCasingCollisions(tracked, ['b/Other.tsx']), []);
});
