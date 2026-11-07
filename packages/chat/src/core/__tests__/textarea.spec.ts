import { findMentionRange } from '../textarea';

describe('findMentionRange', () => {
  it.each([
    ['@', 1, { start: 0, end: 1 }],
    ['@git', 4, { start: 0, end: 4 }],
    ['Look up @git tomorrow', 12, { start: 8, end: 12 }],
    ['Look up\n@', 9, { start: 8, end: 9 }],
  ])('finds a standalone mention in %s', (text, caret, expected) => {
    expect(findMentionRange(text, caret)).toEqual(expected);
  });

  it.each(['person@example.com', 'hello@', 'draft @git later', 'no mention'])(
    'ignores email addresses and text beyond the token: %s',
    (text) => {
      expect(findMentionRange(text, text.length)).toBeUndefined();
    },
  );

  it('ignores a selection and invalid caret positions', () => {
    expect(findMentionRange('@git', 1, 4)).toBeUndefined();
    expect(findMentionRange('@git', 0)).toBeUndefined();
    expect(findMentionRange('@git', 5)).toBeUndefined();
  });
});
