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
  default: ({ alignRight }: { alignRight?: boolean }) => (
    <div data-testid="image" data-aligned-right={String(alignRight)} />
  ),
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

describe('Part image alignment', () => {
  it('right-aligns user image parts without moving assistant images', () => {
    const imagePart = {
      type: ContentTypes.IMAGE_FILE,
      [ContentTypes.IMAGE_FILE]: {
        file_id: 'image-1',
        filename: 'upload.png',
        filepath: '/images/upload.png',
      },
    } as TMessageContentParts;
    const { rerender } = render(
      <Part part={imagePart} isSubmitting={false} showCursor={false} isCreatedByUser={false} />,
    );
    expect(screen.getByTestId('image')).toHaveAttribute('data-aligned-right', 'false');

    rerender(<Part part={imagePart} isSubmitting={false} showCursor={false} isCreatedByUser />);
    expect(screen.getByTestId('image')).toHaveAttribute('data-aligned-right', 'true');
  });
});

describe('Part tool renderer selection', () => {
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
