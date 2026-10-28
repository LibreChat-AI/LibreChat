import React from 'react';
import { render } from '@testing-library/react';
import { Tools, Constants, ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import Part from '../Part';

function mockStub(testId: string) {
  return function Stub() {
    return <div data-testid={testId} />;
  };
}

function mockPassthrough({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

jest.mock('../Parts', () => ({
  ImageGen: mockStub('image-gen'),
  ExecuteCode: mockStub('execute-code'),
  AgentUpdate: mockStub('agent-update'),
  EmptyText: mockStub('empty-text'),
  Reasoning: mockStub('reasoning'),
  ReasoningMarker: mockStub('reasoning-marker'),
  Summary: mockStub('summary'),
  Text: mockStub('text'),
  SkillCall: mockStub('skill-call'),
  MemoryCall: mockStub('memory-call'),
  ReadFileCall: mockStub('read-file-call'),
  FileAuthoringCall: mockStub('file-authoring-call'),
  BashCall: mockStub('bash-call'),
  SubagentCall: mockStub('subagent-call'),
  SteerPart: mockStub('steer-part'),
}));
jest.mock('../Parts/BackgroundTaskCall', () => ({
  __esModule: true,
  default: mockStub('background-task-call'),
}));
jest.mock('../MessageContent', () => ({ ErrorMessage: mockStub('error-message') }));
jest.mock('../AskUserQuestionCall', () => ({
  __esModule: true,
  default: mockStub('ask-user-question-call'),
}));
jest.mock('../AskUserQuestion', () => ({
  __esModule: true,
  default: mockStub('ask-user-question'),
}));
jest.mock('../RetrievalCall', () => ({ __esModule: true, default: mockStub('retrieval-call') }));
jest.mock('../ToolApproval', () => ({ __esModule: true, default: mockStub('tool-approval') }));
jest.mock('../AgentHandoff', () => ({ __esModule: true, default: mockStub('agent-handoff') }));
jest.mock('../CodeAnalyze', () => ({ __esModule: true, default: mockStub('code-analyze') }));
jest.mock('../WebSearch', () => ({ __esModule: true, default: mockStub('web-search') }));
jest.mock('../ToolCall', () => ({ __esModule: true, default: mockStub('tool-call') }));
jest.mock('../Image', () => ({ __esModule: true, default: mockStub('image') }));
jest.mock('../Container', () => ({ __esModule: true, default: mockPassthrough }));
jest.mock('../preparation', () => ({ ToolPreparation: mockPassthrough }));

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
    'ask-user-question',
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

describe('Part registry parity with the replaced switch', () => {
  it.each(PART_TYPES)('routes the %s part to the same component', (_label, part, expected) => {
    expect(drawn(part)).toBe(expected);
  });

  it.each(TOOL_NAMES)('routes a %s call with args %s to the same card', (name, args, expected) => {
    expect(drawn(agentCall(name, args))).toBe(expected);
  });
});
