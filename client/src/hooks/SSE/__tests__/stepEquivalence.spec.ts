import React from 'react';
import { createHash } from 'crypto';
import { RecoilRoot } from 'recoil';
import { createStore, Provider } from 'jotai';
import { renderHook, act } from '@testing-library/react';
import {
  Constants,
  StepTypes,
  StepEvents,
  ContentTypes,
  ToolCallTypes,
} from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  EventSubmission,
  PtcToolCallEvent,
  SubagentUpdateEvent,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { StepEvent } from '@librechat/chat';
import {
  subagentProgressKey,
  subagentProgressByToolCallId,
  takeRegisteredSubagentProgressKeys,
  subagentParentStreamOpenByToolCallId,
} from '~/components/Chat/Subagents/state';
import { ptcTraceByToolCallId, ptcTraceKey } from '~/hooks/SSE/ptc';
import { sandboxStartingByToolCallId } from '~/hooks/SSE/sandbox';
import useStepHandler from '~/hooks/SSE/useStepHandler';

/**
 * Equivalence table for the step reducer. Each row is an event sequence shaped like a recorded
 * agent stream, with the frame boundaries and run-boundary calls the SSE hooks make. The digest
 * pins what the pre-reducer `stepHandler` produced for the row on every channel it writes: each
 * message-list write, each announcement, each host callback, and the live-status atoms. The
 * digests were recorded by running that handler side by side with this binding and requiring
 * equal logs, so a row whose digest moves changed observable behavior.
 */

const PRELIM: string = Constants.USE_PRELIM_RESPONSE_MESSAGE_ID;
const SUBAGENT: string = Constants.SUBAGENT;

type Step =
  | StepEvent
  | { frame: true }
  | { sync: TMessage }
  | { call: 'clearStepMaps' | 'flushPendingDeltas' | 'cancelPendingDeltaFlush' | 'prunePtcTraces' };

type Row = {
  name: string;
  submission?: Partial<EventSubmission>;
  cache?: TMessage[];
  steps: Step[];
  sandbox?: string[];
  ptc?: Array<[string, string]>;
  subagents?: string[];
  digest: string;
};

const user = (overrides: Partial<TMessage> = {}): TMessage => ({
  messageId: 'user-1',
  conversationId: 'conv-1',
  parentMessageId: Constants.NO_PARENT as string,
  isCreatedByUser: true,
  text: 'Hello',
  sender: 'User',
  ...overrides,
});

const response = (overrides: Partial<TMessage> = {}): TMessage => ({
  messageId: 'resp-1',
  conversationId: 'conv-1',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  text: '',
  sender: 'Assistant',
  content: [],
  ...overrides,
});

const textStep = (id: string, index: number, runId = 'resp-1'): StepEvent => ({
  event: StepEvents.ON_RUN_STEP,
  data: {
    id,
    runId,
    index,
    type: StepTypes.MESSAGE_CREATION,
    stepDetails: { type: StepTypes.MESSAGE_CREATION, message_creation: { message_id: id } },
    usage: null,
  },
});

const toolStep = (
  id: string,
  index: number,
  calls: Array<{ id: string; name: string; args?: string }>,
  overrides: Partial<Agents.RunStep> = {},
): StepEvent => ({
  event: StepEvents.ON_RUN_STEP,
  data: {
    id,
    runId: 'resp-1',
    index,
    type: StepTypes.TOOL_CALLS,
    stepDetails: {
      type: StepTypes.TOOL_CALLS,
      tool_calls: calls.map((call) => ({
        args: '',
        ...call,
        type: ToolCallTypes.TOOL_CALL,
      })),
    },
    usage: null,
    ...overrides,
  },
});

const text = (id: string, value: string): StepEvent => ({
  event: StepEvents.ON_MESSAGE_DELTA,
  data: { id, delta: { content: [{ type: ContentTypes.TEXT, text: value }] } },
});

const think = (id: string, value: string): StepEvent => ({
  event: StepEvents.ON_REASONING_DELTA,
  data: { id, delta: { content: [{ type: ContentTypes.THINK, think: value }] } },
});

const args = (id: string, callId: string | undefined, value: string, at?: number): StepEvent => ({
  event: StepEvents.ON_RUN_STEP_DELTA,
  data: {
    id,
    ...(at != null ? { observed_at: at } : {}),
    delta: {
      type: StepTypes.TOOL_CALLS,
      tool_calls: [{ ...(callId ? { id: callId } : {}), index: 0, args: value }],
    },
  },
});

const completed = (
  id: string,
  call: { id: string; name: string; args: string; output: string },
  at?: number,
): StepEvent => ({
  event: StepEvents.ON_RUN_STEP_COMPLETED,
  data: {
    result: { id, index: 0, ...(at != null ? { completed_at: at } : {}), tool_call: call },
  } as { result: Agents.ToolEndEvent },
});

const closed = (id: string, index: number): StepEvent => ({
  event: StepEvents.ON_RUN_STEP_CLOSED,
  data: { id, index, status: 'completed' } as Agents.RunStepClosedEvent,
});

const subagent = (overrides: Partial<SubagentUpdateEvent>): StepEvent => ({
  event: StepEvents.ON_SUBAGENT_UPDATE,
  data: {
    runId: 'resp-1',
    subagentRunId: 'child-1',
    subagentType: 'self',
    subagentAgentId: 'child-agent',
    parentAgentId: 'parent-agent',
    phase: 'start',
    label: 'started',
    timestamp: '2026-10-11T00:00:00.000Z',
    ...overrides,
  } as SubagentUpdateEvent,
});

const ptc = (overrides: Partial<PtcToolCallEvent>): StepEvent => ({
  event: StepEvents.ON_PTC_TOOL_CALL,
  data: {
    tool_call_id: 'call_ptc',
    call_id: 'call_ptc:0',
    name: 'read_file',
    status: 'running',
    runId: 'resp-1',
    ...overrides,
  },
});

const subagentPart = (id: string): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    tool_call: { id, name: SUBAGENT, args: '{}', type: ToolCallTypes.TOOL_CALL },
  }) as TMessageContentParts;

const summaryStep = (id: string, index: number): StepEvent => {
  const step = textStep(id, index) as Extract<StepEvent, { event: StepEvents.ON_RUN_STEP }>;
  return {
    event: StepEvents.ON_RUN_STEP,
    data: {
      ...step.data,
      summary: { type: ContentTypes.SUMMARY, model: 'm', provider: 'p' },
    } as Agents.RunStep,
  };
};

const summaryDelta = (id: string, value: string): StepEvent => ({
  event: StepEvents.ON_SUMMARIZE_DELTA,
  data: {
    id,
    delta: { summary: { type: ContentTypes.SUMMARY, content: [{ type: 'text', text: value }] } },
  } as unknown as Agents.SummarizeDeltaEvent,
});

const rows: Row[] = [
  {
    name: 'streams reasoning then text, coalesced per frame',
    cache: [user()],
    steps: [
      textStep('s1', 0),
      think('s1', 'Let me'),
      think('s1', ' think'),
      { frame: true },
      textStep('s2', 1),
      text('s2', 'Hel'),
      text('s2', 'lo'),
      { frame: true },
      text('s2', '!'),
      { call: 'flushPendingDeltas' },
      { frame: true },
    ],
    digest: '078e3ccb88c2a351',
  },
  {
    name: 'replays deltas that arrive before their run step',
    cache: [user()],
    steps: [
      text('s1', 'early'),
      args('t1', 'call-1', '{"q":', 50),
      completed('t1', { id: 'call-1', name: 'search', args: '{"q":1}', output: 'ok' }, 90),
      textStep('s1', 0),
      toolStep('t1', 1, [{ id: 'call-1', name: 'search' }]),
      { frame: true },
    ],
    digest: 'b11e5d4a36c3f25d',
  },
  {
    name: 'times a tool call from preparation to close',
    cache: [user()],
    steps: [
      {
        event: StepEvents.ON_TOOL_PREPARATION,
        data: { id: 't1', index: 0, observed_at: 100 },
      },
      toolStep('t1', 0, [{ id: 'call-1', name: 'execute_code' }]),
      args('t1', undefined, '{"code":', 120),
      args('t1', 'call-1', '"1+1"}', 130),
      {
        event: StepEvents.ON_TOOL_CALLS_DISPATCHED,
        data: {
          dispatched_at: 150,
          toolCalls: [{ id: 'call-1', name: 'execute_code', stepId: 't1' }],
        },
      },
      { event: StepEvents.ON_SANDBOX_STARTING, data: { tool_call_id: 'call-1' } },
      { event: StepEvents.ON_SANDBOX_STARTING, data: { tool_call_id: 'call-2' } },
      completed('t1', { id: 'call-1', name: 'execute_code', args: '{}', output: '2' }, 400),
      closed('t1', 0),
    ],
    sandbox: ['call-1', 'call-2'],
    digest: '43800a3620d7f481',
  },
  {
    name: 'reports a skill file authored by a tool call',
    cache: [user()],
    steps: [
      toolStep('t1', 0, [{ id: 'call-1', name: 'create_file' }]),
      completed('t1', {
        id: 'call-1',
        name: 'create_file',
        args: '{"file_path":"skills/demo/SKILL.md"}',
        output: 'written',
      }),
    ],
    digest: '3655708ced395a6c',
  },
  {
    name: 'regenerates an earlier branch through the preliminary id',
    submission: {
      isRegenerate: true,
      userMessage: user({ responseMessageId: 'resp-old' }),
      initialResponse: response({ messageId: 'resp-old_', parentMessageId: 'user-1' }),
      messages: [
        user(),
        response({ messageId: 'resp-old', text: 'old' }),
        user({ messageId: 'user-2', parentMessageId: 'resp-old' }),
        response({ messageId: 'resp-2', parentMessageId: 'user-2' }),
      ],
    },
    steps: [textStep('s1', 0, PRELIM), text('s1', 'again'), { frame: true }],
    digest: '55ebe9bf5b9df0ea',
  },
  {
    name: 'continues an edit after its retained prefix',
    cache: [user()],
    submission: {
      editedContent: { index: 0, type: ContentTypes.TEXT, text: 'kept' },
      editPrefixLength: 1,
      initialResponse: response({ content: [{ type: ContentTypes.TEXT, text: 'kept' }] }),
    } as Partial<EventSubmission>,
    steps: [
      textStep('s1', 0),
      text('s1', ' and more'),
      { frame: true },
      toolStep('t1', 1, [{ id: 'call-1', name: 'search' }]),
      textStep('s2', 2),
      text('s2', 'tail'),
      { frame: true },
    ],
    digest: 'bcf040ec24e470fc',
  },
  {
    name: 'streams and settles a summary',
    cache: [user()],
    steps: [
      { event: StepEvents.ON_SUMMARIZE_START, data: { agentId: 'a1' } } as StepEvent,
      summaryStep('sum1', 0),
      summaryDelta('sum1', 'Earlier, '),
      summaryDelta('sum1', 'we talked.'),
      { frame: true },
      {
        event: StepEvents.ON_SUMMARIZE_COMPLETE,
        data: {
          id: 'sum1',
          agentId: 'a1',
          summary: {
            type: ContentTypes.SUMMARY,
            content: [{ type: 'text', text: 'Earlier, we talked.' }],
          },
        },
      } as StepEvent,
    ],
    digest: '141779fddd2f4add',
  },
  {
    name: 'announces a failed summary',
    cache: [user()],
    steps: [
      summaryStep('sum1', 0),
      {
        event: StepEvents.ON_SUMMARIZE_COMPLETE,
        data: { id: 'sum1', agentId: 'a1', error: 'boom' },
      } as StepEvent,
    ],
    digest: 'f63470a3394dbd94',
  },
  {
    name: 'records an agent handoff',
    cache: [user()],
    steps: [
      textStep('s1', 0),
      {
        event: StepEvents.ON_AGENT_UPDATE,
        data: {
          type: ContentTypes.AGENT_UPDATE,
          agent_update: { runId: 'resp-1', index: 1, agentId: 'agent-2' },
        },
      },
    ],
    digest: '48f03bdf6613a5f0',
  },
  {
    name: 'routes subagent envelopes to their parent occurrence',
    cache: [user()],
    steps: [
      subagent({ phase: 'start', label: 'a' }),
      toolStep('t1', 0, [{ id: 'call-sub', name: SUBAGENT }]),
      subagent({ phase: 'run_step_delta' as SubagentUpdateEvent['phase'], label: 'b' }),
      subagent({ phase: 'stop', label: 'c' }),
      subagent({ subagentRunId: 'child-2', runId: 'resp-2', phase: 'start', label: 'd' }),
      { sync: response({ messageId: 'resp-2', content: [subagentPart('call-sub-2')] }) },
      { call: 'clearStepMaps' },
    ],
    subagents: [
      subagentProgressKey('resp-1', 'call-sub', 0),
      subagentProgressKey('resp-2', 'call-sub-2', 0),
    ],
    digest: '4e5902ea8131cf80',
  },
  {
    name: 'folds a programmatic tool-call trace and settles it across a gap',
    steps: [
      ptc({ call_id: 'c:0', args: 'a' }),
      ptc({ call_id: 'c:1' }),
      ptc({ call_id: 'c:0', status: 'success', durationMs: 5 }),
      ptc({ call_id: 'c:9', status: 'error', error: 'late' }),
      ptc({ call_id: 'c:2', runId: PRELIM }),
      { call: 'prunePtcTraces' },
    ],
    submission: { initialResponse: response({ messageId: 'resp-prelim' }) },
    ptc: [
      ['resp-1', 'call_ptc'],
      ['resp-prelim', 'call_ptc'],
    ],
    digest: '9d1bb17142716632',
  },
  {
    name: 'restores a user turn missing from another tab',
    submission: { initialResponse: response({ messageId: 'resp-placeholder' }) },
    cache: [
      user({ messageId: 'user-0' }),
      response({ messageId: 'resp-abandoned', parentMessageId: 'user-1' }),
      response({ messageId: 'resp-placeholder', parentMessageId: 'user-1' }),
    ],
    steps: [textStep('s1', 0), text('s1', 'hi'), { frame: true }],
    digest: '2196daeec40a5ec4',
  },
  {
    name: 'keeps the compaction anchor of a compact regenerate',
    submission: {
      isRegenerate: true,
      compact: true,
      userMessage: user({ messageId: 'anchor', isCreatedByUser: false }),
      initialResponse: response({ messageId: 'anchor_', parentMessageId: 'anchor' }),
      messages: [user(), response({ messageId: 'anchor', parentMessageId: 'user-1' })],
    },
    steps: [summaryStep('sum1', 0), summaryDelta('sum1', 'short'), { frame: true }],
    digest: 'bec603f100020017',
  },
  {
    name: 'drops a queued flush at an abort boundary',
    cache: [user()],
    steps: [
      textStep('s1', 0),
      text('s1', 'partial'),
      { call: 'cancelPendingDeltaFlush' },
      { frame: true },
      { call: 'clearStepMaps' },
      text('s1', 'orphan'),
      textStep('s1', 0),
      { frame: true },
    ],
    digest: '3e9b683cabfffbcc',
  },
];

function run(hook: typeof useStepHandler, row: Row) {
  takeRegisteredSubagentProgressKeys();
  const store = createStore();
  let cache: TMessage[] = row.cache ?? [];
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.set(nextFrame, cb);
    return nextFrame++;
  });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  const runFrames = () => {
    const queued = [...frames.values()];
    frames.clear();
    queued.forEach((cb) => cb(0));
  };

  const log = {
    writes: [] as string[],
    announcements: [] as string[],
    callbacks: [] as string[],
    atoms: {} as Record<string, unknown>,
  };
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(RecoilRoot, null, React.createElement(Provider, { store }, children));
  const { result } = renderHook(
    () => ({
      handler: hook({
        setMessages: (messages) => {
          cache = messages;
          log.writes.push(JSON.stringify(messages));
        },
        getMessages: () => cache,
        announcePolite: (options) => log.announcements.push(JSON.stringify(options)),
        lastAnnouncementTimeRef: { current: 0 },
        onSkillAuthoringComplete: () => log.callbacks.push('skill'),
        onSubagentIndexChange: (id) => log.callbacks.push(`subagent-index:${id}`),
      }),
      readPtc: (key: string) => store.get(ptcTraceByToolCallId(key)),
    }),
    { wrapper },
  );

  const submission = {
    userMessage: user(),
    isRegenerate: false,
    isTemporary: false,
    messages: [],
    conversation: { conversationId: 'conv-1' },
    endpointOption: {},
    initialResponse: response(),
    ...row.submission,
  } as unknown as EventSubmission;

  act(() => {
    for (const step of row.steps) {
      if ('frame' in step) {
        runFrames();
      } else if ('sync' in step) {
        result.current.handler.syncStepMessage(step.sync);
      } else if ('call' in step) {
        result.current.handler[step.call]();
      } else {
        result.current.handler.stepHandler(step, submission);
      }
    }
    runFrames();
  });

  for (const id of row.sandbox ?? []) {
    log.atoms[`sandbox:${id}`] = store.get(sandboxStartingByToolCallId(id));
  }
  for (const [messageId, toolCallId] of row.ptc ?? []) {
    log.atoms[`ptc:${messageId}`] = result.current.readPtc(ptcTraceKey(messageId, toolCallId));
  }
  for (const key of row.subagents ?? []) {
    log.atoms[`subagent:${key}`] = [
      store.get(subagentParentStreamOpenByToolCallId(key)),
      store.get(subagentProgressByToolCallId(key)),
    ];
  }
  jest.restoreAllMocks();
  return log;
}

const digest = (log: ReturnType<typeof run>) =>
  createHash('sha256').update(JSON.stringify(log)).digest('hex').slice(0, 16);

describe('step reducer equivalence', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  it.each(rows.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    const log = run(useStepHandler, row);
    expect(
      log.writes.length + log.callbacks.length + Object.keys(log.atoms).length,
    ).toBeGreaterThan(0);
    expect(digest(log)).toBe(row.digest);
  });
});
