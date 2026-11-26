import {
  FEEDBACK_TAGS,
  getTagByKey,
  feedbackSchema,
  isOtherFeedback,
  resolveFeedbackTag,
} from './feedback';

describe('feedbackSchema', () => {
  it.each(FEEDBACK_TAGS)('accepts $key with its $direction rating', ({ direction, key }) => {
    expect(feedbackSchema.safeParse({ rating: direction, tag: key }).success).toBe(true);
  });

  it.each(FEEDBACK_TAGS)('rejects $key with the opposite rating', ({ direction, key }) => {
    const oppositeRating = direction === 'thumbsUp' ? 'thumbsDown' : 'thumbsUp';

    expect(feedbackSchema.safeParse({ rating: oppositeRating, tag: key }).success).toBe(false);
  });
});

describe('isOtherFeedback', () => {
  it.each([
    ['other', true],
    ['other_feedback', true],
    ['inaccurate', false],
    ['accurate_reliable', false],
  ] as const)('marks %s as asking for a comment: %s', (key, expected) => {
    expect(isOtherFeedback(key)).toBe(expected);
  });

  it('asks for nothing without a category', () => {
    expect(isOtherFeedback()).toBe(false);
  });
});

describe('resolveFeedbackTag', () => {
  it('reads a stored key and a tag object alike', () => {
    expect(resolveFeedbackTag('other_feedback')).toEqual(getTagByKey('other_feedback'));
    expect(resolveFeedbackTag(getTagByKey('other'))).toEqual(getTagByKey('other'));
    expect(resolveFeedbackTag(null)).toBeUndefined();
  });
});
