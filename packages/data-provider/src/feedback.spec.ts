import { FEEDBACK_TAGS, feedbackSchema } from './feedback';

describe('feedbackSchema', () => {
  it.each(FEEDBACK_TAGS)('accepts $key with its $direction rating', ({ direction, key }) => {
    expect(feedbackSchema.safeParse({ rating: direction, tag: key }).success).toBe(true);
  });

  it.each(FEEDBACK_TAGS)('rejects $key with the opposite rating', ({ direction, key }) => {
    const oppositeRating = direction === 'thumbsUp' ? 'thumbsDown' : 'thumbsUp';

    expect(feedbackSchema.safeParse({ rating: oppositeRating, tag: key }).success).toBe(false);
  });
});
