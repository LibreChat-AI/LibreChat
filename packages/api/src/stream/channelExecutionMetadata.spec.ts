import jwt from 'jsonwebtoken';
import { generateAgentTriggerToken, generateShortLivedToken } from '~/crypto/jwt';
import { resolveChannelExecutionMetadata } from './metadata';

const marker = { channelId: 'channel-1', runId: 'run-1' };
const originalSecret = process.env.JWT_SECRET;
beforeAll(() => {
  process.env.JWT_SECRET = 'channel-execution-test-secret';
});
afterAll(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});

it('does not manufacture channel authority for an ordinary request', () => {
  expect(resolveChannelExecutionMetadata({})).toEqual({});
});
it.each(['none', 'header', 'ordinary-token', 'wrong-signature', 'missing-header'])(
  'rejects an untrusted channel marker: %s',
  (mode) => {
    let token = generateAgentTriggerToken('user');
    if (mode === 'ordinary-token') token = generateShortLivedToken('user');
    else if (mode === 'wrong-signature')
      token = jwt.sign({ id: 'user', scope: 'agent_trigger' }, 'wrong-secret');
    const headers =
      mode === 'none'
        ? {}
        : {
            ...(mode === 'missing-header' ? {} : { 'x-lc-agent-trigger': '1' }),
            ...(mode === 'header' ? {} : { authorization: `Bearer ${token}` }),
          };
    expect(() =>
      resolveChannelExecutionMetadata({ headers, body: { channelExecution: marker } }),
    ).toThrow('channel_execution_forbidden');
  },
);
it('retains only a validated marker on signed trigger ingress', () => {
  const headers = {
    'x-lc-agent-trigger': '1',
    authorization: `Bearer ${generateAgentTriggerToken('user')}`,
  };
  expect(resolveChannelExecutionMetadata({ headers, body: { channelExecution: marker } })).toEqual({
    channelExecution: marker,
  });
  expect(() =>
    resolveChannelExecutionMetadata({
      headers,
      body: { channelExecution: { ...marker, token: 'private' } },
    }),
  ).toThrow('channel_execution_invalid');
});
