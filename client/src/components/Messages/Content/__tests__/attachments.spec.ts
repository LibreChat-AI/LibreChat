import { Constants, ErrorTypes, ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import {
  isAttachmentError,
  mayBeAttachmentError,
  findAttachmentRecovery,
} from '../Error/attachments';

describe('isAttachmentError', () => {
  it.each([
    ['a code environment upload rate limit', 'Error uploading code environment file: 429'],
    [
      'the agent attachment limit counting resent files',
      'An error occurred while processing the request: This turn exceeds the configured attachment count limit (12 > 10). Remove some attachments or use smaller files and try again.',
    ],
    [
      'duplicate document names on Bedrock',
      JSON.stringify({
        type: ErrorTypes.UPSTREAM_MODEL_ERROR,
        message:
          'Messages can’t contain duplicate document names. Rename the document and retry your request.',
      }),
    ],
    ['an unrestorable file', JSON.stringify({ type: ErrorTypes.RESOURCE_RECOVERY_REQUIRED })],
    ['an over-long prompt', 'An error occurred while processing the request: prompt is too long'],
    ['a typed input length error', JSON.stringify({ type: ErrorTypes.INPUT_LENGTH, info: '9/5' })],
    [
      'a typed context overflow',
      JSON.stringify({ type: ErrorTypes.FINAL_CONTEXT_OVERFLOW, projectedMessageTokens: 9 }),
    ],
    ['a missing attachment', 'An attached file is no longer available. Remove it and retry.'],
    ['an oversized image', 'messages.3.content.1.image.source.base64: image exceeds 5 MB maximum'],
  ])('recognizes %s', (_label, text) => {
    expect(isAttachmentError(text)).toBe(true);
  });

  it.each([
    ['a model rate limit', JSON.stringify({ type: ErrorTypes.MODEL_RATE_LIMIT })],
    ['a dropped stream', 'Error connecting to server, try refreshing the page.'],
    ['an invalid key', JSON.stringify({ type: ErrorTypes.INVALID_USER_KEY })],
    ['provider prose', 'An error occurred while processing the request: 500 Internal Server Error'],
  ])('does not blame files for %s', (_label, text) => {
    expect(isAttachmentError(text)).toBe(false);
  });
});

describe('mayBeAttachmentError', () => {
  it.each([
    ['a file failure', 'Error uploading code environment file: 429'],
    ['an unexplained provider failure', JSON.stringify({ type: ErrorTypes.UPSTREAM_MODEL_ERROR })],
    [
      'an Anthropic error body',
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }),
    ],
    ['provider prose', 'An error occurred while processing the request: 400 Bad Request'],
  ])('offers the files as a way out of %s', (_label, text) => {
    expect(mayBeAttachmentError(text)).toBe(true);
  });

  it.each([
    ['a missing key', JSON.stringify({ type: ErrorTypes.NO_USER_KEY })],
    ['a model rate limit', JSON.stringify({ type: ErrorTypes.MODEL_RATE_LIMIT })],
    ['a token balance', JSON.stringify({ type: 'token_balance', balance: 0 })],
    [
      'a legacy LangChain rate limit',
      'An error occurred while processing the request: 429 Too many requests\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_RATE_LIMIT/',
    ],
    ['a nested quota code', JSON.stringify({ error: { code: 'insufficient_quota' } })],
    [
      'an Anthropic rate limit inside its generic envelope',
      JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
    ],
  ])('does not point at files for %s', (_label, text) => {
    expect(mayBeAttachmentError(text)).toBe(false);
  });
});

const screenshot = { file_id: 'screenshot', filename: 'screenshot.png', type: 'image/png' };

const user = (
  messageId: string,
  parentMessageId: string,
  fields: Partial<TMessage> = {},
): TMessage =>
  ({
    messageId,
    parentMessageId,
    conversationId: 'convo',
    isCreatedByUser: true,
    text: `question ${messageId}`,
    ...fields,
  }) as TMessage;

const answer = (
  messageId: string,
  parentMessageId: string,
  fields: Partial<TMessage> = {},
): TMessage =>
  ({
    messageId,
    parentMessageId,
    conversationId: 'convo',
    isCreatedByUser: false,
    text: `answer ${messageId}`,
    ...fields,
  }) as TMessage;

describe('findAttachmentRecovery', () => {
  it('offers only a retry when the failed turn alone carries files', () => {
    const messages = [
      user('u1', Constants.NO_PARENT),
      answer('a1', 'u1'),
      user('u2', 'a1', { files: [screenshot] }),
      answer('a2', 'u2', { error: true }),
    ];

    const recovery = findAttachmentRecovery(messages, messages[3]);

    expect(recovery).toEqual({ parent: messages[2], canRetry: true, branchTargetId: undefined });
  });

  it('also offers a branch ending before the failed turn when earlier turns carry files', () => {
    const messages = [
      user('u1', Constants.NO_PARENT, { files: [screenshot] }),
      answer('a1', 'u1'),
      user('u2', 'a1', { files: [screenshot] }),
      answer('a2', 'u2', { error: true }),
    ];

    expect(findAttachmentRecovery(messages, messages[3])).toEqual({
      parent: messages[2],
      canRetry: true,
      branchTargetId: 'a1',
    });
  });

  it('counts code outputs on earlier answers as files', () => {
    const messages = [
      user('u1', Constants.NO_PARENT),
      answer('a1', 'u1', {
        attachments: [{ file_id: 'chart', toolCallId: 't' }] as TMessage['attachments'],
      }),
      user('u2', 'a1'),
      answer('a2', 'u2', { error: true }),
    ];

    expect(findAttachmentRecovery(messages, messages[3])).toEqual({
      parent: messages[2],
      canRetry: false,
      branchTargetId: 'a1',
    });
  });

  it('counts attachments steered into an earlier response as files', () => {
    const steered = [
      { type: ContentTypes.TEXT, text: 'Working on it.' },
      { type: ContentTypes.STEER, steer: 'use this', steerId: 's1', files: [screenshot] },
    ] as TMessage['content'];
    const messages = [
      user('u1', Constants.NO_PARENT),
      answer('a1', 'u1', { content: steered }),
      user('u2', 'a1'),
      answer('a2', 'u2', { error: true }),
    ];

    expect(findAttachmentRecovery(messages, messages[3])).toEqual({
      parent: messages[2],
      canRetry: false,
      branchTargetId: 'a1',
    });
  });

  it('does not count search sources as files', () => {
    const messages = [
      user('u1', Constants.NO_PARENT),
      answer('a1', 'u1', {
        attachments: [{ type: 'web_search', toolCallId: 't' }] as TMessage['attachments'],
      }),
      user('u2', 'a1'),
      answer('a2', 'u2', { error: true }),
    ];

    expect(findAttachmentRecovery(messages, messages[3])).toBeNull();
  });

  it('ignores files on a sibling branch', () => {
    const messages = [
      user('u1', Constants.NO_PARENT),
      answer('a1', 'u1'),
      user('sibling', 'a1', { files: [screenshot] }),
      user('u2', 'a1'),
      answer('a2', 'u2', { error: true }),
    ];

    expect(findAttachmentRecovery(messages, messages[4])).toBeNull();
  });

  it('offers nothing to retry for a files-only message, since there is no text to resend', () => {
    const messages = [
      user('u1', Constants.NO_PARENT, { text: '', files: [screenshot] }),
      answer('a1', 'u1', { error: true }),
    ];

    expect(findAttachmentRecovery(messages, messages[1])).toBeNull();
  });

  it('offers nothing on a user turn or a response with no user turn behind it', () => {
    const messages = [
      user('u1', Constants.NO_PARENT, { files: [screenshot] }),
      answer('a1', 'u1'),
      answer('a2', 'a1', { error: true }),
    ];

    expect(findAttachmentRecovery(messages, messages[0])).toBeNull();
    expect(findAttachmentRecovery(messages, messages[2])).toBeNull();
    expect(findAttachmentRecovery(undefined, messages[1])).toBeNull();
  });
});
