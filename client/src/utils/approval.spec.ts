import { ContentTypes } from 'librechat-data-provider';
import type { Agents, TMessage, TMessageContentParts } from 'librechat-data-provider';
import {
  ASK_USER_QUESTION,
  applyPendingAction,
  countTaggedApprovalParts,
  getAskUserQuestionPart,
  findPendingActionMessageIndex,
  removeAskUserQuestionPart,
  parseAskUserQuestionArgs,
  parseAskUserQuestionsArgs,
  resolveAskUserQuestionPart,
  getSubmittedAskAnswer,
  findLiveAskUserQuestion,
  collectLiveAskToolCallIds,
  isAnsweredAskUserQuestionPart,
  splitOtherOption,
} from './approval';
import { hasPendingApprovalInPart } from './groupToolCalls';

const toolCallPart = (id: string, extra: Record<string, unknown> = {}): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: { id, name: 'search', args: '{}', ...extra },
  }) as unknown as TMessageContentParts;

const textPart = (text: string): TMessageContentParts =>
  ({ type: ContentTypes.TEXT, text }) as unknown as TMessageContentParts;

const msg = (over: Partial<TMessage> = {}): TMessage =>
  ({ messageId: 'm1', isCreatedByUser: false, content: [], ...over }) as unknown as TMessage;

const toolApprovalAction = (over: Record<string, unknown> = {}): Agents.PendingAction =>
  ({
    actionId: 'a1',
    streamId: 's1',
    createdAt: 0,
    payload: {
      type: 'tool_approval',
      action_requests: [
        { name: 'search', arguments: '{}', tool_call_id: 'tc1', description: 'Run search' },
      ],
      review_configs: [
        { action_name: 'search', tool_call_id: 'tc1', allowed_decisions: ['approve', 'reject'] },
      ],
    },
    ...over,
  }) as unknown as Agents.PendingAction;

const askAction = (over: Record<string, unknown> = {}): Agents.PendingAction =>
  ({
    actionId: 'a1',
    streamId: 's1',
    createdAt: 0,
    payload: { type: 'ask_user_question', question: { question: 'What name?' } },
    ...over,
  }) as unknown as Agents.PendingAction;

const getToolCall = (part: TMessageContentParts | undefined) =>
  (part as unknown as { tool_call?: Agents.ToolCall & { approval?: unknown } })?.tool_call;

describe('applyPendingAction — tool_approval', () => {
  it('joins by tool_call_id (not position) and sets approval from the matching request + review', () => {
    // tc1 is the SECOND part — a by-position join would mis-target the first.
    const message = msg({ content: [toolCallPart('tcX'), toolCallPart('tc1')] });
    const result = applyPendingAction(message, toolApprovalAction());

    expect(result).not.toBe(message); // new reference: something changed
    expect(getToolCall(result.content?.[0] as TMessageContentParts)?.approval).toBeUndefined();
    expect(getToolCall(result.content?.[1] as TMessageContentParts)?.approval).toEqual({
      actionId: 'a1',
      allowed_decisions: ['approve', 'reject'],
      description: 'Run search',
    });
  });

  it('replaces displayed tool args with the matching action request arguments', () => {
    const originalArgs = { query: 'original model args' };
    const rewrittenArgs = { query: 'rewritten by policy hook' };
    const message = msg({ content: [toolCallPart('tc1', { args: originalArgs })] });
    const action = toolApprovalAction({
      payload: {
        type: 'tool_approval',
        action_requests: [
          {
            name: 'search',
            arguments: rewrittenArgs,
            tool_call_id: 'tc1',
            description: 'Review rewritten search',
          },
        ],
        review_configs: [
          {
            action_name: 'search',
            tool_call_id: 'tc1',
            allowed_decisions: ['approve', 'reject', 'edit', 'respond'],
          },
        ],
      },
    });

    const result = applyPendingAction(message, action);

    expect(getToolCall(result.content?.[0] as TMessageContentParts)?.args).toEqual(rewrittenArgs);
    expect(getToolCall(message.content?.[0] as TMessageContentParts)?.args).toEqual(originalArgs);
  });

  it('leaves a completed tool call (with output) untouched and returns the same message reference', () => {
    const message = msg({ content: [toolCallPart('tc1', { output: 'already ran' })] });
    const result = applyPendingAction(message, toolApprovalAction());
    expect(result).toBe(message);
  });

  it('defaults allowed_decisions to [] when no review config matches the tool call', () => {
    const action = toolApprovalAction({
      payload: {
        type: 'tool_approval',
        action_requests: [{ name: 'search', arguments: '{}', tool_call_id: 'tc1' }],
        review_configs: [], // no config for tc1
      },
    });
    const message = msg({ content: [toolCallPart('tc1')] });
    const result = applyPendingAction(message, action);
    expect(getToolCall(result.content?.[0] as TMessageContentParts)?.approval).toMatchObject({
      allowed_decisions: [],
    });
  });

  it('returns the same message when content is empty or not an array', () => {
    const empty = msg({ content: [] });
    expect(applyPendingAction(empty, toolApprovalAction())).toBe(empty);
    const nonArray = msg({ content: undefined as unknown as TMessageContentParts[] });
    expect(applyPendingAction(nonArray, toolApprovalAction())).toBe(nonArray);
  });

  it('returns the same message when no tool call matches the pending request', () => {
    const message = msg({ content: [toolCallPart('other')] });
    expect(applyPendingAction(message, toolApprovalAction())).toBe(message);
  });
});

describe('countTaggedApprovalParts', () => {
  const twoToolAction = () =>
    toolApprovalAction({
      payload: {
        type: 'tool_approval',
        action_requests: [
          { name: 'search', arguments: '{}', tool_call_id: 'tc1' },
          { name: 'search', arguments: '{}', tool_call_id: 'tc2' },
        ],
        review_configs: [],
      },
    });

  it('counts tagged parts so a partial multi-tool apply is detectable (1 of 2)', () => {
    const action = twoToolAction();
    // Only tc1 has rendered when the action is first applied → 1 < 2, retry should continue.
    const partial = applyPendingAction(msg({ content: [toolCallPart('tc1')] }), action);
    expect(countTaggedApprovalParts(partial, 'a1')).toBe(1);
    // Both siblings present → both tagged → retry can stop.
    const full = applyPendingAction(
      msg({ content: [toolCallPart('tc1'), toolCallPart('tc2')] }),
      action,
    );
    expect(countTaggedApprovalParts(full, 'a1')).toBe(2);
  });

  it('returns 0 when nothing is tagged or content is not an array', () => {
    expect(countTaggedApprovalParts(msg({ content: [toolCallPart('tc1')] }), 'a1')).toBe(0);
    expect(countTaggedApprovalParts(msg({ content: [textPart('hi')] }), 'a1')).toBe(0);
    expect(
      countTaggedApprovalParts(
        msg({ content: undefined as unknown as TMessageContentParts[] }),
        'a1',
      ),
    ).toBe(0);
  });

  it('ignores parts tagged with a different actionId', () => {
    const tagged = applyPendingAction(
      msg({ content: [toolCallPart('tc1')] }),
      toolApprovalAction(),
    );
    expect(countTaggedApprovalParts(tagged, 'a1')).toBe(1);
    expect(countTaggedApprovalParts(tagged, 'other-action')).toBe(0);
  });
});

describe('applyPendingAction — subagent-nested tool calls', () => {
  const subagentMsg = (childId: string): TMessage =>
    msg({
      content: [
        {
          type: ContentTypes.TOOL_CALL,
          [ContentTypes.TOOL_CALL]: {
            id: 'sub1',
            name: 'subagent',
            args: '{}',
            subagent_content: [toolCallPart(childId)],
          },
        } as unknown as TMessageContentParts,
      ],
    });

  const childAction = () =>
    toolApprovalAction({
      payload: {
        type: 'tool_approval',
        action_requests: [{ name: 'search', arguments: '{}', tool_call_id: 'child-tc1' }],
        review_configs: [
          {
            action_name: 'search',
            tool_call_id: 'child-tc1',
            allowed_decisions: ['approve', 'reject'],
          },
        ],
      },
    });

  it('tags a tool paused inside a subagent and makes it countable', () => {
    const message = subagentMsg('child-tc1');
    const result = applyPendingAction(message, childAction());
    expect(result).not.toBe(message); // new reference

    const parentToolCall = getToolCall(result.content?.[0] as TMessageContentParts) as
      | { subagent_content?: TMessageContentParts[] }
      | undefined;
    const nested = parentToolCall?.subagent_content?.[0];
    expect(getToolCall(nested)?.approval).toMatchObject({ actionId: 'a1' });
    // The retry loop's "all tagged" check is now reachable for the nested call.
    expect(countTaggedApprovalParts(result, 'a1')).toBe(1);
  });

  it('still tags the nested pause in a message whose settled calls arrived as previews', () => {
    /** The shape a preview-aware conversation load returns: a settled sibling shortened, and
     *  the running subagent's transcript kept because it holds an unresolved approval. */
    const message = msg({
      content: [
        toolCallPart('done-call', {
          output: 'head…tail',
          outputTruncated: true,
          outputLength: 40_000,
        }),
        ...(subagentMsg('child-tc1').content as TMessageContentParts[]),
      ],
    });
    const result = applyPendingAction(message, childAction());
    const parentToolCall = getToolCall(result.content?.[1] as TMessageContentParts) as
      | { subagent_content?: TMessageContentParts[] }
      | undefined;
    expect(getToolCall(parentToolCall?.subagent_content?.[0])?.approval).toMatchObject({
      actionId: 'a1',
    });
    expect(hasPendingApprovalInPart(result.content?.[1] as TMessageContentParts)).toBe(true);
    expect(hasPendingApprovalInPart(result.content?.[0] as TMessageContentParts)).toBe(false);
    expect(countTaggedApprovalParts(result, 'a1')).toBe(1);
  });

  it('returns the same message when no nested tool call matches', () => {
    const message = subagentMsg('child-other');
    expect(applyPendingAction(message, childAction())).toBe(message);
    expect(countTaggedApprovalParts(message, 'a1')).toBe(0);
  });
});

describe('applyPendingAction — ask_user_question', () => {
  it('appends a synthetic ask-user-question part carrying the actionId and question', () => {
    const message = msg({ content: [textPart('hello')] });
    const result = applyPendingAction(message, askAction());
    expect(result.content).toHaveLength(2);
    const part = getAskUserQuestionPart(result.content?.[1] as TMessageContentParts);
    expect(part?.[ASK_USER_QUESTION]).toMatchObject({
      actionId: 'a1',
      question: { question: 'What name?' },
    });
  });

  it('is idempotent on replay: the same actionId replaces in place rather than stacking', () => {
    const once = applyPendingAction(msg({ content: [] }), askAction());
    const twice = applyPendingAction(once, askAction());
    expect(twice.content).toHaveLength(1); // not duplicated

    const other = applyPendingAction(twice, askAction({ actionId: 'a2' }));
    expect(other.content).toHaveLength(2); // a different action does append
  });

  it('coerces non-array content to a single-part array', () => {
    const message = msg({ content: undefined as unknown as TMessageContentParts[] });
    const result = applyPendingAction(message, askAction());
    expect(result.content).toHaveLength(1);
  });
});

describe('parseAskUserQuestionArgs', () => {
  it('parses a JSON-string args payload (the persisted wire shape)', () => {
    const parsed = parseAskUserQuestionArgs(
      JSON.stringify({ question: 'Which?', options: [{ label: 'A', value: 'a' }] }),
    );
    expect(parsed?.question).toBe('Which?');
    expect(parsed?.options).toHaveLength(1);
  });

  it('accepts an already-parsed object', () => {
    expect(parseAskUserQuestionArgs({ question: 'Which?' })?.question).toBe('Which?');
  });

  it('degrades to null on empty, malformed, or question-less args', () => {
    expect(parseAskUserQuestionArgs('')).toBeNull();
    expect(parseAskUserQuestionArgs('not json')).toBeNull();
    expect(parseAskUserQuestionArgs('{"no_question": true}')).toBeNull();
    expect(parseAskUserQuestionArgs(undefined)).toBeNull();
  });

  it('passes multiSelect through only as a strict boolean true', () => {
    expect(parseAskUserQuestionArgs({ question: 'Which?', multiSelect: true })?.multiSelect).toBe(
      true,
    );
    expect(
      parseAskUserQuestionArgs({ question: 'Which?', multiSelect: 'yes' })?.multiSelect,
    ).toBeUndefined();
    expect(parseAskUserQuestionArgs({ question: 'Which?' })?.multiSelect).toBeUndefined();
  });
});

describe('parseAskUserQuestionsArgs', () => {
  it('parses a complete batch and preserves headers and options', () => {
    const parsed = parseAskUserQuestionsArgs({
      questions: [
        {
          id: 'environment',
          header: 'Environment',
          question: 'Which environment?',
          options: [{ label: 'Staging', value: 'staging' }],
        },
        { id: 'window', question: 'Which window?' },
      ],
    });
    expect(parsed?.questions).toHaveLength(2);
    expect(parsed?.questions[0]).toMatchObject({ id: 'environment', header: 'Environment' });
  });

  it('rejects malformed and duplicate-id batches', () => {
    expect(parseAskUserQuestionsArgs({ questions: [] })).toBeNull();
    expect(
      parseAskUserQuestionsArgs({
        questions: [
          { id: 'same', question: 'First?' },
          { id: 'same', question: 'Second?' },
        ],
      }),
    ).toBeNull();
  });

  it('trims valid headers and omits whitespace-only or oversized headers', () => {
    const parsed = parseAskUserQuestionsArgs({
      questions: [
        { id: 'trimmed', header: '  Context  ', question: 'First?' },
        { id: 'blank', header: '   ', question: 'Second?' },
        { id: 'large', header: 'x'.repeat(81), question: 'Third?' },
      ],
    });

    expect(parsed?.questions[0].header).toBe('Context');
    expect(parsed?.questions[1].header).toBeUndefined();
    expect(parsed?.questions[2].header).toBeUndefined();
  });
});

describe('removeAskUserQuestionPart', () => {
  it('strips the synthetic part for the matching actionId and keeps everything else', () => {
    const withCard = applyPendingAction(msg({ content: [textPart('hello')] }), askAction());
    const stripped = removeAskUserQuestionPart(withCard, 'a1');
    expect(stripped.content).toHaveLength(1);
    expect(stripped.content?.[0]).toMatchObject({ type: 'text' });
  });

  it('returns the same reference when no matching part exists (different actionId / none)', () => {
    const plain = msg({ content: [textPart('hi')] });
    expect(removeAskUserQuestionPart(plain, 'a1')).toBe(plain);
    const withCard = applyPendingAction(plain, askAction());
    expect(removeAskUserQuestionPart(withCard, 'other-action')).toBe(withCard);
  });

  it('tolerates non-array content', () => {
    const weird = msg({ content: undefined as unknown as TMessageContentParts[] });
    expect(removeAskUserQuestionPart(weird, 'a1')).toBe(weird);
  });
});

describe('resolveAskUserQuestionPart', () => {
  const withCardAndToolCall = () => {
    const base = msg({
      content: [
        textPart('pre-pause'),
        {
          type: 'tool_call',
          tool_call: { id: 'tc1', name: 'ask_user_question', args: '', type: 'tool_call' },
        } as unknown as TMessageContentParts,
      ],
    });
    return applyPendingAction(base, askAction());
  };

  it('strips the card and stamps the answer (seeding args from the synthetic question)', () => {
    const resolved = resolveAskUserQuestionPart(withCardAndToolCall(), 'a1', 'green');
    const content = resolved.content as Array<{
      type?: string;
      tool_call?: Record<string, unknown>;
    }>;
    expect(content.some((part) => part?.type === 'ask_user_question')).toBe(false);
    const toolCall = content[1]?.tool_call as Record<string, unknown>;
    expect(toolCall.output).toBe('green');
    expect(toolCall.progress).toBe(1);
    expect(JSON.parse(toolCall.args as string)).toMatchObject({ question: 'What name?' });
  });

  it('keeps streamed args when the part already has them', () => {
    const base = msg({
      content: [
        {
          type: 'tool_call',
          tool_call: {
            id: 'tc1',
            name: 'ask_user_question',
            args: '{"question":"streamed"}',
            type: 'tool_call',
          },
        } as unknown as TMessageContentParts,
      ],
    });
    const resolved = resolveAskUserQuestionPart(applyPendingAction(base, askAction()), 'a1', 'x');
    const toolCall = (resolved.content as Array<{ tool_call?: Record<string, unknown> }>)[0]
      ?.tool_call as Record<string, unknown>;
    expect(toolCall.args).toBe('{"question":"streamed"}');
    expect(toolCall.output).toBe('x');
  });

  it('returns the same reference when the message has no matching synthetic part', () => {
    const plain = msg({ content: [textPart('hi')] });
    expect(resolveAskUserQuestionPart(plain, 'a1', 'x')).toBe(plain);
  });

  it('records the submitted answer by tool_call id (render-layer fallback for mid-stream copies)', () => {
    resolveAskUserQuestionPart(withCardAndToolCall(), 'a1', 'purple');
    expect(getSubmittedAskAnswer('tc1')).toBe('purple');
    expect(getSubmittedAskAnswer('unknown')).toBeUndefined();
    expect(getSubmittedAskAnswer(undefined)).toBeUndefined();
  });

  it('stamps the exact tool_call when the payload carried tool_call_id (multi-ask turn)', () => {
    const askToolCallPart = (id: string) =>
      ({
        type: 'tool_call',
        tool_call: { id, name: 'ask_user_question', args: '', type: 'tool_call' },
      }) as unknown as TMessageContentParts;
    const base = msg({ content: [askToolCallPart('tc_a'), askToolCallPart('tc_b')] });
    const withCard = applyPendingAction(
      base,
      askAction({
        actionId: 'a-multi-ask',
        payload: {
          type: 'ask_user_question',
          question: { question: 'Which region?' },
          tool_call_id: 'tc_a',
        },
      }),
    );
    const resolved = resolveAskUserQuestionPart(withCard, 'a-multi-ask', 'us-east');
    const content = resolved.content as Array<{ tool_call?: Record<string, unknown> }>;
    // Without the id, the newest-unanswered fallback would stamp tc_b.
    expect(content[0]?.tool_call?.output).toBe('us-east');
    expect(content[1]?.tool_call?.output).toBeUndefined();
  });

  it('stamps one batched tool call with structured args and answers', () => {
    const base = msg({
      content: [
        {
          type: 'tool_call',
          tool_call: { id: 'tc-batch', name: 'ask_user_question', args: '', type: 'tool_call' },
        } as unknown as TMessageContentParts,
      ],
    });
    const questions = [
      { id: 'environment', question: 'Which environment?' },
      { id: 'window', question: 'Which window?' },
    ];
    const withCard = applyPendingAction(
      base,
      askAction({
        actionId: 'a-batch',
        payload: {
          type: 'ask_user_question',
          question: questions[0],
          questions,
          tool_call_id: 'tc-batch',
        },
      }),
    );
    const resolved = resolveAskUserQuestionPart(withCard, 'a-batch', {
      environment: 'staging',
      window: '7d',
    });
    const toolCall = (resolved.content as Array<{ tool_call?: Record<string, unknown> }>)[0]
      ?.tool_call as Record<string, unknown>;
    expect(JSON.parse(toolCall.args as string)).toEqual({ questions });
    expect(JSON.parse(toolCall.output as string)).toEqual({
      answers: { environment: 'staging', window: '7d' },
    });
  });
});

describe('splitOtherOption', () => {
  it("folds a model-supplied 'Other'-style option into the inline placeholder", () => {
    const { choices, otherLabel } = splitOtherOption([
      { label: 'Red', value: 'red' },
      { label: 'Other (type your own)', value: 'other' },
    ]);
    expect(choices.map((o) => o.value)).toEqual(['red']);
    expect(otherLabel).toBe('Other (type your own)');
  });

  it('matches by label when the value is not literally other', () => {
    const { choices, otherLabel } = splitOtherOption([
      { label: 'Blue', value: 'blue' },
      { label: 'Something else entirely', value: 'custom_answer' },
    ]);
    expect(choices).toHaveLength(1);
    expect(otherLabel).toBe('Something else entirely');
  });

  it('leaves real choices untouched (no false positives, undefined input)', () => {
    const options = [
      { label: 'Red', value: 'red' },
      { label: 'Mother of pearl', value: 'pearl' },
    ];
    expect(splitOtherOption(options)).toEqual({ choices: options });
    expect(splitOtherOption(undefined)).toEqual({ choices: [] });
  });
});

describe('findLiveAskUserQuestion', () => {
  it('returns the newest live question across messages', () => {
    const older = applyPendingAction(msg({ content: [] }), askAction());
    const newer = applyPendingAction(
      { ...msg({ content: [] }), messageId: 'm2' },
      askAction({ actionId: 'a2' }),
    );
    const found = findLiveAskUserQuestion([older, newer]);
    expect(found?.actionId).toBe('a2');
    expect(found?.messageId).toBe('m2');
    expect(found?.question.question).toBe('What name?');
  });

  it('returns null with no live question or non-array input', () => {
    expect(findLiveAskUserQuestion([msg({ content: [textPart('hi')] })])).toBeNull();
    expect(findLiveAskUserQuestion(null)).toBeNull();
    expect(findLiveAskUserQuestion(undefined)).toBeNull();
  });

  /**
   * The strip on answer-submit is a store write, so any holder of an older copy
   * of the message (the SSE step handler's in-flight cache, a replayed event)
   * can put the card back. Honouring a resurrected card reopened the popover
   * over a question the user had already answered, options greyed out.
   */
  it('ignores a resurrected card for an answered question', () => {
    const paused = applyPendingAction(msg({ content: [] }), askAction({ actionId: 'a-answered' }));
    expect(findLiveAskUserQuestion([paused])?.actionId).toBe('a-answered');

    resolveAskUserQuestionPart(paused, 'a-answered', 'Ada');

    // `paused` is the pre-answer copy — exactly what a stale cache writes back.
    expect(findLiveAskUserQuestion([paused])).toBeNull();
  });

  it('falls back to an older live question when the newest is answered', () => {
    const older = applyPendingAction(msg({ content: [] }), askAction({ actionId: 'a-live' }));
    const newer = applyPendingAction(
      { ...msg({ content: [] }), messageId: 'm2' },
      askAction({ actionId: 'a-done' }),
    );
    resolveAskUserQuestionPart(newer, 'a-done', 'Ada');

    expect(findLiveAskUserQuestion([older, newer])?.actionId).toBe('a-live');
  });
});

describe('collectLiveAskToolCallIds', () => {
  const attributedAsk = (actionId: string, toolCallId: string) =>
    askAction({
      actionId,
      payload: {
        type: 'ask_user_question',
        question: { question: 'Q?' },
        tool_call_id: toolCallId,
      },
    });

  it('collects every live pause id, not just the newest, and drops answered ones', () => {
    const first = applyPendingAction(msg({ content: [] }), attributedAsk('a-first', 'call_1'));
    const both = applyPendingAction(first, attributedAsk('a-second', 'call_2'));

    expect(collectLiveAskToolCallIds([both])).toEqual({
      ids: ['call_1', 'call_2'],
      hasUnattributed: false,
    });

    resolveAskUserQuestionPart(both, 'a-first', 'Ada');

    // `both` is the pre-answer copy — the answered pause must still drop out.
    expect(collectLiveAskToolCallIds([both])).toEqual({
      ids: ['call_2'],
      hasUnattributed: false,
    });
  });

  it('flags unattributed pauses and handles non-array input', () => {
    const unattributed = applyPendingAction(
      msg({ content: [] }),
      askAction({ actionId: 'a-unattributed' }),
    );

    expect(collectLiveAskToolCallIds([unattributed])).toEqual({ ids: [], hasUnattributed: true });
    expect(collectLiveAskToolCallIds(null)).toEqual({ ids: [], hasUnattributed: false });
    expect(collectLiveAskToolCallIds(undefined)).toEqual({ ids: [], hasUnattributed: false });
  });
});

describe('isAnsweredAskUserQuestionPart', () => {
  it('marks only cards whose question was actually answered', () => {
    const live = applyPendingAction(msg({ content: [] }), askAction({ actionId: 'a-open' }));
    const answered = applyPendingAction(msg({ content: [] }), askAction({ actionId: 'a-closed' }));
    resolveAskUserQuestionPart(answered, 'a-closed', 'Ada');

    expect(isAnsweredAskUserQuestionPart(answered.content?.[0])).toBe(true);
    expect(isAnsweredAskUserQuestionPart(live.content?.[0])).toBe(false);
    expect(isAnsweredAskUserQuestionPart(textPart('hi'))).toBe(false);
    expect(isAnsweredAskUserQuestionPart(undefined)).toBe(false);
  });

  it('stays false for a question whose resolve found no matching card', () => {
    const paused = applyPendingAction(msg({ content: [] }), askAction({ actionId: 'a-other' }));
    resolveAskUserQuestionPart(paused, 'a-missing', 'Ada');
    expect(isAnsweredAskUserQuestionPart(paused.content?.[0])).toBe(false);
  });
});

describe('applyPendingAction — unsupported type', () => {
  it('returns the original message unchanged', () => {
    const message = msg({ content: [textPart('hi')] });
    const action = {
      actionId: 'a1',
      payload: { type: 'mystery' },
    } as unknown as Agents.PendingAction;
    expect(applyPendingAction(message, action)).toBe(message);
  });
});

describe('getAskUserQuestionPart', () => {
  it('returns the typed part for an ask-user-question synthetic part', () => {
    const appended = applyPendingAction(msg({ content: [] }), askAction());
    const part = getAskUserQuestionPart(appended.content?.[0] as TMessageContentParts);
    expect(part?.type).toBe(ASK_USER_QUESTION);
    expect(part?.[ASK_USER_QUESTION].actionId).toBe('a1');
  });

  it('returns undefined for a non-ask part, undefined, or a wrong type', () => {
    expect(getAskUserQuestionPart(toolCallPart('tc1'))).toBeUndefined();
    expect(getAskUserQuestionPart(undefined)).toBeUndefined();
    expect(getAskUserQuestionPart(textPart('x'))).toBeUndefined();
  });
});

describe('findPendingActionMessageIndex', () => {
  const assistant = (messageId: string) => msg({ messageId, isCreatedByUser: false });
  const user = (messageId: string) => msg({ messageId, isCreatedByUser: true });

  it('returns the index of the assistant message matching responseMessageId exactly', () => {
    const messages = [user('u1'), assistant('r1'), assistant('r2')];
    const idx = findPendingActionMessageIndex(
      messages,
      toolApprovalAction({ responseMessageId: 'r1' }),
    );
    expect(idx).toBe(1);
  });

  it('returns -1 (retry) when a provided responseMessageId matches only a user message', () => {
    // `<userMsg>_` style ids could collide with the user bubble — never resolve to it;
    // -1 makes the caller retry on the next frame once the assistant placeholder renders.
    const messages = [user('shared'), assistant('r-last')];
    const idx = findPendingActionMessageIndex(
      messages,
      toolApprovalAction({ responseMessageId: 'shared' }),
    );
    expect(idx).toBe(-1);
  });

  it('returns -1 (retry) when a provided responseMessageId is not found at all', () => {
    // Provided-but-absent means the in-flight assistant placeholder is not in the list
    // yet — defer rather than attach the prompt/approval to a prior reply.
    const messages = [assistant('r1'), user('u1'), assistant('r2')];
    const idx = findPendingActionMessageIndex(
      messages,
      toolApprovalAction({ responseMessageId: 'missing' }),
    );
    expect(idx).toBe(-1);
  });

  it('falls back to the last assistant message only when no responseMessageId is provided', () => {
    const messages = [assistant('r1'), user('u1'), assistant('r2')];
    const idx = findPendingActionMessageIndex(messages, toolApprovalAction());
    expect(idx).toBe(2);
  });

  it('returns -1 for an empty list or when no assistant message exists', () => {
    expect(findPendingActionMessageIndex([], toolApprovalAction())).toBe(-1);
    expect(findPendingActionMessageIndex([user('u1')], toolApprovalAction())).toBe(-1);
  });
});
