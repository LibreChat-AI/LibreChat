import React from 'react';
import { useStore, useAtomValue } from 'jotai';
import { RecoilRoot, useRecoilCallback } from 'recoil';
import { renderHook, act } from '@testing-library/react';
import {
  Constants,
  StepTypes,
  StepEvents,
  ContentTypes,
  ToolCallTypes,
} from 'librechat-data-provider';
import type {
  TMessageContentParts,
  SummaryContentPart,
  EventSubmission,
  TEndpointOption,
  TConversation,
  TMessage,
  SubagentUpdateEvent,
  PtcToolCallEvent,
  Agents,
} from 'librechat-data-provider';
import type { PtcTrace, PtcTraceEntry } from '~/store/ptc';
import {
  subagentProgressByToolCallId,
  subagentProgressKey,
} from '~/components/Chat/Subagents/state';
import { ptcTraceByToolCallId, ptcTraceKey, PTC_TRACE_MAX_ENTRIES } from '~/store/ptc';
import { resolveAskUserQuestionPart } from '~/utils/approval';
import { sandboxStartingByToolCallId } from '~/store/sandbox';
import useStepHandler from '~/hooks/SSE/useStepHandler';
import { IsolatedAtomStore } from 'test/harness';

/** `Constants` is a heterogeneous enum (`string | number`); annotate as
 *  `string` so the member is usable where a `string` field is expected. */
const USE_PRELIM_RESPONSE_MESSAGE_ID: string = Constants.USE_PRELIM_RESPONSE_MESSAGE_ID;

const getToolCallName = (part?: TMessageContentParts): string | undefined => {
  if (part?.type !== ContentTypes.TOOL_CALL) {
    return undefined;
  }
  const { tool_call: toolCall } = part;
  return 'name' in toolCall ? toolCall.name : undefined;
};

type TSubmissionForTest = {
  userMessage: TMessage;
  isEdited?: boolean;
  isContinued?: boolean;
  isTemporary: boolean;
  messages: TMessage[];
  isRegenerate?: boolean;
  compact?: boolean;
  conversation: Partial<TConversation>;
  endpointOption: TEndpointOption;
  initialResponse: TMessage;
  editedContent?: { index: number; type: string; [key: string]: unknown } | null;
};

describe('useStepHandler', () => {
  const mockSetMessages = jest.fn();
  const mockGetMessages = jest.fn();
  const mockAnnouncePolite = jest.fn();
  const mockOnSkillAuthoringComplete = jest.fn();
  const mockLastAnnouncementTimeRef = { current: 0 };

  const createHookParams = () => ({
    setMessages: mockSetMessages,
    getMessages: mockGetMessages,
    announcePolite: mockAnnouncePolite,
    lastAnnouncementTimeRef: mockLastAnnouncementTimeRef,
    onSkillAuthoringComplete: mockOnSkillAuthoringComplete,
  });

  const createUserMessage = (overrides: Partial<TMessage> = {}): TMessage => ({
    messageId: 'user-msg-1',
    conversationId: 'conv-1',
    parentMessageId: '00000000-0000-0000-0000-000000000000',
    isCreatedByUser: true,
    text: 'Hello',
    sender: 'User',
    ...overrides,
  });

  const createResponseMessage = (overrides: Partial<TMessage> = {}): TMessage => ({
    messageId: 'response-msg-1',
    conversationId: 'conv-1',
    parentMessageId: 'user-msg-1',
    isCreatedByUser: false,
    text: '',
    sender: 'Assistant',
    content: [],
    ...overrides,
  });

  const createSubmission = (overrides: Partial<TSubmissionForTest> = {}): EventSubmission =>
    ({
      userMessage: createUserMessage(),
      isRegenerate: false,
      isEdited: false,
      isContinued: false,
      isTemporary: false,
      messages: [],
      conversation: {},
      endpointOption: {} as TEndpointOption,
      initialResponse: createResponseMessage(),
      ...overrides,
    }) as unknown as EventSubmission;

  const createRunStep = (overrides: Partial<Agents.RunStep> = {}): Agents.RunStep => ({
    id: 'step-1',
    runId: 'response-msg-1',
    index: 0,
    type: StepTypes.MESSAGE_CREATION,
    stepDetails: {
      type: StepTypes.MESSAGE_CREATION,
      message_creation: { message_id: 'msg-1' },
    },
    usage: null,
    ...overrides,
  });

  const createToolCallRunStep = (overrides: Partial<Agents.RunStep> = {}): Agents.RunStep => ({
    id: 'step-tool-1',
    runId: 'response-msg-1',
    index: 0,
    type: StepTypes.TOOL_CALLS,
    stepDetails: {
      type: StepTypes.TOOL_CALLS,
      tool_calls: [
        {
          id: 'tool-call-1',
          name: 'test_tool',
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
        },
      ],
    },
    usage: null,
    ...overrides,
  });

  const createMessageDelta = (
    stepId: string,
    text: string,
    overrides: Partial<Agents.MessageDeltaEvent> = {},
  ): Agents.MessageDeltaEvent => ({
    id: stepId,
    delta: {
      content: [{ type: ContentTypes.TEXT, text }],
    },
    ...overrides,
  });

  const createReasoningDelta = (
    stepId: string,
    think: string,
    overrides: Partial<Agents.ReasoningDeltaEvent> = {},
  ): Agents.ReasoningDeltaEvent => ({
    id: stepId,
    delta: {
      content: [{ type: ContentTypes.THINK, think }],
    },
    ...overrides,
  });

  /** Delta cache flushes are rAF-coalesced; run them synchronously so the
   * merged-output assertions below observe the flushed state. The dedicated
   * coalescing test overrides this with a manual queue. */
  beforeEach(() => {
    jest.clearAllMocks();
    mockLastAnnouncementTimeRef.current = 0;
    mockGetMessages.mockReturnValue([]);
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should return stepHandler, clearStepMaps, and syncStepMessage functions', () => {
      const { result } = renderHook(() => useStepHandler(createHookParams()));

      expect(typeof result.current.stepHandler).toBe('function');
      expect(typeof result.current.clearStepMaps).toBe('function');
      expect(typeof result.current.syncStepMessage).toBe('function');
    });
  });

  describe('on_run_step event', () => {
    it('should create response message when not in messageMap', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(mockSetMessages).toHaveBeenCalled();
      const setMessagesCall = mockSetMessages.mock.calls[0][0];
      expect(setMessagesCall).toContainEqual(
        expect.objectContaining({ messageId: 'response-msg-1' }),
      );
    });

    it('keeps an assistant compaction anchor when the response receives its durable ID', () => {
      const userMessage = createUserMessage();
      const anchor = createResponseMessage({ messageId: 'anchor-response' });
      const initialResponse = createResponseMessage({
        messageId: 'anchor-response_',
        parentMessageId: anchor.messageId,
      });
      const submission = createSubmission({
        userMessage: { ...anchor, text: '' },
        messages: [userMessage, anchor],
        initialResponse,
        isRegenerate: true,
        compact: true,
      });
      const runStep = createRunStep({ runId: 'summary-response' });

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      const messages = mockSetMessages.mock.calls.at(-1)?.[0] as TMessage[];
      expect(messages.map(({ messageId }) => messageId)).toEqual([
        userMessage.messageId,
        anchor.messageId,
        'summary-response',
      ]);
      expect(messages[1]).toBe(anchor);
      expect(messages[2]).toMatchObject({
        messageId: 'summary-response',
        parentMessageId: anchor.messageId,
      });
    });

    it('should warn and return early when no responseMessageId', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep({ runId: '' });
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(consoleSpy).toHaveBeenCalledWith('No message id found in run step event');
      expect(mockSetMessages).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should handle USE_PRELIM_RESPONSE_MESSAGE_ID by using initialResponse', () => {
      const initialResponse = createResponseMessage({ messageId: 'initial-response-id' });
      mockGetMessages.mockReturnValue([initialResponse]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep({ runId: 'USE_PRELIM_RESPONSE_MESSAGE_ID' });
      const submission = createSubmission({
        initialResponse,
      });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(mockSetMessages).toHaveBeenCalled();
    });

    it('should handle tool call steps and store tool call IDs', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createToolCallRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(mockSetMessages).toHaveBeenCalled();
      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall.find((m: TMessage) => !m.isCreatedByUser);
      expect(responseMsg?.content).toContainEqual(
        expect.objectContaining({
          type: ContentTypes.TOOL_CALL,
          tool_call: expect.objectContaining({ name: 'test_tool' }),
        }),
      );
    });

    it('should preserve multiple tool call steps for the same preliminary response', () => {
      const responseMessage = createResponseMessage();
      let currentMessages = [responseMessage];
      mockGetMessages.mockImplementation(() => currentMessages);
      mockSetMessages.mockImplementation((messages) => {
        currentMessages = messages;
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const submission = createSubmission({ initialResponse: responseMessage });

      const firstRunStep = createToolCallRunStep({
        id: 'step-oauth-eli',
        runId: USE_PRELIM_RESPONSE_MESSAGE_ID,
        index: 0,
        stepDetails: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [
            {
              id: 'tool-call-eli',
              name: `oauth${Constants.mcp_delimiter}ELI`,
              args: '',
              type: ToolCallTypes.TOOL_CALL,
            },
          ],
        },
      });
      const secondRunStep = createToolCallRunStep({
        id: 'step-oauth-vespa',
        runId: USE_PRELIM_RESPONSE_MESSAGE_ID,
        index: 1,
        stepDetails: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [
            {
              id: 'tool-call-vespa',
              name: `oauth${Constants.mcp_delimiter}Vespa`,
              args: '',
              type: ToolCallTypes.TOOL_CALL,
            },
          ],
        },
      });

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_RUN_STEP, data: firstRunStep },
          submission,
        );
        result.current.stepHandler(
          { event: StepEvents.ON_RUN_STEP, data: secondRunStep },
          submission,
        );
      });

      const responseMsg = currentMessages.find((m) => !m.isCreatedByUser);
      expect(responseMsg?.content).toHaveLength(2);
      expect(getToolCallName(responseMsg?.content?.[0])).toBe(`oauth${Constants.mcp_delimiter}ELI`);
      expect(getToolCallName(responseMsg?.content?.[1])).toBe(
        `oauth${Constants.mcp_delimiter}Vespa`,
      );
    });

    it('should clear OAuth prompt slots when one occupies the real response slot', () => {
      const responseMessage = createResponseMessage();
      let currentMessages = [responseMessage];
      mockGetMessages.mockImplementation(() => currentMessages);
      mockSetMessages.mockImplementation((messages) => {
        currentMessages = messages;
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const submission = createSubmission({ initialResponse: responseMessage });

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: createToolCallRunStep({
              id: 'step-oauth-eli',
              runId: USE_PRELIM_RESPONSE_MESSAGE_ID,
              index: 0,
              stepDetails: {
                type: StepTypes.TOOL_CALLS,
                tool_calls: [
                  {
                    id: 'tool-call-eli',
                    name: `oauth${Constants.mcp_delimiter}ELI`,
                    args: '',
                    type: ToolCallTypes.TOOL_CALL,
                  },
                ],
              },
            }),
          },
          submission,
        );
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: createToolCallRunStep({
              id: 'step-oauth-vespa',
              runId: USE_PRELIM_RESPONSE_MESSAGE_ID,
              index: 1,
              stepDetails: {
                type: StepTypes.TOOL_CALLS,
                tool_calls: [
                  {
                    id: 'tool-call-vespa',
                    name: `oauth${Constants.mcp_delimiter}Vespa`,
                    args: '',
                    type: ToolCallTypes.TOOL_CALL,
                  },
                ],
              },
            }),
          },
          submission,
        );
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: createRunStep({
              id: 'step-message',
              runId: USE_PRELIM_RESPONSE_MESSAGE_ID,
              index: 0,
            }),
          },
          submission,
        );
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-message', 'Ready') },
          submission,
        );
      });

      const responseMsg = currentMessages.find((m) => !m.isCreatedByUser);
      expect(responseMsg?.content).toEqual([{ type: ContentTypes.TEXT, text: 'Ready' }]);
    });

    it('should not replace the message list from a shorter refresh during tool call steps', () => {
      const userMessage = createUserMessage();
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValueOnce([userMessage, responseMessage]).mockReturnValueOnce([]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createToolCallRunStep({
        runId: responseMessage.messageId,
        stepDetails: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [
            {
              id: 'tool-call-eli',
              name: `oauth${Constants.mcp_delimiter}ELI`,
              args: '',
              type: ToolCallTypes.TOOL_CALL,
            },
          ],
        },
      });

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_RUN_STEP, data: runStep },
          createSubmission({ userMessage, initialResponse: responseMessage }),
        );
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      expect(lastCall.map((message: TMessage) => message.messageId)).toEqual([
        userMessage.messageId,
        responseMessage.messageId,
      ]);
    });

    it('should replay buffered deltas after registering step', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const submission = createSubmission();
      const stepId = 'step-buffered';

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta(stepId, 'Hello') },
          submission,
        );
      });

      expect(mockSetMessages).not.toHaveBeenCalled();

      const runStep = createRunStep({ id: stepId });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(mockSetMessages).toHaveBeenCalled();
      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall.find((m: TMessage) => !m.isCreatedByUser);
      expect(responseMsg?.content).toContainEqual(
        expect.objectContaining({ type: ContentTypes.TEXT, text: 'Hello' }),
      );
    });

    it('should ensure userMessage is present in multi-tab scenarios', () => {
      const userMsg = createUserMessage();
      mockGetMessages.mockReturnValue([]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission({ userMessage: userMsg });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(mockSetMessages).toHaveBeenCalled();
      const setMessagesCall = mockSetMessages.mock.calls[0][0];
      expect(setMessagesCall).toContainEqual(
        expect.objectContaining({ messageId: userMsg.messageId }),
      );
    });

    /**
     * Regression: the preempt-fold incident. When the missing user message is
     * restored while its abandoned (preempt-incomplete) sibling responses are
     * already in the list, appending it at the tail orders those children
     * BEFORE their parent — buildTree then hoists them into phantom root
     * branches and the thread folds to the latest branch until a refetch.
     */
    it('inserts a missing user message before its abandoned sibling responses', () => {
      const rootUser = createUserMessage({ messageId: 'user-1' });
      const assist1 = createResponseMessage({ messageId: 'assist-1', parentMessageId: 'user-1' });
      const user2 = createUserMessage({ messageId: 'user-2', parentMessageId: 'assist-1' });
      const assist2 = createResponseMessage({ messageId: 'assist-2', parentMessageId: 'user-2' });
      const abandoned1 = createResponseMessage({
        messageId: 'abandoned-1',
        parentMessageId: 'user-3',
        unfinished: true,
      });
      const abandoned2 = createResponseMessage({
        messageId: 'abandoned-2',
        parentMessageId: 'user-3',
        unfinished: true,
      });
      const user3 = createUserMessage({ messageId: 'user-3', parentMessageId: 'assist-2' });

      const cachedMessages = [rootUser, assist1, user2, assist2, abandoned1, abandoned2];
      mockGetMessages.mockReturnValue(cachedMessages);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep({ runId: 'assist-3' });
      const submission = createSubmission({
        userMessage: user3,
        messages: cachedMessages,
        initialResponse: createResponseMessage({
          messageId: 'user-3_',
          parentMessageId: 'user-3',
        }),
      });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(mockSetMessages).toHaveBeenCalled();
      const written = mockSetMessages.mock.calls[0][0] as TMessage[];
      expect(written.map((message) => message.messageId)).toEqual([
        'user-1',
        'assist-1',
        'user-2',
        'assist-2',
        'user-3',
        'abandoned-1',
        'abandoned-2',
        'assist-3',
      ]);
    });

    it('keeps the pending user message when replayed OAuth tool calls merge immediately', () => {
      const rootUser = createUserMessage({ messageId: 'root-user' });
      const selectedResponse = createResponseMessage({
        messageId: 'selected-response',
        parentMessageId: rootUser.messageId,
      });
      const followUpUser = createUserMessage({
        messageId: 'follow-up-user',
        parentMessageId: selectedResponse.messageId,
      });
      const followUpResponse = createResponseMessage({
        messageId: 'follow-up-response',
        parentMessageId: followUpUser.messageId,
      });
      const siblingResponse = createResponseMessage({
        messageId: 'sibling-response',
        parentMessageId: rootUser.messageId,
      });
      const pendingUser = createUserMessage({
        messageId: 'pending-user',
        parentMessageId: followUpResponse.messageId,
      });
      const initialResponse = createResponseMessage({
        messageId: 'pending-user_',
        parentMessageId: pendingUser.messageId,
      });

      let currentMessages = [
        rootUser,
        selectedResponse,
        followUpUser,
        followUpResponse,
        siblingResponse,
      ];
      mockGetMessages.mockImplementation(() => currentMessages);
      mockSetMessages.mockImplementation((messages) => {
        currentMessages = messages;
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createToolCallRunStep({
        id: 'step-oauth-login',
        runId: USE_PRELIM_RESPONSE_MESSAGE_ID,
        stepDetails: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [
            {
              id: 'tool-call-oauth',
              name: `oauth${Constants.mcp_delimiter}Google-Workspace`,
              args: '',
              type: ToolCallTypes.TOOL_CALL,
            },
          ],
        },
      });
      const submission = createSubmission({
        userMessage: pendingUser,
        messages: currentMessages,
        initialResponse,
      });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(currentMessages.map((message) => message.messageId)).toEqual([
        rootUser.messageId,
        selectedResponse.messageId,
        followUpUser.messageId,
        followUpResponse.messageId,
        siblingResponse.messageId,
        pendingUser.messageId,
        initialResponse.messageId,
      ]);
      expect(currentMessages.at(-1)).toEqual(
        expect.objectContaining({
          messageId: initialResponse.messageId,
          parentMessageId: pendingUser.messageId,
          content: expect.arrayContaining([
            expect.objectContaining({
              type: ContentTypes.TOOL_CALL,
              tool_call: expect.objectContaining({
                name: `oauth${Constants.mcp_delimiter}Google-Workspace`,
              }),
            }),
          ]),
        }),
      );
    });

    it('keeps pending OAuth ancestry when content arrives after an orphaned refresh', () => {
      const rootUser = createUserMessage({ messageId: 'root-user' });
      const existingResponse = createResponseMessage({
        messageId: 'existing-response',
        parentMessageId: rootUser.messageId,
      });
      const pendingUser = createUserMessage({
        messageId: 'pending-user',
        parentMessageId: existingResponse.messageId,
      });
      const initialResponse = createResponseMessage({
        messageId: 'pending-user_',
        parentMessageId: pendingUser.messageId,
      });

      let currentMessages = [rootUser, existingResponse];
      mockGetMessages.mockImplementation(() => currentMessages);
      mockSetMessages.mockImplementation((messages) => {
        currentMessages = messages;
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const submission = createSubmission({
        userMessage: pendingUser,
        messages: [rootUser, existingResponse],
        initialResponse,
      });

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: createToolCallRunStep({
              id: 'step-oauth-login',
              runId: USE_PRELIM_RESPONSE_MESSAGE_ID,
              stepDetails: {
                type: StepTypes.TOOL_CALLS,
                tool_calls: [
                  {
                    id: 'tool-call-oauth',
                    name: `oauth${Constants.mcp_delimiter}Google-Workspace`,
                    args: '',
                    type: ToolCallTypes.TOOL_CALL,
                  },
                ],
              },
            }),
          },
          submission,
        );
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: createRunStep({
              id: 'step-message',
              runId: USE_PRELIM_RESPONSE_MESSAGE_ID,
              index: 0,
            }),
          },
          submission,
        );
      });

      currentMessages = [initialResponse];

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-message', 'Ready') },
          submission,
        );
      });

      expect(currentMessages.map((message) => message.messageId)).toEqual([
        rootUser.messageId,
        existingResponse.messageId,
        pendingUser.messageId,
        initialResponse.messageId,
      ]);
      expect(currentMessages.at(-1)).toEqual(
        expect.objectContaining({
          parentMessageId: pendingUser.messageId,
          content: [{ type: ContentTypes.TEXT, text: 'Ready' }],
        }),
      );
    });

    it('replaces the preliminary OAuth response when post-auth streaming uses a stable response id', () => {
      const rootUser = createUserMessage({ messageId: 'root-user' });
      const existingResponse = createResponseMessage({
        messageId: 'existing-response',
        parentMessageId: rootUser.messageId,
      });
      const pendingUser = createUserMessage({
        messageId: 'pending-user',
        parentMessageId: existingResponse.messageId,
      });
      const preliminaryResponse = createResponseMessage({
        messageId: 'pending-user_',
        parentMessageId: pendingUser.messageId,
        content: [
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: 'tool-call-oauth',
              name: `oauth${Constants.mcp_delimiter}Google-Workspace`,
              type: ToolCallTypes.TOOL_CALL,
              args: '',
            },
          },
        ],
      });
      const stableResponse = createResponseMessage({
        messageId: 'stable-response',
        parentMessageId: pendingUser.messageId,
      });

      let currentMessages = [rootUser, existingResponse, preliminaryResponse];
      mockGetMessages.mockImplementation(() => currentMessages);
      mockSetMessages.mockImplementation((messages) => {
        currentMessages = messages;
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const submission = createSubmission({
        userMessage: pendingUser,
        messages: [rootUser, existingResponse],
        initialResponse: preliminaryResponse,
      });

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: createRunStep({
              id: 'step-message',
              runId: stableResponse.messageId,
              index: 0,
            }),
          },
          submission,
        );
      });

      expect(currentMessages.map((message) => message.messageId)).toEqual([
        rootUser.messageId,
        existingResponse.messageId,
        pendingUser.messageId,
        stableResponse.messageId,
      ]);

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-message', 'Ready') },
          submission,
        );
      });

      expect(currentMessages.map((message) => message.messageId)).toEqual([
        rootUser.messageId,
        existingResponse.messageId,
        pendingUser.messageId,
        stableResponse.messageId,
      ]);
      expect(currentMessages.at(-1)).toEqual(
        expect.objectContaining({
          messageId: stableResponse.messageId,
          parentMessageId: pendingUser.messageId,
          content: [{ type: ContentTypes.TEXT, text: 'Ready' }],
        }),
      );
    });

    it('should not insert regenerate transport userMessage before preliminary OAuth steps', () => {
      const originalUser = createUserMessage({ messageId: 'original-user-message' });
      const originalResponse = createResponseMessage({
        messageId: 'original-response-message',
        parentMessageId: originalUser.messageId,
      });
      const initialResponse = createResponseMessage({
        messageId: 'original-response-message_',
        parentMessageId: originalUser.messageId,
      });
      const regenerateUserMessage = createUserMessage({
        messageId: 'synthetic-regenerate-user-message',
        parentMessageId: originalResponse.messageId,
      });

      let currentMessages = [originalUser];
      mockGetMessages.mockImplementation(() => currentMessages);
      mockSetMessages.mockImplementation((messages) => {
        currentMessages = messages;
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createToolCallRunStep({
        id: 'step-oauth-login',
        runId: USE_PRELIM_RESPONSE_MESSAGE_ID,
        stepDetails: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [
            {
              id: 'tool-call-oauth',
              name: `oauth${Constants.mcp_delimiter}Google-Workspace`,
              args: '',
              type: ToolCallTypes.TOOL_CALL,
            },
          ],
        },
      });
      const submission = createSubmission({
        userMessage: regenerateUserMessage,
        isRegenerate: true,
        messages: [originalUser, originalResponse],
        initialResponse,
      });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(currentMessages).toHaveLength(2);
      expect(currentMessages.map((message) => message.messageId)).toEqual([
        originalUser.messageId,
        initialResponse.messageId,
      ]);
      expect(currentMessages).not.toContainEqual(
        expect.objectContaining({ messageId: regenerateUserMessage.messageId }),
      );
      expect(currentMessages[1]?.content).toContainEqual(
        expect.objectContaining({
          type: ContentTypes.TOOL_CALL,
          tool_call: expect.objectContaining({
            name: `oauth${Constants.mcp_delimiter}Google-Workspace`,
          }),
        }),
      );
    });

    it('should preserve regenerate history when OAuth steps arrive before optimistic state commits', () => {
      const originalUser = createUserMessage({ messageId: 'original-user-message' });
      const originalResponse = createResponseMessage({
        messageId: 'original-response-message',
        parentMessageId: originalUser.messageId,
      });
      const initialResponse = createResponseMessage({
        messageId: 'original-response-message_',
        parentMessageId: originalUser.messageId,
      });
      const regenerateUserMessage = createUserMessage({
        messageId: 'synthetic-regenerate-user-message',
        parentMessageId: originalResponse.messageId,
      });

      mockGetMessages.mockReturnValue([]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createToolCallRunStep({
        id: 'step-oauth-login',
        runId: USE_PRELIM_RESPONSE_MESSAGE_ID,
        stepDetails: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [
            {
              id: 'tool-call-oauth',
              name: `oauth${Constants.mcp_delimiter}Google-Workspace`,
              args: '',
              type: ToolCallTypes.TOOL_CALL,
            },
          ],
        },
      });
      const submission = createSubmission({
        userMessage: regenerateUserMessage,
        isRegenerate: true,
        messages: [originalUser],
        initialResponse,
      });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      expect(lastCall).toHaveLength(2);
      expect(lastCall.map((message: TMessage) => message.messageId)).toEqual([
        originalUser.messageId,
        initialResponse.messageId,
      ]);
      expect(lastCall).not.toContainEqual(
        expect.objectContaining({ messageId: regenerateUserMessage.messageId }),
      );
      expect(lastCall[1]?.content).toContainEqual(
        expect.objectContaining({
          type: ContentTypes.TOOL_CALL,
          tool_call: expect.objectContaining({
            name: `oauth${Constants.mcp_delimiter}Google-Workspace`,
          }),
        }),
      );
    });

    it('does not seed non-tail regenerate run steps from the latest assistant message', () => {
      const originalUser = createUserMessage({ messageId: 'original-user-message' });
      const originalResponse = createResponseMessage({
        messageId: 'original-response-message',
        parentMessageId: originalUser.messageId,
        content: [
          {
            type: ContentTypes.TEXT,
            text: 'Original response',
          },
        ],
      });
      const followUpUser = createUserMessage({
        messageId: 'follow-up-user-message',
        parentMessageId: originalResponse.messageId,
      });
      const latestResponse = createResponseMessage({
        messageId: 'latest-response-message',
        parentMessageId: followUpUser.messageId,
        content: [
          {
            type: ContentTypes.TEXT,
            text: 'Latest response content must not leak into regenerate',
          },
        ],
      });
      const initialResponse = createResponseMessage({
        messageId: 'original-response-message_',
        parentMessageId: originalUser.messageId,
        content: [],
      });
      const regenerateUserMessage = createUserMessage({
        messageId: 'server-regenerate-user-message',
        parentMessageId: originalResponse.messageId,
      });

      let currentMessages = [originalUser, originalResponse, followUpUser, latestResponse];
      mockGetMessages.mockImplementation(() => currentMessages);
      mockSetMessages.mockImplementation((messages) => {
        currentMessages = messages;
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep({
        id: 'step-message-create',
        runId: 'server-regenerated-response-message',
      });
      const submission = createSubmission({
        userMessage: regenerateUserMessage,
        isRegenerate: true,
        messages: [originalUser],
        initialResponse,
      });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      const regeneratedResponse = currentMessages.find(
        (message) => message.messageId === 'server-regenerated-response-message',
      );
      expect(regeneratedResponse).toEqual(
        expect.objectContaining({
          parentMessageId: originalUser.messageId,
          content: [],
        }),
      );
      expect(regeneratedResponse?.content).not.toEqual(latestResponse.content);
      expect(currentMessages.map((message) => message.messageId)).toEqual([
        originalUser.messageId,
        'server-regenerated-response-message',
      ]);
    });

    it('preserves sibling assistant responses when regenerating one response', () => {
      const originalUser = createUserMessage({ messageId: 'original-user-message' });
      const selectedResponse = createResponseMessage({
        messageId: 'selected-response-message',
        parentMessageId: originalUser.messageId,
        content: [
          {
            type: ContentTypes.TEXT,
            text: 'Selected response',
          },
        ],
      });
      const siblingResponse = createResponseMessage({
        messageId: 'sibling-response-message',
        parentMessageId: originalUser.messageId,
        content: [
          {
            type: ContentTypes.TEXT,
            text: 'Sibling response should stay visible',
          },
        ],
      });
      const initialResponse = createResponseMessage({
        messageId: 'selected-response-message_',
        parentMessageId: originalUser.messageId,
        content: [],
      });
      const regenerateUserMessage = createUserMessage({
        messageId: 'server-regenerate-user-message',
        parentMessageId: selectedResponse.messageId,
        responseMessageId: initialResponse.messageId,
      });

      let currentMessages = [originalUser, selectedResponse, siblingResponse];
      mockGetMessages.mockImplementation(() => currentMessages);
      mockSetMessages.mockImplementation((messages) => {
        currentMessages = messages;
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep({
        id: 'step-message-create',
        runId: 'server-regenerated-response-message',
      });
      const submission = createSubmission({
        userMessage: regenerateUserMessage,
        isRegenerate: true,
        messages: [originalUser, selectedResponse, siblingResponse],
        initialResponse,
      });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(currentMessages.map((message) => message.messageId)).toEqual([
        originalUser.messageId,
        siblingResponse.messageId,
        'server-regenerated-response-message',
      ]);
      expect(currentMessages).not.toContainEqual(
        expect.objectContaining({ messageId: selectedResponse.messageId }),
      );
    });

    it('should propagate step metadata (agentId, groupId) for parallel rendering', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createToolCallRunStep({
        agentId: 'agent-1',
        groupId: 2,
      });
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall.find((m: TMessage) => !m.isCreatedByUser);
      const toolCallContent = responseMsg?.content?.find(
        (c: TMessageContentParts) => c.type === ContentTypes.TOOL_CALL,
      );
      expect(toolCallContent).toMatchObject({
        agentId: 'agent-1',
        groupId: 2,
      });
    });

    it('carries a steer landed on the placeholder into the renamed response', () => {
      const user = createUserMessage({ messageId: 'user-1' });
      const steerPart = {
        type: ContentTypes.STEER,
        [ContentTypes.STEER]: 'change of plan',
        steerId: 'steer-1',
      } as TMessageContentParts;
      const placeholder = createResponseMessage({
        messageId: 'user-1_',
        parentMessageId: 'user-1',
        content: [steerPart],
      });
      mockGetMessages.mockReturnValue([user, placeholder]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const submission = createSubmission({
        userMessage: user,
        messages: [user, placeholder],
        initialResponse: createResponseMessage({ messageId: 'user-1_', parentMessageId: 'user-1' }),
      });

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: createRunStep({ runId: 'server-resp', index: 1 }),
          },
          submission,
        );
      });

      const calls = mockSetMessages.mock.calls;
      const written = calls[calls.length - 1][0] as TMessage[];
      expect(written.map((message) => message.messageId)).toEqual(['user-1', 'server-resp']);
      expect(written[1].content?.[0]).toEqual(
        expect.objectContaining({ type: ContentTypes.STEER, steerId: 'steer-1' }),
      );
    });

    it('seeds a regenerated response from the submission placeholder, steer included', () => {
      const user = createUserMessage({ messageId: 'user-1' });
      const priorResponse = createResponseMessage({
        messageId: 'prior-resp',
        parentMessageId: 'user-1',
        content: [{ type: ContentTypes.TEXT, text: 'old answer' }],
      });
      const steerPart = {
        type: ContentTypes.STEER,
        [ContentTypes.STEER]: 'change of plan',
        steerId: 'steer-1',
      } as TMessageContentParts;
      const placeholder = createResponseMessage({
        messageId: 'user-1_',
        parentMessageId: 'user-1',
        content: [steerPart],
      });
      mockGetMessages.mockReturnValue([user, priorResponse, placeholder]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const submission = createSubmission({
        userMessage: user,
        isRegenerate: true,
        messages: [user, priorResponse],
        initialResponse: placeholder,
      });

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: createRunStep({ runId: 'server-resp', index: 1 }),
          },
          submission,
        );
      });

      const calls = mockSetMessages.mock.calls;
      const written = calls[calls.length - 1][0] as TMessage[];
      const ids = written.map((message) => message.messageId);
      expect(ids).toContain('server-resp');
      expect(ids).not.toContain('user-1_');
      const response = written.find((message) => message.messageId === 'server-resp');
      expect(response?.content?.[0]).toEqual(
        expect.objectContaining({ type: ContentTypes.STEER, steerId: 'steer-1' }),
      );
    });
  });

  describe('on_agent_update event', () => {
    it('should update message with agent update content', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      mockSetMessages.mockClear();

      const agentUpdate: Agents.AgentUpdate = {
        type: ContentTypes.AGENT_UPDATE,
        agent_update: {
          runId: 'response-msg-1',
          index: 1,
          agentId: 'agent-1',
        },
      };

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_AGENT_UPDATE, data: agentUpdate },
          submission,
        );
      });

      expect(mockSetMessages).toHaveBeenCalled();
    });

    it('should warn when no responseMessageId for agent update', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const agentUpdate: Agents.AgentUpdate = {
        type: ContentTypes.AGENT_UPDATE,
        agent_update: {
          runId: '',
          index: 0,
          agentId: 'agent-1',
        },
      };
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_AGENT_UPDATE, data: agentUpdate },
          submission,
        );
      });

      expect(consoleSpy).toHaveBeenCalledWith('No message id found in agent update event');
      consoleSpy.mockRestore();
    });
  });

  describe('on_message_delta event', () => {
    it('should append text delta to existing content', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      mockSetMessages.mockClear();

      const messageDelta = createMessageDelta('step-1', 'Hello');

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: messageDelta },
          submission,
        );
      });

      expect(mockSetMessages).toHaveBeenCalled();
      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall[lastCall.length - 1];
      expect(responseMsg.content).toContainEqual(
        expect.objectContaining({ type: ContentTypes.TEXT, text: 'Hello' }),
      );
    });

    it('should buffer delta when step does not exist', () => {
      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const messageDelta = createMessageDelta('nonexistent-step', 'Buffered');
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: messageDelta },
          submission,
        );
      });

      expect(mockSetMessages).not.toHaveBeenCalled();
    });

    it('should concatenate multiple text deltas', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-1', 'Hello ') },
          submission,
        );
      });

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-1', 'World') },
          submission,
        );
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall[lastCall.length - 1];
      expect(responseMsg.content).toContainEqual(
        expect.objectContaining({ type: ContentTypes.TEXT, text: 'Hello World' }),
      );
    });

    it('applies every entry of a multi-part text delta in order', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_MESSAGE_DELTA,
            data: {
              id: 'step-1',
              delta: {
                content: [
                  { type: ContentTypes.TEXT, text: 'Hello ' },
                  { type: ContentTypes.TEXT, text: 'streaming ' },
                  { type: ContentTypes.TEXT, text: 'world' },
                ],
              },
            },
          },
          submission,
        );
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall[lastCall.length - 1];
      expect(responseMsg.content).toContainEqual(
        expect.objectContaining({ type: ContentTypes.TEXT, text: 'Hello streaming world' }),
      );
    });

    it('coalesces multiple deltas into a single flush per animation frame', () => {
      const rafQueue: FrameRequestCallback[] = [];
      (window.requestAnimationFrame as jest.Mock).mockImplementation((cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      });

      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });
      mockSetMessages.mockClear();

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-1', 'Hello ') },
          submission,
        );
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-1', 'World') },
          submission,
        );
      });

      expect(mockSetMessages).not.toHaveBeenCalled();
      expect(rafQueue).toHaveLength(1);

      act(() => {
        rafQueue.forEach((cb) => cb(0));
      });

      expect(mockSetMessages).toHaveBeenCalledTimes(1);
      const flushed = mockSetMessages.mock.calls[0][0];
      const responseMsg = flushed[flushed.length - 1];
      expect(responseMsg.content).toContainEqual(
        expect.objectContaining({ type: ContentTypes.TEXT, text: 'Hello World' }),
      );
    });

    it('flushPendingDeltas applies queued tokens synchronously and voids the frame', () => {
      const rafQueue: FrameRequestCallback[] = [];
      (window.requestAnimationFrame as jest.Mock).mockImplementation((cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      });

      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });
      mockSetMessages.mockClear();

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-1', 'Hello ') },
          submission,
        );
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-1', 'World') },
          submission,
        );
      });
      expect(mockSetMessages).not.toHaveBeenCalled();

      act(() => {
        result.current.flushPendingDeltas();
      });

      expect(mockSetMessages).toHaveBeenCalledTimes(1);
      const flushed = mockSetMessages.mock.calls[0][0];
      const responseMsg = flushed[flushed.length - 1];
      expect(responseMsg.content).toContainEqual(
        expect.objectContaining({ type: ContentTypes.TEXT, text: 'Hello World' }),
      );

      act(() => {
        rafQueue.forEach((cb) => cb(0));
      });
      expect(mockSetMessages).toHaveBeenCalledTimes(1);
    });

    it('should return early when contentPart is null', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      mockSetMessages.mockClear();

      const messageDelta: Agents.MessageDeltaEvent = {
        id: 'step-1',
        delta: { content: [] },
      };

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: messageDelta },
          submission,
        );
      });

      expect(mockSetMessages).not.toHaveBeenCalled();
    });
  });

  describe('on_reasoning_delta event', () => {
    it('should append reasoning delta to existing content', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      mockSetMessages.mockClear();

      const reasoningDelta = createReasoningDelta('step-1', 'Thinking...');

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_REASONING_DELTA, data: reasoningDelta },
          submission,
        );
      });

      expect(mockSetMessages).toHaveBeenCalled();
      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall[lastCall.length - 1];
      expect(responseMsg.content).toContainEqual(
        expect.objectContaining({ type: ContentTypes.THINK, think: 'Thinking...' }),
      );
    });

    it('should buffer reasoning delta when step does not exist', () => {
      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const reasoningDelta = createReasoningDelta('nonexistent-step', 'Buffered');
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_REASONING_DELTA, data: reasoningDelta },
          submission,
        );
      });

      expect(mockSetMessages).not.toHaveBeenCalled();
    });

    it('should concatenate multiple reasoning deltas', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_REASONING_DELTA, data: createReasoningDelta('step-1', 'First ') },
          submission,
        );
      });

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_REASONING_DELTA, data: createReasoningDelta('step-1', 'thought') },
          submission,
        );
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall[lastCall.length - 1];
      expect(responseMsg.content).toContainEqual(
        expect.objectContaining({ type: ContentTypes.THINK, think: 'First thought' }),
      );
    });

    it('preserves a live reasoning label across later deltas', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
        result.current.syncStepMessage({
          ...responseMessage,
          content: [
            {
              type: ContentTypes.THINK,
              think: 'First ',
              reasoning_label: 'Tracing the streaming path',
              reasoning_label_step_id: 'step-1',
              reasoning_label_attempts: 1,
              reasoning_label_submitted_chars: 6,
              reasoning_label_revision: 1,
              reasoning_label_status: 'streaming',
            },
          ],
        });
        result.current.stepHandler(
          { event: StepEvents.ON_REASONING_DELTA, data: createReasoningDelta('step-1', 'thought') },
          submission,
        );
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall[lastCall.length - 1];
      expect(responseMsg.content).toContainEqual(
        expect.objectContaining({
          type: ContentTypes.THINK,
          think: 'First thought',
          reasoning_label: 'Tracing the streaming path',
          reasoning_label_attempts: 1,
          reasoning_label_submitted_chars: 6,
          reasoning_label_revision: 1,
          reasoning_label_status: 'streaming',
        }),
      );
    });

    it('clears a retained label when a new reasoning step folds into the same part', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
        result.current.syncStepMessage({
          ...responseMessage,
          content: [
            {
              type: ContentTypes.THINK,
              think: 'Retained ',
              reasoning_label: 'Inspecting the old path',
              reasoning_label_step_id: 'old-step',
              reasoning_label_attempts: 3,
              reasoning_label_submitted_chars: 9,
              reasoning_label_revision: 3,
              reasoning_label_status: 'complete',
            },
          ],
        });
        result.current.stepHandler(
          { event: StepEvents.ON_REASONING_DELTA, data: createReasoningDelta('step-1', 'thought') },
          submission,
        );
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const part = lastCall.at(-1)?.content?.[0];
      expect(part).toMatchObject({
        type: ContentTypes.THINK,
        think: 'Retained thought',
        reasoning_label_step_id: 'step-1',
      });
      expect(part).not.toHaveProperty('reasoning_label');
      expect(part).not.toHaveProperty('reasoning_label_attempts');
      expect(part).not.toHaveProperty('reasoning_label_submitted_chars');
      expect(part).not.toHaveProperty('reasoning_label_revision');
    });

    it('clears a retained label when THINK arrives through a message delta', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
        result.current.syncStepMessage({
          ...responseMessage,
          content: [
            {
              type: ContentTypes.THINK,
              think: 'Retained ',
              reasoning_label: 'Inspecting the old path',
              reasoning_label_step_id: 'old-step',
              reasoning_label_attempts: 3,
              reasoning_label_submitted_chars: 9,
              reasoning_label_revision: 3,
              reasoning_label_status: 'complete',
            },
          ],
        });
        result.current.stepHandler(
          {
            event: StepEvents.ON_MESSAGE_DELTA,
            data: {
              id: 'step-1',
              delta: { content: [{ type: ContentTypes.THINK, think: 'thought' }] },
            },
          },
          submission,
        );
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const part = lastCall.at(-1)?.content?.[0];
      expect(part).toMatchObject({
        type: ContentTypes.THINK,
        think: 'Retained thought',
        reasoning_label_step_id: 'step-1',
      });
      expect(part).not.toHaveProperty('reasoning_label');
      expect(part).not.toHaveProperty('reasoning_label_attempts');
      expect(part).not.toHaveProperty('reasoning_label_submitted_chars');
      expect(part).not.toHaveProperty('reasoning_label_revision');
    });

    it('applies every entry of a multi-part reasoning delta in order', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_REASONING_DELTA,
            data: {
              id: 'step-1',
              delta: {
                content: [
                  { type: ContentTypes.THINK, think: 'First reasoning block. ' },
                  { type: ContentTypes.THINK, think: 'Second reasoning block.' },
                ],
              },
            },
          },
          submission,
        );
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall[lastCall.length - 1];
      expect(responseMsg.content).toContainEqual(
        expect.objectContaining({
          type: ContentTypes.THINK,
          think: 'First reasoning block. Second reasoning block.',
        }),
      );
    });
  });

  describe('on_run_step_delta event', () => {
    it('should update tool call with delta args', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createToolCallRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      mockSetMessages.mockClear();

      const runStepDelta: Agents.RunStepDeltaEvent = {
        id: 'step-tool-1',
        delta: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [{ name: 'test_tool', args: '{"key": "value"}' }],
        },
      };

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_RUN_STEP_DELTA, data: runStepDelta },
          submission,
        );
      });

      expect(mockSetMessages).toHaveBeenCalled();
    });

    it('should buffer run step delta when step does not exist', () => {
      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStepDelta: Agents.RunStepDeltaEvent = {
        id: 'nonexistent-step',
        delta: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [{ name: 'test_tool', args: '{}' }],
        },
      };
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_RUN_STEP_DELTA, data: runStepDelta },
          submission,
        );
      });

      expect(mockSetMessages).not.toHaveBeenCalled();
    });

    it('should handle auth information in run step delta', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createToolCallRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      mockSetMessages.mockClear();

      const runStepDelta: Agents.RunStepDeltaEvent = {
        id: 'step-tool-1',
        delta: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [{ name: 'test_tool', args: '{}' }],
          auth: 'oauth-token-123',
          expires_at: 1704067200,
        },
      };

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_RUN_STEP_DELTA, data: runStepDelta },
          submission,
        );
      });

      expect(mockSetMessages).toHaveBeenCalled();
      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall.find((m: TMessage) => !m.isCreatedByUser);
      const toolCallContent = responseMsg?.content?.find(
        (c: TMessageContentParts) => c.type === ContentTypes.TOOL_CALL,
      );
      expect(toolCallContent?.tool_call?.auth).toEqual('oauth-token-123');
    });
  });

  describe('sandbox startup state', () => {
    const wrapper = ({ children }: React.PropsWithChildren) =>
      React.createElement(RecoilRoot, null, React.createElement(IsolatedAtomStore, null, children));

    it.each(['completed', 'cleanup'] as const)(
      'clears the Jotai startup signal on %s',
      (terminal) => {
        mockGetMessages.mockReturnValue([createResponseMessage()]);
        const { result } = renderHook(
          () => ({
            ...useStepHandler(createHookParams()),
            starting: useAtomValue(sandboxStartingByToolCallId('tool-call-1')),
          }),
          { wrapper },
        );
        const submission = createSubmission();
        expect(result.current.starting).toBe(false);
        act(() => {
          result.current.stepHandler(
            { event: StepEvents.ON_RUN_STEP, data: createToolCallRunStep() },
            submission,
          );
          result.current.stepHandler(
            { event: StepEvents.ON_SANDBOX_STARTING, data: { tool_call_id: 'tool-call-1' } },
            submission,
          );
        });
        expect(result.current.starting).toBe(true);
        act(() => {
          if (terminal === 'cleanup') {
            result.current.clearStepMaps();
            return;
          }
          result.current.stepHandler(
            {
              event: StepEvents.ON_RUN_STEP_COMPLETED,
              data: {
                result: {
                  id: 'step-tool-1',
                  index: 0,
                  tool_call: {
                    id: 'tool-call-1',
                    name: 'test_tool',
                    args: '{}',
                    output: 'done',
                    type: ToolCallTypes.TOOL_CALL,
                  },
                } as Agents.ToolEndEvent,
              },
            },
            submission,
          );
        });
        expect(result.current.starting).toBe(false);
      },
    );
  });

  describe('on_run_step_completed event', () => {
    it('should finalize tool call with output', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createToolCallRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      mockSetMessages.mockClear();

      const completedEvent = {
        result: {
          id: 'step-tool-1',
          index: 0,
          tool_call: {
            id: 'tool-call-1',
            name: 'test_tool',
            args: '{}',
            output: 'Tool result output',
            inputValidationError: true as const,
            type: ToolCallTypes.TOOL_CALL,
          },
        },
      };

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP_COMPLETED,
            data: completedEvent as { result: Agents.ToolEndEvent },
          },
          submission,
        );
      });

      expect(mockSetMessages).toHaveBeenCalled();
      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall.find((m: TMessage) => !m.isCreatedByUser);
      const toolCallContent = responseMsg?.content?.find(
        (c: TMessageContentParts) => c.type === ContentTypes.TOOL_CALL,
      );
      expect(toolCallContent?.tool_call?.output).toBe('Tool result output');
      expect(toolCallContent?.tool_call?.progress).toBe(1);
      expect(toolCallContent?.tool_call?.inputValidationError).toBe(true);
      expect(toolCallContent?.tool_call?.stepId).toBe('step-tool-1');
    });

    it('signals skill authoring when a completed create_file call targets a skill path', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createToolCallRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      const completedEvent = {
        result: {
          id: 'step-tool-1',
          index: 0,
          tool_call: {
            id: 'tool-call-1',
            name: 'create_file',
            args: JSON.stringify({ file_path: 'skills/demo/SKILL.md', content: '# Demo' }),
            output: 'Updated skills/demo/SKILL.md (6 chars).',
            type: ToolCallTypes.TOOL_CALL,
          },
        },
      };

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP_COMPLETED,
            data: completedEvent as { result: Agents.ToolEndEvent },
          },
          submission,
        );
      });

      expect(mockOnSkillAuthoringComplete).toHaveBeenCalledTimes(1);
    });

    it('does not signal skill authoring for non-skill file authoring calls', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createToolCallRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      const completedEvent = {
        result: {
          id: 'step-tool-1',
          index: 0,
          tool_call: {
            id: 'tool-call-1',
            name: 'create_file',
            args: JSON.stringify({ file_path: '/mnt/data/report.md', content: '# Report' }),
            output: 'Created /mnt/data/report.md (8 chars).',
            type: ToolCallTypes.TOOL_CALL,
          },
        },
      };

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP_COMPLETED,
            data: completedEvent as { result: Agents.ToolEndEvent },
          },
          submission,
        );
      });

      expect(mockOnSkillAuthoringComplete).not.toHaveBeenCalled();
    });

    it('should warn when step not found for completed event', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const completedEvent = {
        result: {
          id: 'nonexistent-step',
          index: 0,
          tool_call: {
            id: 'tool-call-1',
            name: 'test_tool',
            args: '{}',
            type: ToolCallTypes.TOOL_CALL,
          },
        },
      };
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP_COMPLETED,
            data: completedEvent as { result: Agents.ToolEndEvent },
          },
          submission,
        );
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        'No run step or runId found for completed tool call event',
      );
      consoleSpy.mockRestore();
    });

    it('should mark completed OAuth prompts as finished', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createToolCallRunStep({
        id: 'step-oauth-eli',
        stepDetails: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [
            {
              id: 'tool-call-eli',
              name: `oauth${Constants.mcp_delimiter}ELI`,
              args: '',
              type: ToolCallTypes.TOOL_CALL,
            },
          ],
        },
      });
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP_COMPLETED,
            data: {
              result: {
                id: 'step-oauth-eli',
                index: 0,
                tool_call: {
                  id: 'tool-call-eli',
                  name: `oauth${Constants.mcp_delimiter}ELI`,
                  args: '',
                  output: 'OAuth authentication completed',
                  type: ToolCallTypes.TOOL_CALL,
                },
              },
            },
          },
          submission,
        );
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall.find((m: TMessage) => !m.isCreatedByUser);
      expect(responseMsg?.content?.[0]?.tool_call?.progress).toBe(1);
    });
  });

  describe('clearStepMaps', () => {
    it('should clear all internal maps', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      act(() => {
        result.current.clearStepMaps();
      });

      mockSetMessages.mockClear();

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-1', 'Test') },
          submission,
        );
      });

      expect(mockSetMessages).not.toHaveBeenCalled();
    });
  });

  describe('syncStepMessage', () => {
    it('should sync message into messageMap', () => {
      const responseMessage = createResponseMessage({
        content: [{ type: ContentTypes.TEXT, text: 'Synced content' }],
      });
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      act(() => {
        result.current.syncStepMessage(responseMessage);
      });

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-1', ' more') },
          submission,
        );
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall[lastCall.length - 1];
      expect(responseMsg.content).toContainEqual(
        expect.objectContaining({ type: ContentTypes.TEXT, text: 'Synced content more' }),
      );
    });

    it('should handle null message gracefully', () => {
      const { result } = renderHook(() => useStepHandler(createHookParams()));

      expect(() => {
        act(() => {
          result.current.syncStepMessage(null as unknown as TMessage);
        });
      }).not.toThrow();
    });

    it('should handle message without messageId gracefully', () => {
      const { result } = renderHook(() => useStepHandler(createHookParams()));

      expect(() => {
        act(() => {
          result.current.syncStepMessage({ ...createResponseMessage(), messageId: '' });
        });
      }).not.toThrow();
    });
  });

  describe('announcePolite for accessibility', () => {
    it('should announce composing after MESSAGE_UPDATE_INTERVAL', () => {
      const MESSAGE_UPDATE_INTERVAL = 7000;
      mockLastAnnouncementTimeRef.current = Date.now() - MESSAGE_UPDATE_INTERVAL - 1;

      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(mockAnnouncePolite).toHaveBeenCalledWith({ message: 'composing', isStatus: true });
    });

    it('should not announce if within MESSAGE_UPDATE_INTERVAL', () => {
      mockLastAnnouncementTimeRef.current = Date.now();

      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(mockAnnouncePolite).not.toHaveBeenCalled();
    });
  });

  describe('edited content scenarios', () => {
    it('should use initialResponse content for index offsetting in edit scenarios', () => {
      const existingContent: TMessageContentParts[] = [
        { type: ContentTypes.TEXT, text: 'Previous content' },
      ];
      const initialResponse = createResponseMessage({
        messageId: 'initial-response-id',
        content: existingContent,
      });
      mockGetMessages.mockReturnValue([initialResponse]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep({
        runId: 'initial-response-id',
        index: 0,
      });
      const submission = createSubmission({
        editedContent: { index: 0, type: ContentTypes.TEXT, text: 'Previous content' },
        initialResponse,
      });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(mockSetMessages).toHaveBeenCalled();
    });
  });

  describe('delta buffering and replay', () => {
    it('should buffer multiple deltas and replay in order', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const submission = createSubmission();
      const stepId = 'step-multi-buffer';

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta(stepId, 'First ') },
          submission,
        );
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta(stepId, 'Second ') },
          submission,
        );
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta(stepId, 'Third') },
          submission,
        );
      });

      expect(mockSetMessages).not.toHaveBeenCalled();

      const runStep = createRunStep({ id: stepId });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(mockSetMessages).toHaveBeenCalled();
      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall.find((m: TMessage) => !m.isCreatedByUser);
      expect(responseMsg?.content).toContainEqual(
        expect.objectContaining({ type: ContentTypes.TEXT, text: 'First Second Third' }),
      );
    });

    it('should buffer mixed delta types and replay correctly', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const submission = createSubmission();
      const stepId = 'step-mixed-buffer';

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_REASONING_DELTA,
            data: createReasoningDelta(stepId, 'Thinking...'),
          },
          submission,
        );
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta(stepId, 'Response') },
          submission,
        );
      });

      expect(mockSetMessages).not.toHaveBeenCalled();

      const runStep = createRunStep({ id: stepId });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(mockSetMessages).toHaveBeenCalled();
    });
  });

  describe('content type mismatch handling', () => {
    it('displaces a synthetic ask-user-question card when the resumed segment streams into its slot', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      /** The pause-scoped card is appended at the END of the content — exactly
       *  the ABSOLUTE index the resumed run's first new part arrives at. */
      const askPart = {
        type: 'ask_user_question',
        ask_user_question: { actionId: 'a1', question: { question: 'Which?' } },
      } as unknown as TMessageContentParts;
      const responseMessage = createResponseMessage({
        content: [{ type: ContentTypes.TEXT, text: 'Pre-pause text' }, askPart],
      });
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      act(() => {
        result.current.syncStepMessage(responseMessage);
      });

      const runStep = createRunStep({ index: 1 });
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      const textDelta: Agents.MessageDeltaEvent = {
        id: 'step-1',
        delta: { content: [{ type: ContentTypes.TEXT, text: 'Resumed answer' }] },
      };

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: textDelta },
          submission,
        );
      });

      expect(consoleSpy).not.toHaveBeenCalledWith('Content type mismatch', expect.anything());

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1];
      const updated = lastCall[0][lastCall[0].length - 1] as TMessage;
      const content = updated.content as Array<{ type?: string; text?: string }>;
      expect(content.some((part) => part?.type === 'ask_user_question')).toBe(false);
      expect(content[1]).toMatchObject({ type: ContentTypes.TEXT, text: 'Resumed answer' });
      consoleSpy.mockRestore();
    });

    it('drops an answered ask card when the resumed segment streams AROUND its slot', () => {
      /**
       * The first event after a resume re-renders the ask tool_call at ITS OWN
       * index, never the card's, so the slot displacement above cannot fire.
       * This handler's cached copy still holds the card the answer-submit
       * stripped from the store; writing it back reopened the popover over an
       * answered question with its options locked.
       */
      const askPart = {
        type: 'ask_user_question',
        ask_user_question: { actionId: 'a2', question: { question: 'Which env?' } },
      } as unknown as TMessageContentParts;
      const askToolCall = {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'ask-call-1',
          name: 'ask_user_question',
          args: '{"question":"Which env?"}',
          type: ToolCallTypes.TOOL_CALL,
        },
      } as unknown as TMessageContentParts;
      /** Card appended at the END (index 2), ask tool_call at index 1. */
      const paused = createResponseMessage({
        content: [{ type: ContentTypes.TEXT, text: 'Let me ask.' }, askToolCall, askPart],
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      act(() => {
        result.current.syncStepMessage(paused);
      });

      /** The user answers: the store copy is stripped + stamped, and the action
       *  is recorded as answered. The handler's cached copy is untouched. */
      const answered = resolveAskUserQuestionPart(paused, 'a2', 'prod');
      mockGetMessages.mockReturnValue([answered]);

      /** Resume replays the ask tool_call's completion at index 1, not 2. */
      const askCompletion = createToolCallRunStep({
        id: 'step-ask',
        index: 1,
        stepDetails: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [
            {
              id: 'ask-call-1',
              name: 'ask_user_question',
              args: '{"question":"Which env?"}',
              output: 'prod',
              type: ToolCallTypes.TOOL_CALL,
            },
          ],
        },
      } as Partial<Agents.RunStep>);

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_RUN_STEP, data: askCompletion },
          createSubmission(),
        );
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1];
      const updated = (lastCall[0] as TMessage[]).find((m) => m.messageId === 'response-msg-1');
      const content = (updated?.content ?? []) as Array<{ type?: string }>;
      expect(content.some((part) => part?.type === 'ask_user_question')).toBe(false);
      /** The real content is untouched: only the answered card is dropped. */
      expect(content[1]).toMatchObject({ type: ContentTypes.TOOL_CALL });
    });

    it('does not compact absolute content indices when dropping an answered ask card', () => {
      const askPart = {
        type: 'ask_user_question',
        ask_user_question: { actionId: 'a-sparse', question: { question: 'Which env?' } },
      } as unknown as TMessageContentParts;
      const askToolCall = {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'ask-call-sparse',
          name: 'ask_user_question',
          args: '{"question":"Which env?"}',
          type: ToolCallTypes.TOOL_CALL,
        },
      } as unknown as TMessageContentParts;
      const sparseContent = [{ type: ContentTypes.TEXT, text: 'Before' }] as TMessageContentParts[];
      sparseContent[2] = askToolCall;
      sparseContent[3] = askPart;
      const paused = createResponseMessage({ content: sparseContent });

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      act(() => {
        result.current.syncStepMessage(paused);
      });
      mockGetMessages.mockReturnValue([resolveAskUserQuestionPart(paused, 'a-sparse', 'prod')]);

      const askCompletion = createToolCallRunStep({
        id: 'step-ask-sparse',
        index: 2,
        stepDetails: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [
            {
              id: 'ask-call-sparse',
              name: 'ask_user_question',
              args: '{"question":"Which env?"}',
              output: 'prod',
              type: ToolCallTypes.TOOL_CALL,
            },
          ],
        },
      } as Partial<Agents.RunStep>);

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_RUN_STEP, data: askCompletion },
          createSubmission(),
        );
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1];
      const updated = (lastCall[0] as TMessage[]).find((m) => m.messageId === 'response-msg-1');
      expect(updated?.content?.[1]).toBeUndefined();
      expect(updated?.content?.[2]).toMatchObject({
        type: ContentTypes.TOOL_CALL,
        tool_call: { id: 'ask-call-sparse' },
      });
    });

    it('keeps a still-live ask card when an event streams around its slot', () => {
      /** Only ANSWERED cards are droppable — a late event racing a live pause
       *  must not take the question away before the user can respond. */
      const askPart = {
        type: 'ask_user_question',
        ask_user_question: { actionId: 'a3', question: { question: 'Live?' } },
      } as unknown as TMessageContentParts;
      const responseMessage = createResponseMessage({
        content: [{ type: ContentTypes.TEXT, text: 'Pre-pause' }, askPart],
      });
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      act(() => {
        result.current.syncStepMessage(responseMessage);
      });

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_RUN_STEP, data: createRunStep({ index: 0 }) },
          createSubmission(),
        );
      });
      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_MESSAGE_DELTA,
            data: {
              id: 'step-1',
              delta: { content: [{ type: ContentTypes.TEXT, text: ' more' }] },
            } as Agents.MessageDeltaEvent,
          },
          createSubmission(),
        );
      });

      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1];
      const updated = (lastCall[0] as TMessage[]).find((m) => m.messageId === 'response-msg-1');
      const content = (updated?.content ?? []) as Array<{ type?: string }>;
      expect(content.some((part) => part?.type === 'ask_user_question')).toBe(true);
    });

    it('should warn on content type mismatch and not overwrite', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const responseMessage = createResponseMessage({
        content: [{ type: ContentTypes.THINK, think: 'Existing thought' }],
      });
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      act(() => {
        result.current.syncStepMessage(responseMessage);
      });

      const runStep = createRunStep({ index: 0 });
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      const textDelta: Agents.MessageDeltaEvent = {
        id: 'step-1',
        delta: { content: [{ type: ContentTypes.TEXT, text: 'New text' }] },
      };

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: textDelta },
          submission,
        );
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        'Content type mismatch',
        expect.objectContaining({
          existingType: ContentTypes.THINK,
          contentType: ContentTypes.TEXT,
        }),
      );
      consoleSpy.mockRestore();
    });
  });

  describe('summarization events', () => {
    it('ON_SUMMARIZE_START calls announcePolite', () => {
      mockLastAnnouncementTimeRef.current = Date.now();
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_SUMMARIZE_START,
            data: {
              agentId: 'agent-1',
              provider: 'test-provider',
              model: 'test-model',
              messagesToRefineCount: 5,
              summaryVersion: 1,
            },
          },
          submission,
        );
      });

      expect(mockAnnouncePolite).toHaveBeenCalledWith({
        message: 'summarize_started',
        isStatus: true,
      });
    });

    it('ON_SUMMARIZE_DELTA accumulates content on known run step', async () => {
      mockLastAnnouncementTimeRef.current = Date.now();
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const submission = createSubmission();

      const runStep = createRunStep({
        summary: {
          type: ContentTypes.SUMMARY,
          model: 'test-model',
          provider: 'test-provider',
        } as TMessageContentParts & { type: typeof ContentTypes.SUMMARY },
      });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      mockSetMessages.mockClear();

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_SUMMARIZE_DELTA,
            data: {
              id: 'step-1',
              delta: {
                summary: {
                  type: ContentTypes.SUMMARY,
                  content: [{ type: ContentTypes.TEXT, text: 'chunk1' }],
                  provider: 'test-provider',
                  model: 'test-model',
                  summarizing: true,
                },
              },
            },
          },
          submission,
        );
      });

      await act(async () => {
        await new Promise((r) => requestAnimationFrame(r));
      });

      expect(mockSetMessages).toHaveBeenCalled();
      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall[lastCall.length - 1];
      const summaryPart = responseMsg.content?.find(
        (c: TMessageContentParts) => c.type === ContentTypes.SUMMARY,
      );
      expect(summaryPart).toBeDefined();
      expect(summaryPart.content).toContainEqual(
        expect.objectContaining({ type: ContentTypes.TEXT, text: 'chunk1' }),
      );
    });

    it('ON_SUMMARIZE_DELTA buffers when run step is not yet known', () => {
      mockLastAnnouncementTimeRef.current = Date.now();
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_SUMMARIZE_DELTA,
            data: {
              id: 'step-1',
              delta: {
                summary: {
                  type: ContentTypes.SUMMARY,
                  content: [{ type: ContentTypes.TEXT, text: 'buffered chunk' }],
                  provider: 'test-provider',
                  model: 'test-model',
                  summarizing: true,
                },
              },
            },
          },
          submission,
        );
      });

      expect(mockSetMessages).not.toHaveBeenCalled();
    });

    it('ON_SUMMARIZE_COMPLETE success replaces summarizing part with finalized summary', () => {
      mockLastAnnouncementTimeRef.current = Date.now();
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const submission = createSubmission();

      const runStep = createRunStep({
        summary: {
          type: ContentTypes.SUMMARY,
          model: 'test-model',
          provider: 'test-provider',
        } as TMessageContentParts & { type: typeof ContentTypes.SUMMARY },
      });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_SUMMARIZE_DELTA,
            data: {
              id: 'step-1',
              delta: {
                summary: {
                  type: ContentTypes.SUMMARY,
                  content: [{ type: ContentTypes.TEXT, text: 'partial' }],
                  provider: 'test-provider',
                  model: 'test-model',
                  summarizing: true,
                },
              },
            },
          },
          submission,
        );
      });

      mockSetMessages.mockClear();
      mockAnnouncePolite.mockClear();

      const lastSetCall = mockGetMessages.mock.results[mockGetMessages.mock.results.length - 1];
      const latestMessages = lastSetCall?.value ?? [];
      mockGetMessages.mockReturnValue(
        latestMessages.length > 0 ? latestMessages : [responseMessage],
      );

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_SUMMARIZE_COMPLETE,
            data: {
              id: 'step-1',
              agentId: 'agent-1',
              summary: {
                type: ContentTypes.SUMMARY,
                content: [{ type: ContentTypes.TEXT, text: 'Final summary' }],
                tokenCount: 100,
                summarizing: false,
              },
            },
          },
          submission,
        );
      });

      expect(mockAnnouncePolite).toHaveBeenCalledWith({
        message: 'summarize_completed',
        isStatus: true,
      });
      expect(mockSetMessages).toHaveBeenCalled();
      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall.find((m: TMessage) => m.messageId === 'response-msg-1');
      const summaryPart = responseMsg?.content?.find(
        (c: TMessageContentParts) => c.type === ContentTypes.SUMMARY,
      );
      expect(summaryPart).toMatchObject({ summarizing: false });
    });

    it('ON_SUMMARIZE_COMPLETE error finalizes the part in place without splicing it out', () => {
      mockLastAnnouncementTimeRef.current = Date.now();
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const submission = createSubmission();

      const runStep = createRunStep({
        summary: {
          type: ContentTypes.SUMMARY,
          model: 'test-model',
          provider: 'test-provider',
        } as TMessageContentParts & { type: typeof ContentTypes.SUMMARY },
      });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_SUMMARIZE_DELTA,
            data: {
              id: 'step-1',
              delta: {
                summary: {
                  type: ContentTypes.SUMMARY,
                  content: [{ type: ContentTypes.TEXT, text: 'partial' }],
                  provider: 'test-provider',
                  model: 'test-model',
                  summarizing: true,
                },
              },
            },
          },
          submission,
        );
      });

      mockSetMessages.mockClear();
      mockAnnouncePolite.mockClear();

      const lastSetCall = mockGetMessages.mock.results[mockGetMessages.mock.results.length - 1];
      const latestMessages = lastSetCall?.value ?? [];
      mockGetMessages.mockReturnValue(
        latestMessages.length > 0 ? latestMessages : [responseMessage],
      );

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_SUMMARIZE_COMPLETE,
            data: {
              id: 'step-1',
              agentId: 'agent-1',
              error: 'LLM failed',
            },
          },
          submission,
        );
      });

      expect(mockAnnouncePolite).toHaveBeenCalledWith({
        message: 'summarize_failed',
        isStatus: true,
      });
      expect(mockSetMessages).toHaveBeenCalled();
      const lastCall = mockSetMessages.mock.calls[mockSetMessages.mock.calls.length - 1][0];
      const responseMsg = lastCall.find((m: TMessage) => m.messageId === 'response-msg-1');
      /**
       * Failed rounds must keep their slot: splicing shifts every later part
       * under the index-keyed renderer and breaks the position == step-index
       * invariant that updateContent writes rely on. The part is finalized in
       * place with its streamed content preserved.
       */
      const summaryParts =
        responseMsg?.content?.filter(
          (c: TMessageContentParts) => c.type === ContentTypes.SUMMARY,
        ) ?? [];
      expect(summaryParts).toHaveLength(1);
      expect((summaryParts[0] as SummaryContentPart).summarizing).toBe(false);
      expect((summaryParts[0] as SummaryContentPart).content).toEqual([
        { type: ContentTypes.TEXT, text: 'partial' },
      ]);
    });

    it('ON_SUMMARIZE_COMPLETE returns early when target message not in messageMap', () => {
      mockLastAnnouncementTimeRef.current = Date.now();
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_SUMMARIZE_COMPLETE,
            data: {
              id: 'step-1',
              agentId: 'agent-1',
              summary: {
                type: ContentTypes.SUMMARY,
                content: [{ type: ContentTypes.TEXT, text: 'Final summary' }],
                tokenCount: 100,
                summarizing: false,
              },
            },
          },
          submission,
        );
      });

      expect(mockSetMessages).not.toHaveBeenCalled();
      expect(mockAnnouncePolite).not.toHaveBeenCalled();
    });

    it('ON_SUMMARIZE_COMPLETE with undefined summary finalizes existing part with summarizing=false', () => {
      mockLastAnnouncementTimeRef.current = Date.now();
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      const submission = createSubmission();

      const runStep = createRunStep({
        summary: {
          type: ContentTypes.SUMMARY,
          model: 'test-model',
          provider: 'test-provider',
        } as TMessageContentParts & { type: typeof ContentTypes.SUMMARY },
      });

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_SUMMARIZE_DELTA,
            data: {
              id: 'step-1',
              delta: {
                summary: {
                  type: ContentTypes.SUMMARY,
                  content: [{ type: ContentTypes.TEXT, text: 'partial' }],
                  provider: 'test-provider',
                  model: 'test-model',
                  summarizing: true,
                },
              },
            },
          },
          submission,
        );
      });

      mockSetMessages.mockClear();
      mockAnnouncePolite.mockClear();

      const lastSetCall = mockGetMessages.mock.results[mockGetMessages.mock.results.length - 1];
      const latestMessages = lastSetCall?.value ?? [];
      mockGetMessages.mockReturnValue(
        latestMessages.length > 0 ? latestMessages : [responseMessage],
      );

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_SUMMARIZE_COMPLETE,
            data: {
              id: 'step-1',
              agentId: 'agent-1',
            },
          },
          submission,
        );
      });

      expect(mockAnnouncePolite).toHaveBeenCalledWith({
        message: 'summarize_completed',
        isStatus: true,
      });
      expect(mockSetMessages).toHaveBeenCalledTimes(1);
      const updatedMessages = mockSetMessages.mock.calls[0][0] as TMessage[];
      const summaryPart = updatedMessages[0]?.content?.find(
        (p: TMessageContentParts) => p?.type === ContentTypes.SUMMARY,
      ) as SummaryContentPart | undefined;
      expect(summaryPart?.summarizing).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty messages array', () => {
      mockGetMessages.mockReturnValue([]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(mockSetMessages).toHaveBeenCalled();
    });

    it('should handle undefined messages from getMessages', () => {
      mockGetMessages.mockReturnValue(undefined);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      expect(mockSetMessages).toHaveBeenCalled();
    });

    it('should handle delta with array content', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      const messageDelta: Agents.MessageDeltaEvent = {
        id: 'step-1',
        delta: {
          content: [
            { type: ContentTypes.TEXT, text: 'First' },
            { type: ContentTypes.TEXT, text: 'Second' },
          ],
        },
      };

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: messageDelta },
          submission,
        );
      });

      expect(mockSetMessages).toHaveBeenCalled();
    });

    it('should handle message delta without content', () => {
      const responseMessage = createResponseMessage();
      mockGetMessages.mockReturnValue([responseMessage]);

      const { result } = renderHook(() => useStepHandler(createHookParams()));

      const runStep = createRunStep();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, submission);
      });

      mockSetMessages.mockClear();

      const messageDelta: Agents.MessageDeltaEvent = {
        id: 'step-1',
        delta: {},
      };

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: messageDelta },
          submission,
        );
      });

      expect(mockSetMessages).not.toHaveBeenCalled();
    });
  });

  describe('on_subagent_update event', () => {
    /**
     * These tests exercise the real `atomFamily` through an isolated store and
     * a reader mounted alongside the hook under test. No mocks of the store
     * module — only the same `setMessages`/`getMessages` spies the rest of
     * this file uses.
     */
    const subagentStoreWrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(RecoilRoot, null, React.createElement(IsolatedAtomStore, null, children));
    const renderStepHandlerWithReader = (): {
      result: ReturnType<typeof renderHook>['result'];
      getProgress: (toolCallId: string, parentMessageId?: string, partIndex?: number) => unknown;
    } => {
      /** Composite hook: the step handler under test + a reader bound to the
       *  same store it writes through. Reading from the default store instead
       *  would answer for a different one, so its writes wouldn't be visible. */
      const hookResult = renderHook(
        () => {
          const stepHandler = useStepHandler(createHookParams());
          const jotaiStore = useStore();
          const read = (
            toolCallId: string,
            parentMessageId: string = 'response-msg-1',
            partIndex: number = 0,
          ): unknown =>
            jotaiStore.get(
              subagentProgressByToolCallId(
                subagentProgressKey(parentMessageId, toolCallId, partIndex),
              ),
            );
          return { ...stepHandler, read };
        },
        { wrapper: subagentStoreWrapper },
      );

      const getProgress = (
        toolCallId: string,
        parentMessageId?: string,
        partIndex?: number,
      ): unknown => (hookResult.result.current as any).read(toolCallId, parentMessageId, partIndex);
      return { result: hookResult.result, getProgress };
    };

    const buildSubagentToolCallPart = (toolCallId: string): TMessageContentParts =>
      ({
        type: ContentTypes.TOOL_CALL,
        [ContentTypes.TOOL_CALL]: {
          id: toolCallId,
          name: Constants.SUBAGENT,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 0.1,
        },
      }) as unknown as TMessageContentParts;

    /**
     * Directly seed the hook's internal `messageMap` with a response message
     * whose content contains one or more `subagent` tool calls. Uses the
     * real `syncStepMessage` export so we exercise the same code path the
     * SSE pipeline uses for reconnects — no mocks, no patched internals.
     */
    const seedResponseWithSubagentToolCalls = (
      result: ReturnType<typeof renderHook>['result'],
      toolCallIds: string[],
    ): { response: TMessage; submission: EventSubmission } => {
      const response: TMessage = {
        ...createResponseMessage(),
        content: toolCallIds.map(buildSubagentToolCallPart),
      };
      mockGetMessages.mockReturnValue([response]);
      const submission = createSubmission({
        initialResponse: createResponseMessage({
          messageId: 'initial-response-id',
        }),
      });
      act(() => {
        (result.current as any).syncStepMessage(response);
      });
      return { response, submission };
    };

    const makeUpdate = (overrides: Partial<SubagentUpdateEvent> = {}): SubagentUpdateEvent => ({
      runId: 'response-msg-1',
      subagentRunId: 'child-run-1',
      subagentType: 'self',
      subagentAgentId: 'child-1',
      parentAgentId: 'parent',
      phase: 'start',
      label: 'Subagent "self" started',
      timestamp: new Date().toISOString(),
      ...overrides,
    });

    it('signals parent-index discovery on child lifecycle events, not every progress delta', () => {
      const onSubagentIndexChange = jest.fn();
      const { result } = renderHook(
        () => useStepHandler({ ...createHookParams(), onSubagentIndexChange }),
        { wrapper: subagentStoreWrapper },
      );
      const submission = createSubmission();

      act(() => {
        for (const phase of ['start', 'run_step_delta', 'stop', 'error'] as const) {
          result.current.stepHandler(
            { event: StepEvents.ON_SUBAGENT_UPDATE, data: makeUpdate({ phase }) },
            submission,
          );
        }
      });
      expect(onSubagentIndexChange.mock.calls).toEqual([['conv-1'], ['conv-1'], ['conv-1']]);

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_SUBAGENT_UPDATE, data: makeUpdate({ phase: 'start' }) },
          createSubmission({
            userMessage: createUserMessage({ conversationId: String(Constants.NEW_CONVO) }),
            initialResponse: createResponseMessage({ conversationId: String(Constants.NEW_CONVO) }),
          }),
        );
      });
      expect(onSubagentIndexChange).toHaveBeenCalledTimes(3);

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_SUBAGENT_UPDATE, data: makeUpdate({ phase: 'start' }) },
          createSubmission({
            userMessage: createUserMessage({ conversationId: String(Constants.NEW_CONVO) }),
            initialResponse: createResponseMessage({ conversationId: 'saved-parent' }),
          }),
        );
      });
      expect(onSubagentIndexChange).toHaveBeenLastCalledWith('saved-parent');
    });

    it('correlates updates to a tool call via parentToolCallId (deterministic path)', () => {
      const { result, getProgress } = renderStepHandlerWithReader();
      const { submission } = seedResponseWithSubagentToolCalls(result, ['call_A']);

      const start = makeUpdate({ parentToolCallId: 'call_A', phase: 'start' });
      const step = makeUpdate({
        parentToolCallId: 'call_A',
        phase: 'run_step',
        label: 'Using tool: calculator',
      });
      const stop = makeUpdate({
        parentToolCallId: 'call_A',
        phase: 'stop',
        label: 'Subagent "self" finished',
      });

      act(() => {
        (result.current as any).stepHandler(
          { event: StepEvents.ON_SUBAGENT_UPDATE, data: start },
          submission,
        );

        (result.current as any).stepHandler(
          { event: StepEvents.ON_SUBAGENT_UPDATE, data: step },
          submission,
        );

        (result.current as any).stepHandler(
          { event: StepEvents.ON_SUBAGENT_UPDATE, data: stop },
          submission,
        );
      });

      const bucket = getProgress('call_A') as {
        status: string;
        latestLabel?: string;
        subagentType: string;
      };
      /** The atom no longer retains raw envelopes — they're folded
       *  incrementally into `contentParts`/`tickerState`. Metadata
       *  (status, latestLabel, subagentType) still reflects the last
       *  update, which is what the UI actually renders from. */
      expect(bucket.status).toBe('stop');
      expect(bucket.latestLabel).toBe('Subagent "self" finished');
      expect(bucket.subagentType).toBe('self');
    });

    /** An `atomFamily` caches a member per key for the life of the tab, and every
     *  invocation key is unique. The drain boundary exists to keep that bounded,
     *  so it has to release the members, not merely blank them. */
    it('frees the family members it drains at the conversation boundary', () => {
      const { result, getProgress } = renderStepHandlerWithReader();
      const { submission } = seedResponseWithSubagentToolCalls(result, ['call_A']);

      act(() => {
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeUpdate({ parentToolCallId: 'call_A', phase: 'start' }),
          },
          submission,
        );
      });
      const invocationKey = subagentProgressKey('response-msg-1', 'call_A', 0);
      const held = subagentProgressByToolCallId(invocationKey);
      expect(getProgress('call_A')).not.toBeNull();

      act(() => (result.current as any).resetSubagentAtoms());

      expect(getProgress('call_A')).toBeNull();
      expect(subagentProgressByToolCallId(invocationKey)).not.toBe(held);
    });

    it('falls back to oldest-unclaimed tool call when parentToolCallId is absent', () => {
      const { result, getProgress } = renderStepHandlerWithReader();
      /** Two subagent tool calls seeded in creation order. Without
       *  `parentToolCallId`, forward iteration must claim `call_old` for
       *  the first start and `call_new` for the second. */
      const { submission } = seedResponseWithSubagentToolCalls(result, ['call_old', 'call_new']);

      const updateOld = makeUpdate({
        subagentRunId: 'run-1',
        phase: 'start',
        label: 'first',
      });
      const updateNew = makeUpdate({
        subagentRunId: 'run-2',
        phase: 'start',
        label: 'second',
      });

      act(() => {
        (result.current as any).stepHandler(
          { event: StepEvents.ON_SUBAGENT_UPDATE, data: updateOld },
          submission,
        );

        (result.current as any).stepHandler(
          { event: StepEvents.ON_SUBAGENT_UPDATE, data: updateNew },
          submission,
        );
      });

      const first = getProgress('call_old') as { latestLabel?: string };
      const second = getProgress('call_new', undefined, 1) as { latestLabel?: string };
      expect(first.latestLabel).toBe('first');
      expect(second.latestLabel).toBe('second');
    });

    it('buffers early-arriving updates and replays once a tool call is claimable', () => {
      const { result, getProgress } = renderStepHandlerWithReader();
      const submission = createSubmission({
        initialResponse: createResponseMessage({
          messageId: 'initial-response-id',
        }),
      });
      /** Deliberately: no `mockGetMessages.mockReturnValue([response])`
       *  and no ON_RUN_STEP yet, so the tool call isn't visible. The
       *  first envelope must be buffered. */
      mockGetMessages.mockReturnValue([]);

      const earlyUpdate = makeUpdate({
        phase: 'start',
        label: 'arrives first',
      });
      const laterUpdate = makeUpdate({
        phase: 'run_step',
        label: 'arrives after correlation',
      });

      act(() => {
        (result.current as any).stepHandler(
          { event: StepEvents.ON_SUBAGENT_UPDATE, data: earlyUpdate },
          submission,
        );
      });

      /** Now the tool call appears. Subsequent update can claim and drain. */
      const responseWithToolCall: TMessage = {
        ...createResponseMessage(),
        content: [buildSubagentToolCallPart('call_late')],
      };
      mockGetMessages.mockReturnValue([responseWithToolCall]);
      act(() => {
        (result.current as any).syncStepMessage(responseWithToolCall);
      });

      act(() => {
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: { ...laterUpdate, parentToolCallId: 'call_late' },
          },
          submission,
        );
      });

      const bucket = getProgress('call_late') as {
        status: string;
        latestLabel?: string;
      };
      /** The buffered `start` event and the current `run_step` both
       *  get applied in order — the latest label reflects the most
       *  recently processed envelope. */
      expect(bucket.status).toBe('run_step');
      expect(bucket.latestLabel).toBe('arrives after correlation');
    });

    it('keeps atom state bounded under a large burst of lifecycle-only updates', () => {
      /** Previously the atom retained a 200-event rolling window so long
       *  runs could lose earlier tool_call records. We now fold events
       *  into `contentParts` + `tickerState` incrementally — no raw
       *  event array is stored, so memory is bounded by the structural
       *  output (text/reasoning runs + tool calls), not delta volume.
       *  A pile of pass-through phases like `run_step_delta` must not
       *  create lines at all. */
      const { result, getProgress } = renderStepHandlerWithReader();
      const { submission } = seedResponseWithSubagentToolCalls(result, ['call_cap']);

      act(() => {
        for (let i = 0; i < 500; i++) {
          (result.current as any).stepHandler(
            {
              event: StepEvents.ON_SUBAGENT_UPDATE,
              data: makeUpdate({
                parentToolCallId: 'call_cap',
                phase: 'run_step_delta',
                label: `delta-${i}`,
              }),
            },
            submission,
          );
        }
      });

      const bucket = getProgress('call_cap') as {
        contentParts: unknown[];
        tickerState: { lines: unknown[] };
        latestLabel?: string;
      };
      expect(bucket.contentParts).toEqual([]);
      expect(bucket.tickerState.lines).toEqual([]);
      expect(bucket.latestLabel).toBe('delta-499');
    });

    it('keeps parallel subagent streams independent when events interleave', () => {
      /**
       * Parallel tool calls: the LLM emits two `subagent` tool calls in the
       * same AIMessage, LangChain invokes them concurrently, and the SDK
       * streams `ON_SUBAGENT_UPDATE` envelopes for both runs in arbitrary
       * order. Each envelope carries `parentToolCallId` (SDK dev.2+), so
       * correlation stays deterministic. Verify no cross-contamination
       * between buckets: each tool_call_id's atom should accumulate only
       * that run's events, and closing one stream must not affect the
       * other.
       */
      const { result, getProgress } = renderStepHandlerWithReader();
      const { submission } = seedResponseWithSubagentToolCalls(result, ['call_a', 'call_b']);

      const makeParallelUpdate = (
        runId: string,
        toolCallId: string,
        overrides: Partial<SubagentUpdateEvent> = {},
      ): SubagentUpdateEvent => ({
        ...makeUpdate({ subagentRunId: runId, parentToolCallId: toolCallId }),
        ...overrides,
      });

      act(() => {
        // Interleaved order: a-start, b-start, a-step, b-step, a-stop, b-stop
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeParallelUpdate('run_a', 'call_a', {
              phase: 'start',
              label: 'A started',
            }),
          },
          submission,
        );
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeParallelUpdate('run_b', 'call_b', {
              phase: 'start',
              label: 'B started',
            }),
          },
          submission,
        );
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeParallelUpdate('run_a', 'call_a', {
              phase: 'run_step',
              label: 'A using calculator',
            }),
          },
          submission,
        );
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeParallelUpdate('run_b', 'call_b', {
              phase: 'run_step',
              label: 'B using web',
            }),
          },
          submission,
        );
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeParallelUpdate('run_a', 'call_a', {
              phase: 'stop',
              label: 'A done',
            }),
          },
          submission,
        );
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeParallelUpdate('run_b', 'call_b', {
              phase: 'run_step',
              label: 'B still going',
            }),
          },
          submission,
        );
      });

      const bucketA = getProgress('call_a') as {
        subagentRunId: string;
        status: string;
        latestLabel?: string;
      };
      const bucketB = getProgress('call_b', undefined, 1) as {
        subagentRunId: string;
        status: string;
        latestLabel?: string;
      };

      /** Each bucket only captures its own run's lifecycle — metadata
       *  (status, latestLabel, subagentRunId) stays scoped to the
       *  matching tool_call_id despite interleaved delivery order. */
      expect(bucketA.subagentRunId).toBe('run_a');
      expect(bucketB.subagentRunId).toBe('run_b');
      expect(bucketA.latestLabel).toBe('A done');
      expect(bucketB.latestLabel).toBe('B still going');

      // A reached `stop`, B is still running — their statuses should reflect that
      expect(bucketA.status).toBe('stop');
      expect(bucketB.status).toBe('run_step');
    });

    it('keeps reused provider tool-call IDs isolated across parent messages', () => {
      const { result, getProgress } = renderStepHandlerWithReader();
      const firstResponse: TMessage = {
        ...createResponseMessage({ messageId: 'response-one' }),
        content: [buildSubagentToolCallPart('call_shared')],
      };
      const secondResponse: TMessage = {
        ...createResponseMessage({ messageId: 'response-two' }),
        content: [buildSubagentToolCallPart('call_shared')],
      };
      act(() => {
        (result.current as any).syncStepMessage(firstResponse);
        (result.current as any).syncStepMessage(secondResponse);
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeUpdate({
              runId: 'response-one',
              subagentRunId: 'child-one',
              parentToolCallId: 'call_shared',
              label: 'first parent',
            }),
          },
          createSubmission(),
        );
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeUpdate({
              runId: 'response-two',
              subagentRunId: 'child-two',
              parentToolCallId: 'call_shared',
              label: 'second parent',
            }),
          },
          createSubmission(),
        );
      });

      expect(getProgress('call_shared', 'response-one')).toEqual(
        expect.objectContaining({ subagentRunId: 'child-one', latestLabel: 'first parent' }),
      );
      expect(getProgress('call_shared', 'response-two')).toEqual(
        expect.objectContaining({ subagentRunId: 'child-two', latestLabel: 'second parent' }),
      );
    });

    it('buffers an update for its expected parent instead of claiming another same-ID call', () => {
      const { result, getProgress } = renderStepHandlerWithReader();
      const firstResponse: TMessage = {
        ...createResponseMessage({ messageId: 'response-one' }),
        content: [buildSubagentToolCallPart('call_shared')],
      };
      act(() => {
        (result.current as any).syncStepMessage(firstResponse);
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeUpdate({
              runId: 'response-two',
              subagentRunId: 'child-two',
              parentToolCallId: 'call_shared',
              phase: 'stop',
              label: 'finished before parent two arrived',
            }),
          },
          createSubmission(),
        );
      });

      expect(getProgress('call_shared', 'response-one')).toBeNull();

      const secondResponse: TMessage = {
        ...createResponseMessage({ messageId: 'response-two' }),
        content: [buildSubagentToolCallPart('call_shared')],
      };
      act(() => {
        (result.current as any).syncStepMessage(secondResponse);
      });

      expect(getProgress('call_shared', 'response-one')).toBeNull();
      expect(getProgress('call_shared', 'response-two')).toEqual(
        expect.objectContaining({
          subagentRunId: 'child-two',
          status: 'stop',
          latestLabel: 'finished before parent two arrived',
        }),
      );
    });

    it('keeps repeated provider tool-call IDs isolated by content-part occurrence', () => {
      const { result, getProgress } = renderStepHandlerWithReader();
      const { submission } = seedResponseWithSubagentToolCalls(result, [
        'call_shared',
        'call_shared',
      ]);

      act(() => {
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeUpdate({
              subagentRunId: 'child-one',
              parentToolCallId: 'call_shared',
              label: 'first occurrence',
            }),
          },
          submission,
        );
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeUpdate({
              subagentRunId: 'child-two',
              parentToolCallId: 'call_shared',
              label: 'second occurrence',
            }),
          },
          submission,
        );
      });

      expect(getProgress('call_shared', 'response-msg-1', 0)).toEqual(
        expect.objectContaining({ subagentRunId: 'child-one', latestLabel: 'first occurrence' }),
      );
      expect(getProgress('call_shared', 'response-msg-1', 1)).toEqual(
        expect.objectContaining({ subagentRunId: 'child-two', latestLabel: 'second occurrence' }),
      );
    });

    it('clearStepMaps preserves subagent atoms so the panel can be re-opened for auditability', () => {
      /**
       * Intentionally the inverse of the earlier behavior: the collapsed
       * `SubagentCall` ticker and its panel must stay readable after the
       * stream ends. Wiping the atoms on `clearStepMaps` would leave a
       * completed subagent tool call with no content to display, forcing
       * the fallback "raw tool output" branch and losing interleaved tool
       * calls / reasoning from the rendering. Growth is bounded (200-event
       * cap per atom, one atom per subagent spawn).
       */
      const { result, getProgress } = renderStepHandlerWithReader();
      const { submission } = seedResponseWithSubagentToolCalls(result, ['call_keep']);

      act(() => {
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeUpdate({
              parentToolCallId: 'call_keep',
              phase: 'stop',
            }),
          },
          submission,
        );
      });

      expect(getProgress('call_keep')).not.toBeNull();

      act(() => {
        (result.current as any).clearStepMaps();
      });

      expect(getProgress('call_keep')).not.toBeNull();
    });

    it('uses parent stream closure to release a detached sequence waiting at handoff', () => {
      const { result, getProgress } = renderStepHandlerWithReader();
      const { submission } = seedResponseWithSubagentToolCalls(result, ['call_handoff']);

      act(() => {
        (result.current as any).stepHandler(
          {
            event: StepEvents.ON_SUBAGENT_UPDATE,
            data: makeUpdate({
              parentToolCallId: 'call_handoff',
              activityEventId: 'task:5',
              activitySequence: 5,
              phase: 'message_delta',
              data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'suffix' }] } },
            }),
          },
          submission,
        );
      });

      expect(getProgress('call_handoff')).toEqual(
        expect.objectContaining({ contentParts: [], pendingSequencedEvents: [expect.any(Object)] }),
      );

      act(() => {
        (result.current as any).clearStepMaps();
      });

      expect(getProgress('call_handoff')).toEqual(
        expect.objectContaining({
          contentParts: [{ type: ContentTypes.TEXT, text: 'suffix' }],
          lastActivitySequence: 5,
        }),
      );
    });
  });

  /**
   * Edited resubmissions offset every incoming index past the prefix the
   * client retained, because the server indexes only the NEW content. A
   * resume SYNC invalidates that arrangement twice over: it REPLACES
   * `initialResponse.content` with the server's completion-local snapshot
   * (so the live array no longer measures the prefix), and when it also
   * replaces the RENDERED content the prefix is gone entirely and server
   * indices become absolute.
   *
   * Activity labels already honored both facts; run steps did not, so a
   * batch's tool cards and its header could resolve in different index
   * spaces. These cases pin the states no other suite constructs.
   */
  describe('edit-prefix index space across resume', () => {
    const textPart = (text: string): TMessageContentParts =>
      ({ type: ContentTypes.TEXT, [ContentTypes.TEXT]: text }) as TMessageContentParts;

    /** A retained non-text part, so the trailing-text `-1` adjustment stays out
     *  of offset assertions. */
    const keptToolPart = (): TMessageContentParts =>
      ({
        type: ContentTypes.TOOL_CALL,
        [ContentTypes.TOOL_CALL]: {
          id: 'kept-tool',
          name: 'kept_tool',
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
        },
      }) as unknown as TMessageContentParts;

    /** Renders the hook against a live message array and returns the response. */
    const runToolStepAt = (serverIndex: number, submission: EventSubmission) => {
      const responseMessage = submission.initialResponse as TMessage;
      let currentMessages: TMessage[] = [responseMessage];
      mockGetMessages.mockImplementation(() => currentMessages);
      mockSetMessages.mockImplementation((messages: TMessage[]) => {
        currentMessages = messages;
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: createToolCallRunStep({ index: serverIndex, runId: responseMessage.messageId }),
          },
          submission,
        );
      });
      return currentMessages.find((m) => !m.isCreatedByUser);
    };

    it('applies no offset for an unedited submission', () => {
      const response = runToolStepAt(0, createSubmission());
      expect(getToolCallName(response?.content?.[0])).toBe('test_tool');
    });

    it('offsets by the retained prefix for an edited submission', () => {
      const submission = createSubmission({
        editedContent: { index: 0, type: ContentTypes.TEXT },
        initialResponse: createResponseMessage({
          content: [textPart('kept a'), textPart('kept b')],
        }),
      } as never);
      (submission as { editPrefixLength?: number }).editPrefixLength = 2;

      const response = runToolStepAt(0, submission);
      /** Server index 0 is the first NEW part, so it lands past the prefix. */
      expect(getToolCallName(response?.content?.[2])).toBe('test_tool');
      expect(response?.content?.[0]).toMatchObject({ [ContentTypes.TEXT]: 'kept a' });
    });

    /**
     * The `preserveLoadedContent` shape: SYNC replaced `initialResponse.content`
     * with an empty completion-local snapshot but KEPT the rendered prefix, so
     * the flag stays clear. Measuring the live array would drop the offset to
     * zero and overwrite retained content.
     */
    it('offsets by the captured length when sync replaced the live content array', () => {
      const submission = createSubmission({
        editedContent: { index: 0, type: ContentTypes.TEXT },
        initialResponse: createResponseMessage({ content: [] }),
      } as never);
      (submission as { editPrefixLength?: number }).editPrefixLength = 2;

      const response = runToolStepAt(0, submission);
      expect(getToolCallName(response?.content?.[2])).toBe('test_tool');
    });

    /**
     * Post-SYNC: the rendered content IS the completion-local snapshot, so
     * incoming indices are already absolute — the same space activity labels
     * switch to when the flag is set. Any offset here writes past the end.
     */
    it('applies no offset once the prefix is cleared by a resume sync', () => {
      const submission = createSubmission({
        editedContent: { index: 0, type: ContentTypes.TEXT },
        initialResponse: createResponseMessage({ content: [] }),
      } as never);
      Object.assign(submission, { editPrefixLength: 2, editPrefixCleared: true });

      const response = runToolStepAt(0, submission);
      /** Offset still applied, this would land at index 2 and leave a hole. */
      expect(getToolCallName(response?.content?.[0])).toBe('test_tool');
      expect(response?.content).toHaveLength(1);
    });

    it('keeps a cleared-prefix tool card at its absolute server index', () => {
      const submission = createSubmission({
        editedContent: { index: 0, type: ContentTypes.TEXT },
        initialResponse: createResponseMessage({
          content: [textPart('snapshot a'), textPart('snapshot b')],
        }),
      } as never);
      Object.assign(submission, { editPrefixLength: 2, editPrefixCleared: true });

      const response = runToolStepAt(2, submission);
      /** Absolute: index 2 stays 2, appending after the snapshot's own parts. */
      expect(getToolCallName(response?.content?.[2])).toBe('test_tool');
      expect(response?.content?.[0]).toMatchObject({ [ContentTypes.TEXT]: 'snapshot a' });
    });

    /**
     * Deltas resolve through `calculateContentIndex`, which now receives the
     * offset directly instead of measuring the prefix array. A prefix ending
     * in a NON-text part isolates the offset from the separate `-1`
     * adjustment that intentionally continues a retained trailing text part.
     */
    it('offsets message deltas by the same prefix as run steps', () => {
      const submission = createSubmission({
        editedContent: { index: 0, type: ContentTypes.TEXT },
        initialResponse: createResponseMessage({
          content: [textPart('kept a'), keptToolPart()],
        }),
      } as never);
      (submission as { editPrefixLength?: number }).editPrefixLength = 2;

      const responseMessage = submission.initialResponse as TMessage;
      let currentMessages: TMessage[] = [responseMessage];
      mockGetMessages.mockImplementation(() => currentMessages);
      mockSetMessages.mockImplementation((messages: TMessage[]) => {
        currentMessages = messages;
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: createRunStep({ index: 0, runId: responseMessage.messageId }),
          },
          submission,
        );
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-1', 'streamed') },
          submission,
        );
      });

      const response = currentMessages.find((m) => !m.isCreatedByUser);
      expect(response?.content?.[2]).toMatchObject({ [ContentTypes.TEXT]: 'streamed' });
      expect(response?.content?.[0]).toMatchObject({ [ContentTypes.TEXT]: 'kept a' });
      expect(
        (submission as { editPrefixFirstPartFolded?: boolean }).editPrefixFirstPartFolded,
      ).toBeUndefined();
    });

    it('records when the first completion part actually folds into the retained tail', () => {
      const submission = createSubmission({
        editedContent: { index: 0, type: ContentTypes.TEXT },
        initialResponse: createResponseMessage({ content: [textPart('kept'), textPart('tail')] }),
      } as never);
      (submission as { editPrefixLength?: number }).editPrefixLength = 2;
      const responseMessage = submission.initialResponse as TMessage;
      let currentMessages: TMessage[] = [responseMessage];
      mockGetMessages.mockImplementation(() => currentMessages);
      mockSetMessages.mockImplementation((messages: TMessage[]) => {
        currentMessages = messages;
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: createRunStep({ index: 0, runId: responseMessage.messageId }),
          },
          submission,
        );
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-1', ' continued') },
          submission,
        );
      });

      expect(
        (submission as { editPrefixFirstPartFolded?: boolean }).editPrefixFirstPartFolded,
      ).toBe(true);
    });

    it('does not merge final-answer text into a retained commentary phase', () => {
      const commentary = {
        type: ContentTypes.TEXT,
        [ContentTypes.TEXT]: 'Checked the current deployment. ',
        phase: 'commentary',
      } as TMessageContentParts;
      const submission = createSubmission({
        editedContent: { index: 0, type: ContentTypes.TEXT },
        initialResponse: createResponseMessage({ content: [textPart('kept'), commentary] }),
      } as never);
      (submission as { editPrefixLength?: number }).editPrefixLength = 2;
      const responseMessage = submission.initialResponse as TMessage;
      let currentMessages: TMessage[] = [responseMessage];
      mockGetMessages.mockImplementation(() => currentMessages);
      mockSetMessages.mockImplementation((messages: TMessage[]) => {
        currentMessages = messages;
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: createRunStep({
              stepDetails: {
                type: StepTypes.MESSAGE_CREATION,
                message_creation: { message_id: 'msg-1', phase: 'final_answer' },
              },
            }),
          },
          submission,
        );
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-1', 'Done') },
          submission,
        );
      });

      const response = currentMessages.find((message) => !message.isCreatedByUser);
      expect(response?.content?.[1]).toMatchObject({
        [ContentTypes.TEXT]: 'Checked the current deployment. ',
        phase: 'commentary',
      });
      expect(response?.content?.[2]).toMatchObject({
        [ContentTypes.TEXT]: 'Done',
        phase: 'final_answer',
      });
    });

    it.each([
      [undefined, 'commentary'],
      ['commentary', undefined],
    ] as const)(
      'does not merge phased and unphased text (%s → %s)',
      (retainedPhase, incomingPhase) => {
        const retained = {
          type: ContentTypes.TEXT,
          [ContentTypes.TEXT]: 'Retained text. ',
          ...(retainedPhase != null && { phase: retainedPhase }),
        } as TMessageContentParts;
        const submission = createSubmission({
          editedContent: { index: 0, type: ContentTypes.TEXT },
          initialResponse: createResponseMessage({ content: [textPart('kept'), retained] }),
        } as never);
        (submission as { editPrefixLength?: number }).editPrefixLength = 2;
        const responseMessage = submission.initialResponse as TMessage;
        let currentMessages: TMessage[] = [responseMessage];
        mockGetMessages.mockImplementation(() => currentMessages);
        mockSetMessages.mockImplementation((messages: TMessage[]) => {
          currentMessages = messages;
        });

        const { result } = renderHook(() => useStepHandler(createHookParams()));
        act(() => {
          result.current.stepHandler(
            {
              event: StepEvents.ON_RUN_STEP,
              data: createRunStep({
                stepDetails: {
                  type: StepTypes.MESSAGE_CREATION,
                  message_creation: {
                    message_id: 'msg-1',
                    ...(incomingPhase != null && { phase: incomingPhase }),
                  },
                },
              }),
            },
            submission,
          );
          result.current.stepHandler(
            { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-1', 'New text') },
            submission,
          );
        });

        const response = currentMessages.find((message) => !message.isCreatedByUser);
        expect(response?.content?.[1]).toMatchObject(retained);
        expect(response?.content?.[2]).toMatchObject({
          [ContentTypes.TEXT]: 'New text',
          ...(incomingPhase != null && { phase: incomingPhase }),
        });
      },
    );

    /**
     * Post-sync a delta continues at the snapshot's NEXT absolute slot. With
     * the offset still applied it would jump past that slot and leave a hole
     * the label reservation could never line up with.
     */
    it('applies no delta offset once the prefix is cleared', () => {
      const submission = createSubmission({
        editedContent: { index: 0, type: ContentTypes.TEXT },
        initialResponse: createResponseMessage({ content: [keptToolPart(), keptToolPart()] }),
      } as never);
      Object.assign(submission, { editPrefixLength: 2, editPrefixCleared: true });

      const responseMessage = submission.initialResponse as TMessage;
      let currentMessages: TMessage[] = [responseMessage];
      mockGetMessages.mockImplementation(() => currentMessages);
      mockSetMessages.mockImplementation((messages: TMessage[]) => {
        currentMessages = messages;
      });

      const { result } = renderHook(() => useStepHandler(createHookParams()));
      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: createRunStep({ index: 2, runId: responseMessage.messageId }),
          },
          submission,
        );
        result.current.stepHandler(
          { event: StepEvents.ON_MESSAGE_DELTA, data: createMessageDelta('step-1', 'streamed') },
          submission,
        );
      });

      const response = currentMessages.find((m) => !m.isCreatedByUser);
      expect(response?.content?.[2]).toMatchObject({ [ContentTypes.TEXT]: 'streamed' });
      expect(response?.content).toHaveLength(3);
    });
  });

  describe('PTC inner tool-call trace', () => {
    const renderWithTraceReader = () => {
      const hookResult = renderHook(
        () => {
          const stepHandler = useStepHandler(createHookParams());
          const read = useRecoilCallback(
            ({ snapshot }) =>
              (messageId: string, toolCallId: string): PtcTrace =>
                snapshot
                  .getLoadable(ptcTraceByToolCallId(ptcTraceKey(messageId, toolCallId)))
                  .valueOrThrow(),
            [],
          );
          return { ...stepHandler, read };
        },
        { wrapper: RecoilRoot },
      );
      return {
        result: hookResult.result,
        getEntries: (toolCallId: string, messageId = 'response-msg-1'): PtcTraceEntry[] =>
          (
            hookResult.result.current as unknown as { read: (m: string, id: string) => PtcTrace }
          ).read(messageId, toolCallId).entries,
        getTrace: (toolCallId: string, messageId = 'response-msg-1'): PtcTrace =>
          (
            hookResult.result.current as unknown as { read: (m: string, id: string) => PtcTrace }
          ).read(messageId, toolCallId),
      };
    };

    const ptcEvent = (overrides: Partial<PtcToolCallEvent>): PtcToolCallEvent => ({
      tool_call_id: 'call_ptc',
      call_id: 'call_ptc:0',
      name: 'read_file',
      status: 'running',
      runId: 'response-msg-1',
      ...overrides,
    });

    it('appends a row for each inner call the program starts', () => {
      const { result, getEntries } = renderWithTraceReader();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_PTC_TOOL_CALL,
            data: ptcEvent({ call_id: 'call_ptc:0', args: 'path=a.ts' }),
          },
          submission,
        );
        result.current.stepHandler(
          {
            event: StepEvents.ON_PTC_TOOL_CALL,
            data: ptcEvent({ call_id: 'call_ptc:1', name: 'write_file', args: 'path=b.ts' }),
          },
          submission,
        );
      });

      expect(getEntries('call_ptc')).toEqual([
        { callId: 'call_ptc:0', name: 'read_file', status: 'running', args: 'path=a.ts' },
        { callId: 'call_ptc:1', name: 'write_file', status: 'running', args: 'path=b.ts' },
      ]);
    });

    it('settles a row in place instead of appending a duplicate', () => {
      const { result, getEntries } = renderWithTraceReader();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_PTC_TOOL_CALL, data: ptcEvent({ args: 'path=a.ts' }) },
          submission,
        );
        result.current.stepHandler(
          {
            event: StepEvents.ON_PTC_TOOL_CALL,
            data: ptcEvent({ status: 'success', durationMs: 1200 }),
          },
          submission,
        );
      });

      expect(getEntries('call_ptc')).toEqual([
        {
          callId: 'call_ptc:0',
          name: 'read_file',
          status: 'success',
          args: 'path=a.ts',
          durationMs: 1200,
        },
      ]);
    });

    it('keeps each PTC call trace under its own tool call id', () => {
      const { result, getEntries } = renderWithTraceReader();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_PTC_TOOL_CALL, data: ptcEvent({}) },
          submission,
        );
        result.current.stepHandler(
          {
            event: StepEvents.ON_PTC_TOOL_CALL,
            data: ptcEvent({ tool_call_id: 'call_other', call_id: 'call_other:0' }),
          },
          submission,
        );
      });

      expect(getEntries('call_ptc')).toHaveLength(1);
      expect(getEntries('call_other')).toHaveLength(1);
    });

    it('drops an envelope with no call identity rather than seeding a blank row', () => {
      const { result, getEntries } = renderWithTraceReader();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_PTC_TOOL_CALL, data: ptcEvent({ call_id: '' }) },
          submission,
        );
      });

      expect(getEntries('call_ptc')).toEqual([]);
    });

    it('keeps a reused tool_call_id isolated across parent messages', () => {
      const { result, getEntries } = renderWithTraceReader();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_PTC_TOOL_CALL, data: ptcEvent({ name: 'read_file' }) },
          submission,
        );
        result.current.stepHandler(
          {
            event: StepEvents.ON_PTC_TOOL_CALL,
            data: ptcEvent({ name: 'write_file', runId: 'response-msg-2' }),
          },
          submission,
        );
      });

      expect(getEntries('call_ptc').map((e) => e.name)).toEqual(['read_file']);
      expect(getEntries('call_ptc', 'response-msg-2').map((e) => e.name)).toEqual(['write_file']);
    });

    it('drops an envelope that cannot be scoped to a parent message', () => {
      const { result, getEntries } = renderWithTraceReader();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_PTC_TOOL_CALL, data: ptcEvent({ runId: undefined }) },
          submission,
        );
      });

      expect(getEntries('call_ptc')).toEqual([]);
    });

    it('marks rows still running across a resume gap and keeps settled ones', () => {
      const { result, getEntries } = renderWithTraceReader();
      const submission = createSubmission();

      act(() => {
        /** Real order: each row opens as `running` before it settles. */
        result.current.stepHandler(
          { event: StepEvents.ON_PTC_TOOL_CALL, data: ptcEvent({ call_id: 'call_ptc:0' }) },
          submission,
        );
        result.current.stepHandler(
          {
            event: StepEvents.ON_PTC_TOOL_CALL,
            data: ptcEvent({ call_id: 'call_ptc:0', status: 'success', durationMs: 900 }),
          },
          submission,
        );
        result.current.stepHandler(
          {
            event: StepEvents.ON_PTC_TOOL_CALL,
            data: ptcEvent({ call_id: 'call_ptc:1', name: 'write_file' }),
          },
          submission,
        );
      });
      expect(getEntries('call_ptc')).toHaveLength(2);

      act(() => {
        (result.current as unknown as { prunePtcTraces: () => void }).prunePtcTraces();
      });

      expect(getEntries('call_ptc').map((e) => [e.callId, e.status])).toEqual([
        ['call_ptc:0', 'success'],
        ['call_ptc:1', 'interrupted'],
      ]);
    });

    it('lets a call still running across the gap settle onto its marked row', () => {
      const { result, getEntries } = renderWithTraceReader();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_PTC_TOOL_CALL,
            data: ptcEvent({ call_id: 'call_ptc:0', name: 'write_file' }),
          },
          submission,
        );
      });

      act(() => {
        (result.current as unknown as { prunePtcTraces: () => void }).prunePtcTraces();
      });
      expect(getEntries('call_ptc').map((e) => e.status)).toEqual(['interrupted']);

      /** The call outlived the disconnect, so its terminal event arrives on
       *  the restored live stream and must land on the row it opened. */
      act(() => {
        result.current.stepHandler(
          {
            event: StepEvents.ON_PTC_TOOL_CALL,
            data: ptcEvent({
              call_id: 'call_ptc:0',
              name: 'write_file',
              status: 'success',
              durationMs: 1400,
            }),
          },
          submission,
        );
      });

      expect(getEntries('call_ptc')).toEqual([
        expect.objectContaining({ callId: 'call_ptc:0', status: 'success', durationMs: 1400 }),
      ]);
    });

    it('caps the retained rows and reports how many it dropped', () => {
      const { result, getTrace } = renderWithTraceReader();
      const submission = createSubmission();
      const total = PTC_TRACE_MAX_ENTRIES + 25;

      act(() => {
        for (let i = 0; i < total; i++) {
          result.current.stepHandler(
            { event: StepEvents.ON_PTC_TOOL_CALL, data: ptcEvent({ call_id: `call_ptc:${i}` }) },
            submission,
          );
        }
      });

      const trace = getTrace('call_ptc');
      expect(trace.entries).toHaveLength(PTC_TRACE_MAX_ENTRIES);
      expect(trace.dropped).toBe(25);
      /** The tail is retained, so the newest call is still visible. */
      expect(trace.entries.at(-1)?.callId).toBe(`call_ptc:${total - 1}`);
    });

    it('ignores a settle whose row the cap already evicted', () => {
      const { result, getTrace } = renderWithTraceReader();
      const submission = createSubmission();

      act(() => {
        for (let i = 0; i < PTC_TRACE_MAX_ENTRIES + 5; i++) {
          result.current.stepHandler(
            { event: StepEvents.ON_PTC_TOOL_CALL, data: ptcEvent({ call_id: `call_ptc:${i}` }) },
            submission,
          );
        }
        result.current.stepHandler(
          {
            event: StepEvents.ON_PTC_TOOL_CALL,
            data: ptcEvent({ call_id: 'call_ptc:0', status: 'success', durationMs: 10 }),
          },
          submission,
        );
      });

      const trace = getTrace('call_ptc');
      expect(trace.entries).toHaveLength(PTC_TRACE_MAX_ENTRIES);
      expect(trace.entries.some((e) => e.callId === 'call_ptc:0')).toBe(false);
    });

    it('releases the trace atoms on reset', () => {
      const { result, getEntries } = renderWithTraceReader();
      const submission = createSubmission();

      act(() => {
        result.current.stepHandler(
          { event: StepEvents.ON_PTC_TOOL_CALL, data: ptcEvent({}) },
          submission,
        );
      });
      expect(getEntries('call_ptc')).toHaveLength(1);

      act(() => {
        (result.current as unknown as { resetPtcAtoms: () => void }).resetPtcAtoms();
      });

      expect(getEntries('call_ptc')).toEqual([]);
    });
  });
});
