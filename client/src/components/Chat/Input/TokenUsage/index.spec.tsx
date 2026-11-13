import { Provider, createStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';
import type { TokenUsageView } from '~/hooks/Chat/useTokenUsage';
import TokenUsage from './index';

const mockStartupConfig = jest.fn();
const mockTokenUsage = jest.fn();
const mockBalanceQuery = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig() }),
  useGetUserBalance: () => mockBalanceQuery(),
  useGetLangfuseSessionLinkQuery: () => ({ data: undefined }),
}));
jest.mock('~/hooks/Chat/useTokenUsage', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockTokenUsage(...args),
}));
jest.mock('~/hooks/Chat/useCompactConversation', () => ({
  __esModule: true,
  default: () => ({ compact: jest.fn(), canCompact: false, isCompacting: false }),
  supportsCompaction: () => false,
}));
jest.mock('@librechat/chat/components', () => ({
  ...jest.requireActual('@librechat/chat/components'),
  ContextBreakdown: ({
    expanded,
    onExpandedChange,
  }: {
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
  }) => (
    <button
      type="button"
      data-testid="context-breakdown-stub"
      aria-expanded={expanded}
      onClick={() => onExpandedChange(!expanded)}
    />
  ),
}));

const conversation = { conversationId: 'convo-1', endpoint: 'openAI' } as TConversation;
const renderGauge = () =>
  render(<TokenUsage index={0} conversation={conversation} isSubmitting={false} />);

describe('TokenUsage gauge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStartupConfig.mockReturnValue({ balance: { enabled: true } });
    mockTokenUsage.mockReturnValue({ usedTokens: 0 } as TokenUsageView);
  });

  it.each([false, true])('stays hidden on a fresh chat, balance enabled=%s', (enabled) => {
    mockStartupConfig.mockReturnValue({ balance: { enabled } });
    renderGauge();
    expect(screen.queryByTestId('token-usage')).not.toBeInTheDocument();
    expect(mockBalanceQuery).not.toHaveBeenCalled();
  });

  it('keeps account credits out of the context card', async () => {
    mockTokenUsage.mockReturnValue({ usedTokens: 83200, maxTokens: 200000, percent: 41.6 });
    renderGauge();
    expect(screen.getByTestId('token-usage')).toHaveClass(
      'size-theme-control',
      'rounded-theme-control-round',
    );
    await userEvent.click(screen.getByTestId('token-usage'));
    const card = await screen.findByRole('dialog');
    expect(within(card).getByTestId('context-breakdown-stub')).toBeInTheDocument();
    expect(within(card).queryByTestId('balance-summary')).not.toBeInTheDocument();
    expect(mockBalanceQuery).not.toHaveBeenCalled();
    expect(card).toHaveClass(
      'max-h-[calc(100dvh-1rem)]',
      'max-w-[calc(100vw-1rem)]',
      'overflow-y-auto',
    );
    expect(screen.getByTestId('token-usage-card')).toHaveClass('w-96', 'max-w-full');
  });

  it('keeps the totals disclosure choice across remounts', async () => {
    localStorage.clear();
    mockTokenUsage.mockReturnValue({ usedTokens: 83200, maxTokens: 200000, percent: 41.6 });
    const tree = () => (
      <Provider store={createStore()}>
        <TokenUsage index={0} conversation={conversation} isSubmitting={false} />
      </Provider>
    );
    const first = render(tree());
    await userEvent.click(screen.getByTestId('token-usage'));
    expect(await screen.findByTestId('context-breakdown-stub')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await userEvent.click(screen.getByTestId('context-breakdown-stub'));
    expect(screen.getByTestId('context-breakdown-stub')).toHaveAttribute('aria-expanded', 'true');
    first.unmount();
    render(tree());
    await userEvent.click(screen.getByTestId('token-usage'));
    expect(await screen.findByTestId('context-breakdown-stub')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    localStorage.clear();
  });

  it('mounts nothing while the startup config is loading', () => {
    mockStartupConfig.mockReturnValue(undefined);
    const { container } = renderGauge();
    expect(container).toBeEmptyDOMElement();
    expect(mockTokenUsage).not.toHaveBeenCalled();
  });

  it('mounts nothing when context usage is disabled, even if credits are enabled', () => {
    mockStartupConfig.mockReturnValue({
      balance: { enabled: true },
      interface: { contextUsage: false },
    });
    const { container } = renderGauge();
    expect(container).toBeEmptyDOMElement();
    expect(mockTokenUsage).not.toHaveBeenCalled();
    expect(mockBalanceQuery).not.toHaveBeenCalled();
  });
});
