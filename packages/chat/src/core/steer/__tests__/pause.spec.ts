import { ContentTypes, ASK_USER_QUESTION } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { hasLiveRunPause, hasLiveToolApproval, selectLiveMessageState } from '../pause';
import { getSteerErrorCode, isDefiniteSteerRejection } from '../errors';

const assistant = (messageId: string, content: unknown[] = []): TMessage =>
  ({ messageId, isCreatedByUser: false, content }) as unknown as TMessage;

const approvalPart = (output?: string) => ({
  type: ContentTypes.TOOL_CALL,
  [ContentTypes.TOOL_CALL]: { approval: { status: 'pending' }, output },
});

const askPart = {
  type: ASK_USER_QUESTION,
  [ASK_USER_QUESTION]: { actionId: 'ask-1', question: { question: 'Which?' } },
};

describe('hasLiveToolApproval', () => {
  it('detects an approval with no output on the latest assistant message', () => {
    expect(hasLiveToolApproval([assistant('a', [approvalPart()])])).toBe(true);
    expect(hasLiveToolApproval([assistant('a', [approvalPart('done')])])).toBe(false);
  });

  it('lets a resolved active tail decide over the cache order', () => {
    const paused = assistant('a', [approvalPart()]);
    const sibling = assistant('b');
    expect(hasLiveToolApproval([paused, sibling])).toBe(false);
    expect(hasLiveToolApproval([sibling, paused], sibling)).toBe(false);
    expect(hasLiveToolApproval([sibling], paused)).toBe(true);
  });
});

describe('hasLiveRunPause', () => {
  it('treats a live ask-user question as a pause', () => {
    expect(hasLiveRunPause([assistant('a', [askPart])])).toBe(true);
    expect(hasLiveRunPause(assistant('a', [askPart]))).toBe(true);
    expect(hasLiveRunPause([assistant('a')])).toBe(false);
  });
});

describe('selectLiveMessageState', () => {
  it('reports the queue parent of the latest assistant message', () => {
    expect(selectLiveMessageState(assistant('a'))).toEqual({
      approval: false,
      parentMessageId: 'a',
    });
    expect(
      selectLiveMessageState({
        ...assistant('a'),
        clientQueueParentMessageId: 'q',
      } as TMessage),
    ).toEqual({ approval: false, parentMessageId: 'q' });
    expect(selectLiveMessageState(null)).toEqual({ approval: false, parentMessageId: undefined });
  });
});

describe('steer errors', () => {
  it('reads the server error code', () => {
    expect(getSteerErrorCode({ response: { data: { code: 'RUN_PAUSED' } } })).toBe('RUN_PAUSED');
    expect(getSteerErrorCode(new Error('x'))).toBeUndefined();
  });

  it('treats only non-intermediary 4xx responses as definite rejections', () => {
    expect(isDefiniteSteerRejection({ response: { status: 409 } })).toBe(true);
    expect(isDefiniteSteerRejection({ response: { status: 408 } })).toBe(false);
    expect(isDefiniteSteerRejection({ response: { status: 425 } })).toBe(false);
    expect(isDefiniteSteerRejection({ response: { status: 502 } })).toBe(false);
    expect(isDefiniteSteerRejection(new Error('network'))).toBe(false);
  });
});
