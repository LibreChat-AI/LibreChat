import { RE2JS } from 're2js';
import { convertStringsToRegex, setFileConfigRegexCompiler } from 'librechat-data-provider';

describe('file-config MIME patterns on a linear-time engine (ReDoS-safe)', () => {
  afterAll(() => {
    setFileConfigRegexCompiler((pattern) => new RegExp(pattern));
  });

  it('evaluates a catastrophic admin MIME pattern in bounded time', () => {
    setFileConfigRegexCompiler((pattern) => RE2JS.compile(pattern));
    const [matcher] = convertStringsToRegex(['(a+)+$']);
    const adversarial = 'a'.repeat(60) + '!';
    const start = process.hrtime.bigint();
    const matched = matcher.test(adversarial);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
