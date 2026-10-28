import { Constants, StepEvents, tMessageSchema } from 'librechat-data-provider';
import type { Agents, TMessage, TSubmission } from 'librechat-data-provider';
import {
  getStepEventId,
  isOAuthStepEvent,
  mergeResumeMessages,
  getResumeMessageIndexes,
  hasSubmissionUserMessage,
  buildResumeEventSubmission,
  completedResponseMessageId,
  isCompactionAnchorProjection,
  buildMinimalResumeSubmission,
  resumeStateMatchesSubmission,
  buildSubmissionFromResumeState,
  getResumeBranchTargetMessageId,
} from '../resumable';

const message = (fields: Partial<TMessage>) =>
  ({ conversationId: 'c-1', text: '', ...fields }) as TMessage;

const user = message({
  messageId: 'u-1',
  parentMessageId: Constants.NO_PARENT as string,
  isCreatedByUser: true,
});
const response = message({ messageId: 'r-1', parentMessageId: 'u-1', isCreatedByUser: false });

const resumeState = (fields: Partial<Agents.ResumeState> = {}) =>
  ({
    runSteps: [],
    aggregatedContent: [],
    userMessage: {
      messageId: 'u-1',
      parentMessageId: Constants.NO_PARENT as string,
      text: 'Hello',
    },
    responseMessageId: 'r-1',
    conversationId: 'c-1',
    ...fields,
  }) as Agents.ResumeState;

describe('isCompactionAnchorProjection', () => {
  it('recognizes an identity-only slot, whoever authored it', () => {
    expect(isCompactionAnchorProjection({ messageId: 'leaf' })).toBe(true);
    expect(isCompactionAnchorProjection({ messageId: 'leaf', parentMessageId: 'p' })).toBe(false);
    expect(isCompactionAnchorProjection({ messageId: 'leaf', text: 'hi' })).toBe(false);
    expect(isCompactionAnchorProjection(null)).toBe(false);
  });
});

describe('buildMinimalResumeSubmission', () => {
  const build = (messages: TMessage[]) =>
    buildMinimalResumeSubmission({
      messages,
      streamId: 'c-1',
      createdAt: 2000,
      isTemporary: false,
      conversationId: 'c-1',
      generationProtocolVersion: 1,
    });

  it('parents an assistant placeholder under the last user turn', () => {
    const submission = build([user, response]);
    expect(submission.userMessage).toBe(user);
    expect(submission.initialResponse).toMatchObject({
      messageId: 'resume_',
      parentMessageId: 'u-1',
      isCreatedByUser: false,
    });
    expect(submission).toMatchObject({ resumeStreamId: 'c-1', resumeGenerationCreatedAt: 2000 });
  });

  it('builds a placeholder an error turn can parse when history holds no user turn', () => {
    const submission = build([]);
    expect(submission.userMessage).toMatchObject({ messageId: 'resume', isCreatedByUser: true });
    expect(() =>
      tMessageSchema.parse({ ...submission.initialResponse, error: true }),
    ).not.toThrow();
  });
});

describe('buildSubmissionFromResumeState', () => {
  it('strips the persisted pair a fresh resume re-supplies', () => {
    const submission = buildSubmissionFromResumeState(
      resumeState(),
      'c-1',
      [user, response],
      'c-1',
      2000,
      2,
    );
    expect(submission.messages).toEqual([]);
    expect(submission.isRegenerate).toBe(false);
    expect(submission.initialResponse).toMatchObject({ messageId: 'r-1', parentMessageId: 'u-1' });
    expect(submission).toMatchObject({
      resumeStreamId: 'c-1',
      resumeGenerationCreatedAt: 2000,
      resumeGenerationProtocolVersion: 2,
    });
  });

  it('keeps an anchored run on the row its slot names', () => {
    const leaf = message({ messageId: 'leaf', parentMessageId: 'u-1', isCreatedByUser: false });
    const submission = buildSubmissionFromResumeState(
      resumeState({ userMessage: { messageId: 'leaf' }, responseMessageId: 'sum-1' }),
      'c-1',
      [user, leaf],
      'c-1',
    );
    expect(submission.userMessage).toBe(leaf);
    expect(submission.isRegenerate).toBe(true);
    expect(submission.compact).toBe(true);
  });
});

describe('resume matching', () => {
  it('matches a submission to resume state by either message id', () => {
    const submission = { userMessage: user, initialResponse: response } as TSubmission;
    expect(resumeStateMatchesSubmission({ resumeState: resumeState() }, submission)).toBe(true);
    expect(
      resumeStateMatchesSubmission(
        { resumeState: resumeState({ userMessage: { messageId: 'x' } }) },
        submission,
      ),
    ).toBe(true);
    expect(resumeStateMatchesSubmission(undefined, submission)).toBe(false);
    expect(hasSubmissionUserMessage(submission, [user], 'c-1')).toBe(true);
    expect(hasSubmissionUserMessage(submission, [user], 'c-2')).toBe(false);
  });

  it('targets the padded response, then the persisted one, then the user parent', () => {
    const padded = resumeState({ responseMessageId: 'r-1_' });
    expect(getResumeBranchTargetMessageId(padded, [message({ messageId: 'r-1_' })])).toBe('r-1_');
    expect(getResumeBranchTargetMessageId(padded, [response])).toBe('r-1');
    expect(getResumeBranchTargetMessageId(padded, [])).toBe(Constants.NO_PARENT);
  });
});

describe('resume message merge', () => {
  it('adopts the resumed identity onto the current user turn', () => {
    const submission = buildResumeEventSubmission(
      { userMessage: user, initialResponse: response, conversation: {} } as TSubmission,
      user,
      resumeState({ conversationId: 'c-2' }),
    );
    expect(submission.userMessage).toMatchObject({ messageId: 'u-1', conversationId: 'c-2' });
    expect(submission.initialResponse).toMatchObject({
      messageId: 'r-1',
      parentMessageId: 'u-1',
      isCreatedByUser: false,
    });
  });

  it('replaces the preliminary pair with the resumed one', () => {
    const preliminaryUser = message({ messageId: 'tmp', isCreatedByUser: true });
    const preliminaryResponse = message({ messageId: 'tmp_', parentMessageId: 'tmp' });
    const messages = [preliminaryUser, preliminaryResponse];
    const indexes = getResumeMessageIndexes(messages, 'u-1', 'r-1', 'tmp', 'tmp_');
    expect(indexes).toEqual({
      userIndex: -1,
      responseIndex: -1,
      preliminaryUserIndex: 0,
      preliminaryResponseIndex: 1,
    });
    expect(mergeResumeMessages(messages, user, response, indexes).map((m) => m.messageId)).toEqual([
      'u-1',
      'r-1',
    ]);
  });

  it('identifies a completed response only when it is unambiguous', () => {
    const sibling = message({ messageId: 'r-2', parentMessageId: 'u-1', isCreatedByUser: false });
    expect(completedResponseMessageId([user, response], 'u-1', 'u-1')).toBe('r-1');
    expect(completedResponseMessageId([user, response, sibling], 'u-1', 'u-1')).toBeUndefined();
    expect(completedResponseMessageId([user, response, sibling], 'u-1', 'r-2_')).toBe('r-2');
  });
});

describe('step events', () => {
  it('flags the OAuth steps and reads their ids', () => {
    const oauthStep = {
      event: StepEvents.ON_RUN_STEP,
      data: {
        id: 'step-1',
        stepDetails: { tool_calls: [{ name: `oauth${Constants.mcp_delimiter}github` }] },
      },
    };
    expect(isOAuthStepEvent(oauthStep)).toBe(true);
    expect(getStepEventId(oauthStep)).toBe('step-1');
    expect(
      isOAuthStepEvent({ event: StepEvents.ON_RUN_STEP_DELTA, data: { delta: { auth: 'url' } } }),
    ).toBe(true);
    expect(isOAuthStepEvent({ event: StepEvents.ON_RUN_STEP, data: { stepDetails: {} } })).toBe(
      false,
    );
    expect(getStepEventId({ data: { result: { id: 'step-2' } } })).toBe('step-2');
  });
});
