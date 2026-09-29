import type { ServerRequest } from '~/types';
import { createAgentExecutionContext, createRequestAgentExecutionContext } from './runtime';

describe('createRequestAgentExecutionContext', () => {
  afterEach(() => jest.restoreAllMocks());

  it('captures one server timestamp and reuses it across request-backed initialization', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    const req = { body: {} } as ServerRequest;

    const first = createRequestAgentExecutionContext(req);
    const second = createRequestAgentExecutionContext(req);

    expect(first.turnStartedAt).toBe(1000);
    expect(second.turnStartedAt).toBe(1000);
    expect(req.turnStartedAt).toBe(1000);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('captures server time when a request-free caller omits the turn start', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(3000);

    const context = createAgentExecutionContext({ requestBody: {} });

    expect(context.turnStartedAt).toBe(3000);
    expect(now).toHaveBeenCalledTimes(1);
  });
});
