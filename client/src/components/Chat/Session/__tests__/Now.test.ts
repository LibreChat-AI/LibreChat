import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { LocalizeFunction } from '~/common';
import { describeTailPart } from '../Now';

const localize = ((key: string) => key) as LocalizeFunction;
const part = (value: Record<string, unknown>) => value as TMessageContentParts;
const call = (name: string, args: string) =>
  part({ type: ContentTypes.TOOL_CALL, [ContentTypes.TOOL_CALL]: { id: 'call', name, args } });

describe('describeTailPart', () => {
  it('reads a tool call by what it says it is for', () => {
    expect(
      describeTailPart(
        call('bash_tool', '{"intent":"Run the focused specs","command":"jest"}'),
        localize,
      ),
    ).toBe('Run the focused specs');
  });

  it('falls back to the tool when the call states no intent', () => {
    const line = describeTailPart(call('web_search', '{"query":"jotai"}'), localize);
    expect(typeof line).toBe('string');
    expect(line).not.toBe('');
    expect(line).not.toContain('jotai');
  });

  it('reads text by the line being written', () => {
    expect(
      describeTailPart(
        part({
          type: ContentTypes.TEXT,
          text: 'Eleven paths are fine.\n\nChecking the bulk updates  \n',
        }),
        localize,
      ),
    ).toBe('Checking the bulk updates');
  });

  it('reads a long line from its end, at a word, so the newest words are the ones shown', () => {
    const line = describeTailPart(
      part({
        type: ContentTypes.TEXT,
        text: 'Fourteen write paths so far, and eleven of them invalidate the cache before they return',
      }),
      localize,
    );
    expect(line).toBe('…of them invalidate the cache before they return');
  });

  it('says a reasoning part is thinking without quoting it', () => {
    expect(
      describeTailPart(
        part({ type: ContentTypes.THINK, think: 'private chain of thought' }),
        localize,
      ),
    ).toBe('com_ui_subagent_progress_thinking');
  });

  it('has nothing to say for empty text or a part with no short telling', () => {
    expect(describeTailPart(part({ type: ContentTypes.TEXT, text: '  \n' }), localize)).toBeNull();
    expect(describeTailPart(part({ type: ContentTypes.IMAGE_FILE }), localize)).toBeNull();
  });
});
