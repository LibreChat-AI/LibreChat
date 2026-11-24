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
jest.mock('../parts/WebSearch', () => ({
  __esModule: true,
  WebSearchCall: mockStub('web-search'),
}));
jest.mock('../parts/ask/Call', () => ({
  __esModule: true,
  default: mockStub('ask-user-question-call'),
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
  /** An error part is the host's to draw: the package has no error card of its own. */
  ['error', asPart({ type: ContentTypes.ERROR, [ContentTypes.ERROR]: 'bad' }), null],
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
    /** A paused question is the host's to claim, with its way to answer. */
    null,
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
  /** A subagent's card reads the host's state; without the host it is a generic tool card. */
  [Constants.SUBAGENT as string, '{}', 'tool-call'],
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
