import { z } from 'zod';
import { promptBrowserFacts, promptServerFacts } from './prompts';

const browser = z.discriminatedUnion('name', promptBrowserFacts);
const server = z.discriminatedUnion('name', promptServerFacts);

describe('prompt product facts', () => {
  const resolved = {
    name: 'librechat.prompts.resolved',
    feature: 'prompts',
    entryPoint: 'picker',
    variables: true,
  };

  it.each(['native', 'langfuse'])('keeps only the stable %s identity', (source) => {
    const prompt = { source, groupId: 'g' };
    expect(browser.safeParse({ ...resolved, prompt }).success).toBe(true);
    for (const extra of [{ promptId: 'revision-id' }, { version: 2 }]) {
      expect(browser.safeParse({ ...resolved, prompt: { ...prompt, ...extra } }).success).toBe(
        false,
      );
    }
  });

  it.each(['created', 'revision.created', 'deployed'])(
    'rejects revisions on %s facts',
    (action) => {
      const fact = {
        name: `librechat.prompts.${action}`,
        feature: 'prompts',
        source: 'native',
        groupId: 'g',
        ...(action === 'deployed' ? { deployment: 'explicit' } : {}),
      };
      expect(server.safeParse(fact).success).toBe(true);
      expect(server.safeParse({ ...fact, promptId: 'revision-id' }).success).toBe(false);
      expect(server.safeParse({ ...fact, version: 2 }).success).toBe(false);
    },
  );

  it('rejects content and confines resolution to browser observations', () => {
    const fact = { ...resolved, prompt: { source: 'native', groupId: 'g' } };
    expect(browser.safeParse({ ...fact, text: 'private prompt' }).success).toBe(false);
    expect(
      browser.safeParse({ ...fact, prompt: { ...fact.prompt, text: 'private prompt' } }).success,
    ).toBe(false);
    expect(server.safeParse(fact).success).toBe(false);
  });

  it.each(['initial', 'explicit', 'automatic'])(
    'accepts %s deployment without content',
    (deployment) => {
      expect(
        server.safeParse({
          name: 'librechat.prompts.deployed',
          feature: 'prompts',
          source: 'native',
          groupId: 'g',
          deployment,
        }).success,
      ).toBe(true);
    },
  );
});
