import { configSchema, spreadsheetParsingSchema } from './config';

describe('spreadsheet parsing policy', () => {
  it('keeps existing defaults and carries explicit tuning through configSchema', () => {
    expect(configSchema.parse({ version: '1.3.17' }).spreadsheetParsing).toBeUndefined();
    expect(spreadsheetParsingSchema.parse({})).toEqual({ timeoutMs: 5000, maxConcurrent: 2 });
    expect(
      configSchema.parse({
        version: '1.3.17',
        spreadsheetParsing: { timeoutMs: 30_000, maxConcurrent: 4 },
      }).spreadsheetParsing,
    ).toEqual({ timeoutMs: 30_000, maxConcurrent: 4 });
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
    { timeoutMs: Infinity },
    { timeoutMs: 10.5 },
    { maxConcurrent: 0 },
    { maxConcurrent: 9 },
    { maxConcurrent: 1.5 },
    { timeoutMs: '5000' },
    { misspelled: true },
  ])('rejects policy that removes or bypasses a bound: %p', (spreadsheetParsing) => {
    expect(configSchema.safeParse({ version: '1.3.17', spreadsheetParsing }).success).toBe(false);
  });
});
