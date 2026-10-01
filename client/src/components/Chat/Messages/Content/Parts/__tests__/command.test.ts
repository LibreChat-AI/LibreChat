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

  it('returns null for output without the attached-workspace trailer', () => {
    expect(parseCommandOutput('stdout:\nhello\n')).toBeNull();
    expect(parseCommandOutput('')).toBeNull();
    expect(parseCommandOutput('Error: rate limited\n[exit code: 1]')).toBeNull();
  });

  it('ignores a marker the command printed itself', () => {
    expect(parseCommandOutput('stdout:\n[exit code: 1]\n')).toBeNull();
  });
});
