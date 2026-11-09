import { createHash } from 'node:crypto';
import { fragmentSubagentContent } from './subagentContent';

it('preserves Unicode scalars across independent BSON UTF-8 fragment encodings', () => {
  const original = `${'x'.repeat(128 * 1024 - 1)}😀${'y'.repeat(128 * 1024)}𐐷`;
  const fragments = fragmentSubagentContent(original);
  const recovered = fragments
    .map((fragment) => Buffer.from(fragment, 'utf8').toString('utf8'))
    .join('');
  expect(recovered).toBe(original);
  expect(createHash('sha256').update(recovered).digest('hex')).toBe(
    createHash('sha256').update(original).digest('hex'),
  );
  expect(fragments.every((fragment) => fragment.length <= 128 * 1024)).toBe(true);
});
