import React from 'react';
import { render, screen } from '@testing-library/react';
import { Constants, ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import Part from '../Part';

jest.mock('../Parts', () => ({
  ImageGen: () => <div data-testid="image-gen" />,
  ExecuteCode: () => <div data-testid="execute-code" />,
  AgentUpdate: () => <div data-testid="agent-update" />,
  EmptyText: () => <div data-testid="empty-text" />,
  Reasoning: () => <div data-testid="reasoning" />,
  ReasoningMarker: ({ label }: { label?: string }) => (
    <div data-testid="reasoning-marker">{label}</div>
  ),
  Summary: () => <div data-testid="summary" />,
  Text: ({ text }: { text?: string }) => <div data-testid="text">{text}</div>,
  SkillCall: () => <div data-testid="skill-call" />,
  ReadFileCall: () => <div data-testid="read-file-call" />,
  FileAuthoringCall: ({ toolName }: { toolName: string }) => (
    <div data-testid="file-authoring-call" data-tool-name={toolName} />
  ),
  BashCall: ({ commandField }: { commandField?: string }) => (
    <div data-testid="bash-call" data-command-field={commandField ?? 'command'} />
  ),
  SubagentCall: () => <div data-testid="subagent-call" />,
}));

jest.mock('../MessageContent', () => ({
  ErrorMessage: () => <div data-testid="error-message" />,
}));

jest.mock('../RetrievalCall', () => ({
  __esModule: true,
  default: () => <div data-testid="retrieval-call" />,
}));

jest.mock('../AgentHandoff', () => ({
  __esModule: true,
  default: () => <div data-testid="agent-handoff" />,
}));

jest.mock('../CodeAnalyze', () => ({
  __esModule: true,
  default: () => <div data-testid="code-analyze" />,
}));

jest.mock('../Container', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('../WebSearch', () => ({
  __esModule: true,
  default: () => <div data-testid="web-search" />,
}));

jest.mock('../ToolCall', () => ({
  __esModule: true,
  default: ({ runStepStatus }: { runStepStatus?: string }) => (
    <div data-testid="tool-call" data-run-step-status={runStepStatus} />
  ),
}));

jest.mock('../Image', () => ({
  __esModule: true,
  default: () => <div data-testid="image" />,
}));

jest.mock('~/utils', () => ({
  getPartKeyIndex: jest.requireActual('~/utils').getPartKeyIndex,
  getCachedPreview: jest.fn(),
}));

const renderPart = (part: TMessageContentParts) =>
  render(<Part part={part} isSubmitting={false} showCursor={false} isCreatedByUser={false} />);

const toolCallPart = (name: string, args = '{"code":"echo hi"}'): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id: 'call_1',
      name,
      args,
      output: 'hi',
      progress: 1,
    },
  }) as unknown as TMessageContentParts;

describe('Part tool renderer selection', () => {
  it.each(['image_gen_oai', 'image_edit_oai', 'gemini_image_gen'])(
    'keeps a successful %s call on the image renderer',
    (name) => {
      renderPart(toolCallPart(name));
      expect(screen.getByTestId('image-gen')).toBeInTheDocument();
    },
  );

  it.each(['completed', 'failed'] as const)(
    'makes a failed image-generation step with %s status revealable',
    (runStepStatus) => {
      renderPart({
        ...toolCallPart('image_gen_oai'),
        tool_call: {
          id: 'call_1',
          name: 'image_gen_oai',
          args: '{}',
          output: 'Error: Invalid image arguments\n Please fix your mistakes.',
          progress: 1,
          runStepStatus,
        },
      } as TMessageContentParts);
      expect(screen.getByTestId('tool-call')).toHaveAttribute(
        'data-run-step-status',
        runStepStatus,
      );
      expect(screen.queryByTestId('image-gen')).not.toBeInTheDocument();
    },
  );

  it('keeps a cancelled image-generation step out of the failed disclosure', () => {
    renderPart({
      ...toolCallPart('image_gen_oai'),
      tool_call: {
        id: 'call_1',
        name: 'image_gen_oai',
        args: '{}',
        output: 'Error: Invalid image arguments\n Please fix your mistakes.',
        progress: 1,
        runStepStatus: 'cancelled',
      },
    } as TMessageContentParts);
    expect(screen.getByTestId('image-gen')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-call')).not.toBeInTheDocument();
  });

  it('routes a failed function-style image call through the shared disclosure', () => {
    renderPart({
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        type: 'function',
        progress: 1,
        function: {
          name: 'image_gen_oai',
          arguments: '{}',
          output: 'Error: Invalid image arguments\n Please fix your mistakes.',
        },
      },
    } as TMessageContentParts);
    expect(screen.getByTestId('tool-call')).toBeInTheDocument();
  });

  it('routes bash PTC tool calls through the BashCall renderer', () => {
    renderPart(toolCallPart(Constants.BASH_PROGRAMMATIC_TOOL_CALLING));

    expect(screen.getByTestId('bash-call')).toHaveAttribute('data-command-field', 'code');
    expect(screen.queryByTestId('execute-code')).not.toBeInTheDocument();
  });

  it('routes default run_tools_with_code PTC calls through the BashCall renderer', () => {
    renderPart(toolCallPart(Constants.PROGRAMMATIC_TOOL_CALLING));

    expect(screen.getByTestId('bash-call')).toHaveAttribute('data-command-field', 'code');
    expect(screen.queryByTestId('execute-code')).not.toBeInTheDocument();
  });

  it('keeps Python PTC calls on the ExecuteCode renderer', () => {
    renderPart(
      toolCallPart(Constants.PROGRAMMATIC_TOOL_CALLING, '{"lang":"py","code":"print(1)"}'),
    );

    expect(screen.getByTestId('execute-code')).toBeInTheDocument();
    expect(screen.queryByTestId('bash-call')).not.toBeInTheDocument();
  });

  it('routes create_file calls through the file-authoring renderer', () => {
    renderPart(
      toolCallPart('create_file', '{"file_path":"skills/demo/SKILL.md","content":"# Demo"}'),
    );

    expect(screen.getByTestId('file-authoring-call')).toHaveAttribute(
      'data-tool-name',
      'create_file',
    );
    expect(screen.queryByTestId('tool-call')).not.toBeInTheDocument();
  });

  it('routes edit_file calls through the file-authoring renderer', () => {
    renderPart(
      toolCallPart(
        'edit_file',
        '{"file_path":"skills/demo/SKILL.md","old_text":"Demo","new_text":"Updated"}',
      ),
    );

    expect(screen.getByTestId('file-authoring-call')).toHaveAttribute(
      'data-tool-name',
      'edit_file',
    );
    expect(screen.queryByTestId('tool-call')).not.toBeInTheDocument();
  });

  it('renders a cancelled generic background tool as cancelled', () => {
    const part = toolCallPart('search_mcp_docs') as Extract<
      TMessageContentParts,
      { type: typeof ContentTypes.TOOL_CALL }
    >;
    Object.assign(part[ContentTypes.TOOL_CALL], {
      runStepStatus: 'failed',
      backgroundTask: { cancelled: true },
    });

    renderPart(part);

    expect(screen.getByTestId('tool-call')).toHaveAttribute('data-run-step-status', 'cancelled');
  });

  it('routes an unavailable reasoning marker to the marker renderer', () => {
    renderPart({
      type: ContentTypes.THINK,
      think: '',
      reasoning_unavailable: true,
      reasoning_label: 'Planning the answer',
    } as TMessageContentParts);

    expect(screen.getByTestId('reasoning-marker')).toHaveTextContent('Planning the answer');
    expect(screen.queryByTestId('reasoning')).not.toBeInTheDocument();
  });

  it('keeps reasoning with text on the full Reasoning renderer even when marked unavailable', () => {
    renderPart({
      type: ContentTypes.THINK,
      think: 'Actual thoughts',
      reasoning_unavailable: true,
    } as TMessageContentParts);

    expect(screen.getByTestId('reasoning')).toBeInTheDocument();
    expect(screen.queryByTestId('reasoning-marker')).not.toBeInTheDocument();
  });
});
