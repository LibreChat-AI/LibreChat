import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider, useSetAtom } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ContentTypes, Tools, Constants, ToolCallTypes } from 'librechat-data-provider';
import type {
  TAttachment,
  TMessage,
  TMessageContentParts,
  SearchResultData,
} from 'librechat-data-provider';
import { resolveAskUserQuestionPart } from '~/utils/approval';
import { sandboxStartingByToolCallId } from '~/store';
import ContentParts from '../ContentParts';
import { getLiveActivity } from '../live';
import store from '~/store';

/**
 * Parity between a live fold and the cards it unmounts.
 *
 * The folded row takes over everything its hidden cards used to say, so the
 * contract is agreement, not a list of examples: given the same call and the
 * attachments it owns, the REAL card and the folded summary must reach the
 * same verdict. Nothing that decides an outcome is mocked here — the error
 * parser, the phase resolver and the specialized cards are the real ones; only
 * the MCP lookups, which need a server, are replaced.
 */
jest.mock('~/hooks/MCP', () => {
  const mcpServerNames: string[] = [];
  return { useMCPIconMap: () => new Map(), useMCPServerNames: () => mcpServerNames };
});

type Verdict = 'running' | 'completed' | 'failed' | 'cancelled';

type Fixture = {
  name: string;
  call: Record<string, unknown>;
  attachments?: TAttachment[];
  verdict: Verdict;
};

const HANDLE = JSON.stringify({
  background_task_id: 'bg1',
  tool: 'lookup',
  status: 'running',
  message: 'Dispatched. Poll with check_background_task.',
});

const statusAttachment = (status: string, toolCallId = 't1'): TAttachment =>
  ({
    type: 'background_task_status',
    status,
    toolCallId,
    messageId: 'm1',
  }) as unknown as TAttachment;

const memoryErrorAttachment = {
  type: Tools.memory,
  toolCallId: 't1',
  messageId: 'm1',
  [Tools.memory]: { type: 'error', key: 'diet', value: 'over the limit' },
} as unknown as TAttachment;

const FIXTURES: Fixture[] = [
  { name: 'a call still running', call: { name: 'lookup', output: '' }, verdict: 'running' },
  { name: 'a completed call', call: { name: 'lookup', output: 'rows' }, verdict: 'completed' },
  {
    name: 'a step the run closed as failed with benign output',
    call: { name: 'lookup', output: 'rows', runStepStatus: 'failed' },
    verdict: 'failed',
  },
  {
    name: 'a step the run closed as cancelled',
    call: { name: 'lookup', output: '', runStepStatus: 'cancelled' },
    verdict: 'cancelled',
  },
  {
    name: 'error-shaped output with no terminal status',
    call: { name: 'lookup', output: 'Error processing tool: connection refused' },
    verdict: 'failed',
  },
  {
    name: 'a memory tool failing in prose',
    call: { name: 'set_memory', output: 'Invalid key "x". Must be one of: diet' },
    verdict: 'failed',
  },
  {
    name: 'a memory tool failing through its error artifact',
    call: { name: 'set_memory', output: 'Memory set for key "diet"' },
    attachments: [memoryErrorAttachment],
    verdict: 'failed',
  },
  {
    name: 'a detached task that failed through its status attachment',
    call: { name: Tools.execute_code, output: HANDLE, runStepStatus: 'completed' },
    attachments: [statusAttachment('error')],
    verdict: 'failed',
  },
  {
    name: 'a detached task cancelled through its status attachment',
    call: { name: Tools.execute_code, output: HANDLE, runStepStatus: 'completed' },
    attachments: [statusAttachment('cancelled')],
    verdict: 'cancelled',
  },
  {
    name: 'a detached task carrying the cancelled flag',
    call: {
      name: Tools.execute_code,
      output: HANDLE,
      runStepStatus: 'completed',
      backgroundTask: { cancelled: true },
    },
    verdict: 'cancelled',
  },
  {
    name: 'a status attachment that belongs to a different call',
    call: { name: Tools.execute_code, output: HANDLE, runStepStatus: 'completed' },
    attachments: [statusAttachment('error', 'someone-else')],
    verdict: 'completed',
  },
];

const toPart = (call: Record<string, unknown>, id = 't1'): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id,
      args: '{}',
      type: 'tool_call',
      progress: call.output ? 1 : 0.1,
      ...call,
    },
  }) as unknown as TMessageContentParts;

const mount = (
  content: TMessageContentParts[],
  attachments: TAttachment[] | undefined,
  fold: boolean,
  searchResults?: Record<string, SearchResultData>,
) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RecoilRoot>
        <ContentParts
          content={content}
          attachments={attachments}
          searchResults={searchResults}
          messageId="m1"
          conversationId="c1"
          isCreatedByUser={false}
          isLast
          isLatestMessage
          isSubmitting
          showThinking={false}
          foldLiveActivity={fold}
        />
      </RecoilRoot>
    </QueryClientProvider>,
  );

/** What the real card says, read the way a user would, in the real English
 *  strings: `ProgressText` appends "failed" on `failed`, swaps in the stop
 *  glyph on `cancelled`, and shimmers while `running`. */
const cardVerdict = (container: HTMLElement): Verdict => {
  if (/failed/i.test(container.textContent ?? '')) {
    return 'failed';
  }
  if (container.querySelector('.lucide-x') != null) {
    return 'cancelled';
  }
  return container.querySelector('.shimmer') != null ? 'running' : 'completed';
};

const foldVerdict = (): Verdict => {
  const card = screen.getByTestId('activity-phase-card');
  const outcome = within(card).queryByTestId('live-phase-outcome')?.textContent ?? '';
  if (outcome.includes('failed')) {
    return 'failed';
  }
  if (outcome.includes('cancelled')) {
    return 'cancelled';
  }
  return /^Running (?!in background)/.test(within(card).getAllByRole('button')[0].textContent ?? '')
    ? 'running'
    : 'completed';
};

describe('live combo aggregation', () => {
  const activity = (parts: Array<TMessageContentParts | undefined>) =>
    getLiveActivity(parts, (key) => key, []);

  it('counts a long repeated suffix without reading the historical prefix twice per delta', () => {
    const parts = Array.from({ length: 1024 }, (_, index) =>
      toPart({ name: 'lookup', output: 'ok' }, `call-${index}`),
    );
    const first = parts[0];
    const readFirst = jest.fn(() => first);
    Object.defineProperty(parts, 0, { get: readFirst });

    for (const intent of ['Checking', 'Checking the', 'Checking the last file']) {
      parts[parts.length - 1] = toPart({ name: 'lookup', args: { intent } }, 'tail');
      readFirst.mockClear();
      /** A tail that names its own work hides the count, but the span pass
       *  still reaches the head, and must do so exactly once per delta. */
      expect(activity(parts).comboCount).toBe(1);
      expect(readFirst).toHaveBeenCalledTimes(1);
    }

    /** The same 1,024 parts under a generic tail: the whole suffix counts, on
     *  the same single prefix read. */
    parts[parts.length - 1] = toPart({ name: 'lookup', output: 'ok' }, 'tail');
    readFirst.mockClear();
    expect(activity(parts).comboCount).toBe(1024);
    expect(readFirst).toHaveBeenCalledTimes(1);
  });

  it('counts only the suffix, ignoring descriptive metadata and sparse slots', () => {
    const call = (name: string) => toPart({ name, output: 'ok' });
    expect(
      activity([
        call('read_file'),
        call('edit_file'),
        call('read_file'),
        undefined,
        { type: ContentTypes.THINK, think: 'Checking another file' },
        { type: ContentTypes.ACTIVITY_LABEL, activity_label: 'Read a file' },
        call('read_file'),
      ]).comboCount,
    ).toBe(2);
  });

  it('uses full tool identity, not the shared MCP server or icon', () => {
    expect(
      activity([
        toPart({ name: 'read_mcp_workspace', output: 'ok' }),
        toPart({ name: 'edit_mcp_workspace', output: 'ok' }),
      ]).comboCount,
    ).toBe(1);
  });

  it('reuses normalized Bash identity and recomputes it when streamed arguments change', () => {
    const first = toPart({ name: Tools.bash_tool, output: 'ok' });
    const programmatic = (lang: string) =>
      toPart({ name: Constants.PROGRAMMATIC_TOOL_CALLING, args: { lang } });
    expect(activity([first, programmatic('bash')]).comboCount).toBe(2);
    expect(activity([first, programmatic('python')]).comboCount).toBe(1);
  });

  it.each<TMessageContentParts>([
    { type: ContentTypes.THINK, think: 'Considering the results' },
    { type: ContentTypes.TEXT, text: 'Checking the results', phase: 'commentary' },
    { type: ContentTypes.ACTIVITY_LABEL, activity_label: 'Checked the results' },
  ])('does not attach a tool multiplier to a trailing $type line', (tail) => {
    expect(
      activity([
        toPart({ name: 'lookup', output: 'ok' }, 'first'),
        toPart({ name: 'lookup', output: 'ok' }, 'second'),
        tail,
      ]).comboCount,
    ).toBe(1);
  });
});

describe('live fold parity with the cards it hides', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(FIXTURES)('agrees with the real card on $name', ({ call, attachments, verdict }) => {
    jest.useFakeTimers();
    const cards = mount([toPart(call)], attachments, false);
    /** A card eases its progress to completion over a few hundred ms; the
     *  verdict compared is the one it settles on, not the animation's lag. */
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(cardVerdict(cards.container)).toBe(verdict);
    cards.unmount();

    mount([toPart(call)], attachments, true);
    expect(foldVerdict()).toBe(verdict);
  });

  it('does not charge a reused provider id with what an earlier step produced', () => {
    /** Provider ids repeat across steps. The first save failed through an
     *  error artifact owned by its step; the second, with no step of its own
     *  yet, succeeded and must not inherit that artifact. */
    const earlier = toPart(
      { name: 'set_memory', output: 'Memory set for key "diet"', stepId: 's1' },
      'dup',
    );
    const later = toPart({ name: 'set_memory', output: 'Memory set for key "diet"' }, 'dup');
    const artifact = { ...memoryErrorAttachment, toolCallId: 'dup', stepId: 's1' } as TAttachment;
    mount([earlier, later], [artifact], true);
    const button = within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0];

    expect(within(button).getByTestId('live-phase-outcome')).toHaveTextContent('1 failed');
    expect(button).not.toHaveTextContent(/^Failed/);
  });

  it('keeps a subagent card available even after its dispatch settles', () => {
    /** Its card follows the subagent progress atom, which the row cannot. */
    const running = mount([toPart({ name: 'subagent', output: '' })], undefined, true);
    expect(screen.queryByTestId('activity-phase-card')).toBeNull();
    running.unmount();

    mount([toPart({ name: 'subagent', output: 'done' })], undefined, true);
    expect(screen.queryByTestId('activity-phase-card')).toBeNull();
  });

  it('shows a multiplier for consecutive uses of the same tool and resets on a different tool', () => {
    jest.useFakeTimers();
    const first = toPart({ name: 'create_file', output: 'created' }, 'first');
    const second = toPart({ name: 'create_file', output: '' }, 'second');
    const view = mount([first, second], undefined, true);

    expect(screen.getByTestId('live-phase-combo')).toHaveTextContent('×2');
    expect(
      within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0],
    ).toHaveAccessibleName(/×2/);

    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <RecoilRoot>
          <ContentParts
            content={[first, second, toPart({ name: 'edit_file', output: '' }, 'third')]}
            messageId="m1"
            conversationId="c1"
            isCreatedByUser={false}
            isLast
            isLatestMessage
            isSubmitting
            showThinking={false}
          />
        </RecoilRoot>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('live-phase-combo')).toHaveTextContent('×2');
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(screen.queryByTestId('live-phase-combo')).toBeNull();
  });

  it('prints the multiplier beside the line it counts, not at the row edge', () => {
    mount(
      [
        toPart({ name: 'create_file', output: 'created' }, 'first'),
        toPart({ name: 'create_file', output: '' }, 'second'),
      ],
      undefined,
      true,
    );
    const header = within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0];
    const [lineId] = (header.getAttribute('aria-labelledby') ?? '').split(' ');
    const line = document.getElementById(lineId);
    const combo = screen.getByTestId('live-phase-combo');

    expect(line).not.toBeNull();
    /** One flex track with the line, directly after the box holding it: the
     *  count belongs to that line, so nothing may sit between them and the
     *  row's free space has to open up after the pair, not inside it. */
    expect(combo.parentElement).toContainElement(line);
    expect(combo.previousElementSibling).toContainElement(line);
    expect(combo.previousElementSibling?.className).not.toContain('flex-1');
    expect(combo.nextElementSibling).toBeNull();
  });

  it('keeps the whole row for a line with no multiplier', () => {
    /** The reasoning preview decides whether it may stream freely by comparing
     *  itself to the row, so a lone line must still be measured full width. */
    mount([toPart({ name: 'create_file', output: '' }, 'only')], undefined, true);
    const header = within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0];
    const [lineId] = (header.getAttribute('aria-labelledby') ?? '').split(' ');

    expect(screen.queryByTestId('live-phase-combo')).toBeNull();
    expect(document.getElementById(lineId)?.parentElement?.className).toContain('flex-1');
  });

  it('keeps the span verdict after the multiplier', () => {
    mount(
      [
        toPart({ name: 'create_file', output: 'created', runStepStatus: 'failed' }, 'first'),
        toPart({ name: 'create_file', output: '' }, 'second'),
      ],
      undefined,
      true,
    );
    const combo = screen.getByTestId('live-phase-combo');
    const outcome = screen.getByTestId('live-phase-outcome');

    expect(combo).toHaveTextContent('×2');
    expect(outcome).toHaveTextContent('1 failed');
    /** The count reads with the line; the verdict stays where the row ends. */
    expect(combo.compareDocumentPosition(outcome) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(combo.parentElement).not.toContainElement(outcome);
    expect(
      within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0],
    ).toHaveAccessibleName(/×2 · 1 failed$/);
  });

  it('changes the multiplier with the throttled status line', () => {
    jest.useFakeTimers();
    /** Generic lines, because only those carry a count: the multiplier has to
     *  arrive with the line it belongs to, not a paint ahead of it. */
    const first = toPart({ name: 'create_file', output: 'created' }, 'first');
    const second = toPart({ name: 'create_file', output: '' }, 'second');
    const view = mount([first], undefined, true);
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <RecoilRoot>
          <ContentParts
            content={[first, second]}
            messageId="m1"
            conversationId="c1"
            isCreatedByUser={false}
            isLast
            isLatestMessage
            isSubmitting
            showThinking={false}
          />
        </RecoilRoot>
      </QueryClientProvider>,
    );

    const header = within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0];
    expect(header).toHaveAccessibleName('Ran Create File');
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(header).toHaveAccessibleName('Running Create File ×2');
  });

  it('drops the multiplier as soon as the call names its own work', () => {
    /** A count modifies the tool's name. Once the line is a sentence about
     *  this call, `×2` reads as a claim about the sentence. */
    const view = mount(
      [
        toPart({ name: 'create_file', output: 'created' }, 'first'),
        toPart({ name: 'create_file', args: '{"intent":"Creating the second file"}' }, 'second'),
      ],
      undefined,
      true,
    );
    const header = within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0];

    expect(header).toHaveAccessibleName('Creating the second file');
    expect(screen.queryByTestId('live-phase-combo')).toBeNull();

    /** The same pair without the intent still counts, so the suppression is
     *  the line's doing and not a lost count. */
    view.unmount();
    mount(
      [
        toPart({ name: 'create_file', output: 'created' }, 'first'),
        toPart({ name: 'create_file', output: '' }, 'second'),
      ],
      undefined,
      true,
    );
    expect(screen.getByTestId('live-phase-combo')).toHaveTextContent('×2');
  });

  it('drops the multiplier on a line that reports how the call ended', () => {
    mount(
      [
        toPart({ name: 'lookup', output: 'rows' }, 'first'),
        toPart({ name: 'lookup', output: 'rows', runStepStatus: 'failed' }, 'second'),
      ],
      undefined,
      true,
    );
    const header = within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0];

    /** The span's verdict still counts the failure; the line does not count
     *  the tool, because "Failed lookup ×2" would blame both calls. */
    expect(header).toHaveAccessibleName(/^Failed: lookup/);
    expect(screen.queryByTestId('live-phase-combo')).toBeNull();
    expect(screen.getByTestId('live-phase-outcome')).toHaveTextContent('1 failed');
  });

  it('resets the multiplier across an agent handoff', () => {
    const handoff = {
      type: ContentTypes.AGENT_UPDATE,
      [ContentTypes.AGENT_UPDATE]: { agentId: 'agent-b', index: 1 },
    } as TMessageContentParts;
    mount(
      [
        toPart({ name: 'create_file', output: 'created' }, 'first'),
        handoff,
        toPart({ name: 'create_file', output: '' }, 'second'),
      ],
      undefined,
      true,
    );

    expect(screen.queryByTestId('live-phase-combo')).toBeNull();
  });

  it('treats a second call that reuses a provider id as a new line', () => {
    jest.useFakeTimers();
    const first = toPart({ name: 'lookup', args: '{"intent":"First pass"}', output: 'ok' }, 'dup');
    const second = toPart({ name: 'lookup', args: '{"intent":"Second pass"}', output: '' }, 'dup');
    const view = mount([first], undefined, true);
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <RecoilRoot>
          <ContentParts
            content={[first, second]}
            messageId="m1"
            conversationId="c1"
            isCreatedByUser={false}
            isLast
            isLatestMessage
            isSubmitting
            showThinking={false}
          />
        </RecoilRoot>
      </QueryClientProvider>,
    );
    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(screen.getByTestId('activity-phase-announcer')).toHaveTextContent('First pass');
  });

  it('previews CJK reasoning sentence by sentence', () => {
    const think = {
      type: ContentTypes.THINK,
      think: '两个引用共享一个提交。接下来检查顺序约定',
    } as unknown as TMessageContentParts;
    mount([toPart({ name: 'lookup', output: 'rows' }), think], undefined, true);
    const button = within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0];

    /** Only the finished sentence; the one still being written stays out. */
    expect(button).toHaveTextContent('两个引用共享一个提交。');
    expect(button).not.toHaveTextContent('接下来');
  });

  it('keeps a CJK sentence that ends exactly at the tail instead of reverting to the call', () => {
    const think = {
      type: ContentTypes.THINK,
      think: '两个引用共享一个提交。接下来检查顺序约定。',
    } as unknown as TMessageContentParts;
    mount([toPart({ name: 'lookup', output: 'rows' }), think], undefined, true);
    const button = within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0];

    expect(button).toHaveTextContent('接下来检查顺序约定。');
  });

  it.each([
    ['still running, with no status marker yet', undefined, 'Running in background'],
    [
      'finished, once its status marker arrives',
      [statusAttachment('completed')],
      'Finished in background',
    ],
  ])('says what the real card says for a detached task %s', (_name, attachments, text) => {
    const call = { name: Tools.execute_code, output: HANDLE, runStepStatus: 'completed' };
    jest.useFakeTimers();
    const cards = mount([toPart(call)], attachments, false);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(cards.container).toHaveTextContent(text);
    cards.unmount();

    mount([toPart(call)], attachments, true);
    expect(
      within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0],
    ).toHaveTextContent(text);
  });

  it('does not re-announce a sentence when the stream pauses after a space', () => {
    jest.useFakeTimers();
    const frame = (think: string) => (
      <QueryClientProvider client={new QueryClient()}>
        <RecoilRoot>
          <ContentParts
            content={[
              toPart({ name: 'lookup', output: 'rows' }),
              { type: ContentTypes.THINK, think } as unknown as TMessageContentParts,
            ]}
            messageId="m1"
            conversationId="c1"
            isCreatedByUser={false}
            isLast
            isLatestMessage
            isSubmitting
            showThinking={false}
          />
        </RecoilRoot>
      </QueryClientProvider>
    );
    const view = render(frame('Both refs share'));
    for (const next of ['Both refs share ', 'Both refs share a', 'Both refs share a ']) {
      view.rerender(frame(next));
      act(() => {
        jest.advanceTimersByTime(500);
      });
    }

    expect(screen.getByTestId('activity-phase-announcer')).toBeEmptyDOMElement();
  });

  describe('glyphs the collapsed header surfaces', () => {
    const searchAttachment = {
      type: Tools.web_search,
      toolCallId: 't1',
      messageId: 'm1',
      [Tools.web_search]: {
        turn: 0,
        organic: [
          { link: 'https://www.youtube.com/watch?v=1', title: 'a' },
          { link: 'https://www.cnbc.com/story', title: 'b' },
          { link: 'https://www.cnbc.com/other', title: 'c' },
        ],
      },
    } as unknown as TAttachment;
    const search = toPart({ name: Tools.web_search, output: 'results' });
    const sites = (root: HTMLElement) =>
      Array.from(root.querySelectorAll('img')).map((image) => image.getAttribute('alt'));

    const summary = (end: number, label = 'Reviewed the work'): TMessageContentParts =>
      ({
        type: ContentTypes.ACTIVITY_LABEL,
        [ContentTypes.ACTIVITY_LABEL]: label,
        activity_label_type: 'phase',
        activity_start_index: 0,
        activity_end_index: end,
        activity_count: end,
        pending: false,
      }) as TMessageContentParts;

    it.each([true, false])('does not borrow another span’s streamed sites (fold=%s)', (fold) => {
      const content = [search, toPart({ name: Tools.web_search }, 't2')];
      const view = mount(content, [], fold, {
        0: searchAttachment[Tools.web_search] as SearchResultData,
      });
      const header = within(view.container).getAllByRole('button')[0];
      expect(sites(header)).toEqual([]);
      expect(header.querySelector('.lucide-globe')).not.toBeNull();
    });

    it('keeps sources from different calls whose search turn numbers repeat', () => {
      const second = toPart({ name: Tools.web_search, output: 'results' }, 't2');
      const secondAttachment = {
        ...searchAttachment,
        toolCallId: 't2',
        [Tools.web_search]: {
          turn: 0,
          organic: [{ link: 'https://example.com/story', title: 'd' }],
        },
      } as TAttachment;
      mount([search, second], [searchAttachment, secondAttachment], true);
      const header = within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0];
      expect(sites(header)).toEqual(['youtube.com', 'cnbc.com', 'example.com']);
    });

    it.each([
      [ToolCallTypes.CODE_INTERPRETER, { code_interpreter: { outputs: [] } }, '.lucide-terminal'],
      [ToolCallTypes.RETRIEVAL, {}, '.lucide-file-search'],
      [ToolCallTypes.FILE_SEARCH, {}, '.lucide-file-search'],
      [
        ToolCallTypes.FUNCTION,
        { function: { name: 'read_file', output: 'done' } },
        '.lucide-file-text',
      ],
    ])('retains the real glyph for a settled legacy %s call', (type, payload, selector) => {
      const legacy = {
        type: ContentTypes.TOOL_CALL,
        tool_call: { id: 'legacy', type, ...payload },
      } as TMessageContentParts;
      mount([legacy, summary(1)], undefined, true);
      expect(
        screen.getByRole('button', { name: 'Reviewed the work' }).querySelector(selector),
      ).not.toBeNull();
    });

    it('retains the subagent glyph inside a mixed settled span', () => {
      mount(
        [
          toPart({ name: Constants.SUBAGENT, output: 'done' }),
          toPart({ name: 'read_file', output: 'done' }, 't2'),
          summary(2),
        ],
        undefined,
        true,
      );
      const header = screen.getByRole('button', { name: 'Reviewed the work' });
      expect(header.querySelector('.lucide-users')).not.toBeNull();
      expect(header.querySelector('.lucide-file-text')).not.toBeNull();
    });

    it.each([true, false])('puts failure ahead of site identity (fold=%s)', (fold) => {
      const failed = toPart({ name: Tools.web_search, output: 'results', runStepStatus: 'failed' });
      const view = mount(
        [failed, toPart({ name: 'lookup', output: 'ok' }, 't2')],
        [searchAttachment],
        fold,
      );
      const header = within(view.container).getAllByRole('button')[0];
      expect(header.querySelector('.lucide-triangle-alert')).not.toBeNull();
      expect(sites(header)).toEqual([]);
    });

    it.each([true, false])('puts cancellation ahead of tool identity (fold=%s)', (fold) => {
      const cancelled = toPart({ name: 'lookup', runStepStatus: 'cancelled' });
      const view = mount(
        [cancelled, toPart({ name: 'read_file', output: 'ok' }, 't2')],
        undefined,
        fold,
      );
      const header = within(view.container).getAllByRole('button')[0];
      expect(header.querySelector('.lucide-x')).not.toBeNull();
    });

    it.each(['failed', 'cancelled'] as const)('retains %s after a span settles', (status) => {
      mount(
        [toPart({ name: 'read_file', output: 'done', runStepStatus: status }), summary(1)],
        undefined,
        true,
      );
      const header = screen.getByRole('button', { name: 'Reviewed the work' });
      expect(
        header.querySelector(status === 'failed' ? '.lucide-triangle-alert' : '.lucide-x'),
      ).not.toBeNull();
    });

    it('retains attachment-backed failure on the nested group after files are hoisted', () => {
      mount(
        [
          toPart({ name: 'set_memory', output: 'Memory saved' }),
          toPart({ name: 'lookup', output: 'ok' }, 't2'),
          summary(2),
        ],
        [memoryErrorAttachment],
        true,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Reviewed the work' }));
      const group = screen.getByRole('button', { name: /Ran 2 actions.*1 failed/ });
      expect(group).toHaveAccessibleName(/1 failed/);
      expect(group.querySelector('.lucide-triangle-alert')).not.toBeNull();
    });

    it('shows the sites a search read on the live row, one per domain, with no card mounted', () => {
      mount([search], [searchAttachment], true);
      const button = within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0];

      expect(sites(button)).toEqual(['youtube.com', 'cnbc.com']);
      expect(screen.queryByTestId('tool-call')).toBeNull();
    });

    it('keeps them on the settled summary instead of trading them for a check', () => {
      const summary = {
        type: ContentTypes.ACTIVITY_LABEL,
        [ContentTypes.ACTIVITY_LABEL]: 'Checked the announcement',
        activity_label_type: 'phase',
        activity_start_index: 0,
        activity_end_index: 1,
        activity_count: 1,
        pending: false,
      } as unknown as TMessageContentParts;
      mount([search, summary], [searchAttachment], true);
      const button = screen.getByRole('button', { name: 'Checked the announcement' });

      expect(sites(button)).toEqual(['youtube.com', 'cnbc.com']);
    });

    it('shows them on an unfolded group header too', () => {
      const second = toPart({ name: Tools.web_search, output: 'results' }, 't2');
      const view = mount([search, second], [searchAttachment], false);
      const header = within(view.container).getAllByRole('button')[0];

      expect(sites(header)).toEqual(['youtube.com', 'cnbc.com']);
    });

    it('keeps the warning glyph on a failed summary: status outranks identity', () => {
      const failed = {
        type: ContentTypes.ACTIVITY_LABEL,
        [ContentTypes.ACTIVITY_LABEL]: 'Could not reach the site',
        activity_label_type: 'phase',
        activity_start_index: 0,
        activity_end_index: 1,
        activity_count: 1,
        status: 'failed',
        pending: false,
      } as unknown as TMessageContentParts;
      mount([search, failed], [searchAttachment], true);
      const button = screen.getByRole('button', { name: 'Could not reach the site' });

      expect(sites(button)).toEqual([]);
      expect(button.querySelector('.lucide-triangle-alert')).not.toBeNull();
    });
  });

  it('keeps an earlier failure on the row while a newer call is the line', () => {
    mount(
      [
        toPart({ name: 'lookup', output: 'rows', runStepStatus: 'failed' }, 't1'),
        toPart({ name: 'lookup', args: '{"intent":"Querying the graph', output: '' }, 't2'),
      ],
      undefined,
      true,
    );
    const button = within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0];

    expect(button).toHaveTextContent('Querying the graph');
    expect(within(button).getByTestId('live-phase-outcome')).toHaveTextContent('1 failed');
    expect(button).toHaveAccessibleName(/Querying the graph.*1 failed/);
  });

  it('announces a failure on the SAME call at once, without waiting for another source', () => {
    jest.useFakeTimers();
    const frame = (call: Record<string, unknown>) => (
      <QueryClientProvider client={new QueryClient()}>
        <RecoilRoot>
          <ContentParts
            content={[toPart(call)]}
            messageId="m1"
            conversationId="c1"
            isCreatedByUser={false}
            isLast
            isLatestMessage
            isSubmitting
            showThinking={false}
          />
        </RecoilRoot>
      </QueryClientProvider>
    );
    const view = render(frame({ name: 'lookup', output: '' }));
    const announcer = () => screen.getByTestId('activity-phase-announcer');
    expect(announcer()).toBeEmptyDOMElement();

    view.rerender(frame({ name: 'lookup', output: '', runStepStatus: 'failed' }));
    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(announcer()).toHaveTextContent('1 failed');
    expect(announcer().closest('button')).toBeNull();
  });

  it('speaks the generated summary through the region that was already mounted', () => {
    const calls = [toPart({ name: 'lookup', output: 'rows' }, 't1')];
    const frame = (content: TMessageContentParts[]) => (
      <QueryClientProvider client={new QueryClient()}>
        <RecoilRoot>
          <ContentParts
            content={content}
            messageId="m1"
            conversationId="c1"
            isCreatedByUser={false}
            isLast
            isLatestMessage
            isSubmitting
            showThinking={false}
          />
        </RecoilRoot>
      </QueryClientProvider>
    );
    const view = render(frame(calls));
    const before = screen.getByTestId('activity-phase-announcer');

    view.rerender(
      frame([
        ...calls,
        {
          type: ContentTypes.ACTIVITY_LABEL,
          [ContentTypes.ACTIVITY_LABEL]: 'Fetched the rows',
          activity_label_type: 'phase',
          activity_start_index: 0,
          activity_end_index: 1,
          activity_count: 1,
          pending: false,
        } as unknown as TMessageContentParts,
      ]),
    );

    const after = screen.getByTestId('activity-phase-announcer');
    expect(after).toBe(before);
    expect(after).toHaveTextContent('Fetched the rows');
  });
});

describe('live activity hardening transitions', () => {
  afterEach(() => jest.useRealTimers());

  const frame = (content: TMessageContentParts[], extra?: React.ReactNode) => (
    <QueryClientProvider client={new QueryClient()}>
      <RecoilRoot>
        <Provider>
          {extra}
          <ContentParts
            content={content}
            messageId="m1"
            conversationId="c1"
            isCreatedByUser={false}
            isLast
            isLatestMessage
            isSubmitting
            showThinking={false}
          />
        </Provider>
      </RecoilRoot>
    </QueryClientProvider>
  );

  it('shows a thought only as finished sentences, each held for a second', () => {
    jest.useFakeTimers();
    const content = (think: string): TMessageContentParts[] => [
      { type: ContentTypes.THINK, think },
    ];
    const view = render(frame(content('Let me')));
    const header = screen.getByRole('button');
    /** Nothing finished yet: the generic line, not a fragment. */
    expect(header).toHaveAccessibleName('Thinking...');
    view.rerender(frame(content('Let me check the evidence')));
    act(() => jest.advanceTimersByTime(1000));
    expect(header).toHaveAccessibleName('Thinking...');

    /** A sentence finishing a second after the last paint shows at once. */
    view.rerender(frame(content('Let me check the evidence.')));
    expect(header).toHaveAccessibleName('Let me check the evidence.');

    /** The next sentence is written behind the finished one. */
    view.rerender(frame(content('Let me check the evidence. Now I can')));
    act(() => jest.advanceTimersByTime(200));
    expect(header).toHaveAccessibleName('Let me check the evidence.');

    /** Finished 200ms after the last paint: the line holds its sentence for
     *  the rest of the second before the next one takes it. */
    view.rerender(frame(content('Let me check the evidence. Now I can decide.')));
    act(() => jest.advanceTimersByTime(200));
    expect(header).toHaveAccessibleName('Let me check the evidence.');
    act(() => jest.advanceTimersByTime(600));
    expect(header).toHaveAccessibleName('Now I can decide.');
    expect(screen.getByTestId('activity-phase-announcer')).toBeEmptyDOMElement();
  });

  it('keeps decimals and versions inside one sentence', () => {
    jest.useFakeTimers();
    const content = (think: string): TMessageContentParts[] => [
      { type: ContentTypes.THINK, think },
    ];
    render(frame(content('The gain was 3.5 points on v2.1 today. Next up')));
    expect(screen.getByRole('button')).toHaveAccessibleName(
      'The gain was 3.5 points on v2.1 today.',
    );
  });

  function SandboxEvent() {
    const setStarting = useSetAtom(sandboxStartingByToolCallId('sandbox-call'));
    return (
      <>
        <button onClick={() => setStarting(true)}>{'Start sandbox'}</button>
        <button onClick={() => setStarting(false)}>{'Clear sandbox startup'}</button>
      </>
    );
  }

  it.each([
    [Tools.bash_tool, { command: 'echo ready' }],
    [Tools.execute_code, { lang: 'py', code: 'print(1)' }],
    [Constants.PROGRAMMATIC_TOOL_CALLING, { lang: 'python', code: 'print(1)' }],
    [Constants.BASH_PROGRAMMATIC_TOOL_CALLING, { code: 'echo ready' }],
  ])('names %s sandbox startup on the row without unfolding the span', (name, args) => {
    /** Unfolding here to let the card say "Starting sandbox" opened the WHOLE
     *  span for as long as the call ran and shut it when output landed — on
     *  every call of a run whose model did not put `intent` first. The row
     *  reads the same sandbox signal instead, and stays one card throughout. */
    jest.useFakeTimers();
    const call = { name, args, output: '' };
    const earlier = toPart({ ...call, output: 'ok' }, 'earlier');
    const view = render(frame([earlier, toPart(call, 'sandbox-call')], <SandboxEvent />));
    const card = screen.getByTestId('activity-phase-card');
    const header = within(card).getByRole('button');
    expect(screen.queryByTestId('tool-call')).toBeNull();
    expect(header).toHaveAccessibleName(/×2$/);
    expect(screen.getByTestId('live-phase-combo')).toHaveTextContent('×2');

    fireEvent.click(screen.getByRole('button', { name: 'Start sandbox' }));
    expect(header).toHaveAccessibleName(/×2$/);
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(header).toHaveAccessibleName('Starting sandbox environment');
    expect(screen.queryByTestId('live-phase-combo')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Clear sandbox startup' }));
    expect(header).toHaveAccessibleName('Starting sandbox environment');
    expect(screen.queryByTestId('live-phase-combo')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(header).toHaveAccessibleName(/×2$/);
    expect(screen.getByTestId('live-phase-combo')).toHaveTextContent('×2');

    fireEvent.click(screen.getByRole('button', { name: 'Start sandbox' }));
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(header).toHaveAccessibleName('Starting sandbox environment');
    /** Output can arrive before the transient startup flag is cleared. */
    view.rerender(
      frame([
        earlier,
        toPart({ ...call, output: 'ok', runStepStatus: 'completed' }, 'sandbox-call'),
      ]),
    );
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(screen.getByTestId('activity-phase-card')).toBe(card);
    expect(header).toHaveAccessibleName(/^Ran .* ×2$/);
    expect(screen.getByTestId('live-phase-combo')).toHaveTextContent('×2');
  });

  it('keeps startup and intent labels uncounted, then counts a new generic call', () => {
    jest.useFakeTimers();
    const earlier = toPart({ name: Tools.execute_code, output: 'ok' }, 'earlier');
    const pending = toPart({ name: Tools.execute_code, output: '' }, 'sandbox-call');
    const view = render(frame([earlier, pending], <SandboxEvent />));
    const header = within(screen.getByTestId('activity-phase-card')).getByRole('button');
    fireEvent.click(screen.getByRole('button', { name: 'Start sandbox' }));
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(header).toHaveAccessibleName('Starting sandbox environment');
    expect(screen.queryByTestId('live-phase-combo')).toBeNull();

    const named = toPart(
      { name: Tools.execute_code, args: '{"intent":"Checking the data', output: '' },
      'sandbox-call',
    );
    view.rerender(frame([earlier, named]));
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(header).toHaveAccessibleName('Checking the data');
    expect(screen.queryByTestId('live-phase-combo')).toBeNull();

    view.rerender(
      frame([earlier, named, toPart({ name: Tools.execute_code, output: '' }, 'next-call')]),
    );
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(header).toHaveAccessibleName(/^Running .* ×3$/);
    expect(screen.getByTestId('live-phase-combo')).toHaveTextContent('×3');
  });

  it('holds one card across a run of code calls whose intent is not the first key', () => {
    /** The shape of the run that flashed: `{"command":…,"intent":…}`, which the
     *  anchored intent reader rejects, so each call was "a code call with no
     *  intent" from the moment its args completed until its output landed. */
    const args = '{"command":"gh run view 1","intent":"Viewing the failing run"}';
    const writing = toPart({ name: Tools.bash_tool, args: '{"command":"gh run', output: '' }, 'b1');
    const dispatched = toPart({ name: Tools.bash_tool, args, output: '' }, 'b1');
    const finished = toPart({ name: Tools.bash_tool, args, output: 'ok' }, 'b1');
    const view = render(frame([writing]));
    const card = screen.getByTestId('activity-phase-card');
    for (const content of [
      [dispatched],
      [finished],
      [finished, toPart({ name: Tools.bash_tool, args, output: '' }, 'b2')],
    ]) {
      view.rerender(frame(content));
      expect(screen.getByTestId('activity-phase-card')).toBe(card);
      expect(screen.queryByTestId('tool-call')).toBeNull();
    }
  });

  it('folds an early code delta and keeps folding once its intent arrives', () => {
    jest.useFakeTimers();
    const view = render(frame([toPart({ name: Tools.execute_code, args: '', output: '' })]));
    const card = screen.getByTestId('activity-phase-card');
    view.rerender(
      frame([
        toPart({ name: Tools.execute_code, args: '{"intent":"Checking the data', output: '' }),
      ]),
    );
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(screen.getByTestId('activity-phase-card')).toBe(card);
    expect(screen.getByRole('button')).toHaveAccessibleName('Checking the data');
  });

  it('keeps the optimistic question record visible through stale SSE copies and folds subsequent work', () => {
    const question = { question: 'Which region?' };
    const call = toPart({ name: 'ask_user_question', args: question, output: '' }, 'answered-ask');
    const message = {
      messageId: 'm1',
      content: [
        call,
        {
          type: 'ask_user_question',
          ask_user_question: { actionId: 'answer-action', tool_call_id: 'answered-ask', question },
        },
      ],
    } as TMessage;
    resolveAskUserQuestionPart(message, 'answer-action', 'Europe');
    const view = render(frame([call]));
    expect(screen.queryByTestId('activity-phase-card')).toBeNull();
    expect(screen.getByTestId('ask-user-question-call')).toHaveTextContent('Asked');
    view.rerender(
      frame([call, toPart({ name: 'lookup', args: { intent: 'Checking Europe' } }, 'next')]),
    );
    expect(screen.getByTestId('ask-user-question-call')).toHaveTextContent('Asked');
    expect(screen.getByTestId('activity-phase-card')).toHaveTextContent('Checking Europe');
  });

  it('keeps a detached subagent outside the next live span', () => {
    const output = JSON.stringify({
      background_task_id: 'bg-child',
      subagent_thread_id: 'thread',
      tool: 'subagent',
      subagent_type: 'self',
      status: 'running',
      message: 'Poll background_task_id',
    });
    render(
      frame([
        toPart({
          name: 'subagent',
          args: { run_in_background: true },
          output,
          runStepStatus: 'completed',
        }),
        toPart({ name: 'lookup', args: { intent: 'Continuing the parent' } }, 'next'),
      ]),
    );
    const fold = screen.getByTestId('activity-phase-card');
    expect(fold).toHaveTextContent('Continuing the parent');
    expect(screen.getByText('Ran agent').closest('[data-testid="activity-phase-card"]')).toBeNull();
  });

  it.each(['x'.repeat(1199), 'Earlier sentence. ' + 'x'.repeat(1199)])(
    'does not repeatedly announce one thought as its bounded preview window moves',
    (initial) => {
      jest.useFakeTimers();
      const content = (think: string) => [
        toPart({ name: 'lookup', output: 'rows' }),
        { type: ContentTypes.THINK, think } as TMessageContentParts,
      ];
      const view = render(frame(content(initial)));
      for (const suffix of [' ', ' more', ' more text', ' more text. Next sentence']) {
        view.rerender(frame(content(initial + suffix)));
        act(() => {
          jest.advanceTimersByTime(500);
        });
      }
      expect(screen.getByTestId('activity-phase-announcer')).toBeEmptyDOMElement();
      /** The finished sentence is the long run itself, clamped to one line;
       *  the sentence after it is still being written. */
      expect(screen.getByRole('button')).toHaveAccessibleName(`${'x'.repeat(255)}…`);
    },
  );

  it('does not replay a source change when two consecutive calls begin with identical text', () => {
    jest.useFakeTimers();
    const first = toPart({ name: 'lookup', args: { intent: 'Checking' }, output: 'ok' }, 'first');
    const second = (intent: string) => toPart({ name: 'lookup', args: { intent } }, 'second');
    const view = render(frame([first]));
    view.rerender(frame([first, second('Checking')]));
    act(() => {
      jest.advanceTimersByTime(500);
    });
    view.rerender(frame([first, second('Checking the next file')]));
    act(() => {
      jest.advanceTimersByTime(500);
    });
    const header = screen.getByRole('button');
    expect(header).toHaveAccessibleName('Checking the next file');
    expect(screen.queryByTestId('live-phase-combo')).toBeNull();
    expect(header.querySelector('.absolute[aria-hidden="true"]')).toBeNull();
  });

  it.each(['error', 'cancelled', 'completed'] as const)(
    'updates a cached detached outcome on a late %s attachment',
    (status) => {
      jest.useFakeTimers();
      const part = toPart({ name: Tools.execute_code, output: HANDLE, runStepStatus: 'completed' });
      const client = new QueryClient();
      const tree = (attachments?: TAttachment[]) => (
        <QueryClientProvider client={client}>
          <RecoilRoot>
            <ContentParts
              content={[part]}
              attachments={attachments}
              messageId="m1"
              conversationId="c1"
              isCreatedByUser={false}
              isLast
              isLatestMessage
              isSubmitting
              showThinking={false}
            />
          </RecoilRoot>
        </QueryClientProvider>
      );
      const view = render(tree());
      expect(screen.getByRole('button')).toHaveAccessibleName('Running in background');
      view.rerender(tree([statusAttachment(status)]));
      act(() => {
        jest.advanceTimersByTime(500);
      });
      const expected = {
        error: /Failed.*1 failed/,
        cancelled: /Cancelled.*1 cancelled/,
        completed: 'Finished in background',
      }[status];
      /** The header is the first button; a failure adds the pill after it. */
      expect(screen.getAllByRole('button')[0]).toHaveAccessibleName(expected);
    },
  );

  it('does not lose a late failure at the start of a long unlabelled span', () => {
    jest.useFakeTimers();
    const calls = Array.from({ length: 1024 }, (_, index) =>
      toPart(
        {
          name: 'lookup',
          args: { intent: `Looking up item ${index}` },
          output: 'ok',
        },
        `call-${index}`,
      ),
    );
    const view = render(frame(calls));
    expect(screen.queryByTestId('live-phase-outcome')).toBeNull();
    view.rerender(
      frame([
        toPart({ name: 'lookup', output: 'ok', runStepStatus: 'failed' }, 'call-0'),
        ...calls.slice(1),
      ]),
    );
    expect(screen.getAllByRole('button')[0]).toHaveAccessibleName(/Looking up item 1023.*1 failed/);
    expect(screen.getByTestId('activity-phase-announcer')).toHaveTextContent('1 failed');
  });

  it('owns exactly one polite region across live-to-settled replacement', () => {
    const calls = [toPart({ name: 'lookup', output: 'ok' })];
    const view = render(frame(calls));
    const announcer = screen.getByTestId('activity-phase-announcer');
    view.rerender(
      frame([
        ...calls,
        {
          type: ContentTypes.ACTIVITY_LABEL,
          activity_label: 'Completed lookup',
          activity_label_type: 'phase',
          activity_start_index: 0,
          activity_end_index: 1,
          activity_count: 1,
          pending: false,
        } as TMessageContentParts,
      ]),
    );
    expect(screen.getAllByRole('status')).toEqual([announcer]);
    expect(announcer).toHaveTextContent('Completed lookup');
  });
});

describe('live disclosure ownership', () => {
  const thought: TMessageContentParts = { type: ContentTypes.THINK, think: 'Planning the lookup.' };
  const queryClient = new QueryClient();
  const frame = (content: TMessageContentParts[], messageId = 'm1', isSubmitting = true) => (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <ContentParts
          content={content}
          messageId={messageId}
          conversationId="c1"
          isCreatedByUser={false}
          isLast
          isLatestMessage
          isSubmitting={isSubmitting}
          showThinking={false}
          foldLiveActivity
        />
      </RecoilRoot>
    </QueryClientProvider>
  );

  const originalObserver = global.IntersectionObserver;
  afterEach(() => {
    global.IntersectionObserver = originalObserver;
  });
  beforeEach(() => {
    const observer: IntersectionObserver = {
      root: null,
      rootMargin: '',
      thresholds: [],
      observe: jest.fn(),
      unobserve: jest.fn(),
      disconnect: jest.fn(),
      takeRecords: () => [],
    };
    global.IntersectionObserver = jest.fn(() => observer);
  });

  it.each(['answer', 'stop'] as const)(
    'keeps opened reasoning visible when the run reaches %s without tools',
    (transition) => {
      const view = render(frame([thought]));
      fireEvent.click(within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0]);
      expect(
        view.container.querySelector('.group\\/reasoning button[aria-expanded]'),
      ).toHaveAttribute('aria-expanded', 'true');

      const content: TMessageContentParts[] =
        transition === 'answer'
          ? [thought, { type: ContentTypes.TEXT, text: 'Here is the answer.' }]
          : [thought];
      view.rerender(frame(content, 'm1', transition === 'answer'));
      expect(screen.getByRole('button', { name: /^Thoughts$/i })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    },
  );

  it('preserves an explicitly closed thought when the answer starts', () => {
    const view = render(frame([thought]));
    fireEvent.click(within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0]);
    const reasoningHeader = view.container.querySelector(
      '.group\\/reasoning button[aria-expanded]',
    );
    expect(reasoningHeader).not.toBeNull();
    fireEvent.click(reasoningHeader!);
    view.rerender(frame([thought, { type: ContentTypes.TEXT, text: 'Here is the answer.' }]));
    expect(screen.getByRole('button', { name: /^Thoughts$/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it.each(['tool', 'thought'] as const)(
    'isolates a new streaming sibling beginning with a %s',
    (kind) => {
      const phase: TMessageContentParts = {
        type: ContentTypes.ACTIVITY_LABEL,
        activity_label: 'Looked up results',
        activity_label_type: 'phase',
        activity_start_index: 0,
        activity_end_index: 1,
      };
      const view = render(
        frame(
          [toPart({ name: 'lookup', output: 'done' }, 'old-tool'), phase],
          'old-message',
          false,
        ),
      );
      fireEvent.click(within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0]);
      view.rerender(
        frame(
          [kind === 'tool' ? toPart({ name: 'lookup', output: '' }, 'new-tool') : thought],
          'new-message',
        ),
      );
      expect(
        within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0],
      ).toHaveAttribute('aria-expanded', 'false');
    },
  );

  it('isolates two reasoning-only streaming siblings at the same position', () => {
    const view = render(frame([thought], 'old-message'));
    fireEvent.click(within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0]);
    view.rerender(frame([thought], 'new-message'));
    expect(
      within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0],
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a reasoning-led card open when its tool-backed message hydrates mid-stream', () => {
    const view = render(frame([thought]));
    fireEvent.click(within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0]);
    const content = [thought, toPart({ name: 'lookup', output: '' }, 'tool')];
    view.rerender(frame(content));
    const card = screen.getByTestId('activity-phase-card');
    view.rerender(frame(content, 'server-id'));
    expect(screen.getByTestId('activity-phase-card')).toBe(card);
    expect(within(card).getAllByRole('button')[0]).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('tool pane identity at finalization', () => {
  const call = (id = 't1', extra: Record<string, unknown> = {}) =>
    toPart(
      {
        name: 'bash_tool',
        args: { command: 'printf hello' },
        output: '',
        ...extra,
      },
      id,
    );

  function setup(autoExpand = false) {
    const client = new QueryClient();
    const frame = (props: Partial<React.ComponentProps<typeof ContentParts>> = {}) => (
      <QueryClientProvider client={client}>
        <Provider>
          <RecoilRoot initializeState={({ set }) => set(store.autoExpandTools, autoExpand)}>
            <ContentParts
              messageId="user-message_"
              conversationId="c1"
              content={[call()]}
              isCreatedByUser={false}
              isLast
              isLatestMessage
              isSubmitting
              showThinking={false}
              foldLiveActivity={false}
              {...props}
            />
          </RecoilRoot>
        </Provider>
      </QueryClientProvider>
    );
    return frame;
  }

  const toggles = (container: HTMLElement) =>
    Array.from(
      container.querySelectorAll<HTMLButtonElement>('.progress-text-wrapper button[aria-expanded]'),
    );

  it.each(['completed', 'cancelled', 'failed'] as const)(
    'keeps the opened pane after %s and sparse content compaction',
    async (status) => {
      const frame = setup();
      const { container, rerender } = render(frame({ content: [undefined, call()] }));
      fireEvent.click(toggles(container)[0]);
      expect(toggles(container)[0]).toHaveAttribute('aria-expanded', 'true');
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.querySelector('code.hljs span')).not.toBeNull();
      rerender(
        frame({
          messageId: 'server-response',
          isSubmitting: false,
          content: [
            {
              ...call('t1', { output: 'hello', runStepStatus: status, stepId: 'final-step' }),
              streamedIndex: 1,
            },
          ],
        }),
      );
      expect(toggles(container)[0]).toHaveAttribute('aria-expanded', 'true');
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.querySelector('code.hljs span')).not.toBeNull();
    },
  );

  it('keeps an explicitly closed pane closed when auto-expand is enabled', () => {
    const frame = setup(true);
    const { container, rerender } = render(frame());
    expect(toggles(container)[0]).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggles(container)[0]);
    rerender(frame({ messageId: 'server-response', isSubmitting: false }));
    expect(toggles(container)[0]).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps an untouched pane closed at completion', () => {
    const frame = setup();
    const { container, rerender } = render(frame());
    rerender(frame({ messageId: 'server-response', isSubmitting: false }));
    expect(toggles(container)[0]).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the tool choice when a live phase unwraps into settled content', () => {
    const frame = setup();
    const { container, rerender } = render(frame({ foldLiveActivity: true }));
    fireEvent.click(within(screen.getByTestId('activity-phase-card')).getAllByRole('button')[0]);
    fireEvent.click(toggles(container)[0]);
    expect(toggles(container)[0]).toHaveAttribute('aria-expanded', 'true');
    rerender(frame({ messageId: 'server-response', isSubmitting: false, foldLiveActivity: true }));
    expect(toggles(container)[0]).toHaveAttribute('aria-expanded', 'true');
  });

  it.each([
    { messageId: 'other-response', isSubmitting: false },
    { messageId: 'regenerated-response_', isSubmitting: true },
    { messageId: 'server-response', conversationId: 'c2', isSubmitting: false },
  ])('does not leak the choice into another response: %j', (next) => {
    const frame = setup();
    const { container, rerender } = render(
      frame({ messageId: 'server-response', isSubmitting: false }),
    );
    fireEvent.click(toggles(container)[0]);
    rerender(frame(next));
    expect(toggles(container)[0]).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps repeated provider ids independent by content position', () => {
    const frame = setup();
    const content = [
      call(),
      { type: ContentTypes.TEXT, text: 'Between calls' } as TMessageContentParts,
      call(),
    ];
    const { container, rerender } = render(frame({ content }));
    fireEvent.click(toggles(container)[0]);
    rerender(frame({ content, messageId: 'server-response', isSubmitting: false }));
    expect(toggles(container)[0]).toHaveAttribute('aria-expanded', 'true');
    expect(toggles(container)[1]).toHaveAttribute('aria-expanded', 'false');
  });
});
