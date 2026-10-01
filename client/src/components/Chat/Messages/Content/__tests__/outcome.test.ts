import { Tools, ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { summarizeSpan } from '../outcome';

const bashPart = (
  id: string,
  output: string,
  name: string = Tools.bash_tool,
  executor: string | null = 'attached_workspace',
) =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id,
      name,
      args: { command: 'make test' },
      output,
      progress: 1,
      runStepStatus: 'completed',
      ...(executor != null && { executor }),
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

  it('ignores a trailer on sandbox output the server did not mark', () => {
    const sandbox = summarizeSpan([
      bashPart('a', 'stdout:\n[exit code: 1]', Tools.bash_tool, null),
    ]);
    expect(sandbox.failed).toBe(0);
    const attached = summarizeSpan([bashPart('a', 'stdout:\n[exit code: 1]')]);
    expect(attached.failed).toBe(1);
  });

  it('does not read exit trailers on tools other than bash', () => {
    const summary = summarizeSpan([bashPart('a', 'stdout:\nx\n\n[exit code: 1]', 'fetch_image')]);
    expect(summary.failed).toBe(0);
  });
});
