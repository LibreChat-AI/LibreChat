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

  it.each([
    [
      'a public suffix shared with the base',
      'https://flux.example.co.uk',
      'https://attacker.co.uk/poll',
    ],
    [
      'a sibling on a multi-tenant suffix',
      'https://flux.workers.dev',
      'https://evil.workers.dev/poll',
    ],
    ['another port on the same host', 'http://localhost:8080', 'http://localhost:9090/poll'],
    [
      'a BFL cluster when the base is a proxy',
      'https://proxy.example.com',
      'https://api.eu2.bfl.ai/poll',
    ],
  ])('falls back for %s', (_label, baseUrl, pollingUrl) => {
    expect(resolveFluxResultRequest(baseUrl, taskId, pollingUrl)).toEqual({
      url: `${baseUrl}/v1/get_result`,
      params: { id: taskId },
    });
  });

  it('follows a polling_url on the same origin as a custom base URL', () => {
    expect(
      resolveFluxResultRequest('http://localhost:8080', taskId, 'http://localhost:8080/poll?id=1'),
    ).toEqual({ url: 'http://localhost:8080/poll?id=1' });
  });
});
