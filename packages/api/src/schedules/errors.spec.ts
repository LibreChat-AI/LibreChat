import { ContentTypes } from 'librechat-data-provider';
import { getScheduledRunError } from './errors';

describe('getScheduledRunError', () => {
  it('detects a terminal provider error after completed tool calls', () => {
    expect(
      getScheduledRunError([
        { type: ContentTypes.TOOL_CALL, tool_call: { name: 'search' } },
        { type: ContentTypes.ERROR, error: 'The model provider could not complete this request' },
      ]),
    ).toBe('Run ended with a model provider error');
  });

  it('does not fail a response that contains a text answer', () => {
    expect(
      getScheduledRunError([
        { type: ContentTypes.ERROR, error: 'provider failed' },
        { type: ContentTypes.TEXT, text: 'A completed answer' },
      ]),
    ).toBeNull();
  });

  it('ignores responses without an error part', () => {
    expect(getScheduledRunError([{ type: ContentTypes.TEXT, text: 'Done' }])).toBeNull();
    expect(getScheduledRunError(undefined)).toBeNull();
    expect(getScheduledRunError('error')).toBeNull();
  });

  it('uses a stable fallback for a malformed error part', () => {
    expect(getScheduledRunError([{ type: ContentTypes.ERROR }])).toBe(
      'Run ended with a model provider error',
    );
  });
});
