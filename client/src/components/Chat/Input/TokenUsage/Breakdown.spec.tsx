import '@testing-library/jest-dom/extend-expect';
import { Provider } from 'jotai';
import userEvent from '@testing-library/user-event';
import { Constants, Tools } from 'librechat-data-provider';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import type { TokenUsageView } from '~/hooks/Chat/useTokenUsage';
import Breakdown from './Breakdown';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const view = {
  usedTokens: 10,
  percent: 0,
  isEstimate: true,
  snapshot: null,
  snapshotActive: false,
  branchTotals: {
    input: 10,
    output: 0,
    counted: 1,
    total: 1,
    estTokens: 0,
    tailEstTokens: 0,
    estToolTokens: 0,
    tailEstToolTokens: 0,
    containsAnchor: false,
    summaryBaseline: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: true },
    tailId: null,
  },
  branchUsage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: true },
  totalUsage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: true },
  hasUsage: true,
  branchCost: 0,
  totalCost: 0,
  liveTokens: 0,
  estimatedTokens: 0,
  overheadTokens: 0,
  messageTokens: 10,
  messagesPruned: false,
} as TokenUsageView;

/** A snapshot-backed branch: messages, instructions, and one tool per group,
 *  with a deferred entry on both the system and MCP families. */
const snapshotView = {
  ...view,
  usedTokens: 1000,
  maxTokens: 2000,
  percent: 50,
  isEstimate: false,
  snapshotActive: true,
  effectiveInstructionTokens: 0,
  snapshot: {
    anchorMessageId: 'message-1',
    effectiveInstructionTokens: 400,
    breakdown: {
      maxContextTokens: 2000,
      instructionTokens: 400,
      systemMessageTokens: 100,
      dynamicInstructionTokens: 20,
      toolSchemaTokens: 280,
      summaryTokens: 50,
      toolCount: 5,
      messageCount: 4,
      messageTokens: 550,
      availableForMessages: 1600,
      toolTokenCounts: {
        web_search: 90,
        deferred_tool: 30,
        [`server${Constants.mcp_delimiter}tool`]: 80,
        [`server${Constants.mcp_delimiter}lazy`]: 40,
        [Tools.skill]: 25,
        [Constants.SUBAGENT]: 15,
      },
      deferredToolNames: ['deferred_tool', `server${Constants.mcp_delimiter}lazy`],
    },
  },
} as unknown as TokenUsageView;

/** Same snapshot with a reported tool-call split present: 150 of the 550
 *  message tokens are tool exchanges, so Messages shows 400 and a Tool calls
 *  row appears. */
const toolSplitView = JSON.parse(JSON.stringify(snapshotView)) as unknown as TokenUsageView;
toolSplitView.snapshot!.breakdown.toolMessageTokens = 150;
toolSplitView.snapshot!.breakdown.toolMessageTokenCounts = { read_file: 100 };
toolSplitView.toolMessageTokenCounts = toolSplitView.snapshot!.breakdown.toolMessageTokenCounts;

const renderBreakdown = (props: Partial<React.ComponentProps<typeof Breakdown>> = {}) =>
  render(
    <Provider>
      <Breakdown view={view} showCost={false} {...props} />
    </Provider>,
  );

const toggle = () => screen.getByTestId('context-breakdown-toggle');

beforeEach(() => {
  localStorage.clear();
});

describe('TokenUsage Breakdown', () => {
  describe('collapse', () => {
    it('opens showing only the gauge, with the detail behind the disclosure', () => {
      renderBreakdown();

      expect(toggle()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByTestId('token-usage-totals')).not.toBeInTheDocument();
    });

    it('reveals the detail once expanded', async () => {
      renderBreakdown();

      await userEvent.click(toggle());

      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('token-usage-totals')).toBeInTheDocument();
    });

    it('persists the expanded choice across mounts', async () => {
      const { unmount } = renderBreakdown();
      await userEvent.click(toggle());
      unmount();

      renderBreakdown();

      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('token-usage-totals')).toBeInTheDocument();
    });

    it('keeps the gauge readout visible while collapsed', () => {
      renderBreakdown({ view: snapshotView });

      expect(within(toggle()).getByText('1K / 2K (50%)')).toBeInTheDocument();
    });
  });

  describe('segments', () => {
    it('stacks the segments in slot order, deferred beside its parent', () => {
      renderBreakdown({ view: snapshotView });

      const segments = Array.from(screen.getByRole('progressbar').children) as HTMLElement[];

      expect(
        segments.map(
          (segment) => /(?:bg-series-\d(?:\/25)?)/.exec(segment.className)?.[0] ?? 'none',
        ),
      ).toEqual([
        'bg-series-1', // messages
        'bg-series-3', // system prompt
        'bg-series-4', // system tools
        'bg-series-4', // system tools, deferred
        'bg-series-5', // mcp tools
        'bg-series-5', // mcp tools, deferred
        'bg-series-6', // skills
        'bg-series-7', // subagents
        'bg-series-8', // summary
      ]);
    });

    it('drops a category that contributes nothing', () => {
      const noSkills = JSON.parse(JSON.stringify(snapshotView)) as TokenUsageView;
      delete noSkills.snapshot?.breakdown.toolTokenCounts?.[Tools.skill];

      renderBreakdown({ view: noSkills });

      expect(screen.getByRole('progressbar').children).toHaveLength(8);
      expect(screen.getByRole('progressbar').querySelector('.bg-series-6')).toBeNull();
    });

    it('gives the deferred rows their family slot and a hatch', async () => {
      renderBreakdown({ view: snapshotView });
      await userEvent.click(toggle());

      const breakdown = screen.getByTestId('context-breakdown');
      const rowFor = (label: string) =>
        within(breakdown).getByText(label).parentElement as HTMLElement;

      const system = rowFor('com_ui_context_tools_system').firstElementChild as HTMLElement;
      const deferred = rowFor('com_ui_context_tools_system_deferred')
        .firstElementChild as HTMLElement;

      expect(system).toHaveClass('bg-series-4');
      expect(deferred).toHaveClass('bg-series-4');
      expect(deferred.getAttribute('style')).toContain('repeating-linear-gradient');
    });

    it('renders the Messages segment solid, like every other series', async () => {
      renderBreakdown({ view: snapshotView });
      await userEvent.click(toggle());

      const messages = within(screen.getByTestId('context-breakdown')).getByText(
        'com_ui_context_messages',
      ).parentElement?.firstElementChild as HTMLElement;

      expect(messages).toHaveClass('bg-series-1');
      expect(messages.className).not.toContain('ring-series-1');
    });

    it('dims the other bar segments while a legend row is hovered', async () => {
      renderBreakdown({ view: snapshotView });
      await userEvent.click(toggle());

      const segments = Array.from(screen.getByRole('progressbar').children) as HTMLElement[];
      const rowFor = (label: string) =>
        within(screen.getByTestId('context-breakdown'))
          .getByText(label)
          .closest('div') as HTMLElement;

      fireEvent.pointerEnter(rowFor('com_ui_context_messages'));

      expect(segments[0].className).not.toContain('opacity-40');
      segments.slice(1).forEach((segment) => expect(segment).toHaveClass('opacity-40'));

      fireEvent.pointerLeave(rowFor('com_ui_context_messages'));

      segments.forEach((segment) => expect(segment.className).not.toContain('opacity-40'));
    });

    it('recedes every segment when the free track row is hovered', async () => {
      renderBreakdown({ view: snapshotView });
      await userEvent.click(toggle());

      const segments = Array.from(screen.getByRole('progressbar').children) as HTMLElement[];
      const rowFor = (label: string) =>
        within(screen.getByTestId('context-breakdown'))
          .getByText(label)
          .closest('div') as HTMLElement;

      fireEvent.pointerEnter(rowFor('com_ui_context_free'));

      segments.forEach((segment) => expect(segment).toHaveClass('opacity-40'));
    });

    it('drops the dimming when the hovered row disappears from a live update', async () => {
      const noSubagents = JSON.parse(JSON.stringify(snapshotView)) as TokenUsageView;
      delete noSubagents.snapshot?.breakdown.toolTokenCounts?.[Constants.SUBAGENT];

      const { rerender } = renderBreakdown({ view: snapshotView });
      await userEvent.click(toggle());

      const segments = () => Array.from(screen.getByRole('progressbar').children) as HTMLElement[];
      const rowFor = (label: string) =>
        within(screen.getByTestId('context-breakdown'))
          .getByText(label)
          .closest('div') as HTMLElement;

      fireEvent.pointerEnter(rowFor('com_ui_context_subagents'));
      segments().forEach((segment, index) =>
        expect(segment.classList.contains('opacity-40')).toBe(index !== 7),
      );

      rerender(
        <Provider>
          <Breakdown view={noSubagents} showCost={false} />
        </Provider>,
      );

      segments().forEach((segment) => expect(segment.className).not.toContain('opacity-40'));

      /** The hover state is cleared, not masked: the row reappearing on a later
       *  live update must not bring the stale dimming back. */
      rerender(
        <Provider>
          <Breakdown view={snapshotView} showCost={false} />
        </Provider>,
      );

      segments().forEach((segment) => expect(segment.className).not.toContain('opacity-40'));
    });

    it('leaves the estimate path unsegmented, with no swatches on its rows', async () => {
      renderBreakdown();
      await userEvent.click(toggle());

      const estimate = screen.getByTestId('context-estimate');

      expect(estimate).toBeInTheDocument();
      expect(estimate.querySelector('[class*="bg-series-"]')).toBeNull();
    });

    it('keeps the estimate rows summing to used tokens when a tool share is known', async () => {
      const estimateWithTools = {
        ...view,
        usedTokens: 600,
        maxTokens: 2000,
        branchTotals: { ...view.branchTotals, input: 300, output: 200 },
        estimatedTokens: 100,
        messageTokens: 600,
        toolCallTokens: 150,
      } as TokenUsageView;

      renderBreakdown({ view: estimateWithTools });
      await userEvent.click(toggle());

      const estimate = screen.getByTestId('context-estimate');
      const peerTotal = Array.from(estimate.children)
        .filter((child) => !child.className.includes('pl-6'))
        .reduce((sum, child) => sum + Number(child.lastElementChild?.textContent ?? 0), 0);

      /** 300 input + 200 output + 100 estimated = 600 used. The tool share is a
       *  subset of those rows, so it may only appear as an indented subtotal —
       *  as a peer row the visible rows would claim 750 of a 600-token window. */
      expect(peerTotal).toBe(600);

      const toolRow = within(estimate).getByText('com_ui_context_tool_calls').parentElement
        ?.parentElement as HTMLElement;
      expect(toolRow.parentElement?.className).toContain('pl-6');
      expect(toolRow.textContent).toContain('150');
    });
    it('splits tool-call usage out of the messages row when reported', async () => {
      renderBreakdown({ view: toolSplitView });
      await userEvent.click(toggle());

      const breakdown = screen.getByTestId('context-breakdown');
      const rowFor = (label: string) =>
        within(breakdown).getByText(label).parentElement?.parentElement as HTMLElement;

      /** 1000 used − 400 instructions − 50 summary − 150 tool calls = 400 */
      expect(rowFor('com_ui_context_messages').textContent).toContain('400');
      expect(rowFor('com_ui_context_tool_calls').textContent).toContain('150');
    });

    it('widens the tool-call row for retained results without exceeding used tokens', async () => {
      const retainedToolSplit = JSON.parse(JSON.stringify(toolSplitView)) as TokenUsageView;
      retainedToolSplit.usedTokens = 1075;
      retainedToolSplit.percent = 53.75;
      retainedToolSplit.snapshot!.retainedToolTokens = 75;

      renderBreakdown({ view: retainedToolSplit });
      await userEvent.click(toggle());

      const breakdown = screen.getByTestId('context-breakdown');
      const rowFor = (label: string) =>
        within(breakdown).getByText(label).parentElement?.parentElement as HTMLElement;

      /** 1075 used − 400 instructions − 50 summary − 225 tool calls = 400
       *  messages: the 75 retained tokens sit outside the pre-invoke 550 total. */
      expect(rowFor('com_ui_context_messages').textContent).toContain('400');
      expect(rowFor('com_ui_context_tool_calls').textContent).toContain('225');

      /** The free track is the only visible peer outside the used context; all
       *  other peer rows must still add up exactly to the meter total. */
      const peerTotal = Array.from(breakdown.children)
        .filter(
          (child) =>
            !child.className.includes('pl-6') &&
            !child.textContent?.includes('com_ui_context_free'),
        )
        .reduce(
          (sum, child) => sum + Number.parseInt(child.lastElementChild?.textContent ?? '0', 10),
          0,
        );
      expect(peerTotal).toBe(1075);
    });
    it('shows every named tool result, including known zeroes, in the disclosure', async () => {
      const manyTools = JSON.parse(JSON.stringify(toolSplitView)) as TokenUsageView;
      manyTools.snapshot!.breakdown.toolMessageTokenCounts = {
        alpha: 30,
        beta: 20,
        gamma: 10,
        delta: 8,
        epsilon: 7,
        zeta: 5,
        eta: 3,
        zero_tool: 0,
      };
      manyTools.toolMessageTokenCounts = manyTools.snapshot!.breakdown.toolMessageTokenCounts;

      renderBreakdown({ view: manyTools });
      await userEvent.click(toggle());
      await userEvent.click(screen.getByRole('button', { name: /com_ui_context_tool_calls/ }));

      const details = screen.getByText('com_ui_context_tool_breakdown')
        .parentElement as HTMLElement;
      for (const name of [
        'alpha',
        'beta',
        'gamma',
        'delta',
        'epsilon',
        'zeta',
        'eta',
        'zero_tool',
      ]) {
        expect(within(details).getByText(name)).toBeInTheDocument();
      }
      expect(
        within(details).getByText('zero_tool').parentElement?.parentElement?.textContent,
      ).toContain('0');
    });

    it('renders a reported zero tool-call share instead of treating it as unavailable', async () => {
      const knownZero = JSON.parse(JSON.stringify(snapshotView)) as TokenUsageView;
      knownZero.snapshot!.breakdown.toolMessageTokens = 0;

      renderBreakdown({ view: knownZero });
      await userEvent.click(toggle());
      const breakdown = screen.getByTestId('context-breakdown');
      expect(within(breakdown).getByText('com_ui_context_tool_calls')).toBeInTheDocument();
      expect(
        within(breakdown).getByText('com_ui_context_tool_calls').parentElement?.parentElement
          ?.textContent,
      ).toContain('0');
    });

    it('uses a native disclosure button for the expandable tool list', async () => {
      renderBreakdown({ view: toolSplitView });
      await userEvent.click(toggle());

      const toolButton = screen.getByRole('button', { name: /com_ui_context_tool_calls/ });
      expect(toolButton).toHaveAttribute('aria-expanded', 'false');

      toolButton.focus();
      await userEvent.keyboard('{Enter}');

      expect(toolButton).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('com_ui_context_tool_breakdown')).toBeInTheDocument();
      expect(document.getElementById(toolButton.getAttribute('aria-controls')!)).toContainElement(
        screen.getByText('com_ui_context_tool_breakdown'),
      );
      await userEvent.keyboard(' ');
      expect(toolButton).toHaveAttribute('aria-expanded', 'false');
    });

    it('keeps the messages row unsplit when the snapshot lacks the tool split', async () => {
      renderBreakdown({ view: snapshotView });
      await userEvent.click(toggle());

      const breakdown = screen.getByTestId('context-breakdown');
      expect(within(breakdown).queryByText('com_ui_context_tool_calls')).toBeNull();
      expect(
        within(breakdown).getByText('com_ui_context_messages').parentElement?.parentElement
          ?.textContent,
      ).toContain('550');
    });

    it('shows cached prompt shares as a subtotal, not beside the context rows', async () => {
      const cached = {
        ...snapshotView,
        cacheRead: 30,
        cacheWrite: 10,
      } as TokenUsageView;
      renderBreakdown({ view: cached });
      await userEvent.click(toggle());

      const breakdown = screen.getByTestId('context-breakdown');
      const cachedRow = within(breakdown).getByText('com_ui_context_cached').parentElement
        ?.parentElement as HTMLElement;

      /** Reconciliation already counted the cached prompt inside the segments
       *  above, so these may only appear indented — as peer rows a fully cached
       *  prompt would show its tokens twice and the visible rows would sum past
       *  the meter. */
      expect(cachedRow.parentElement?.className).toContain('pl-6');
      expect(cachedRow.textContent).toContain('30');
      /** The share column is keyed to the window, like every row above: without
       *  it the cached row reads as a bare number beside rows that all carry a
       *  percentage, with the cell left blank. */
      expect(cachedRow.textContent).toContain('(2%)');
      const peers = Array.from(breakdown.children).filter(
        (child) => !child.className.includes('pl-6'),
      );
      expect(peers.some((peer) => peer.textContent?.includes('com_ui_context_cache_write'))).toBe(
        false,
      );
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    });

    it('hides the compaction hint when the operation is unavailable', async () => {
      renderBreakdown({
        view: { ...toolSplitView, runwayTurns: 2, compactionReclaim: 90000 },
        compactionAvailable: false,
      });
      await userEvent.click(toggle());
      await userEvent.click(screen.getByTestId('context-insights-toggle'));
      const hints = await screen.findByTestId('context-hints');
      expect(hints.textContent).toContain('com_ui_context_runway');
      expect(hints.textContent).not.toContain('com_ui_context_compaction');
    });

    it('warns under pressure inline, with insights behind the ⓘ button', async () => {
      const pressured = JSON.parse(JSON.stringify(toolSplitView)) as TokenUsageView;
      pressured.percent = 85;
      pressured.snapshot!.breakdown.toolMessageTokenCounts = {
        grep: 1500,
        read_file: 500,
      };
      pressured.toolMessageTokenCounts = pressured.snapshot!.breakdown.toolMessageTokenCounts;
      pressured.runwayTurns = 2;
      pressured.compactionReclaim = 90000;

      renderBreakdown({ view: pressured, compactionAvailable: true });
      await userEvent.click(toggle());

      /** Pressure warns inline; insights stay hidden until the ⓘ is hovered */
      expect(screen.getByText('com_ui_context_pressure_warn')).toBeInTheDocument();
      expect(screen.queryByTestId('context-hints')).toBeNull();

      const info = screen.getByTestId('context-insights-toggle');
      await userEvent.click(info);
      const hints = await screen.findByTestId('context-hints');
      expect(hints.textContent).toContain('com_ui_context_largest_tool');
      expect(hints.textContent).toContain('com_ui_context_runway');
      expect(hints.textContent).toContain('com_ui_context_compaction');

      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByTestId('context-hints')).toBeNull());
    });

    it('shows the danger tint at the hard threshold', async () => {
      const critical = JSON.parse(JSON.stringify(toolSplitView)) as TokenUsageView;
      critical.percent = 96;

      renderBreakdown({ view: critical });
      await userEvent.click(toggle());

      expect(screen.getByText('com_ui_context_pressure_danger')).toBeInTheDocument();
    });
  });

  describe('totals', () => {
    it('labels the usage section so the numbers are not read as context', async () => {
      renderBreakdown();
      await userEvent.click(toggle());

      expect(
        within(screen.getByTestId('token-usage-totals')).getByRole('heading', {
          name: 'com_ui_context_totals',
        }),
      ).toBeInTheDocument();
    });

    it('counts a cached subagent call in the all-branches subtotal', async () => {
      /** A fully cached subagent call reports its prompt under cacheRead and
       *  returns nothing: summing input+output alone would hide the row while
       *  the cache rows above still count the same traffic. */
      const cachedSubagent = {
        ...view,
        branchUsage: { ...view.branchUsage, cacheRead: 900 },
        subagentUsage: {
          input: 0,
          output: 0,
          cacheRead: 900,
          cacheWrite: 100,
          cost: 0,
          costKnown: true,
        },
      } as TokenUsageView;

      renderBreakdown({ view: cachedSubagent });
      await userEvent.click(toggle());

      const totals = within(screen.getByTestId('token-usage-totals'));
      expect(
        totals.getByText('com_ui_context_subagents_all').parentElement?.nextElementSibling,
      ).toHaveTextContent('1K');
    });
  });

  describe('langfuse', () => {
    const url = 'https://cloud.langfuse.com/project/project-1/sessions/conversation-1';

    it('renders the Langfuse session as an external link when available', async () => {
      renderBreakdown({ langfuseSessionUrl: url });
      await userEvent.click(toggle());

      expect(screen.getByRole('link', { name: 'com_ui_langfuse_view_session' })).toHaveAttribute(
        'href',
        url,
      );
      expect(screen.getByRole('link')).toHaveAttribute('target', '_blank');
    });

    it('omits the Langfuse session link when no traced message is available', async () => {
      renderBreakdown();
      await userEvent.click(toggle());

      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });
  });
});
