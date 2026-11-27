const millisecondsPerDay = 24 * 60 * 60 * 1000;

export function getRollingDateRange(endDate: Date, days: number) {
  const rangeEnd = new Date(endDate);
  const rangeStart = new Date(endDate.getTime() - days * millisecondsPerDay);
  return { startDate: rangeStart, endDate: rangeEnd };
}
