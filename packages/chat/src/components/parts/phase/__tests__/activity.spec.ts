import { Tools, ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { TranslationKeys } from '@librechat/client';
import type { TOptions } from 'i18next';
import { firstErrorLine } from '../../../../core/parts/output';
import { getToolMeta } from '../../../../core/parts/outcome';
import { getFailedLines, getLiveActivity, getStandardToolCall } from '../activity';

const localize = (key: TranslationKeys, values?: TOptions): string =>
  key === 'com_ui_failed_subject' ? `Failed: ${String(values?.[0])}` : key;

const toPart = (call: Record<string, unknown>, id: string): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: { id, args: '{}', type: 'tool_call', progress: 1, ...call },
  }) as unknown as TMessageContentParts;

describe('firstErrorLine', () => {
  it('strips the tool-call error prefix and keeps the first line', () => {
    expect(
      firstErrorLine('Error: tool call failed: HTTP 429 from github.com\nretry after 60'),
    ).toBe('HTTP 429 from github.com');
  });

  it('strips the generic processing prefix', () => {
    expect(firstErrorLine('Error processing tool: disk full')).toBe('disk full');
  });

  it('strips a bare error prefix such as schema-validation feedback', () => {
    expect(
      firstErrorLine(
        'Error: Tool "slow_echo" input failed schema validation.\n Please fix your mistakes.',
      ),
    ).toBe('Tool "slow_echo" input failed schema validation.');
  });

  it('is empty for no output or output that is not an error', () => {
    expect(firstErrorLine(undefined)).toBe('');
    expect(firstErrorLine('')).toBe('');
    expect(firstErrorLine('{"background_task_id":"bg1","status":"running"}')).toBe('');
  });
});

describe('getFailedLines', () => {
  it('lists every failed call in order with its row label and first error line', () => {
    const parts = [
      toPart({ name: 'lookup', output: 'rows' }, 'ok'),
      toPart(
        {
          name: 'fetch_page',
          args: { intent: 'Read a page', url: 'https://x' },
          output: 'Error: tool call failed: HTTP 429\nmore',
        },
        'f1',
      ),
      undefined,
      toPart({ name: 'lookup', output: 'rows', runStepStatus: 'failed' }, 'f2'),
    ];
    expect(getFailedLines(parts, localize, [])).toEqual([
      { text: 'Failed: Read a page', detail: 'HTTP 429', iconName: 'fetch_page' },
      /** Failed by its run step, with ordinary output: no line of it is the reason. */
      { text: 'Failed: lookup', detail: '', iconName: 'lookup' },
    ]);
  });

  it('records a host close time for a failed tool step', () => {
    const failedAt = Date.now() - 60_000;
    expect(
      getFailedLines(
        [toPart({ name: 'lookup', runStepStatus: 'failed', runStepClosedAt: failedAt }, 'failed')],
        localize,
        [],
      ),
    ).toEqual([{ text: 'Failed: lookup', detail: '', iconName: 'lookup', failedAt }]);
  });

  it('uses a detached task settlement time instead of the earlier dispatch time', () => {
    const settledAt = new Date();
    const call = toPart(
      {
        name: 'lookup',
        output: 'Error: tool call failed: timed out',
        runStepClosedAt: Date.now() - 120_000,
        backgrounded: true,
        backgroundTask: { settledAt },
      },
      'detached',
    );
    expect(getFailedLines([call], localize, [])[0].failedAt).toBe(settledAt);
    const withoutReceipt = toPart(
      {
        name: 'lookup',
        output: 'Error: tool call failed: timed out',
        backgrounded: true,
        runStepClosedAt: Date.now() - 120_000,
      },
      'pending',
    );
    expect(getFailedLines([withoutReceipt], localize, [])[0].failedAt).toBeUndefined();
  });

  it('is empty when nothing failed', () => {
    expect(
      getFailedLines([toPart({ name: 'lookup', output: 'rows' }, 'ok')], localize, []),
    ).toEqual([]);
  });
});

describe('dispatcher calls in tool headers', () => {
  it('names a completed call after the tool it ran', () => {
    const part = toPart(
      {
        name: 'call_tool',
        args: '{"name":"web_search","arguments":"{\\"query\\":\\"news\\"}"}',
        output: 'done',
        dispatched: { name: Tools.web_search, args: '{"query":"news"}' },
      },
      'call_1',
    );
    expect(getStandardToolCall(part)).toMatchObject({
      name: Tools.web_search,
      args: '{"query":"news"}',
    });
    expect(getToolMeta(part)).toMatchObject({ name: Tools.web_search, hasOutput: true });
  });
});

describe('getLiveActivity reasoning preview', () => {
  /** The collapsed header's line for a span that is one streaming thought. */
  const preview = (think: string): string =>
    getLiveActivity(
      [{ type: ContentTypes.THINK, think } as unknown as TMessageContentParts],
      localize,
      [],
    ).text;

  it('names the thought by its generated label once one lands, open or collapsed', () => {
    const thought = {
      type: ContentTypes.THINK,
      think: 'Here is my plan:\n1. Check the refs.\n5.',
      reasoning_label: ' Planning the fix ',
    } as unknown as TMessageContentParts;
    expect(getLiveActivity([thought], localize, []).text).toBe('Planning the fix');
    expect(getLiveActivity([thought], localize, [], undefined, true).text).toBe('Planning the fix');
  });

  it('never shows a list ordinal as the sentence', () => {
    const plan = 'Here is my plan:\n1. Check the refs.\n2. Compare the ordering.\n5.';
    expect(preview(plan)).toBe('Compare the ordering.');
    expect(preview(`${plan} Write`)).toBe('Compare the ordering.');
  });

  it('does not end a sentence at the ordinal of an unpunctuated item', () => {
    expect(preview('Weighing it all. Steps:\n1. Check the refs\n2. Compare\n3. Read')).toBe(
      'Weighing it all.',
    );
    expect(preview('1. Check the refs\n2. Compare')).toBe('com_ui_thinking');
  });

  it('drops block markers and keeps the block above out of the sentence', () => {
    expect(preview('Options to weigh:\n- Use the cache.\n- Skip the read')).toBe('Use the cache.');
    expect(preview('Options:\n  * Use the cache.\n  + Reuse the index.')).toBe('Reuse the index.');
    expect(preview('Order:\n1) Fetch the refs.\n2) Sort')).toBe('Fetch the refs.');
    expect(preview('**Checking the refs**\n\nThe tags share a commit.')).toBe(
      'The tags share a commit.',
    );
    expect(preview('## Checking the refs\nThe tags share a commit.')).toBe(
      'The tags share a commit.',
    );
    expect(preview('Next up:\n## The tags share a commit.')).toBe('The tags share a commit.');
  });

  it('keeps a sentence whole across a soft line break', () => {
    expect(preview('I should compare the cached results\nwith the current response.')).toBe(
      'I should compare the cached results with the current response.',
    );
  });

  it('removes citation anchors in both forms, ending the sentence they follow', () => {
    expect(
      preview('The docs confirm it. \ue202turn0search2 - The notes say it shipped in 2.1. Now'),
    ).toBe('The notes say it shipped in 2.1.');
    expect(preview('The docs confirm it.\\ue202turn0search2 Then')).toBe('The docs confirm it.');
    expect(
      preview('It shipped.\ue202turn0search0\ue202turn1news3 \ue200\ue202turn0ref1\ue201 More'),
    ).toBe('It shipped.');
    expect(preview('\ue203Release 2.1 added it.\ue204\ue202turn0search1 Then')).toBe(
      'Release 2.1 added it.',
    );
  });

  it('keeps decimals, versions and CJK sentences whole', () => {
    expect(preview('The gain was 3.5 points on v2.1 today. Next up')).toBe(
      'The gain was 3.5 points on v2.1 today.',
    );
    expect(preview('先检查引用。然后比较')).toBe('先检查引用。');
  });
});
