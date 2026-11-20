import { resolveActionDomains } from './domains';

const actions = ['https://a.example', 'https://b.example', 'https://c.example'].map((domain) => ({
  metadata: { domain },
}));

describe('resolveActionDomains', () => {
  const domainParser = jest.fn(async (domain: string) => `enc_${domain}`);

  beforeEach(() => {
    domainParser.mockClear();
  });

  it('starts every check before any resolves and keeps action order', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const isActionDomainAllowed = jest.fn(
      (domain?: string | null) =>
        new Promise<boolean>((resolve) => {
          started.push(domain as string);
          releases.push(() => resolve(domain !== 'https://b.example'));
        }),
    );

    const pending = resolveActionDomains(actions, {
      allowedDomains: ['a.example'],
      allowedAddresses: ['10.0.0.1:80'],
      domainParser,
      isActionDomainAllowed,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(actions.map((a) => a.metadata.domain));
    releases.reverse().forEach((release) => release());

    expect(await pending).toEqual([
      { domain: 'enc_https://a.example', isDomainAllowed: true },
      { domain: 'enc_https://b.example', isDomainAllowed: false },
      { domain: 'enc_https://c.example', isDomainAllowed: true },
    ]);
    expect(isActionDomainAllowed).toHaveBeenCalledWith(
      'https://a.example',
      ['a.example'],
      ['10.0.0.1:80'],
    );
    expect(domainParser).toHaveBeenCalledWith('https://a.example', true);
  });

  it('returns an empty list for no actions', async () => {
    const isActionDomainAllowed = jest.fn();
    await expect(
      resolveActionDomains([], { domainParser, isActionDomainAllowed }),
    ).resolves.toEqual([]);
    expect(isActionDomainAllowed).not.toHaveBeenCalled();
  });

  it('rejects when a check throws', async () => {
    const isActionDomainAllowed = jest.fn(async (domain?: string | null) => {
      if (domain === 'https://b.example') {
        throw new Error('dns failure');
      }
      return true;
    });
    await expect(
      resolveActionDomains(actions, { domainParser, isActionDomainAllowed }),
    ).rejects.toThrow('dns failure');
  });
});
