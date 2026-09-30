import { Tools, ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { summarizeSpan } from '../outcome';

const bashPart = (id: string, output: string, name: string = Tools.bash_tool) =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id,
      name,
      args: { command: 'make test' },
      output,
      progress: 1,
      runStepStatus: 'completed',
    },
  }) as unknown as TMessageContentParts;

describe('summarizeSpan command exit status', () => {
  it('counts a bash call that exited non-zero as failed, like its card', () => {
    const summary = summarizeSpan([
      bashPart('a', 'stdout:\nok\n\n[exit code: 0]'),
      bashPart('b', 'stdout:\n1 failing\n\n[exit code: 1]'),
      bashPart('c', 'stdout:\nslow\n\n[timed out]'),
    ]);
    expect(summary.failed).toBe(2);
  });

  it('does not read exit trailers on tools other than bash', () => {
    const summary = summarizeSpan([bashPart('a', 'stdout:\nx\n\n[exit code: 1]', 'fetch_image')]);
    expect(summary.failed).toBe(0);
  });
});
