import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentToolType } from 'librechat-data-provider';
import MCPToolItem from '../MCPToolItem';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  TooltipAnchor: ({ render }: { render: React.ReactElement }) => render,
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));

const tool = {
  tool_id: 'mcp:srv:execute',
  metadata: { name: 'execute', description: 'Runs JavaScript code against the API.' },
} as unknown as AgentToolType;

const pressedOptions: Array<{
  name: string;
  overrides: Partial<React.ComponentProps<typeof MCPToolItem>>;
  label: string;
  border: string;
}> = [
  {
    name: 'deferred',
    overrides: { deferredToolsEnabled: true, isDeferred: true },
    label: 'com_ui_mcp_defer_loading',
    border: 'border-series-4',
  },
  {
    name: 'programmatic',
    overrides: {
      programmaticToolsEnabled: true,
      programmaticToolsAvailable: true,
      isProgrammatic: true,
    },
    label: 'com_ui_mcp_programmatic',
    border: 'border-series-6',
  },
  {
    name: 'background',
    overrides: { backgroundToolsEnabled: true, isBackground: true },
    label: 'com_ui_mcp_background',
    border: 'border-series-1',
  },
  {
    name: 'intent',
    overrides: { toolIntentsEnabled: true, isIntent: true },
    label: 'com_ui_mcp_intent',
    border: 'border-series-3',
  },
];

function setup(overrides: Partial<React.ComponentProps<typeof MCPToolItem>> = {}) {
  const props = {
    tool,
    isSelected: false,
    isDeferred: false,
    isProgrammatic: false,
    isBackground: false,
    isIntent: false,
    intentDisabled: false,
    deferredToolsEnabled: false,
    programmaticToolsEnabled: false,
    programmaticToolsAvailable: false,
    backgroundToolsEnabled: false,
    toolIntentsEnabled: false,
    onToggleSelect: jest.fn(),
    onToggleDefer: jest.fn(),
    onToggleProgrammatic: jest.fn(),
    onToggleBackground: jest.fn(),
    onToggleIntent: jest.fn(),
    ...overrides,
  };
  render(<MCPToolItem {...props} />);
  return props;
}

describe('MCPToolItem', () => {
  test('clicking the row (not just a checkbox) toggles selection', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'execute' }));
    expect(props.onToggleSelect).toHaveBeenCalledTimes(1);
  });

  test('reflects selection via aria-pressed', () => {
    setup({ isSelected: true });
    expect(screen.getByRole('button', { name: 'execute' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('the info button toggles the description panel via aria-expanded', () => {
    setup();
    const infoButton = screen.getByRole('button', { name: 'com_ui_tools_info' });
    expect(infoButton).toHaveAttribute('aria-expanded', 'false');
    // The description is always rendered (the panel animates open/closed), so it stays queryable.
    expect(screen.getByText('Runs JavaScript code against the API.')).toBeInTheDocument();
    fireEvent.click(infoButton);
    expect(infoButton).toHaveAttribute('aria-expanded', 'true');
  });

  test('detail button is an info affordance when no options are enabled', () => {
    setup();
    expect(screen.getByRole('button', { name: 'com_ui_tools_info' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_mcp_tool_options' }),
    ).not.toBeInTheDocument();
  });

  test('detail button stays an info affordance (never a cog) when options exist', () => {
    setup({ deferredToolsEnabled: true, programmaticToolsEnabled: true });
    expect(screen.getByRole('button', { name: 'com_ui_tools_info' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_mcp_tool_options' }),
    ).not.toBeInTheDocument();
  });

  test('defer loading is an inline button (left of the cog) that toggles defer', () => {
    const props = setup({ deferredToolsEnabled: true });
    const deferButton = screen.getByRole('button', { name: 'com_ui_mcp_defer_loading' });
    fireEvent.click(deferButton);
    expect(props.onToggleDefer).toHaveBeenCalledTimes(1);
  });

  test.each(pressedOptions)('$name option uses a semantic pressed-state border', (option) => {
    setup(option.overrides);
    const button = screen.getByRole('button', { name: option.label });

    expect(button).toHaveClass(
      option.border,
      'bg-surface-active',
      'text-text-primary',
      'hover:bg-surface-active-alt',
    );
    expect(button.querySelector('svg')?.className.baseVal).not.toMatch(
      /text-(?:amber|violet|sky|teal)-/,
    );
  });

  test('defer button is absent when deferred tools are disabled', () => {
    setup();
    expect(
      screen.queryByRole('button', { name: 'com_ui_mcp_defer_loading' }),
    ).not.toBeInTheDocument();
  });

  test('programmatic is an inline button rendered only when enabled', () => {
    const props = setup({ programmaticToolsEnabled: true, programmaticToolsAvailable: true });
    const programmaticButton = screen.getByRole('button', { name: 'com_ui_mcp_programmatic' });
    fireEvent.click(programmaticButton);
    expect(props.onToggleProgrammatic).toHaveBeenCalledTimes(1);
  });

  test('programmatic is inert until Code Interpreter is selected', () => {
    const props = setup({ programmaticToolsEnabled: true, programmaticToolsAvailable: false });
    const programmaticButton = screen.getByRole('button', { name: 'com_ui_mcp_programmatic' });

    expect(programmaticButton).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(programmaticButton);
    expect(props.onToggleProgrammatic).not.toHaveBeenCalled();
  });

  test('an existing programmatic setting can be cleared after Code Interpreter is disabled', () => {
    const props = setup({
      programmaticToolsEnabled: true,
      programmaticToolsAvailable: false,
      isProgrammatic: true,
    });
    const programmaticButton = screen.getByRole('button', { name: 'com_ui_mcp_programmatic' });

    expect(programmaticButton).not.toHaveAttribute('aria-disabled');
    fireEvent.click(programmaticButton);
    expect(props.onToggleProgrammatic).toHaveBeenCalledTimes(1);
  });

  test('background is an inline button rendered only when enabled', () => {
    const props = setup({ backgroundToolsEnabled: true });
    const backgroundButton = screen.getByRole('button', { name: 'com_ui_mcp_background' });
    fireEvent.click(backgroundButton);
    expect(props.onToggleBackground).toHaveBeenCalledTimes(1);
  });

  test('background button is absent when background tools are disabled', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'com_ui_mcp_background' })).not.toBeInTheDocument();
  });

  test('intent label is an inline button rendered only when enabled', () => {
    const props = setup({ toolIntentsEnabled: true });
    const intentButton = screen.getByRole('button', { name: 'com_ui_mcp_intent' });
    fireEvent.click(intentButton);
    expect(props.onToggleIntent).toHaveBeenCalledTimes(1);
  });

  test('intent button is absent when tool intents are disabled', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'com_ui_mcp_intent' })).not.toBeInTheDocument();
  });

  test('intent button reflects the opted-in state via aria-pressed', () => {
    setup({ toolIntentsEnabled: true, isIntent: true });
    expect(screen.getByRole('button', { name: 'com_ui_mcp_intent' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('intent button is inert for programmatic-only tools (label can never render)', () => {
    const props = setup({ toolIntentsEnabled: true, intentDisabled: true });
    const intentButton = screen.getByRole('button', { name: 'com_ui_mcp_intent' });
    expect(intentButton).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(intentButton);
    expect(props.onToggleIntent).not.toHaveBeenCalled();
  });
});
