import { badgeAccents } from '../accents';

describe('badgeAccents', () => {
  it('uses opaque semantic series borders for checked capability badges', () => {
    expect(badgeAccents).toEqual({
      amber: 'border-series-4 bg-series-4/10 hover:bg-series-4/20',
      blue: 'border-series-1 bg-series-1/10 hover:bg-series-1/20',
      cyan: 'border-series-3 bg-series-3/10 hover:bg-series-3/20',
      green: 'border-series-7 bg-series-7/10 hover:bg-series-7/20',
      purple: 'border-series-6 bg-series-6/10 hover:bg-series-6/20',
    });

    expect(Object.values(badgeAccents).join(' ')).not.toMatch(
      /(?:amber|blue|cyan|green|purple)-\d/,
    );
  });
});
