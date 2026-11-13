/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom/extend-expect';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { Constants, Tools } from 'librechat-data-provider';
import { render, screen, within, fireEvent } from '@testing-library/react';
import type { TokenUsageView } from '../../../../core/usage';
import { initEnglish } from '../../../../__fixtures__/i18n';
import Breakdown from '../Breakdown';

beforeAll(async () => {
  await initEnglish();
});

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

type BreakdownProps = React.ComponentProps<typeof Breakdown>;
type HostProps = Omit<BreakdownProps, 'expanded' | 'onExpandedChange'> & {
  initialExpanded?: boolean;
  onExpandedChange?: BreakdownProps['onExpandedChange'];
};

/** Stands in for the app container, which owns the expanded state. */
function Host({ initialExpanded = false, onExpandedChange, ...props }: HostProps) {
  const [expanded, setExpanded] = useState(initialExpanded);
  return (
    <Breakdown
      {...props}
      expanded={expanded}
      onExpandedChange={(next) => {
        setExpanded(next);
        onExpandedChange?.(next);
      }}
    />
  );
}

const renderBreakdown = (props: Partial<HostProps> = {}) =>
  render(<Host view={view} showCost={false} {...props} />);

const toggle = () => screen.getByTestId('context-breakdown-toggle');

describe('TokenUsage Breakdown', () => {
  describe('collapse', () => {
    it('shows context immediately and keeps conversation accounting collapsed', () => {
      renderBreakdown();

      expect(toggle()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.getByTestId('context-estimate')).toBeVisible();
      expect(screen.queryByRole('region', { name: 'Token totals' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('token-usage-totals')).not.toBeInTheDocument();
    });

    it('reveals the detail once expanded', async () => {
      renderBreakdown();

      await userEvent.click(toggle());

      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('region', { name: 'Token totals' })).toBeInTheDocument();
      expect(screen.getByTestId('token-usage-totals')).toBeVisible();
    });

    it('reports the disclosure choice to the host', async () => {
      const onExpandedChange = jest.fn();
      renderBreakdown({ onExpandedChange });
      await userEvent.click(toggle());
      expect(onExpandedChange).toHaveBeenCalledWith(true);
    });

    it('keeps the gauge readout visible while collapsed', () => {
      renderBreakdown({ view: snapshotView });

      expect(screen.getByText('1K / 2K')).toBeVisible();
      expect(screen.getByText('50%')).toBeVisible();
      expect(screen.getByTestId('context-breakdown')).toHaveClass('grid-cols-2');
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

      const breakdown = screen.getByTestId('context-breakdown');
      const rowFor = (label: string) =>
        within(breakdown).getByText(label).parentElement as HTMLElement;

      const system = rowFor('System tools').firstElementChild as HTMLElement;
      const deferred = rowFor('System tools (deferred)').firstElementChild as HTMLElement;

      expect(system).toHaveClass('bg-series-4');
      expect(deferred).toHaveClass('bg-series-4');
      expect(deferred.getAttribute('style')).toContain('repeating-linear-gradient');
    });

    it('renders the Messages segment solid, like every other series', async () => {
      renderBreakdown({ view: snapshotView });

      const messages = within(screen.getByTestId('context-breakdown')).getByText('Messages')
        .parentElement?.firstElementChild as HTMLElement;

      expect(messages).toHaveClass('bg-series-1');
      expect(messages.className).not.toContain('ring-series-1');
    });

    it('dims the other bar segments while a legend row is hovered', async () => {
      renderBreakdown({ view: snapshotView });

      const segments = Array.from(screen.getByRole('progressbar').children) as HTMLElement[];
      const rowFor = (label: string) =>
        within(screen.getByTestId('context-breakdown'))
          .getByText(label)
          .closest('div') as HTMLElement;

      fireEvent.pointerEnter(rowFor('Messages'));

      expect(segments[0].className).not.toContain('opacity-40');
      segments.slice(1).forEach((segment) => expect(segment).toHaveClass('opacity-40'));
      expect(rowFor('System prompt').lastElementChild).toHaveClass('opacity-70');
      expect(rowFor('Messages').lastElementChild).not.toHaveClass('opacity-70');

      fireEvent.pointerLeave(rowFor('Messages'));

      segments.forEach((segment) => expect(segment.className).not.toContain('opacity-40'));
      expect(rowFor('System prompt').lastElementChild).not.toHaveClass('opacity-70');
    });

    it('recedes every segment when the free track row is hovered', async () => {
      renderBreakdown({ view: snapshotView });

      const segments = Array.from(screen.getByRole('progressbar').children) as HTMLElement[];
      const rowFor = (label: string) =>
        within(screen.getByTestId('context-breakdown'))
          .getByText(label)
          .closest('div') as HTMLElement;

      fireEvent.pointerEnter(rowFor('Free space'));

      segments.forEach((segment) => expect(segment).toHaveClass('opacity-40'));
    });

    it('highlights an available tool-call row even when its count is zero', () => {
      const zeroTools = JSON.parse(JSON.stringify(snapshotView)) as TokenUsageView;
      zeroTools.snapshot!.breakdown.toolMessageTokens = 0;
      renderBreakdown({ view: zeroTools });
      const legend = within(screen.getByTestId('context-breakdown'));
      fireEvent.pointerEnter(legend.getByText('Tool calls').closest('div')!);
      expect(legend.getByText('Messages').parentElement).toHaveClass('opacity-70');
      expect(legend.getByText('Tool calls').parentElement).not.toHaveClass('opacity-70');
    });

    it('drops the dimming when the hovered row disappears from a live update', async () => {
      const noSubagents = JSON.parse(JSON.stringify(snapshotView)) as TokenUsageView;
      delete noSubagents.snapshot?.breakdown.toolTokenCounts?.[Constants.SUBAGENT];

      const { rerender } = renderBreakdown({ view: snapshotView });

      const segments = () => Array.from(screen.getByRole('progressbar').children) as HTMLElement[];
      const rowFor = (label: string) =>
        within(screen.getByTestId('context-breakdown'))
          .getByText(label)
          .closest('div') as HTMLElement;

      fireEvent.pointerEnter(rowFor('Subagents'));
      segments().forEach((segment, index) =>
        expect(segment.classList.contains('opacity-40')).toBe(index !== 7),
      );

      rerender(<Host view={noSubagents} showCost={false} />);

      segments().forEach((segment) => expect(segment.className).not.toContain('opacity-40'));

      /** The hover state is cleared, not masked: the row reappearing on a later
       *  live update must not bring the stale dimming back. */
      rerender(<Host view={snapshotView} showCost={false} />);

      segments().forEach((segment) => expect(segment.className).not.toContain('opacity-40'));
    });

    it('leaves the estimate path unsegmented, with no swatches on its rows', async () => {
      renderBreakdown();

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

      const estimate = screen.getByTestId('context-estimate');
      const peerTotal = Array.from(estimate.children)
        .filter((child) => !child.className.includes('ps-6'))
        .reduce((sum, child) => sum + Number(child.lastElementChild?.textContent ?? 0), 0);

      /** 300 input + 200 output + 100 estimated = 600 used. The tool share is a
       *  subset of those rows, so it may only appear as an indented subtotal,
       *  as a peer row the visible rows would claim 750 of a 600-token window. */
      expect(peerTotal).toBe(600);

      const toolRow = within(estimate).getByText('Tool calls').parentElement
        ?.parentElement as HTMLElement;
      expect(toolRow.parentElement?.className).toContain('ps-6');
      expect(toolRow.textContent).toContain('150');
    });
    it('splits tool-call usage out of the messages row when reported', async () => {
      renderBreakdown({ view: toolSplitView });

      const breakdown = screen.getByTestId('context-breakdown');
      const rowFor = (label: string) =>
        within(breakdown).getByText(label).parentElement?.parentElement as HTMLElement;

      /** 1000 used − 400 instructions − 50 summary − 150 tool calls = 400 */
      expect(rowFor('Messages').textContent).toContain('400');
      expect(rowFor('Tool calls').textContent).toContain('150');
    });

    it('widens the tool-call row for retained results without exceeding used tokens', async () => {
      const retainedToolSplit = JSON.parse(JSON.stringify(toolSplitView)) as TokenUsageView;
      retainedToolSplit.usedTokens = 1075;
      retainedToolSplit.percent = 53.75;
      retainedToolSplit.snapshot!.retainedToolTokens = 75;

      renderBreakdown({ view: retainedToolSplit });

      const breakdown = screen.getByTestId('context-breakdown');
      const rowFor = (label: string) =>
        within(breakdown).getByText(label).parentElement?.parentElement as HTMLElement;

      /** 1075 used − 400 instructions − 50 summary − 225 tool calls = 400
       *  messages: the 75 retained tokens sit outside the pre-invoke 550 total. */
      expect(rowFor('Messages').textContent).toContain('400');
      expect(rowFor('Tool calls').textContent).toContain('225');

      /** The free track is the only visible peer outside the used context; all
       *  other peer rows must still add up exactly to the meter total. */
      const peerTotal = Array.from(breakdown.children)
        .filter(
          (child) =>
            !child.className.includes('ps-6') && !child.textContent?.includes('Free space'),
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
      await userEvent.click(screen.getByRole('button', { name: /Tool calls/ }));

      const details = screen.getByText('By tool').parentElement as HTMLElement;
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
      const breakdown = screen.getByTestId('context-breakdown');
      expect(within(breakdown).getByText('Tool calls')).toBeInTheDocument();
      expect(
        within(breakdown).getByText('Tool calls').parentElement?.parentElement?.textContent,
      ).toContain('0');
    });

    it('uses a native disclosure button for the expandable tool list', async () => {
      renderBreakdown({ view: toolSplitView });

      const toolButton = screen.getByRole('button', { name: /Tool calls/ });
      expect(toolButton).toHaveAttribute('aria-expanded', 'false');

      toolButton.focus();
      await userEvent.keyboard('{Enter}');

      expect(toolButton).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('By tool')).toBeInTheDocument();
      expect(document.getElementById(toolButton.getAttribute('aria-controls')!)).toContainElement(
        screen.getByText('By tool'),
      );
      await userEvent.keyboard(' ');
      expect(toolButton).toHaveAttribute('aria-expanded', 'false');
    });

    it('keeps the messages row unsplit when the snapshot lacks the tool split', async () => {
      renderBreakdown({ view: snapshotView });

      const breakdown = screen.getByTestId('context-breakdown');
      expect(within(breakdown).queryByText('Tool calls')).toBeNull();
      expect(
        within(breakdown).getByText('Messages').parentElement?.parentElement?.textContent,
      ).toContain('550');
    });

    it('keeps cached traffic inside the context meter without duplicate legend rows', () => {
      renderBreakdown({ view: { ...snapshotView, cacheRead: 30, cacheWrite: 10 } });
      expect(screen.queryByText('Cached')).not.toBeInTheDocument();
      expect(screen.queryByText('Cache write')).not.toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    });

    it('keeps the pressure warning without an insights control', () => {
      renderBreakdown({
        view: { ...toolSplitView, percent: 85, runwayTurns: 2, compactionReclaim: 90000 },
      });
      expect(screen.getByText('Context window is filling up')).toBeInTheDocument();
      expect(screen.queryByTestId('context-insights-toggle')).not.toBeInTheDocument();
      expect(screen.queryByTestId('context-hints')).not.toBeInTheDocument();
    });

    it('shows the danger tint at the hard threshold', async () => {
      const critical = JSON.parse(JSON.stringify(toolSplitView)) as TokenUsageView;
      critical.percent = 96;

      renderBreakdown({ view: critical });

      expect(screen.getByText('Context window is almost full')).toBeInTheDocument();
    });
  });

  describe('totals', () => {
    it('labels the usage section so the numbers are not read as context', async () => {
      renderBreakdown();
      await userEvent.click(toggle());

      expect(toggle()).toHaveAccessibleName('Token totals');
      expect(
        within(screen.getByTestId('token-usage-totals')).queryByRole('heading'),
      ).not.toBeInTheDocument();
      const totals = screen.getByTestId('token-usage-totals');
      expect(totals).not.toHaveClass('border', 'p-3');
      expect(within(totals).queryByRole('button')).not.toBeInTheDocument();
      expect(within(totals).getByText('Input (uncached)')).toBeVisible();
      expect(within(totals).queryByText('This branch')).not.toBeInTheDocument();
    });

    it('leaves all-branch subagent accounting in conversation info', async () => {
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
      expect(totals.queryByText('Subagents (all branches)')).not.toBeInTheDocument();
    });
  });

  describe('conversation accounting', () => {
    it.each([true, false])(
      'does not show sibling totals on an unrecorded branch, showCost=%s',
      async (showCost) => {
        renderBreakdown({
          view: {
            ...view,
            hasUsage: false,
            branchUsage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              costKnown: false,
            },
            branchCost: 0,
            totalUsage: {
              input: 40,
              output: 5,
              cacheRead: 800,
              cacheWrite: 30,
              cost: 0.02,
              costKnown: true,
            },
            totalCost: 0.02,
          },
          showCost,
        });
        expect(screen.queryByTestId('context-breakdown-toggle')).not.toBeInTheDocument();
        expect(screen.queryByTestId('token-usage-totals')).not.toBeInTheDocument();
        expect(screen.queryByTestId('token-usage-all-branches')).not.toBeInTheDocument();
        expect(screen.queryByTestId('usage-cost')).not.toBeInTheDocument();
      },
    );

    it('distinguishes a recorded turn from branch and all-branches cache usage', async () => {
      renderBreakdown({
        view: {
          ...view,
          lastTurnUsage: {
            input: 20,
            output: 5,
            cacheRead: 700,
            cacheWrite: 90,
            cost: 0.004,
            costKnown: true,
          },
          branchUsage: {
            input: 120,
            output: 15,
            cacheRead: 800,
            cacheWrite: 90,
            cost: 0.01,
            costKnown: true,
          },
          totalUsage: {
            input: 140,
            output: 20,
            cacheRead: 900,
            cacheWrite: 90,
            cost: 0.02,
            costKnown: true,
          },
          branchCost: 0.01,
          totalCost: 0.02,
        },
        showCost: true,
      });
      await userEvent.click(toggle());

      expect(screen.queryByTestId('token-usage-last-turn')).not.toBeInTheDocument();
      const totals = within(screen.getByTestId('token-usage-totals'));
      expect(totals.queryByText('This branch')).not.toBeInTheDocument();
      expect(totals.getByText('Cache read').parentElement?.parentElement).toHaveTextContent('800');
      expect(screen.queryByTestId('token-usage-all-branches')).not.toBeInTheDocument();
      expect(within(toggle()).getByTestId('usage-cost')).toHaveTextContent('$0.01');
    });

    it('does not expose all-branches token differences or incomplete branch cost', async () => {
      renderBreakdown({
        view: {
          ...view,
          lastTurnUsage: {
            input: 1,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            costKnown: true,
          },
          branchUsage: { ...view.branchUsage, costKnown: false },
          totalUsage: { ...view.totalUsage, cacheWrite: 25, costKnown: false },
        },
        showCost: true,
      });
      await userEvent.click(toggle());
      expect(screen.queryByTestId('token-usage-all-branches')).not.toBeInTheDocument();
      expect(screen.queryByTestId('usage-cost')).not.toBeInTheDocument();
    });

    it.each([true, false])(
      'leaves turn details on the response, streaming=%s',
      (turnInProgress) => {
        renderBreakdown({
          view: { ...view, lastTurnUsage: undefined, turnInProgress },
          showCost: true,
        });
        expect(screen.queryByTestId('token-usage-last-turn')).not.toBeInTheDocument();
        expect(screen.queryByText('Waiting for model usage...')).not.toBeInTheDocument();
      },
    );
  });

  describe('langfuse', () => {
    const url = 'https://cloud.langfuse.com/project/project-1/sessions/conversation-1';

    it('renders the Langfuse session as an external link when available', async () => {
      renderBreakdown({ langfuseSessionUrl: url });
      await userEvent.click(toggle());

      expect(screen.getByRole('link', { name: 'View session in Langfuse' })).toHaveAttribute(
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
