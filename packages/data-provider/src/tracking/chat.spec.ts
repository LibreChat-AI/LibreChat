import { z } from 'zod';
import { chatBrowserFacts, chatServerFacts } from './chat';
import { EModelEndpoint, Providers } from '../schemas';
import { defaultModels } from '../config';

const browser = z.discriminatedUnion('name', chatBrowserFacts);
const server = z.discriminatedUnion('name', chatServerFacts);

describe('chat facts', () => {
  it('requires explicit submission identity and kind', () => {
    const fact = {
      name: 'librechat.chat.message.submitted',
      feature: 'chat',
      submissionId: 'aef33490-7e1a-4786-9ac6-d45dd28ca281',
      kind: 'retry',
    };
    expect(browser.safeParse(fact).success).toBe(true);
    expect(browser.safeParse({ ...fact, submissionId: undefined }).success).toBe(false);
    expect(browser.safeParse({ ...fact, text: 'private prompt' }).success).toBe(false);
  });
  it('keeps server outcomes off the browser contract', () => {
    expect(
      browser.safeParse({
        name: 'librechat.chat.response.finished',
        feature: 'chat',
        runId: 'run',
        outcome: 'completed',
        durationMs: 1,
      }).success,
    ).toBe(false);
  });
});

describe('chat fact privacy', () => {
  const usage = {
    name: 'librechat.chat.response.finished',
    feature: 'chat',
    runId: 'run',
    outcome: 'completed',
    durationMs: 1,
  };

  it('retains only exact static model and provider names', () => {
    for (const model of Object.values(defaultModels).flat()) {
      expect(server.parse({ ...usage, model })).toMatchObject({ model });
    }
    for (const provider of [...Object.values(EModelEndpoint), ...Object.values(Providers)]) {
      expect(server.parse({ ...usage, provider })).toMatchObject({ provider });
    }
    for (const value of ['private-deployment', 'gpt-4o-private', 'OPENAI', '']) {
      expect(server.parse({ ...usage, model: value, provider: value })).toMatchObject({
        model: 'custom',
        provider: 'custom',
      });
    }
  });

  it.each(['agent_saved', 'asst_saved'])(
    'keeps saved identity %s without its graph index',
    (agentId) => {
      expect(server.parse({ ...usage, agentId: `${agentId}____12` })).toMatchObject({ agentId });
    },
  );

  it.each([
    'privateEndpoint__privateModel___Private Sender____2',
    'agent_private__model___Customer____2',
    'asst_private__model____1',
    'ephemeral',
    'private-name',
  ])('omits ephemeral agent identity %s without dropping the fact', (agentId) => {
    const parsed = server.parse({ ...usage, agentId });
    expect(parsed).toMatchObject({ runId: 'run' });
    expect(parsed).not.toHaveProperty('agentId', agentId);
    expect(JSON.stringify(parsed)).not.toContain(agentId);
  });

  it.each(['messageId', 'responseMessageId', 'arguments', 'result', 'error'])(
    'rejects disallowed field %s',
    (field) => {
      expect(server.safeParse({ ...usage, [field]: 'private' }).success).toBe(false);
    },
  );

  it('applies the same normalization to browser submissions', () => {
    const privateContext = {
      agentId: 'private__model___Sender',
      model: 'private-model',
      provider: 'private-provider',
    };
    const parsed = browser.parse({
      name: 'librechat.chat.message.submitted',
      feature: 'chat',
      submissionId: 'aef33490-7e1a-4786-9ac6-d45dd28ca281',
      kind: 'send',
      ...privateContext,
    });
    expect(parsed).toMatchObject({ model: 'custom', provider: 'custom', agentId: undefined });
  });
});
