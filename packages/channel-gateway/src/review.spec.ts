import type { ResponseReviewDecision } from 'librechat-data-provider';
import type { ChannelBundle, Review } from './types';
import type { ReviewInteraction } from './review';
import { ReviewFlow, nativeDecision, reviewModal, simpleChoices } from './review';
import { ChannelClient } from './client';
import { loadConfig } from './config';
import { SlackClient } from './slack';

const config = loadConfig({
  CHANNEL_SERVICE_TOKEN: 'test-service',
  CHANNEL_TENANT_ID: 'tenant',
  CHANNEL_ID: 'binding',
});
const bundle: ChannelBundle = {
  channel: {
    channelId: 'binding',
    tenantId: 'tenant',
    agentId: 'agent',
    createdBy: 'owner',
    type: 'slack',
    status: 'active',
    credentialMode: 'per_user',
    revision: 'r1',
    slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
  },
  agent: { id: 'agent' },
  credentials: { botToken: 'test-bot' },
};
const ref = () => ({
  runId: 'run',
  revision: 'r1',
  actionId: 'action',
  channelId: 'C1',
  actorId: 'U1',
  expiresAt: Date.now() + 60000,
});
const interaction = (): ReviewInteraction => ({
  teamId: 'T1',
  appId: 'A1',
  actorId: 'U1',
  channelId: 'C1',
  triggerId: 'trigger',
});
const action = (expiresAt = Date.now() + 60000): NonNullable<Review['pendingAction']> => ({
  actionId: 'action',
  expiresAt,
  payload: {
    type: 'tool_approval',
    action_requests: [{ name: 'read_data', arguments: { table: 'public' }, tool_call_id: 'call' }],
    review_configs: [
      { action_name: 'read_data', tool_call_id: 'call', allowed_decisions: ['approve', 'reject'] },
    ],
  },
});
const question = (expiresAt = Date.now() + 60000): NonNullable<Review['pendingAction']> => ({
  actionId: 'action',
  expiresAt,
  payload: {
    type: 'ask_user_question',
    question: {
      question: 'Which one?',
      options: [
        { label: 'One', value: 'first' },
        { label: 'Two', value: 'second' },
      ],
    },
  },
});
const json = (body: object) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const receipt = () =>
  json({ responseId: 'resp_one', actionId: 'action', intentId: 'intent', status: 'queued' });
function setup() {
  const backend = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  const slack = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockImplementation(async () => json({ ok: true, view: { id: 'view' } }));
  return {
    backend,
    slack,
    flow: new ReviewFlow(
      new ChannelClient(config, backend),
      new SlackClient(config, undefined, slack),
      'LibreChat',
    ),
  };
}
const approvalValues = { tool_0: { decision: { selected_option: { value: 'approve' } } } };
function submission(reference = ref()): ReviewInteraction {
  return {
    ...interaction(),
    view: {
      callbackId: 'channel_native_review',
      privateMetadata: JSON.stringify(reference),
      values: approvalValues,
    },
  };
}

describe('native review rendering and validation', () => {
  test('tool arguments are shown only in a plain-text private modal', () => {
    const reference = ref();
    const modal = reviewModal(reference, action(reference.expiresAt));
    expect(JSON.stringify(modal)).toContain('Arguments:');
    expect(JSON.stringify(modal)).not.toContain('mrkdwn');
    expect(nativeDecision(action(), approvalValues)).toEqual({
      actionId: 'action',
      decisions: [{ tool_call_id: 'call', decision: 'approve', scope: 'once' }],
    });
  });
  test('does not invent unsupported approval decisions', () => {
    const pending = action();
    if (pending.payload.type !== 'tool_approval') throw new Error();
    pending.payload.review_configs[0].allowed_decisions = ['edit', 'respond'];
    expect(reviewModal(ref(), pending)).toBeNull();
    expect(() => nativeDecision(pending, approvalValues)).toThrow();
  });
  test('joins approval configuration by tool call ID, never position', () => {
    const pending = action();
    if (pending.payload.type !== 'tool_approval') throw new Error();
    pending.payload.action_requests.push({
      name: 'read_data',
      arguments: {},
      tool_call_id: 'second',
    });
    pending.payload.review_configs.unshift({
      action_name: 'read_data',
      tool_call_id: 'second',
      allowed_decisions: ['reject'],
    });
    expect(() =>
      nativeDecision(pending, {
        ...approvalValues,
        tool_1: { decision: { selected_option: { value: 'approve' } } },
      }),
    ).toThrow('not allowed');
  });
  test('uses ordinal values but sends the original answer', () => {
    const pending = question();
    expect(simpleChoices(pending)).toBe(true);
    expect(
      nativeDecision(pending, { question_0: { choice: { selected_option: { value: '1' } } } }),
    ).toEqual({ actionId: 'action', answer: 'second' });
    expect(() =>
      nativeDecision(pending, { question_0: { choice: { selected_option: { value: '-1' } } } }),
    ).toThrow();
  });
  test('cannot submit a written and selected answer or repeated single choice', () => {
    expect(() =>
      nativeDecision(question(), {
        question_0_text: { answer: { value: 'text' } },
        question_0: { choice: { selected_option: { value: '0' } } },
      }),
    ).toThrow();
    expect(() =>
      nativeDecision(question(), {
        question_0: { choice: { selected_options: [{ value: '0' }, { value: '1' }] } },
      }),
    ).toThrow();
  });
  test('supports multiple independently keyed questions and multiple selections', () => {
    const pending: NonNullable<Review['pendingAction']> = {
      actionId: 'action',
      expiresAt: ref().expiresAt,
      payload: {
        type: 'ask_user_question',
        question: { question: 'First' },
        questions: [
          { id: 'a', question: 'First' },
          {
            id: 'b',
            question: 'Select',
            multiSelect: true,
            options: [
              { label: '1', value: 'one' },
              { label: '2', value: 'two' },
            ],
          },
        ],
      },
    };
    expect(
      nativeDecision(pending, {
        question_0_text: { answer: { value: 'hello' } },
        question_1: { choice: { selected_options: [{ value: '0' }, { value: '1' }] } },
      }),
    ).toEqual({ actionId: 'action', answers: { a: 'hello', b: 'one, two' } });
    expect(simpleChoices(pending)).toBe(false);
  });
  test('oversized content uses browser fallback instead of truncating a decision', () => {
    const pending = action();
    if (pending.payload.type !== 'tool_approval') throw new Error();
    pending.payload.action_requests[0].arguments = 'a'.repeat(3000);
    expect(reviewModal(ref(), pending)).toBeNull();
  });
});

describe('actor-bound review handling', () => {
  test('propagates the acknowledgement deadline through authorized requests', async () => {
    const { backend, flow } = setup();
    const reference = ref();
    const controller = new AbortController();
    backend
      .mockResolvedValueOnce(
        json({ actionId: 'action', pendingAction: action(reference.expiresAt) }),
      )
      .mockResolvedValueOnce(receipt());
    await flow.submit(submission(reference), bundle, controller.signal);
    const signals = backend.mock.calls.map(([, init]) => init?.signal);
    expect(signals).toHaveLength(2);
    controller.abort();
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
  });

  test('private choice uses the exact authorized option and actor', async () => {
    const { backend, flow } = setup();
    const reference = ref();
    backend
      .mockResolvedValueOnce(
        json({ actionId: 'action', pendingAction: question(reference.expiresAt) }),
      )
      .mockResolvedValueOnce(receipt());
    await flow.choice(JSON.stringify({ ...reference, choice: 1 }), interaction(), bundle);
    expect(JSON.parse(String(backend.mock.calls[1][1]?.body))).toMatchObject({
      actor: { externalUserId: 'U1' },
      externalChannelId: 'C1',
      decision: { actionId: 'action', answer: 'second' },
    });
  });

  test('a choice button cannot replace an already saved decision', async () => {
    const { backend, flow } = setup();
    const reference = ref();
    backend.mockResolvedValueOnce(
      json({
        actionId: 'action',
        pendingAction: question(reference.expiresAt),
        pendingDecision: { intentId: 'intent', decision: { actionId: 'action', answer: 'first' } },
      }),
    );
    await flow.choice(JSON.stringify({ ...reference, choice: 1 }), interaction(), bundle);
    expect(backend).toHaveBeenCalledTimes(1);
  });

  test('a saved intent cannot be swapped or resurrected', async () => {
    const { backend, flow } = setup();
    const reference = { ...ref(), savedIntentId: 'original' };
    backend.mockResolvedValueOnce(
      json({
        actionId: 'action',
        pendingAction: action(reference.expiresAt),
        pendingDecision: { intentId: 'different', decision: { actionId: 'action', decisions: [] } },
      }),
    );
    expect(await flow.submit(submission(reference), bundle)).toMatchObject({
      response_action: 'update',
      view: { title: { text: 'Review unavailable' } },
    });
    expect(backend).toHaveBeenCalledTimes(1);
  });

  test('stale revision prevents cancellation from reaching the backend', async () => {
    const { backend, flow } = setup();
    await flow.control(
      'channel_run_cancel',
      JSON.stringify({ runId: 'run', revision: 'old' }),
      interaction(),
      bundle,
    );
    expect(backend).not.toHaveBeenCalled();
  });

  test('opens the modal only after actor-authorized lookup', async () => {
    const { backend, slack, flow } = setup();
    const reference = ref();
    backend.mockResolvedValueOnce(
      json({
        url: 'https://chat.example/review',
        actionId: 'action',
        pendingAction: action(reference.expiresAt),
      }),
    );
    await flow.control(
      'channel_run_review',
      JSON.stringify({ runId: 'run', revision: 'r1' }),
      interaction(),
      bundle,
    );
    const request = JSON.parse(String(backend.mock.calls[0][1]?.body));
    expect(request).toEqual({
      actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
      revision: 'r1',
      externalChannelId: 'C1',
    });
    expect(String(slack.mock.calls[0][0])).toContain('views.open');
  });
  test.each(['teamId', 'appId'] as const)('foreign %s never reaches backend', async (field) => {
    const { backend, flow } = setup();
    const wrong = interaction();
    wrong[field] = 'foreign';
    await expect(
      flow.control(
        'channel_run_review',
        JSON.stringify({ runId: 'run', revision: 'r1' }),
        wrong,
        bundle,
      ),
    ).rejects.toThrow();
    expect(backend).not.toHaveBeenCalled();
  });
  test('foreign actor metadata never reaches backend', async () => {
    const { backend, flow } = setup();
    expect(await flow.submit(submission({ ...ref(), actorId: 'other' }), bundle)).toMatchObject({
      response_action: 'update',
      view: { title: { text: 'Review unavailable' } },
    });
    expect(backend).not.toHaveBeenCalled();
  });
  test('expired or changed action cannot be submitted', async () => {
    const { backend, flow } = setup();
    const reference = ref();
    backend.mockResolvedValueOnce(
      json({ actionId: 'other', pendingAction: action(reference.expiresAt) }),
    );
    expect(await flow.submit(submission(reference), bundle)).toMatchObject({
      response_action: 'update',
    });
    expect(backend).toHaveBeenCalledTimes(1);
  });
  test('accepted decision clears modal, without falsely claiming execution', async () => {
    const { backend, slack, flow } = setup();
    const reference = ref();
    backend
      .mockResolvedValueOnce(
        json({ actionId: 'action', pendingAction: action(reference.expiresAt) }),
      )
      .mockResolvedValueOnce(receipt());
    expect(await flow.submit(submission(reference), bundle)).toEqual({ response_action: 'clear' });
    const payload = new URLSearchParams(String(slack.mock.calls[0]?.[1]?.body));
    expect(payload.get('text')).toBe('Tool call approved.');
    expect(payload.get('text')).not.toContain('completed');
  });
  test('saved decision replaces stale editable modal before any retry', async () => {
    const { backend, flow } = setup();
    const reference = ref();
    const saved: ResponseReviewDecision = {
      actionId: 'action',
      decisions: [{ tool_call_id: 'call', decision: 'reject', scope: 'once' }],
    };
    backend.mockResolvedValueOnce(
      json({
        actionId: 'action',
        pendingAction: action(reference.expiresAt),
        pendingDecision: { intentId: 'intent', decision: saved },
      }),
    );
    const result = await flow.submit(submission(reference), bundle);
    expect(result).toMatchObject({
      response_action: 'update',
      view: { submit: { text: 'Retry continuation' } },
    });
    expect(JSON.stringify(result)).toContain('Tool call declined');
    expect(backend).toHaveBeenCalledTimes(1);
  });
  test('retry sends the immutable saved decision, ignoring edited form state', async () => {
    const { backend, flow } = setup();
    const reference = { ...ref(), savedIntentId: 'intent' };
    const saved: ResponseReviewDecision = {
      actionId: 'action',
      decisions: [{ tool_call_id: 'call', decision: 'reject', scope: 'once' }],
    };
    backend
      .mockResolvedValueOnce(
        json({
          actionId: 'action',
          pendingAction: action(reference.expiresAt),
          pendingDecision: { intentId: 'intent', decision: saved },
        }),
      )
      .mockResolvedValueOnce(receipt());
    expect(await flow.submit(submission(reference), bundle)).toEqual({ response_action: 'clear' });
    expect(JSON.parse(String(backend.mock.calls[1][1]?.body)).decision).toEqual(saved);
  });
  test('ambiguous submission failure reports uncertainty and no raw error', async () => {
    const { backend, flow } = setup();
    const reference = ref();
    backend
      .mockResolvedValueOnce(
        json({ actionId: 'action', pendingAction: action(reference.expiresAt) }),
      )
      .mockRejectedValueOnce(new Error('private key credentials'));
    const result = await flow.submit(submission(reference), bundle);
    expect(result).toMatchObject({
      response_action: 'update',
      view: { title: { text: 'Submission unconfirmed' } },
    });
    expect(JSON.stringify(result)).not.toContain('private key');
  });
  test('OAuth review falls back to a private configurable link, never posting auth URL', async () => {
    const { backend, slack, flow } = setup();
    backend.mockResolvedValueOnce(json({ actionId: 'oauth', url: 'https://chat.example/review' }));
    await flow.control(
      'channel_run_review',
      JSON.stringify({ runId: 'run', revision: 'r1' }),
      interaction(),
      bundle,
    );
    expect(String(slack.mock.calls[0][0])).toContain('chat.postEphemeral');
    const payload = new URLSearchParams(String(slack.mock.calls[0][1]?.body));
    expect(payload.get('blocks')).toContain('Review in LibreChat');
  });
});
