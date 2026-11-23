const axios = require('axios');
const { getBoundedAskUserAnswerValues, serializeAskUserAnswerVariants } = require('@librechat/api');

jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('winston-daily-rotate-file', () => jest.fn());
jest.mock('@librechat/api', () => ({
  isEnabled: () => true,
  getReferencedQuotes: () => undefined,
  mergeQuotedText: jest.fn(),
  getBoundedAskUserAnswerValues: jest.fn(() => []),
  serializeAskUserAnswerVariants: jest.fn(() => []),
  getOutboundTimeoutMs: (config, key) => config?.timeouts?.[key] ?? 10_000,
  outboundRequestBudget: (timeout) => ({ timeout, signal: AbortSignal.timeout(timeout) }),
  logAxiosError: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({ logger: { error: jest.fn() } }));
jest.mock('librechat-data-provider', () => ({ ErrorTypes: { MODERATION: 'moderation' } }));
jest.mock('./denyRequest', () => jest.fn());

const moderateText = require('./moderateText');

describe('moderateText', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not submit oversized answer batches to moderation', async () => {
    const answers = { environment: 'x'.repeat(16_001), credentials: 'safe' };
    const next = jest.fn();

    await moderateText({ body: { answers } }, {}, next);

    expect(getBoundedAskUserAnswerValues).toHaveBeenCalledWith(answers);
    expect(serializeAskUserAnswerVariants).toHaveBeenCalledWith(answers);
    expect(axios.post).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('bounds the moderation request by the configured timeout', async () => {
    axios.post.mockResolvedValue({ data: { results: [{ flagged: false }] } });
    const next = jest.fn();

    await moderateText(
      { body: { text: 'hello' }, config: { timeouts: { moderationMs: 2_500 } } },
      {},
      next,
    );

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      { input: 'hello' },
      expect.objectContaining({ timeout: 2_500 }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});
