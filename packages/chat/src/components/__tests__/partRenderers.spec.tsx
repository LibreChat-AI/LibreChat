/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render } from '@testing-library/react';
import { Tools, Constants, ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { extendPartRenderers, partRenderers } from '../partRenderers';
import { Part } from '../Part';

function mockStub(testId: string) {
  return function Stub() {
    return <div data-testid={testId} />;
  };
}

function mockPassthrough({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

jest.mock('../parts/ImageGen', () => ({ __esModule: true, default: mockStub('image-gen') }));
jest.mock('../parts/ExecuteCode', () => ({ __esModule: true, default: mockStub('execute-code') }));
jest.mock('../AgentUpdate', () => ({ __esModule: true, default: mockStub('agent-update') }));
jest.mock('../EmptyText', () => ({ __esModule: true, default: mockStub('empty-text') }));
jest.mock('../parts/Reasoning', () => ({
  __esModule: true,
  default: mockStub('reasoning'),
  ReasoningMarker: mockStub('reasoning-marker'),
}));
jest.mock('../Summary', () => ({ __esModule: true, default: mockStub('summary') }));
jest.mock('../Text', () => ({ __esModule: true, default: mockStub('text') }));
jest.mock('../parts/SkillCall', () => ({ __esModule: true, default: mockStub('skill-call') }));
jest.mock('../parts/MemoryCall', () => ({ __esModule: true, default: mockStub('memory-call') }));
jest.mock('../parts/ReadFileCall', () => ({
  __esModule: true,
  default: mockStub('read-file-call'),
}));
jest.mock('../parts/FileAuthoringCall', () => ({
  __esModule: true,
  default: mockStub('file-authoring-call'),
}));
jest.mock('../parts/BashCall', () => ({ __esModule: true, default: mockStub('bash-call') }));
jest.mock('../parts/SteerPart', () => ({ __esModule: true, default: mockStub('steer-part') }));
jest.mock('../parts/BackgroundTaskCall', () => ({
  __esModule: true,
  default: mockStub('background-task-call'),
}));
jest.mock('../parts/Retrieval', () => ({ __esModule: true, default: mockStub('retrieval-call') }));
jest.mock('../parts/AgentHandoff', () => ({
  __esModule: true,
  default: mockStub('agent-handoff'),
}));
jest.mock('../parts/CodeAnalyze', () => ({ __esModule: true, default: mockStub('code-analyze') }));
jest.mock('../parts/Image', () => ({ __esModule: true, default: mockStub('image') }));
jest.mock('../parts/Container', () => ({ __esModule: true, default: mockPassthrough }));
jest.mock('../parts/preparation', () => ({
  ...jest.requireActual('../parts/preparation'),
  ToolPreparation: mockPassthrough,
}));
jest.mock('../parts/ToolCall', () => ({ __esModule: true, default: mockStub('tool-call') }));
/** The props the package's subagent card was last drawn with. */
let mockSubagentProps: Record<string, unknown> | undefined;
jest.mock('../parts/SubagentCall', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockSubagentProps = props;
    return <div data-testid="subagent-call" />;
  },
}));
jest.mock('../parts/WebSearch', () => ({
  __esModule: true,
  WebSearchCall: mockStub('web-search'),
}));
jest.mock('../errors/ErrorMessage', () => ({
  __esModule: true,
  default: ({ text, className }: { text: string; className?: string }) => (
    <div data-testid="error-message" data-text={text} className={className} />
  ),
}));
jest.mock('../parts/ask/Call', () => ({
  __esModule: true,
  default: mockStub('ask-user-question-call'),
}));
jest.mock('../approval/hosted', () => ({
  HostedQuestion: ({ actionId, question }: { actionId: string; question: string }) => (
    <div data-testid="paused-question" data-action-id={actionId}>
      {question}
    </div>
  ),
  HostedToolApproval: ({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="tool-approval" data-tool-call-id={toolCallId} />
  ),
}));

/** What `Part` drew: the stubbed component's test id, or the text of an inline element. */
const drawn = (part: TMessageContentParts): string | null => {
  const { container, unmount } = render(
    <Part part={part} isSubmitting={false} showCursor={false} isCreatedByUser={false} />,
  );
  const element = container.firstElementChild;
  const result = element?.getAttribute('data-testid') ?? element?.textContent ?? null;
  unmount();
  return result;
};

const asPart = (part: Record<string, unknown>) => part as unknown as TMessageContentParts;

const agentCall = (name: string, args = '{}') =>
  asPart({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: { id: 'call_1', name, args, output: 'done', progress: 1 },
  });

const assistantsCall = (toolCall: Record<string, unknown>) =>
  asPart({ type: ContentTypes.TOOL_CALL, [ContentTypes.TOOL_CALL]: { progress: 1, ...toolCall } });

const INHERITED = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];

/** Every branch of the switch `Part` replaced, with the component that branch drew. */
const PART_TYPES: [string, TMessageContentParts, string | null][] = [
  ['steer', asPart({ type: ContentTypes.STEER, [ContentTypes.STEER]: 'go' }), 'steer-part'],
  ['error', asPart({ type: ContentTypes.ERROR, [ContentTypes.ERROR]: 'bad' }), 'error-message'],
  [
    'agent update',
    asPart({ type: ContentTypes.AGENT_UPDATE, [ContentTypes.AGENT_UPDATE]: { agentId: 'a' } }),
    'agent-update',
  ],
  ['text', asPart({ type: ContentTypes.TEXT, text: 'hello' }), 'text'],
  ['text without a string', asPart({ type: ContentTypes.TEXT }), null],
  ['reasoning', asPart({ type: ContentTypes.THINK, think: 'hmm' }), 'reasoning'],
  [
    'unavailable reasoning',
    asPart({ type: ContentTypes.THINK, think: '', reasoning_unavailable: true }),
    'reasoning-marker',
  ],
  ['summary', asPart({ type: ContentTypes.SUMMARY, content: [] }), 'summary'],
  [
    'activity label',
    asPart({ type: ContentTypes.ACTIVITY_LABEL, [ContentTypes.ACTIVITY_LABEL]: 'Searched' }),
    'Searched',
  ],
  ['empty activity label', asPart({ type: ContentTypes.ACTIVITY_LABEL }), null],
  [
    'image file',
    asPart({ type: ContentTypes.IMAGE_FILE, [ContentTypes.IMAGE_FILE]: { filepath: '/a.png' } }),
    'image',
  ],
  [
    'ask user question',
    asPart({
      type: 'ask_user_question',
      ask_user_question: { actionId: 'action-1', question: 'Which?' },
    }),
    /** A paused question is claimed before routing and answered in its own card. */
    'paused-question',
  ],
  [
    'code interpreter call',
    assistantsCall({
      type: ToolCallTypes.CODE_INTERPRETER,
      [ToolCallTypes.CODE_INTERPRETER]: { input: '', outputs: [] },
    }),
    'code-analyze',
  ],
  ['retrieval call', assistantsCall({ type: ToolCallTypes.RETRIEVAL }), 'retrieval-call'],
  ['file search call', assistantsCall({ type: ToolCallTypes.FILE_SEARCH }), 'retrieval-call'],
  [
    'image function call',
    assistantsCall({
      type: ToolCallTypes.FUNCTION,
      function: { name: 'dalle', arguments: '{}', output: 'ok' },
    }),
    'image-gen',
  ],
  [
    'function call',
    assistantsCall({
      type: ToolCallTypes.FUNCTION,
      function: { name: 'lookup', arguments: '{}', output: 'ok' },
    }),
    'tool-call',
  ],
  ['unknown type', asPart({ type: 'not_a_part' }), null],
  ...INHERITED.map((type): [string, TMessageContentParts, null] => [
    `inherited ${type}`,
    asPart({ type }),
    null,
  ]),
];

/** Every agent tool name the switch named, with the card it drew. */
const TOOL_NAMES: [string, string, string][] = [
  [Tools.execute_code, '{}', 'execute-code'],
  [
    Constants.PROGRAMMATIC_TOOL_CALLING as string,
    '{"lang":"py","code":"print(1)"}',
    'execute-code',
  ],
  [Constants.PROGRAMMATIC_TOOL_CALLING as string, '{"code":"echo hi"}', 'bash-call'],
  [Constants.BASH_PROGRAMMATIC_TOOL_CALLING as string, '{"code":"echo hi"}', 'bash-call'],
  ['image_gen_oai', '{}', 'image-gen'],
  ['image_edit_oai', '{}', 'image-gen'],
  ['gemini_image_gen', '{}', 'image-gen'],
  ['ask_user_question', '{}', 'ask-user-question-call'],
  [Constants.CHECK_BACKGROUND_TASK as string, '{}', 'background-task-call'],
  ['skill', '{}', 'skill-call'],
  [Constants.SUBAGENT as string, '{}', 'subagent-call'],
  ['set_memory', '{}', 'memory-call'],
  ['delete_memory', '{}', 'memory-call'],
  ['read_file', '{}', 'read-file-call'],
  ['create_file', '{}', 'file-authoring-call'],
  ['edit_file', '{}', 'file-authoring-call'],
  [Tools.bash_tool, '{}', 'bash-call'],
  [Tools.web_search, '{}', 'web-search'],
  ['file_search', '{}', 'retrieval-call'],
  ['retrieval', '{}', 'retrieval-call'],
  [`${Constants.LC_TRANSFER_TO_}research`, '{}', 'agent-handoff'],
  ['some_mcp_tool', '{}', 'tool-call'],
  ...INHERITED.map((name): [string, string, string] => [name, '{}', 'tool-call']),
];

describe('the package’s part renderers', () => {
  it.each(PART_TYPES)('routes the %s part to the same component', (_label, part, expected) => {
    expect(drawn(part)).toBe(expected);
  });

  it.each(TOOL_NAMES)('routes a %s call with args %s to the same card', (name, args, expected) => {
    expect(drawn(agentCall(name, args))).toBe(expected);
  });
});

describe('the package’s subagent card', () => {
  it('is given what the call carries: its saved activity, its preview and its identity', () => {
    const saved = [{ type: ContentTypes.TEXT, text: 'child reply' }];
    const identity = { subagentKind: 'agent', subagentAgentId: 'agent_child' };
    drawn(
      asPart({
        type: ContentTypes.TOOL_CALL,
        agentId: 'agent_parent',
        [ContentTypes.TOOL_CALL]: {
          id: 'call_sub',
          name: Constants.SUBAGENT,
          args: '{"subagent_type":"agent_child"}',
          output: 'done',
          progress: 1,
          stepId: 'step_1',
          subagent_content: saved,
          subagentIdentity: identity,
          subagentContentOmitted: true,
          previewRevision: 'rev-1',
        },
      }),
    );

    expect(mockSubagentProps).toMatchObject({
      toolCallId: 'call_sub',
      args: '{"subagent_type":"agent_child"}',
      output: 'done',
      initialProgress: 1,
      persistedContent: saved,
      subagentIdentity: identity,
      contentPreview: { stepId: 'step_1', agentId: 'agent_parent' },
    });
    expect((mockSubagentProps?.contentPreview as { revision: string }).revision).toMatch(/^rev-1:/);
  });

  it('passes no preview for a call the server sent whole', () => {
    drawn(agentCall(Constants.SUBAGENT as string));
    expect(mockSubagentProps?.contentPreview).toBeUndefined();
    expect(mockSubagentProps?.toolCallId).toBe('call_1');
  });
});

describe('the package’s error part', () => {
  const errorText = (part: Record<string, unknown>) => {
    const { container, unmount } = render(
      <Part
        part={asPart({ type: ContentTypes.ERROR, ...part })}
        isSubmitting={false}
        showCursor={false}
        isCreatedByUser={false}
      />,
    );
    const element = container.querySelector('[data-testid="error-message"]');
    const result = [element?.getAttribute('data-text'), element?.className];
    unmount();
    return result;
  };

  it('draws the error message with the part’s error text, set apart from its neighbors', () => {
    expect(errorText({ [ContentTypes.ERROR]: 'bad' })).toEqual(['bad', 'my-2']);
  });

  it('falls back to the part’s text, plain or wrapped, and to nothing', () => {
    expect(errorText({ text: 'plain' })[0]).toBe('plain');
    expect(errorText({ text: { value: 'wrapped' } })[0]).toBe('wrapped');
    expect(errorText({})[0]).toBe('');
  });
});

describe('paused tool calls and questions', () => {
  const pausedCall = (toolCall: Record<string, unknown>) =>
    asPart({
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 'call_1',
        name: 'some_mcp_tool',
        args: '{}',
        output: '',
        progress: 0.1,
        ...toolCall,
      },
    });
  const draw = (part: TMessageContentParts) =>
    render(<Part part={part} isSubmitting={false} showCursor={false} isCreatedByUser={false} />);

  it('claims a paused question for its card, keyed by its action', () => {
    const { getByTestId } = draw(
      asPart({
        type: 'ask_user_question',
        ask_user_question: { actionId: 'action-1', question: 'Which?' },
      }),
    );
    const card = getByTestId('paused-question');
    expect(card).toHaveAttribute('data-action-id', 'action-1');
    expect(card).toHaveTextContent('Which?');
  });

  it('puts approval controls under any tool card paused with nothing to show yet', () => {
    const { getByTestId } = draw(pausedCall({ name: 'read_file', approval: { actionId: 'a1' } }));
    expect(getByTestId('read-file-call')).toBeInTheDocument();
    expect(getByTestId('tool-approval')).toHaveAttribute('data-tool-call-id', 'call_1');
  });

  it('shows no approval controls once the call has output, or when it never paused', () => {
    const answered = draw(pausedCall({ output: 'done', approval: { actionId: 'a1' } }));
    expect(answered.queryByTestId('tool-approval')).not.toBeInTheDocument();
    answered.unmount();
    const plain = draw(pausedCall({}));
    expect(plain.queryByTestId('tool-approval')).not.toBeInTheDocument();
  });
});

describe('extendPartRenderers', () => {
  const error = asPart({ type: ContentTypes.ERROR, [ContentTypes.ERROR]: 'bad' });
  const with_ = (renderers: ReturnType<typeof extendPartRenderers>, part: TMessageContentParts) => {
    const { container, unmount } = render(
      <Part
        part={part}
        renderers={renderers}
        isSubmitting={false}
        showCursor={false}
        isCreatedByUser={false}
      />,
    );
    const element = container.firstElementChild;
    const result = element?.getAttribute('data-testid') ?? element?.textContent ?? null;
    unmount();
    return result;
  };

  it('adds a host’s part and tool renderers to the package’s, entry by entry', () => {
    const renderers = extendPartRenderers({
      parts: { [ContentTypes.ERROR]: () => <div data-testid="own-error" /> },
      tools: { [Tools.web_search]: () => <div data-testid="own-search" /> },
    });
    expect(with_(renderers, error)).toBe('own-error');
    expect(with_(renderers, agentCall(Tools.web_search))).toBe('own-search');
    expect(with_(renderers, asPart({ type: ContentTypes.TEXT, text: 'hello' }))).toBe('text');
    expect(with_(renderers, agentCall('skill'))).toBe('skill-call');
  });

  it('lets a host replace one of the package’s cards', () => {
    const renderers = extendPartRenderers({
      tools: { skill: () => <div data-testid="own-skill" /> },
    });
    expect(with_(renderers, agentCall('skill'))).toBe('own-skill');
  });

  it('lets a host claim a part before it is routed', () => {
    const renderers = extendPartRenderers({
      claim: ({ part }) =>
        part.type === ContentTypes.TEXT ? <div data-testid="claimed" /> : undefined,
    });
    expect(with_(renderers, asPart({ type: ContentTypes.TEXT, text: 'hello' }))).toBe('claimed');
    expect(with_(renderers, agentCall('skill'))).toBe('skill-call');
  });

  it('lets a host wrap every tool card around the package’s own frame', () => {
    const renderers = extendPartRenderers({
      wrapTool: (card, props) => (
        <section data-testid="wrapped">{partRenderers().wrapTool?.(card, props)}</section>
      ),
    });
    const { container } = render(
      <Part
        part={agentCall('skill')}
        renderers={renderers}
        isSubmitting={false}
        showCursor={false}
        isCreatedByUser={false}
      />,
    );
    expect(container.querySelector('[data-testid="wrapped"] [data-testid="skill-call"]')).not.toBe(
      null,
    );
  });

  it('leaves the package’s own table as it was', () => {
    extendPartRenderers({
      tools: { skill: () => null },
      parts: { [ContentTypes.TEXT]: () => null },
    });
    expect(with_(partRenderers(), agentCall('skill'))).toBe('skill-call');
    expect(with_(partRenderers(), asPart({ type: ContentTypes.TEXT, text: 'hello' }))).toBe('text');
  });
});
