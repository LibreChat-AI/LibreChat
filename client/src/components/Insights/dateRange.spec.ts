import { getRollingDateRange } from './dateRange';

describe('Insights date ranges', () => {
  it('builds shortcut bounds from the same rolling duration as the query', () => {
    const endDate = new Date(2026, 7, 31, 15, 30);

    const range = getRollingDateRange(endDate, 30);

    expect(range.endDate.getTime() - range.startDate.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(range.endDate).toEqual(endDate);
  });
});
