import type { TInsightsAgentVersion } from 'librechat-data-provider';
import { dayKey, getVersionDays } from './versions';

const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map((date) => ({ date }));
const version = (
  number: number,
  savedAt: string | null,
  active = false,
): TInsightsAgentVersion => ({ agentId: 'agent-1', version: number, savedAt, active });

describe('getVersionDays', () => {
  it('shows the latest version saved by each day and marks save days', () => {
    const result = getVersionDays(
      days,
      [
        version(1, '2026-09-20T10:00:00.000Z'),
        version(2, '2026-10-02T10:00:00.000Z'),
        version(3, '2026-10-02T15:00:00.000Z', true),
        version(4, null),
      ],
      'UTC',
      new Date('2026-12-01T00:00:00.000Z'),
    );
    expect(result).toEqual([
      { inUse: 1, saved: [], marked: false, restored: false },
      { inUse: 3, saved: [2, 3], marked: true, restored: false },
      { inUse: 3, saved: [], marked: false, restored: false },
      { inUse: 3, saved: [], marked: false, restored: false },
    ]);
  });

  it('shows no version before the first save', () => {
    expect(getVersionDays(days, [version(1, '2026-10-03T10:00:00.000Z', true)], 'UTC')[0]).toEqual({
      inUse: null,
      saved: [],
      marked: false,
      restored: false,
    });
  });

  it("shows a restored older version on today's point only", () => {
    const result = getVersionDays(
      days,
      [version(1, '2026-09-20T10:00:00.000Z', true), version(2, '2026-10-01T10:00:00.000Z')],
      'UTC',
      new Date('2026-10-04T18:00:00.000Z'),
    );
    expect(result.map(({ inUse, restored }) => [inUse, restored])).toEqual([
      [2, false],
      [2, false],
      [2, false],
      [1, true],
    ]);
  });

  it('marks only the last days with saved versions', () => {
    const week = Array.from({ length: 7 }, (_, index) => ({ date: `2026-10-0${index + 1}` }));
    const saves = week.map(({ date }, index) => version(index + 1, `${date}T10:00:00.000Z`));
    const result = getVersionDays(week, saves, 'UTC', new Date('2026-12-01T00:00:00.000Z'), 5);
    expect(result.map(({ marked }) => marked)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(result[0].saved).toEqual([1]);
  });

  it('places a save on the calendar day of the selected time zone', () => {
    expect(dayKey(new Date('2026-10-03T23:30:00.000Z'), 'Europe/Lisbon')).toBe('2026-10-04');
    expect(dayKey(new Date('2026-10-03T23:30:00.000Z'), 'UTC')).toBe('2026-10-03');
  });
});
