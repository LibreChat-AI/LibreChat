import { parseCommandOutput } from '../command';

describe('parseCommandOutput', () => {
  it('reads a successful run', () => {
    const output = 'stdout:\nready\n\n[exit code: 0]';
    expect(parseCommandOutput(output)).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      failed: false,
      head: 'stdout:\nready\n\n',
      stderr: '',
      trailer: '[exit code: 0]',
    });
  });

  it('splits stderr and fails a non-zero exit', () => {
    const output = 'stdout:\nok\n\nstderr:\nboom\n\n[exit code: 2][output truncated]';
    const result = parseCommandOutput(output);
    expect(result).toMatchObject({ exitCode: 2, failed: true, truncated: true });
    expect(result?.head).toBe('stdout:\nok\n\n');
    expect(result?.stderr).toBe('stderr:\nboom\n\n');
    expect(`${result?.head}${result?.stderr}${result?.trailer}`).toBe(output);
  });

  it('reads stderr-only, signal and timeout runs', () => {
    expect(
      parseCommandOutput('stderr:\nkilled\n\n[terminated by SIGKILL][timed out]'),
    ).toMatchObject({ exitCode: null, signal: 'SIGKILL', timedOut: true, failed: true, head: '' });
    expect(parseCommandOutput('Command completed with no output.\n[exit code: 1]')).toMatchObject({
      exitCode: 1,
      failed: true,
      stderr: '',
    });
  });

  it.each([
    ['stdout:\nready\n\n[exit code: 0]', 0, false, ''],
    ['stderr:\nboom\n[exit code: 2]', 2, true, 'stderr:\nboom\n'],
    ['Command completed with no output.\n[exit code: 0]', 0, false, ''],
  ])('preserves directory labels and parses the verdict: %s', (body, exitCode, failed, stderr) => {
    const directory = `[starting directory: ${JSON.stringify('workspace/folder\t"name')}]\n`;
    const output = directory + body;
    const result = parseCommandOutput(output);
    expect(result).toMatchObject({ exitCode, failed, stderr });
    expect(result?.head).toContain(directory);
    expect(`${result?.head}${result?.stderr}${result?.trailer}`).toBe(output);
  });

  it.each([
    ['', '\n[directory hint: pass cwd instead of a leading cd.]'],
    ['\nCommand reached timeoutMs: 10000. Check partial side effects.', ''],
    [
      '\nCommand reached timeoutMs: 10000. Check partial side effects.',
      '\n[directory hint: pass cwd instead of a leading cd.]',
    ],
  ])('preserves host guidance following timeout markers: %s %s', (timeoutHint, directoryHint) => {
    const output =
      '[starting directory: "workspace/.worktrees/fix-a"]\nstdout:\npartial work\nstderr:\nkilled\n' +
      '[terminated by SIGKILL][timed out][output truncated]' +
      timeoutHint +
      directoryHint;
    const result = parseCommandOutput(output);
    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: true,
      truncated: true,
      failed: true,
      stderr: 'stderr:\nkilled\n',
    });
    expect(result?.trailer).toBe(
      '[terminated by SIGKILL][timed out][output truncated]' + timeoutHint + directoryHint,
    );
    expect(`${result?.head}${result?.stderr}${result?.trailer}`).toBe(output);
  });

  it('uses the final verdict instead of marker-like stdout before host guidance', () => {
    const output =
      '[starting directory: "workspace/"]\nstdout:\n[exit code: 1]\n' +
      '[directory hint: printed by the command]\n\n[exit code: 0]\n' +
      '[directory hint: pass cwd instead of a leading cd.]';
    expect(parseCommandOutput(output)).toMatchObject({ exitCode: 0, failed: false });
  });

  it('rejects malformed headers and unrecognized text after the verdict', () => {
    expect(
      parseCommandOutput(
        '[starting directory: "workspace/unterminated]\nstdout:\nok\n[exit code: 0]',
      ),
    ).toBeNull();
    expect(
      parseCommandOutput('[starting directory: "workspace/"]\nError: rate limited\n[exit code: 1]'),
    ).toBeNull();
    expect(parseCommandOutput('stdout:\nok\n[exit code: 0]\nrandom text')).toBeNull();
  });

  it('returns null for output without the attached-workspace trailer', () => {
    expect(parseCommandOutput('stdout:\nhello\n')).toBeNull();
    expect(parseCommandOutput('')).toBeNull();
    expect(parseCommandOutput('Error: rate limited\n[exit code: 1]')).toBeNull();
  });

  it('ignores a marker the command printed itself', () => {
    expect(parseCommandOutput('stdout:\n[exit code: 1]\n')).toBeNull();
  });
});
