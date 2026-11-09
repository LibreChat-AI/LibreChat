import type { TNmbFinding } from 'librechat-data-provider';
import {
  splitSegment,
  maskPreview,
  findingValue,
  escapeRegex,
  findingsForSegment,
} from './highlight';

const f = (start: number, end: number, over: Partial<TNmbFinding> = {}): TNmbFinding => ({
  entity: 'ACCOUNT_NUMBER',
  type: 'financial',
  location: { segment: 'text', start, end },
  score: 0.9,
  action: 'MASK',
  value_hash: 'abc',
  ...over,
});

describe('highlight', () => {
  const text = 'pay 1234567890 and 9876543210 now';

  it('splits a segment around findings', () => {
    const pieces = splitSegment(text, [f(4, 14), f(19, 29)], 'text');
    expect(pieces.map((p) => p.text)).toEqual([
      'pay ',
      '1234567890',
      ' and ',
      '9876543210',
      ' now',
    ]);
    expect(pieces.filter((p) => p.finding)).toHaveLength(2);
  });

  it('ignores findings of other segments, ALLOW findings, and out-of-range offsets', () => {
    const pieces = splitSegment(
      text,
      [
        f(4, 14, { location: { segment: 'other', start: 4, end: 14 } }),
        f(4, 14, { action: 'ALLOW' }),
        f(900, 910),
      ],
      'text',
    );
    expect(pieces).toEqual([{ text }]);
  });

  it('drops overlapping findings and clips to the text length', () => {
    expect(findingsForSegment([f(4, 14), f(10, 20), f(30, 99)], 'text', text.length)).toHaveLength(
      2,
    );
    expect(findingsForSegment([f(30, 99)], 'text', text.length)[0].location.end).toBe(text.length);
  });

  it('previews masked text with entity tokens', () => {
    expect(maskPreview(text, [f(4, 14), f(19, 29)], 'text')).toBe(
      'pay <ACCOUNT_NUMBER> and <ACCOUNT_NUMBER> now',
    );
  });

  it('reads the covered value and escapes patterns', () => {
    expect(findingValue(f(4, 14), [{ location: 'text', text }])).toBe('1234567890');
    expect(findingValue(f(4, 14), [])).toBe('');
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
  });
});
