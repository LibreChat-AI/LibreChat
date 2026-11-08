import { resolveFluxResultRequest } from './flux';

describe('resolveFluxResultRequest', () => {
  const taskId = 'task-123';

  it('uses the polling_url a global endpoint routes to another cluster', () => {
    const pollingUrl = 'https://api.us7.bfl.ai/v1/get_result?id=task-123';
    expect(resolveFluxResultRequest('https://api.bfl.ai', taskId, pollingUrl)).toEqual({
      url: pollingUrl,
    });
  });

  it('uses a polling_url on another cluster of the same domain as a regional base', () => {
    const pollingUrl = 'https://api.eu2.bfl.ai/v1/get_result?id=task-123';
    expect(resolveFluxResultRequest('https://api.eu.bfl.ai', taskId, pollingUrl)).toEqual({
      url: pollingUrl,
    });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 42],
    ['malformed', 'not a url'],
    ['on another domain', 'https://evil.example.com/v1/get_result?id=task-123'],
    ['a lookalike domain', 'https://api.notbfl.ai/v1/get_result?id=task-123'],
    ['downgraded to http', 'http://api.eu2.bfl.ai/v1/get_result?id=task-123'],
  ])('falls back to get_result on the base URL when polling_url is %s', (_label, pollingUrl) => {
    expect(resolveFluxResultRequest('https://api.bfl.ai/', taskId, pollingUrl)).toEqual({
      url: 'https://api.bfl.ai/v1/get_result',
      params: { id: taskId },
    });
  });

  it('only follows an exact host match when the base URL is an IP or single label', () => {
    expect(
      resolveFluxResultRequest('http://127.0.0.1:8080', taskId, 'http://10.0.0.1/v1/get_result'),
    ).toEqual({ url: 'http://127.0.0.1:8080/v1/get_result', params: { id: taskId } });
    expect(
      resolveFluxResultRequest('http://localhost:8080', taskId, 'http://localhost:8080/poll?id=1'),
    ).toEqual({ url: 'http://localhost:8080/poll?id=1' });
  });
});
