import axios from 'axios';
import { getTokenHeader, setTokenHeader } from '../src/headers-helpers';

describe('setTokenHeader', () => {
  afterEach(() => {
    delete axios.defaults.headers.common['Authorization'];
  });

  it('sets the Authorization header with a Bearer token', () => {
    setTokenHeader('my-token');
    expect(axios.defaults.headers.common['Authorization']).toBe('Bearer my-token');
    expect(getTokenHeader()).toBe('Bearer my-token');
  });

  it('deletes the Authorization header when called with undefined', () => {
    axios.defaults.headers.common['Authorization'] = 'Bearer old-token';
    setTokenHeader(undefined);
    expect(axios.defaults.headers.common['Authorization']).toBeUndefined();
    expect(getTokenHeader()).toBeUndefined();
  });

  it('is a no-op when clearing an already absent header', () => {
    setTokenHeader(undefined);
    expect(axios.defaults.headers.common['Authorization']).toBeUndefined();
  });
});
