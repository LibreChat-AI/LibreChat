import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { TOptions } from 'i18next';
import type { TranslationKeys } from '~/hooks';
import { firstErrorLine, getFailedLines } from '../live';

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

  it('is empty when nothing failed', () => {
    expect(
      getFailedLines([toPart({ name: 'lookup', output: 'rows' }, 'ok')], localize, []),
    ).toEqual([]);
  });
});
