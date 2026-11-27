import { getMemoryApiErrorMessage } from './memory';

describe('getMemoryApiErrorMessage', () => {
  it('preserves an actionable server error', () => {
    const error = Object.assign(new Error('Request failed'), {
      response: { data: { error: 'Value exceeds the configured character limit.' } },
    });

    expect(getMemoryApiErrorMessage(error, 'Error')).toBe(
      'Value exceeds the configured character limit.',
    );
  });

  it('falls back when the server does not provide an error', () => {
    expect(getMemoryApiErrorMessage(new Error('Request failed'), 'Error')).toBe('Error');
  });
});
