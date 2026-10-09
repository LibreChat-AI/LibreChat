import { createTraceFormat } from '../format';

const AFTERNOON = Date.UTC(2026, 8, 12, 13, 5, 9);

describe('createTraceFormat', () => {
  it('scales the duration unit with the magnitude', () => {
    const { duration } = createTraceFormat('en-US');

    expect(duration(12)).toMatch(/^12\s?ms$/);
    expect(duration(1234)).toMatch(/^1\.23\s?s$/);
    expect(duration(65_000)).toMatch(/^1\s?m(in)?\s+5\s?s$/);
    expect(duration(3_720_000)).toMatch(/^1\s?h\s+2\s?m(in)?$/);
    expect(duration(-5)).toMatch(/^0\s?ms$/);
  });

  it("formats numbers in the app's language rather than the runtime's", () => {
    expect(createTraceFormat('de').duration(1234)).toContain('1,23');
    expect(createTraceFormat('en-US').duration(1234)).toContain('1.23');
  });

  it("follows the user's clock setting over the language's own convention", () => {
    const twentyFour = createTraceFormat('en-US', false).clock(AFTERNOON);
    const twelve = createTraceFormat('en-GB', true).clock(AFTERNOON);

    expect(twentyFour).not.toMatch(/am|pm/i);
    expect(twelve).toMatch(/am|pm/i);
  });

  it('falls back to the runtime locale for a malformed language tag', () => {
    expect(() => createTraceFormat('not a locale!').duration(1234)).not.toThrow();
  });
});
