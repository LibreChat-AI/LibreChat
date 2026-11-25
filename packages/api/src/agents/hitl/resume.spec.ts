import {
  ContentTypes,
  GraphEvents,
  StepTypes,
  createContentAggregator,
  type RunStep,
} from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';
import {
  mapToolApprovalResolutions,
  mapAskUserAnswer,
  mapAskUserAnswers,
  getBoundedAskUserAnswerValues,
  serializeAskUserAnswerVariants,
  resolveAskUserQuestionResume,
  findUndecidedToolCalls,
  hasInvalidToolApprovalResolutions,
  resolveToolApprovalResume,
  findDisallowedDecisions,
  findIncompleteDecisions,
  createContentIndexOffsetHandlers,
  hydrateResumeRunSteps,
  attachAskUserQuestionAnswer,
  attachAskUserQuestionAnswers,
  attachAskUserQuestionArgs,
  buildResolvedAskUserQuestion,
  appendResolvedAskUserQuestion,
  findAskUserQuestionContentIndex,
} from './resume';

describe('mapToolApprovalResolutions', () => {
  test('maps each decision type to the SDK discriminated shape, keyed by tool_call_id', () => {
    const resolutions: Agents.ToolApprovalResolution[] = [
      { tool_call_id: 'a', decision: 'approve' },
      { tool_call_id: 'b', decision: 'reject', reason: 'no' },
      { tool_call_id: 'c', decision: 'edit', editedArguments: { x: 1 } },
      { tool_call_id: 'd', decision: 'respond', responseText: 'done' },
    ];

    expect(mapToolApprovalResolutions(resolutions)).toEqual({
      a: { type: 'approve' },
      b: { type: 'reject', reason: 'no' },
      c: { type: 'edit', updatedInput: { x: 1 } },
      d: { type: 'respond', responseText: 'done' },
    });
  });

  test('defaults missing edit args to {} and missing respond text to "" rather than throwing', () => {
    const resolutions: Agents.ToolApprovalResolution[] = [
      { tool_call_id: 'a', decision: 'edit' },
      { tool_call_id: 'b', decision: 'respond' },
    ];
    expect(mapToolApprovalResolutions(resolutions)).toEqual({
      a: { type: 'edit', updatedInput: {} },
      b: { type: 'respond', responseText: '' },
    });
  });

  test('fails closed (reject) on an unrecognized decision', () => {
    const resolutions = [
      { tool_call_id: 'a', decision: 'nonsense' as Agents.ToolApprovalDecisionType },
    ];
    expect(mapToolApprovalResolutions(resolutions)).toEqual({
      a: { type: 'reject', reason: 'Unrecognized approval decision' },
    });
  });

  test('last write wins when the same tool_call_id appears twice', () => {
    const resolutions: Agents.ToolApprovalResolution[] = [
      { tool_call_id: 'a', decision: 'approve' },
      { tool_call_id: 'a', decision: 'reject' },
    ];
    expect(mapToolApprovalResolutions(resolutions)).toEqual({ a: { type: 'reject' } });
  });
});

describe('mapAskUserAnswer', () => {
  test('passes the answer through unchanged', () => {
    expect(mapAskUserAnswer({ answer: 'staging' })).toEqual({ answer: 'staging' });
  });
});

describe('mapAskUserAnswers', () => {
  it('preserves answers keyed by question id', () => {
    expect(mapAskUserAnswers({ answers: { environment: 'staging', window: '7d' } })).toEqual({
      answers: { environment: 'staging', window: '7d' },
    });
  });
});

describe('serializeAskUserAnswerVariants', () => {
  it('covers every bounded downstream answer-map ordering with the resolution wrapper', () => {
    expect(serializeAskUserAnswerVariants({ second: '456', first: '123' })).toEqual([
      '{"answers":{"second":"456","first":"123"}}',
      '{"answers":{"first":"123","second":"456"}}',
    ]);
  });

  it('does not expand invalid or unbounded answer maps', () => {
    expect(serializeAskUserAnswerVariants(['one'])).toEqual([]);
    expect(
      serializeAskUserAnswerVariants({
        one: '1',
        two: '2',
        three: '3',
        four: '4',
        five: '5',
      }),
    ).toEqual([]);
    expect(
      serializeAskUserAnswerVariants({
        one: 'x'.repeat(16_001),
        two: 'safe',
      }),
    ).toEqual([]);
  });
});

describe('getBoundedAskUserAnswerValues', () => {
  it('excludes oversized batches before content middleware can inspect them', () => {
    expect(
      getBoundedAskUserAnswerValues({
        one: 'x'.repeat(16_001),
        two: 'safe',
      }),
    ).toEqual([]);
  });
});

describe('resolveAskUserQuestionResume', () => {
  const payload: Agents.AskUserQuestionInterruptPayload = {
    type: 'ask_user_question',
    question: { question: 'Where and when?' },
    questions: [
      { id: 'environment', question: 'Where?' },
      { id: 'window', question: 'When?' },
    ],
  };

  test('validates and maps a complete batch', () => {
    expect(
      resolveAskUserQuestionResume(payload, {
        answers: { environment: 'staging', window: '7d' },
      }),
    ).toEqual({ resumeValue: { answers: { environment: 'staging', window: '7d' } } });
  });

  test('rejects missing, unknown, and array-shaped answers', () => {
    expect(resolveAskUserQuestionResume(payload, { answers: { environment: 'staging' } })).toEqual({
      status: 400,
      error: 'Answers are required for every question',
    });
    expect(
      resolveAskUserQuestionResume(payload, {
        answers: { environment: 'staging', window: '7d', region: 'us-east-2' },
      }),
    ).toEqual({ status: 400, error: 'Answers contain an unknown question id' });
    expect(resolveAskUserQuestionResume(payload, { answers: ['staging', '7d'] })).toEqual({
      status: 400,
      error: 'Answers are required for every question',
    });
  });

  test('rejects invalid batches and oversized answers', () => {
    expect(
      resolveAskUserQuestionResume(
        { ...payload, questions: [{ id: 'bad id', question: 'Invalid?' }] },
        { answers: { 'bad id': 'yes' } },
      ),
    ).toEqual({ status: 400, error: 'The pending question batch is invalid' });
    expect(
      resolveAskUserQuestionResume(
        {
          ...payload,
          questions: [{ id: undefined, question: 'Invalid?' }],
        } as unknown as Agents.AskUserQuestionInterruptPayload,
        { answers: { undefined: 'yes' } },
      ),
    ).toEqual({ status: 400, error: 'The pending question batch is invalid' });
    expect(
      resolveAskUserQuestionResume(payload, {
        answers: { environment: 'x'.repeat(16_001), window: '7d' },
      }),
    ).toEqual({ status: 400, error: 'An answer exceeds the maximum length' });
  });

  test('preserves legacy single-answer validation and mapping', () => {
    const legacy = { ...payload, questions: undefined };
    expect(resolveAskUserQuestionResume(legacy, { answer: 'staging' })).toEqual({
      resumeValue: { answer: 'staging' },
    });
    expect(resolveAskUserQuestionResume(legacy, {})).toEqual({
      status: 400,
      error: 'An answer is required',
    });
  });
});

describe('findUndecidedToolCalls', () => {
  const payload: Agents.ToolApprovalInterruptPayload = {
    type: 'tool_approval',
    action_requests: [
      { tool_call_id: 'a', name: 'read', arguments: {} },
      { tool_call_id: 'b', name: 'write', arguments: {} },
    ],
    review_configs: [],
  };

  test('returns the tool_call_ids with no decision', () => {
    expect(findUndecidedToolCalls(payload, [{ tool_call_id: 'a', decision: 'approve' }])).toEqual([
      'b',
    ]);
  });

  test('returns [] when every requested tool call is decided', () => {
    expect(
      findUndecidedToolCalls(payload, [
        { tool_call_id: 'a', decision: 'approve' },
        { tool_call_id: 'b', decision: 'reject' },
      ]),
    ).toEqual([]);
  });

  test('ignores resolutions for tool calls not in the action', () => {
    expect(
      findUndecidedToolCalls(payload, [
        { tool_call_id: 'a', decision: 'approve' },
        { tool_call_id: 'b', decision: 'approve' },
        { tool_call_id: 'z', decision: 'approve' },
      ]),
    ).toEqual([]);
  });
});

describe('hasInvalidToolApprovalResolutions', () => {
  const payload: Agents.ToolApprovalInterruptPayload = {
    type: 'tool_approval',
    action_requests: [
      { tool_call_id: 'a', name: 'read', arguments: {} },
      { tool_call_id: 'b', name: 'write', arguments: {} },
    ],
    review_configs: [],
  };

  test('rejects duplicate decisions for one tool-call id', () => {
    expect(
      hasInvalidToolApprovalResolutions(payload, [
        { tool_call_id: 'a', decision: 'approve' },
        { tool_call_id: 'a', decision: 'reject' },
      ]),
    ).toBe(true);
  });

  test('rejects decisions for a tool call outside the pending batch', () => {
    expect(
      hasInvalidToolApprovalResolutions(payload, [
        { tool_call_id: 'a', decision: 'approve' },
        { tool_call_id: 'foreign', decision: 'approve' },
      ]),
    ).toBe(true);
  });

  test('accepts one decision for each requested tool call', () => {
    expect(
      hasInvalidToolApprovalResolutions(payload, [
        { tool_call_id: 'a', decision: 'approve' },
        { tool_call_id: 'b', decision: 'reject' },
      ]),
    ).toBe(false);
  });
});

describe('resolveToolApprovalResume', () => {
  const payload: Agents.ToolApprovalInterruptPayload = {
    type: 'tool_approval',
    action_requests: [
      { tool_call_id: 'a', name: 'read', arguments: {} },
      { tool_call_id: 'b', name: 'write', arguments: {} },
    ],
    review_configs: [
      { tool_call_id: 'a', action_name: 'read', allowed_decisions: ['approve', 'reject'] },
      { tool_call_id: 'b', action_name: 'write', allowed_decisions: ['approve', 'reject'] },
    ],
  };

  test('fails closed when a persisted payload contains duplicate call identities', () => {
    const aliased = {
      ...payload,
      action_requests: [payload.action_requests[0], payload.action_requests[0]],
      review_configs: [payload.review_configs[0], payload.review_configs[0]],
    };

    expect(
      resolveToolApprovalResume(aliased, [{ tool_call_id: 'a', decision: 'approve' }]),
    ).toEqual({ status: 400, error: 'Invalid tool approval payload' });
  });

  test('returns the SDK decision map only for a complete unambiguous batch', () => {
    expect(
      resolveToolApprovalResume(payload, [
        { tool_call_id: 'a', decision: 'approve' },
        { tool_call_id: 'b', decision: 'reject' },
      ]),
    ).toEqual({ resumeValue: { a: { type: 'approve' }, b: { type: 'reject' } } });
  });
});

describe('findDisallowedDecisions', () => {
  const payload: Agents.ToolApprovalInterruptPayload = {
    type: 'tool_approval',
    action_requests: [
      { tool_call_id: 'a', name: 'read', arguments: {} },
      { tool_call_id: 'b', name: 'write', arguments: {} },
    ],
    review_configs: [
      { action_name: 'read', tool_call_id: 'a', allowed_decisions: ['approve', 'reject'] },
      { action_name: 'write', tool_call_id: 'b', allowed_decisions: ['reject', 'respond'] },
    ],
  };

  test('returns [] when every decision is permitted by its review config', () => {
    expect(
      findDisallowedDecisions(payload, [
        { tool_call_id: 'a', decision: 'approve' },
        { tool_call_id: 'b', decision: 'respond', responseText: 'x' },
      ]),
    ).toEqual([]);
  });

  test('flags a decision the policy does not allow for that tool', () => {
    // `b` is restricted to reject/respond — approving it must be rejected.
    expect(
      findDisallowedDecisions(payload, [
        { tool_call_id: 'a', decision: 'approve' },
        { tool_call_id: 'b', decision: 'approve' },
      ]),
    ).toEqual(['b']);
  });

  test('fails closed for a tool_call_id with no matching review config', () => {
    expect(findDisallowedDecisions(payload, [{ tool_call_id: 'z', decision: 'approve' }])).toEqual([
      'z',
    ]);
  });
});

describe('findIncompleteDecisions', () => {
  it('flags an edit decision without editedArguments', () => {
    expect(findIncompleteDecisions([{ tool_call_id: 'a', decision: 'edit' }])).toEqual(['a']);
  });

  it('flags an edit decision whose editedArguments is not a plain object', () => {
    expect(
      findIncompleteDecisions([
        {
          tool_call_id: 'a',
          decision: 'edit',
          editedArguments: [] as unknown as Record<string, unknown>,
        },
      ]),
    ).toEqual(['a']);
  });

  it('flags a respond decision without responseText (or empty)', () => {
    expect(findIncompleteDecisions([{ tool_call_id: 'a', decision: 'respond' }])).toEqual(['a']);
    expect(
      findIncompleteDecisions([{ tool_call_id: 'b', decision: 'respond', responseText: '' }]),
    ).toEqual(['b']);
  });

  it('accepts complete edit/respond and ignores approve/reject', () => {
    expect(
      findIncompleteDecisions([
        { tool_call_id: 'a', decision: 'edit', editedArguments: { q: 1 } },
        { tool_call_id: 'b', decision: 'respond', responseText: 'done' },
        { tool_call_id: 'c', decision: 'approve' },
        { tool_call_id: 'd', decision: 'reject', reason: 'no' },
      ]),
    ).toEqual([]);
  });
});

describe('createContentIndexOffsetHandlers', () => {
  const textSeed = (n: number) => Array.from({ length: n }, () => ({ type: 'text' }));
  const makeRecorder = () => {
    const calls: Array<{ event: string; data: unknown }> = [];
    const handler = { handle: (event: string, data: unknown) => void calls.push({ event, data }) };
    return { calls, handler };
  };

  it('returns the input untouched for offset 0 / undefined handlers', () => {
    const { handler } = makeRecorder();
    const handlers = { on_run_step: handler };
    expect(createContentIndexOffsetHandlers(handlers, [])).toBe(handlers);
    expect(createContentIndexOffsetHandlers(undefined, textSeed(3))).toBeUndefined();
  });

  it('shifts ON_RUN_STEP index by the offset without mutating the original payload', () => {
    const { calls, handler } = makeRecorder();
    const wrapped = createContentIndexOffsetHandlers({ on_run_step: handler }, textSeed(3))!;
    const runStep = { id: 'step_1', index: 0, stepDetails: { type: 'message_creation' } };
    wrapped.on_run_step.handle('on_run_step', runStep as never);
    expect((calls[0].data as { index: number }).index).toBe(3);
    expect(runStep.index).toBe(0); // caller's object untouched
  });

  it('shifts ON_AGENT_UPDATE nested index', () => {
    const { calls, handler } = makeRecorder();
    const wrapped = createContentIndexOffsetHandlers({ on_agent_update: handler }, textSeed(2))!;
    wrapped.on_agent_update.handle('on_agent_update', {
      agent_update: { index: 1, runId: 'r' },
    } as never);
    expect((calls[0].data as { agent_update: { index: number } }).agent_update.index).toBe(3);
  });

  it('passes every other event handler through by reference (stateful instances intact)', () => {
    const { handler } = makeRecorder();
    const deltaHandler = { handle: jest.fn() };
    const wrapped = createContentIndexOffsetHandlers(
      { on_run_step: handler, on_message_delta: deltaHandler },
      textSeed(5),
    )!;
    expect(wrapped.on_message_delta).toBe(deltaHandler);
    // Deltas carry no index — they resolve through the (shifted) stepMap entry.
    wrapped.on_message_delta.handle('on_message_delta', { id: 'step_1', delta: {} } as never);
    expect(deltaHandler.handle).toHaveBeenCalledTimes(1);
  });

  it('rebinds a resumed tool step to its seeded unresolved slot by tool_call id', () => {
    const { calls, handler } = makeRecorder();
    const seed = [
      { type: 'text' },
      { type: 'tool_call', tool_call: { id: 'tc_paused', output: '' } },
      { type: 'tool_call', tool_call: { id: 'tc_done', output: 'already resolved' } },
    ];
    const wrapped = createContentIndexOffsetHandlers({ on_run_step: handler }, seed)!;

    // The paused call's re-execution must land on its seeded slot (1), not 0+3.
    wrapped.on_run_step.handle('on_run_step', {
      id: 'step_t',
      index: 0,
      stepDetails: { type: 'tool_calls', tool_calls: [{ id: 'tc_paused' }] },
    } as never);
    expect((calls[0].data as { index: number }).index).toBe(1);

    // Resolved seeded calls rebind too: ids are minted per call, so a same-id
    // step can only be the interrupted batch re-executing (e.g. an ask part
    // whose answer the resume controller pre-stamped onto the seed).
    wrapped.on_run_step.handle('on_run_step', {
      id: 'step_u',
      index: 1,
      stepDetails: { type: 'tool_calls', tool_calls: [{ id: 'tc_done' }] },
    } as never);
    expect((calls[1].data as { index: number }).index).toBe(2);

    // Message steps always offset.
    wrapped.on_run_step.handle('on_run_step', {
      id: 'step_m',
      index: 2,
      stepDetails: { type: 'message_creation' },
    } as never);
    expect((calls[2].data as { index: number }).index).toBe(5);
  });

  it('leaves a runStep without a numeric index unshifted (defensive)', () => {
    const { calls, handler } = makeRecorder();
    const wrapped = createContentIndexOffsetHandlers({ on_run_step: handler }, textSeed(4))!;
    const weird = { id: 'step_x' };
    wrapped.on_run_step.handle('on_run_step', weird as never);
    expect(calls[0].data).toBe(weird);
  });
});

describe('hydrateResumeRunSteps', () => {
  it('restores step and tool-call identity so a resumed completion updates its seeded card', () => {
    const { contentParts, aggregateContent, stepMap } = createContentAggregator();
    contentParts.push(
      { type: ContentTypes.TEXT, text: 'Before approval' },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'call-approval',
          name: 'approval_probe',
          args: '{"value":"before"}',
        },
      },
    );
    const runStep: RunStep = {
      id: 'step-approval',
      runId: 'response-1',
      type: StepTypes.TOOL_CALLS,
      index: 1,
      stepDetails: {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [
          {
            id: 'call-approval',
            name: 'approval_probe',
            args: { value: 'before' },
          },
        ],
      },
      usage: null,
    };
    const toolCallStepIds = new Map<string, string>();

    hydrateResumeRunSteps([runStep], stepMap, { toolCallStepIds }, contentParts);
    aggregateContent({
      event: GraphEvents.ON_RUN_STEP_COMPLETED,
      data: {
        result: {
          id: 'step-approval',
          index: 1,
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'call-approval',
            name: 'approval_probe',
            args: { value: 'before' },
            output: 'approved output',
          },
        },
      },
    });

    expect(stepMap.get('step-approval')).toBe(runStep);
    expect(toolCallStepIds.get('call-approval')).toBe('step-approval');
    expect(contentParts[1]).toMatchObject({
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'call-approval',
        output: 'approved output',
        progress: 1,
      },
    });
  });

  it('realigns a stale persisted index to the seeded tool card by tool-call id', () => {
    const { contentParts, aggregateContent, stepMap } = createContentAggregator();
    contentParts.push(
      { type: ContentTypes.TEXT, text: 'Prepended after the step was recorded' },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'call-shifted',
          name: 'approval_probe',
          args: '{"value":"shifted"}',
        },
      },
    );
    const staleRunStep: RunStep = {
      id: 'step-shifted',
      runId: 'response-1',
      type: StepTypes.TOOL_CALLS,
      index: 0,
      stepDetails: {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [
          {
            id: 'call-shifted',
            name: 'approval_probe',
            args: { value: 'shifted' },
          },
        ],
      },
      usage: null,
    };
    const toolCallStepIds = new Map<string, string>();

    hydrateResumeRunSteps([staleRunStep], stepMap, { toolCallStepIds }, contentParts);
    aggregateContent({
      event: GraphEvents.ON_RUN_STEP_COMPLETED,
      data: {
        result: {
          id: 'step-shifted',
          index: 0,
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'call-shifted',
            name: 'approval_probe',
            args: { value: 'shifted' },
            output: 'shifted output',
          },
        },
      },
    });

    expect(staleRunStep.index).toBe(0);
    expect(stepMap.get('step-shifted')?.index).toBe(1);
    expect(contentParts[0]).toEqual({
      type: ContentTypes.TEXT,
      text: 'Prepended after the step was recorded',
    });
    expect(contentParts[1]).toMatchObject({
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'call-shifted',
        output: 'shifted output',
        progress: 1,
      },
    });
  });
});

describe('attachAskUserQuestionAnswer', () => {
  const question = { question: 'Which env?', options: [{ label: 'Staging', value: 'staging' }] };
  const askPart = (output?: string) => ({
    type: 'tool_call',
    tool_call: {
      id: 'tc1',
      name: 'ask_user_question',
      args: '',
      ...(output != null && { output }),
    },
  });

  it('stamps args (the authoritative question) and output (the answer) onto the last unanswered ask part', () => {
    const content = [{ type: 'text' } as never, askPart()];
    const next = attachAskUserQuestionAnswer(content as never, question as never, 'staging');
    expect(next).not.toBe(content);
    const patched = (next[1] as { tool_call: Record<string, unknown> }).tool_call;
    expect(patched.output).toBe('staging');
    expect(patched.progress).toBe(1);
    expect(JSON.parse(patched.args as string)).toEqual(question);
    // original untouched (pure)
    expect((content[1] as { tool_call: { output?: string } }).tool_call.output).toBeUndefined();
  });

  it('skips already-answered ask parts and targets the newest unanswered one', () => {
    const content = [askPart('earlier answer'), askPart()];
    const next = attachAskUserQuestionAnswer(content as never, question as never, 'blue');
    expect((next[0] as { tool_call: { output: string } }).tool_call.output).toBe('earlier answer');
    expect((next[1] as { tool_call: { output: string } }).tool_call.output).toBe('blue');
  });

  it('returns the input array untouched when no ask part matches', () => {
    const content = [{ type: 'text' } as never, askPart('done')];
    expect(attachAskUserQuestionAnswer(content as never, question as never, 'x')).toBe(content);
  });

  it('targets the payload tool_call_id exactly when provided (multi-ask turn)', () => {
    const first = {
      type: 'tool_call',
      tool_call: { id: 'tc_a', name: 'ask_user_question', args: '' },
    };
    const second = {
      type: 'tool_call',
      tool_call: { id: 'tc_b', name: 'ask_user_question', args: '' },
    };
    const next = attachAskUserQuestionAnswer(
      [first, second] as never,
      question as never,
      'the answer',
      'tc_a',
    );
    expect((next[0] as { tool_call: { output?: string } }).tool_call.output).toBe('the answer');
    expect((next[1] as { tool_call: { output?: string } }).tool_call.output).toBeUndefined();
  });

  it('returns the input untouched when the payload tool_call_id matches no part', () => {
    const content = [askPart()];
    expect(
      attachAskUserQuestionAnswer(content as never, question as never, 'x', 'tc_missing'),
    ).toBe(content);
  });

  it('stamps batched args and structured answers onto one ask tool call', () => {
    const request = {
      questions: [
        { id: 'environment', question: 'Which env?' },
        { id: 'window', question: 'Which window?' },
      ],
    };
    const output = JSON.stringify({ answers: { environment: 'staging', window: '7d' } });
    const next = attachAskUserQuestionAnswer([askPart()] as never, request, output);
    const toolCall = (next[0] as { tool_call: { args: string; output: string } }).tool_call;
    expect(JSON.parse(toolCall.args)).toEqual(request);
    expect(JSON.parse(toolCall.output)).toEqual({
      answers: { environment: 'staging', window: '7d' },
    });
  });
});

describe('durable ask-user answers', () => {
  it('builds a typed stamp from the validated pending action', () => {
    const pendingAction = {
      actionId: 'action-2',
      streamId: 'stream-1',
      createdAt: 1,
      payload: {
        type: 'ask_user_question',
        question: { question: 'Which env?' },
        tool_call_id: 'ask-2',
      },
    } satisfies Agents.PendingAction;

    expect(buildResolvedAskUserQuestion(pendingAction, { answer: 'production' })).toEqual({
      request: { question: 'Which env?' },
      output: 'production',
      toolCallId: 'ask-2',
    });
  });

  it('associates an ID-less answer with its pause-time content slot', () => {
    const pendingAction = {
      actionId: 'action-legacy',
      streamId: 'stream-1',
      createdAt: 1,
      payload: {
        type: 'ask_user_question',
        question: { question: 'Newest?' },
      },
    } satisfies Agents.PendingAction;

    expect(buildResolvedAskUserQuestion(pendingAction, { answer: 'yes' }, 2)).toEqual({
      request: { question: 'Newest?' },
      output: 'yes',
      contentIndex: 2,
    });
  });

  it('marks an ID-less answer whose paused content part was missing', () => {
    const pendingAction = {
      actionId: 'action-missing',
      streamId: 'stream-1',
      createdAt: 1,
      payload: {
        type: 'ask_user_question',
        question: { question: 'Missing?' },
      },
    } satisfies Agents.PendingAction;

    expect(buildResolvedAskUserQuestion(pendingAction, { answer: 'yes' }, undefined, true)).toEqual(
      {
        request: { question: 'Missing?' },
        output: 'yes',
        contentMissing: true,
      },
    );
  });

  it('accumulates exact-ID answers and replaces a repeated tool call', () => {
    const first = { request: 'First?', output: 'one', toolCallId: 'ask-1' };
    const second = { request: 'Second?', output: 'two', toolCallId: 'ask-2' };
    const corrected = { request: 'First?', output: 'corrected', toolCallId: 'ask-1' };

    expect(appendResolvedAskUserQuestion([first, second], corrected)).toEqual([second, corrected]);
  });

  it('reconstructs multiple retained answers in one content pass', () => {
    const content: Array<{
      type: string;
      tool_call: { id: string; name: string; args: string; output?: string };
    }> = [
      { type: 'tool_call', tool_call: { id: 'ask-1', name: 'ask_user_question', args: '' } },
      { type: 'tool_call', tool_call: { id: 'ask-2', name: 'ask_user_question', args: '' } },
    ];
    const next = attachAskUserQuestionAnswers(content, [
      { request: 'First?', output: 'one', toolCallId: 'ask-1' },
      { request: 'Second?', output: 'two', toolCallId: 'ask-2' },
    ]);

    expect(next.map((part) => part.tool_call.output)).toEqual(['one', 'two']);
    expect(next.map((part) => JSON.parse(part.tool_call.args))).toEqual(['First?', 'Second?']);
  });

  it('keeps a legacy answer on the earlier ask when a later ask is unanswered', () => {
    const content: Array<{
      type: string;
      tool_call: { id: string; name: string; args: string; output?: string };
    }> = [
      { type: 'tool_call', tool_call: { id: 'ask-1', name: 'ask_user_question', args: '' } },
      { type: 'tool_call', tool_call: { id: 'ask-2', name: 'ask_user_question', args: '' } },
    ];

    const next = attachAskUserQuestionAnswers(content, [{ request: 'First?', output: 'one' }]);

    expect(next[0].tool_call.output).toBe('one');
    expect(next[1].tool_call.output).toBeUndefined();
  });

  it('targets the pause-time slot when an ID-less action has multiple empty asks', () => {
    const request = { question: 'Newest?' };
    const content: Array<{
      type: string;
      tool_call: { id: string; name: string; args: string; output?: string };
    }> = [
      { type: 'tool_call', tool_call: { id: 'ask-1', name: 'ask_user_question', args: '' } },
      { type: 'tool_call', tool_call: { id: 'ask-2', name: 'ask_user_question', args: '' } },
    ];
    const contentIndex = findAskUserQuestionContentIndex(content, undefined, request);

    const next = attachAskUserQuestionAnswers(content, [{ request, output: 'yes', contentIndex }]);

    expect(contentIndex).toBe(1);
    expect(next[0].tool_call.output).toBeUndefined();
    expect(next[1].tool_call.output).toBe('yes');
  });

  it('consumes a legacy stamp already present on content before a later ask', () => {
    const firstRequest = { question: 'First?' };
    const content = [
      {
        type: 'tool_call',
        tool_call: {
          id: 'ask-1',
          name: 'ask_user_question',
          args: JSON.stringify(firstRequest),
          output: 'one',
        },
      },
      { type: 'tool_call', tool_call: { id: 'ask-2', name: 'ask_user_question', args: '' } },
    ];

    const next = attachAskUserQuestionAnswers(content, [{ request: firstRequest, output: 'one' }]);

    expect(next).toBe(content);
    expect(next[1].tool_call.output).toBeUndefined();
  });

  it('does not slide ambiguous legacy metadata past different answered content', () => {
    const content = [
      {
        type: 'tool_call',
        tool_call: {
          id: 'ask-1',
          name: 'ask_user_question',
          args: JSON.stringify({ question: 'Different?' }),
          output: 'different',
        },
      },
      { type: 'tool_call', tool_call: { id: 'ask-2', name: 'ask_user_question', args: '' } },
    ];

    const next = attachAskUserQuestionAnswers(content, [
      { request: { question: 'First?' }, output: 'one' },
    ]);

    expect(next).toBe(content);
    expect(next[1].tool_call.output).toBeUndefined();
  });

  it('does not bind a missing-content answer to a later ask', () => {
    const content: Array<{
      type: string;
      tool_call: { id: string; name: string; args: string; output?: string };
    }> = [
      { type: 'tool_call', tool_call: { id: 'later-ask', name: 'ask_user_question', args: '' } },
    ];

    const next = attachAskUserQuestionAnswers(content, [
      { request: { question: 'Missing?' }, output: 'old answer', contentMissing: true },
    ]);

    expect(next).toBe(content);
    expect(next[0].tool_call.output).toBeUndefined();
  });
});

describe('attachAskUserQuestionArgs (pause-time stamp)', () => {
  const question = { question: 'Which env?' };
  it('stamps args on the newest empty ask part, pure', () => {
    const content = [
      { type: 'tool_call', tool_call: { id: 'tc1', name: 'ask_user_question', args: '' } },
    ];
    const next = attachAskUserQuestionArgs(content as never, question as never);
    expect(next).not.toBe(content);
    expect(JSON.parse((next[0] as { tool_call: { args: string } }).tool_call.args)).toEqual(
      question,
    );
    expect((content[0] as { tool_call: { args: string } }).tool_call.args).toBe('');
  });
  it('skips parts that already have args or an output', () => {
    const withArgs = [
      { type: 'tool_call', tool_call: { name: 'ask_user_question', args: '{"question":"x"}' } },
    ];
    expect(attachAskUserQuestionArgs(withArgs as never, question as never)).toBe(withArgs);
    const answered = [
      { type: 'tool_call', tool_call: { name: 'ask_user_question', args: '', output: 'done' } },
    ];
    expect(attachAskUserQuestionArgs(answered as never, question as never)).toBe(answered);
  });

  it('targets the payload tool_call_id exactly when provided (multi-ask turn)', () => {
    const content = [
      { type: 'tool_call', tool_call: { id: 'tc_a', name: 'ask_user_question', args: '' } },
      { type: 'tool_call', tool_call: { id: 'tc_b', name: 'ask_user_question', args: '' } },
    ];
    const next = attachAskUserQuestionArgs(content as never, question as never, 'tc_a');
    expect(JSON.parse((next[0] as { tool_call: { args: string } }).tool_call.args)).toEqual(
      question,
    );
    expect((next[1] as { tool_call: { args: string } }).tool_call.args).toBe('');
  });

  it('stamps the complete batched request at pause time', () => {
    const content = [
      { type: 'tool_call', tool_call: { id: 'tc1', name: 'ask_user_question', args: '' } },
    ];
    const request = {
      questions: [
        { id: 'environment', question: 'Which env?' },
        { id: 'window', question: 'Which window?' },
      ],
    };
    const next = attachAskUserQuestionArgs(content as never, request);
    expect(JSON.parse((next[0] as { tool_call: { args: string } }).tool_call.args)).toEqual(
      request,
    );
  });
});
