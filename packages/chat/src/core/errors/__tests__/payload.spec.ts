import {
  readNumber,
  readObject,
  readString,
  formatDuration,
  formatTimestamp,
  getProviderName,
} from '../payload';

describe('payload readers', () => {
  const json = {
    name: 'value',
    empty: '',
    count: 3,
    numeric: '12',
    blank: ' ',
    infinite: Infinity,
    nested: { inner: 'x' },
    list: ['a'],
    nothing: null,
  };

  it('reads non-empty strings only', () => {
    expect(readString(json, 'name')).toBe('value');
    expect(readString(json, 'empty')).toBeUndefined();
    expect(readString(json, 'count')).toBeUndefined();
    expect(readString(undefined, 'name')).toBeUndefined();
  });

  it('reads finite numbers, numeric strings included', () => {
    expect(readNumber(json, 'count')).toBe(3);
    expect(readNumber(json, 'numeric')).toBe(12);
    expect(readNumber(json, 'blank')).toBeUndefined();
    expect(readNumber(json, 'infinite')).toBeUndefined();
    expect(readNumber(json, 'name')).toBeUndefined();
  });

  it('reads plain objects, not arrays or null', () => {
    expect(readObject(json, 'nested')).toEqual({ inner: 'x' });
    expect(readObject(json, 'list')).toBeUndefined();
    expect(readObject(json, 'nothing')).toBeUndefined();
  });
});

describe('getProviderName', () => {
  it('names a known endpoint and passes any other id through', () => {
    expect(getProviderName('openAI')).toBe('OpenAI');
    expect(getProviderName('my-gateway')).toBe('my-gateway');
  });
});

describe('formatTimestamp', () => {
  it('shows a stored string in a server locale format as persisted', () => {
    expect(formatTimestamp('3/4/2026, 10:00:00 AM')).toBe('3/4/2026, 10:00:00 AM');
  });

  it('formats ISO strings and epoch milliseconds in the reader locale', () => {
    const iso = '2026-03-04T10:00:00.000Z';
    const formatted = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
    expect(formatTimestamp(iso)).toBe(formatted);
    expect(formatTimestamp(new Date(iso).getTime())).toBe(formatted);
  });

  it('returns an unparseable value as text', () => {
    expect(formatTimestamp(Number.NaN)).toBe('NaN');
  });
});

describe('formatDuration', () => {
  it('reads as a countdown, rounding up to the next second', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(1)).toBe('0:01');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(-5)).toBe('0:00');
  });
});
