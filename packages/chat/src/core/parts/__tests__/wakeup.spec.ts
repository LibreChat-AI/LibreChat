import { parseWakeupText, parseWakeupMessage } from '../wakeup';

const subagentText = [
  'A detached subagent task has completed. Continue the parent task using its durable result below.',
  JSON.stringify({
    background_task_id: 'task-1',
    subagent_thread_id: 'thread-1',
    subagent_type: 'self',
    status: 'completed',
    result: '## Daily briefing\nAll clear.',
  }),
  'Host-authored bounded orchestration snapshot:',
  JSON.stringify({ scope: 'current_parent_branch', known_children: [] }),
].join('\n');

const backgroundText = [
  'A background tool task has finished. Continue using its durable result below.',
  JSON.stringify([
    {
      background_task_id: 'bg-1',
      tool_call_id: 'call-1',
      tool: 'web_search',
      status: 'completed',
      result: 'Found 3 sources.',
    },
  ]),
].join('\n');

describe('parseWakeupText', () => {
  it('parses a subagent completion wake-up into one display task', () => {
    const display = parseWakeupText(subagentText);
    expect(display).toEqual({
      kind: 'subagent',
      tasks: [
        {
          taskId: 'task-1',
          status: 'completed',
          result: '## Daily briefing\nAll clear.',
          threadId: 'thread-1',
          subagentType: 'self',
        },
      ],
    });
  });

  it.each(['error', 'cancelled'] as const)('parses a subagent %s wake-up', (status) => {
    const text = [
      `A detached subagent task has ${status}. Continue the parent task using its durable result below.`,
      JSON.stringify({
        background_task_id: 'task-1',
        subagent_thread_id: 'thread-1',
        subagent_type: 'researcher',
        status,
        result: '',
      }),
    ].join('\n');
    expect(parseWakeupText(text)?.tasks[0]?.status).toBe(status);
  });

  it('parses a single background tool wake-up', () => {
    const display = parseWakeupText(backgroundText);
    expect(display).toEqual({
      kind: 'background_tool',
      tasks: [
        {
          taskId: 'bg-1',
          status: 'completed',
          result: 'Found 3 sources.',
          toolCallId: 'call-1',
          toolName: 'web_search',
        },
      ],
    });
  });

  it('parses a cancelled background tool wake-up without exposing its host envelope', () => {
    const text = [
      'A background tool task has finished. Continue using its durable result below.',
      JSON.stringify([
        {
          background_task_id: 'bg-2',
          tool_call_id: 'call-2',
          tool: 'bash_tool',
          status: 'cancelled',
          result: 'Cancelled by the user.',
        },
      ]),
    ].join('\n');
    expect(parseWakeupText(text)).toEqual({
      kind: 'background_tool',
      tasks: [
        {
          taskId: 'bg-2',
          toolCallId: 'call-2',
          toolName: 'bash_tool',
          status: 'cancelled',
          result: 'Cancelled by the user.',
        },
      ],
    });
  });

  it('parses a plural background tool wake-up', () => {
    const text = [
      '2 background tool tasks have finished. Continue using their durable results below.',
      JSON.stringify([
        {
          background_task_id: 'bg-1',
          tool_call_id: 'call-1',
          tool: 'web_search',
          status: 'completed',
          result: 'ok',
        },
        {
          background_task_id: 'bg-2',
          tool_call_id: 'call-2',
          tool: 'execute_code',
          status: 'error',
          result: 'boom',
        },
      ]),
    ].join('\n');
    const display = parseWakeupText(text);
    expect(display?.kind).toBe('background_tool');
    expect(display?.tasks).toHaveLength(2);
    expect(display?.tasks[1]).toMatchObject({ status: 'error', toolName: 'execute_code' });
  });

  it('rejects ordinary user text', () => {
    expect(parseWakeupText('Please summarize the detached subagent task results.')).toBeNull();
    expect(parseWakeupText('')).toBeNull();
    expect(parseWakeupText(undefined)).toBeNull();
  });

  it('rejects a quoted wake-up prompt that does not start the message', () => {
    expect(parseWakeupText(`Look at this:\n${subagentText}`)).toBeNull();
  });

  it('rejects a header whose payload is not valid JSON', () => {
    expect(
      parseWakeupText(
        'A detached subagent task has completed. Continue the parent task using its durable result below.\nnot json',
      ),
    ).toBeNull();
  });

  it('rejects a payload whose status disagrees with the header', () => {
    const text = [
      'A detached subagent task has completed. Continue the parent task using its durable result below.',
      JSON.stringify({
        background_task_id: 'task-1',
        subagent_thread_id: 'thread-1',
        subagent_type: 'self',
        status: 'error',
        result: '',
      }),
    ].join('\n');
    expect(parseWakeupText(text)).toBeNull();
  });

  it('rejects a payload missing required identity fields', () => {
    const text = [
      'A background tool task has finished. Continue using its durable result below.',
      JSON.stringify([{ background_task_id: 'bg-1', status: 'completed', result: 'ok' }]),
    ].join('\n');
    expect(parseWakeupText(text)).toBeNull();
  });

  it('rejects an empty background payload array', () => {
    expect(
      parseWakeupText(
        'A background tool task has finished. Continue using its durable result below.\n[]',
      ),
    ).toBeNull();
  });
});

describe('parseWakeupMessage', () => {
  const at = '2026-11-20T10:00:00.000Z';
  const started = (type: string) => ({ event: { type, occurredAt: at } });
  /** The prose line the model reads, as a later server might word it. */
  const reworded = (text: string) => `A task has settled.\n${text.slice(text.indexOf('\n') + 1)}`;
  const turn = (text: string, type?: string) => ({
    text,
    isCreatedByUser: true,
    ...(type != null && { trigger: started(type) }),
  });

  it.each([
    ['a subagent completion', 'subagent.completion', subagentText],
    ['a background tool completion', 'background-tool.completion', backgroundText],
  ])('draws %s from what started the turn, whatever its header says', (_label, type, text) => {
    const display = parseWakeupMessage(turn(reworded(text), type));

    expect(parseWakeupText(reworded(text))).toBeNull();
    expect(display).toEqual(parseWakeupText(text));
    expect(parseWakeupMessage(turn(text, type))).toEqual(display);
  });

  it('matches a message stored with no record of what started it by its header', () => {
    expect(parseWakeupMessage(turn(subagentText))).toEqual(parseWakeupText(subagentText));
    expect(parseWakeupMessage(turn(backgroundText))?.kind).toBe('background_tool');
    expect(parseWakeupMessage(turn(reworded(subagentText)))).toBeNull();
  });

  it.each(['agent.queued-turn', 'schedule.occurrence', 'review.submitted', 'constructor'])(
    'is not a wake-up when %s started the turn, whatever its text says',
    (type) => {
      expect(parseWakeupMessage(turn(subagentText, type))).toBeNull();
      expect(parseWakeupMessage(turn(backgroundText, type))).toBeNull();
    },
  );

  it('reads the card of the kind that started the turn, not of the kind its text names', () => {
    expect(parseWakeupMessage(turn(subagentText, 'background-tool.completion'))).toBeNull();
    expect(parseWakeupMessage(turn(backgroundText, 'subagent.completion'))).toBeNull();
  });

  it('is not a wake-up when a person submitted the message, with or without a record', () => {
    for (const type of [undefined, 'subagent.completion']) {
      expect(parseWakeupMessage({ ...turn(subagentText, type), isUserSubmitted: true })).toBeNull();
      expect(
        parseWakeupMessage({ ...turn(subagentText, type), isCreatedByUser: false }),
      ).toBeNull();
    }
    expect(parseWakeupMessage(undefined)).toBeNull();
  });

  it('is not a wake-up when a typed message only quotes the header', () => {
    expect(parseWakeupMessage(turn(`Why did I get this?\n${subagentText}`))).toBeNull();
    expect(parseWakeupMessage(turn(subagentText.split('\n')[0]))).toBeNull();
  });

  it('draws nothing from a wake-up whose payload cannot be read', () => {
    expect(parseWakeupMessage(turn('A task has settled.', 'subagent.completion'))).toBeNull();
    expect(
      parseWakeupMessage(turn('A task has settled.\nnot json', 'subagent.completion')),
    ).toBeNull();
    expect(parseWakeupMessage(turn('', 'subagent.completion'))).toBeNull();
    expect(
      parseWakeupMessage(turn('A task has settled.\n[]', 'background-tool.completion')),
    ).toBeNull();
  });
});
