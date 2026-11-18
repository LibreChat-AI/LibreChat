import { Constants, EModelEndpoint } from 'librechat-data-provider';
import useGenerationsByLatest from '../generations';

const base = {
  endpoint: EModelEndpoint.agents,
  messageId: 'response-1',
  latestMessageId: 'response-1',
  isSubmitting: false,
  isCreatedByUser: false,
};

describe('useGenerationsByLatest', () => {
  it('withholds the hover Continue control when the turn ran out of tool steps', () => {
    const result = useGenerationsByLatest({
      ...base,
      finish_reason: String(Constants.TOOL_CALL_LIMIT_FINISH_REASON),
    });

    expect(result.continueSupported).toBe(false);
  });

  it('still offers Continue for other incomplete finish reasons', () => {
    const result = useGenerationsByLatest({
      ...base,
      finish_reason: 'length',
    });

    expect(result.continueSupported).toBe(true);
  });

  it('offers no rerun, edit or continue in a conversation the reader takes no turn in', () => {
    const driven = useGenerationsByLatest({
      ...base,
      finish_reason: 'length',
      parentIsUserMessage: true,
    });
    const followed = useGenerationsByLatest({
      ...base,
      finish_reason: 'length',
      parentIsUserMessage: true,
      readOnly: true,
    });

    expect(driven).toMatchObject({
      regenerateOffered: true,
      regenerateEnabled: true,
      continueSupported: true,
      hideEditButton: false,
    });
    expect(followed).toMatchObject({
      regenerateOffered: false,
      regenerateEnabled: false,
      continueSupported: false,
      hideEditButton: true,
      forkingSupported: true,
    });
  });
});
