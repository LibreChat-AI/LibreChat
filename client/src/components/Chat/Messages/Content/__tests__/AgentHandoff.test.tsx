import React from 'react';
import { RecoilRoot } from 'recoil';
import { QueryKeys, Constants } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AgentHandoff from '../AgentHandoff';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_ui_transferred_to: 'Transferred to',
      com_ui_agent: 'Agent',
      com_ui_handoff_instructions: 'Handoff instructions',
      com_ui_copy_to_clipboard: 'Copy to clipboard',
      com_ui_copied_to_clipboard: 'Copied to clipboard',
    };
    return translations[key] || key;
  },
}));

jest.mock('@librechat/chat/components', () => ({
  ...jest.requireActual('@librechat/chat/components'),
  useExpandCollapse: (isExpanded: boolean) => ({
    style: {
      display: 'grid',
      gridTemplateRows: isExpanded ? '1fr' : '0fr',
      opacity: isExpanded ? 1 : 0,
    },
    ref: { current: null },
  }),
}));

jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: () => ({
    'agent-123': { name: 'Test Agent' },
  }),
}));

jest.mock('~/components/Share/MessageIcon', () => ({
  __esModule: true,
  default: () => <div data-testid="message-icon" />,
}));

jest.mock('lucide-react', () => ({
  ChevronDown: () => <span data-testid="chevron-down" />,
  /** The shared CopyButton/ActionButton composition renders both. */
  Copy: () => <span data-testid="copy-icon" />,
  Check: () => <span data-testid="check-icon" />,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: (string | boolean | undefined)[]) => classes.filter(Boolean).join(' '),
}));

const mockCopy = jest.fn(() => true);
jest.mock('copy-to-clipboard', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockCopy(...(args as [])),
}));

const renderAgentHandoff = (
  props: {
    name: string;
    args: string | Record<string, unknown>;
    output?: string | null;
  },
  configuredTargets: Array<{ id: string; name: string }> = [],
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData([QueryKeys.modelSpecHandoffs], configuredTargets);
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <AgentHandoff {...props} />
      </RecoilRoot>
    </QueryClientProvider>,
  );
};

describe('AgentHandoff', () => {
  beforeEach(() => {
    mockCopy.mockClear();
    mockCopy.mockReturnValue(true);
  });

  it('A11Y-01: renders a semantic button element when hasInfo is true', () => {
    renderAgentHandoff({
      name: 'lc_transfer_to_agent-123',
      args: '{"key":"value"}',
    });

    const button = screen.getByRole('button', { name: /Transferred to/i });
    expect(button.tagName).toBe('BUTTON');
  });

  it('A11Y-02: button has aria-label describing the handoff target', () => {
    renderAgentHandoff({
      name: 'lc_transfer_to_agent-123',
      args: '{"key":"value"}',
    });

    const button = screen.getByRole('button', { name: /Transferred to/i });
    expect(button).toHaveAttribute('aria-label');
    expect(button.getAttribute('aria-label')).toContain('Transferred to');
    expect(button.getAttribute('aria-label')).toContain('Test Agent');
  });

  it('A11Y-03: button has focus-visible ring classes', () => {
    renderAgentHandoff({
      name: 'lc_transfer_to_agent-123',
      args: '{"key":"value"}',
    });

    const button = screen.getByRole('button', { name: /Transferred to/i });
    expect(button.className).toContain('focus-visible:ring-2');
  });

  it('A11Y-04: disabled button is rendered when hasInfo is false', () => {
    renderAgentHandoff({
      name: 'lc_transfer_to_agent-123',
      args: '',
    });

    const button = screen.getByRole('button', { name: /Transferred to/i });
    expect(button).toBeDisabled();
  });

  it('renders the handoff instruction as prose instead of JSON', () => {
    const { container } = renderAgentHandoff({
      name: 'lc_transfer_to_agent-123',
      args: JSON.stringify({
        instructions: 'Review the rollout, validate retention, and report blockers.',
      }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Transferred to/i }));

    expect(
      screen.getByText('Review the rollout, validate retention, and report blockers.'),
    ).toBeInTheDocument();
    expect(container.querySelector('pre')).not.toBeInTheDocument();
    expect(screen.queryByText(/"instructions"/)).not.toBeInTheDocument();
  });

  it('copies the readable instruction rather than its JSON wrapper', async () => {
    renderAgentHandoff({
      name: 'lc_transfer_to_agent-123',
      args: JSON.stringify({ instructions: 'Review the rollout.' }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Transferred to/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));

    expect(mockCopy).toHaveBeenCalledWith('Review the rollout.', { format: 'text/plain' });
    expect(await screen.findByRole('button', { name: 'Copied to clipboard' })).toBeInTheDocument();
  });

  it('leaves the control idle when the clipboard is unavailable', () => {
    /** `copy-to-clipboard` returns false when it cannot reach a clipboard,
     *  which is the case the async API turns into a synchronous throw. */
    mockCopy.mockReturnValueOnce(false);
    renderAgentHandoff({
      name: 'lc_transfer_to_agent-123',
      args: JSON.stringify({ instructions: 'Review the rollout.' }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Transferred to/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));

    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied to clipboard' })).not.toBeInTheDocument();
  });

  it('supports object args and a custom handoff prompt key', () => {
    renderAgentHandoff({
      name: 'lc_transfer_to_agent-123',
      args: { work_items: 'Verify the migration plan.' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Transferred to/i }));

    expect(screen.getByText('Verify the migration plan.')).toBeInTheDocument();
    expect(screen.queryByText('Work items')).not.toBeInTheDocument();
  });

  it('labels each value when a legacy handoff contains multiple fields', () => {
    renderAgentHandoff({
      name: 'lc_transfer_to_agent-123',
      args: JSON.stringify({
        work_items: 'Verify the migration plan.',
        priority: 'High',
      }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Transferred to/i }));

    expect(screen.getByText('Work items')).toBeInTheDocument();
    expect(screen.getByText('Verify the migration plan.')).toBeInTheDocument();
    expect(screen.getByText('Priority')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('renders a partially streamed instruction without exposing JSON syntax', () => {
    renderAgentHandoff({
      name: 'lc_transfer_to_agent-123',
      args: '{"instructions":"Review the rollout and report',
    });

    fireEvent.click(screen.getByRole('button', { name: /Transferred to/i }));

    expect(screen.getByText('Review the rollout and report')).toBeInTheDocument();
    expect(screen.queryByText(/"instructions"/)).not.toBeInTheDocument();
  });
});

test('shows the configured label for a preset handoff outside the saved-agent map', () => {
  const id = Constants.MODEL_SPEC_AGENT_PREFIX + '123';
  renderAgentHandoff({ name: Constants.LC_TRANSFER_TO_ + id, args: '' }, [
    { id, name: 'Preset Specialist' },
  ]);
  expect(
    screen.getByRole('button', { name: 'Transferred to Preset Specialist' }),
  ).toBeInTheDocument();
});
