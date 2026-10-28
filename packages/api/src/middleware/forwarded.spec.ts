import { getForwardedHeaders } from './forwarded';

describe('getForwardedHeaders', () => {
  it('reports the hop count instead of the forwarded-for addresses', () => {
    const result = getForwardedHeaders({
      'x-forwarded-for': '203.0.113.7, 198.51.100.2',
      'x-forwarded-host': 'chat.example.com',
      'x-forwarded-proto': 'https',
    });
    expect(result).toEqual({
      'x-forwarded-for-hops': 2,
      'x-forwarded-host': 'chat.example.com',
      'x-forwarded-proto': 'https',
    });
  });

  it('returns nothing when no forwarded header is present', () => {
    expect(getForwardedHeaders({})).toEqual({});
  });
});
