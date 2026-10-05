import React, { Profiler } from 'react';
import { RecoilRoot } from 'recoil';
import { act, render } from '@testing-library/react';
import { ContentTypes, Tools } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessageContentParts } from 'librechat-data-provider';
import ContentParts from './ContentParts';

/**
 * Render benchmark for a live agent run: one recorded-shape stream (batches of
 * tool calls whose `intent` and args grow per delta, then outputs, then the
 * batch label, then the phase summary and the answer) replayed through the
 * real `ContentParts` tree. Lives outside `__tests__/` and is named
 * `.bench.tsx` so the default jest run skips it; execute it explicitly with:
 *
 *   node node_modules/jest/bin/jest.js --runInBand --coverage=false \
 *     --testMatch '**\/ContentParts.bench.tsx'
 *
 * Reported per scenario:
 *  - commits / totalMs: React Profiler commit count and summed actualDuration
 *    (jsdom wall-clock is not browser-accurate; the before/after ratio is).
 *  - peakNodes / nodeSteps: the largest DOM the run reached and the summed DOM
 *    size over every snapshot — deterministic stand-ins for mounted work.
 *  - shapeChanges: snapshots at which the element count moved, the closest
 *    jsdom gets to "the block changed height".
 */

jest.mock('~/hooks/MCP', () => {
  const mcpServerNames: string[] = ['clickhouse'];
  return {
    useMCPIconMap: () => new Map(),
    useMCPServerNames: () => mcpServerNames,
  };
});

type Snapshot = TMessageContentParts[];

const BATCHES = 4;
const DELTAS_PER_TOOL = 12;
const TEXT_DELTAS = 40;

const INTENTS = [
  'Reading the lens reference to confirm which recovery section is missing.',
  'Querying the indexed graph for both Redis recovery references.',
  'Checking the current PR head and repository design guidance before selecting an execution model.',
];
const NAMES = ['read_file', 'run_select_query_mcp_clickhouse', Tools.execute_code];
const LABELS = [
  'Loaded architecture workflow for Redis script execution',
  'Confirmed PR 16069 head and missing lens reference',
  'Confirmed both Redis recovery refs share commit',
  'Compared script caching against operation ordering',
];
const SUMMARY =
  'Validated Redis recovery references against PR 16069, identifying the missing lens reference';
const ANSWER =
  'Yes, we can aim to merge before release. But the design needs to separate script caching from operation ordering, rather than make the cache helper responsible for both. '.repeat(
    4,
  );

const toolPart = (id: string, name: string, args: string, output: string): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id,
      name,
      args,
      output,
      type: 'tool_call',
      progress: output ? 1 : 0.1,
    },
  }) as unknown as TMessageContentParts;

const labelPart = (text: string, ids: string[]): TMessageContentParts =>
  ({
    type: ContentTypes.ACTIVITY_LABEL,
    [ContentTypes.ACTIVITY_LABEL]: text,
    tool_call_ids: ids,
    pending: text.length === 0,
  }) as unknown as TMessageContentParts;

const argsAt = (tool: number, delta: number): string => {
  const intent = INTENTS[tool];
  const head = intent.slice(0, Math.ceil((intent.length * Math.min(delta, 6)) / 6));
  if (delta <= 6) {
    return `{"intent":"${head}`;
  }
  return `{"intent":"${intent}","code":"${'x = compute(1)\\n'.repeat(delta - 6)}`;
};

function buildStream(labelled: boolean): Snapshot[] {
  const snapshots: Snapshot[] = [];
  let content: Snapshot = [];
  const commit = (next: Snapshot) => {
    content = next;
    snapshots.push(next);
  };
  const replace = (index: number, part: TMessageContentParts) => {
    const next = content.slice();
    next[index] = part;
    commit(next);
  };
  for (let batch = 0; batch < BATCHES; batch += 1) {
    const base = content.length;
    const ids = NAMES.map((_, tool) => `call_${batch}_${tool}`);
    for (let tool = 0; tool < NAMES.length; tool += 1) {
      commit([...content, toolPart(ids[tool], NAMES[tool], '', '')]);
    }
    for (let delta = 1; delta <= DELTAS_PER_TOOL; delta += 1) {
      for (let tool = 0; tool < NAMES.length; tool += 1) {
        replace(base + tool, toolPart(ids[tool], NAMES[tool], argsAt(tool, delta), ''));
      }
    }
    for (let tool = 0; tool < NAMES.length; tool += 1) {
      const args = `${argsAt(tool, DELTAS_PER_TOOL)}"}`;
      replace(base + tool, toolPart(ids[tool], NAMES[tool], args, 'ok: 3 rows'));
    }
    commit([...content, labelPart('', ids)]);
    if (labelled) {
      replace(content.length - 1, labelPart(LABELS[batch], ids));
    }
  }
  if (labelled) {
    commit([
      ...content,
      {
        type: ContentTypes.ACTIVITY_LABEL,
        [ContentTypes.ACTIVITY_LABEL]: SUMMARY,
        activity_label_type: 'phase',
        activity_start_index: 0,
        activity_end_index: content.length,
        activity_count: BATCHES,
        pending: false,
      } as unknown as TMessageContentParts,
    ]);
  }
  const textIndex = content.length;
  for (let delta = 1; delta <= TEXT_DELTAS; delta += 1) {
    const text = ANSWER.slice(0, Math.ceil((ANSWER.length * delta) / TEXT_DELTAS));
    const next = content.slice();
    next[textIndex] = { type: ContentTypes.TEXT, text } as unknown as TMessageContentParts;
    commit(next);
  }
  return snapshots;
}

type Result = {
  commits: number;
  totalMs: number;
  peakNodes: number;
  nodeSteps: number;
  shapeChanges: number;
};

function replay(snapshots: Snapshot[]): Result {
  const result: Result = { commits: 0, totalMs: 0, peakNodes: 0, nodeSteps: 0, shapeChanges: 0 };
  const queryClient = new QueryClient();
  const tree = (content: Snapshot, isSubmitting: boolean) => (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <Profiler
          id="run"
          onRender={(_id, _phase, actualDuration) => {
            result.commits += 1;
            result.totalMs += actualDuration;
          }}
        >
          <ContentParts
            content={content}
            messageId="bench-message"
            conversationId="bench-convo"
            isCreatedByUser={false}
            isLast
            isLatestMessage
            isSubmitting={isSubmitting}
            showThinking={false}
          />
        </Profiler>
      </RecoilRoot>
    </QueryClientProvider>
  );
  jest.useFakeTimers();
  const view = render(tree([], true));
  let previousNodes = -1;
  for (const content of snapshots) {
    view.rerender(tree(content, true));
    /** A delta every 50ms, so anything time-based sees a realistic stream. */
    act(() => {
      jest.advanceTimersByTime(50);
    });
    const nodes = view.container.getElementsByTagName('*').length;
    result.peakNodes = Math.max(result.peakNodes, nodes);
    result.nodeSteps += nodes;
    if (previousNodes >= 0 && nodes !== previousNodes) {
      result.shapeChanges += 1;
    }
    previousNodes = nodes;
  }
  view.rerender(tree(snapshots[snapshots.length - 1], false));
  act(() => {
    jest.advanceTimersByTime(1000);
  });
  view.unmount();
  jest.useRealTimers();
  return result;
}

const median = (values: number[]): number =>
  values.slice().sort((a, b) => a - b)[values.length >> 1];

describe('ContentParts live-run render benchmark', () => {
  it.each([
    ['labelled run (activity labels on)', true],
    ['unlabelled run (feature off)', false],
  ])('%s', (name, labelled) => {
    const snapshots = buildStream(labelled);
    replay(snapshots);
    const runs = [replay(snapshots), replay(snapshots), replay(snapshots)];
    const report = {
      scenario: name,
      snapshots: snapshots.length,
      commits: runs[0].commits,
      totalMs: Number(median(runs.map((run) => run.totalMs)).toFixed(1)),
      peakNodes: runs[0].peakNodes,
      nodeSteps: runs[0].nodeSteps,
      shapeChanges: runs[0].shapeChanges,
    };
    console.log(`BENCH ${JSON.stringify(report)}`);
    expect(report.commits).toBeGreaterThan(0);
  });
});
