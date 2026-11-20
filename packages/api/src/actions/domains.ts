export interface ActionDomainDeps {
  allowedDomains?: string[] | null;
  allowedAddresses?: string[] | null;
  domainParser: (domain: string, inverse?: boolean) => Promise<string>;
  isActionDomainAllowed: (
    domain?: string | null,
    allowedDomains?: string[] | null,
    allowedAddresses?: string[] | null,
  ) => Promise<boolean>;
}

export interface ActionDomainResolution {
  /** Encoded domain used to build tool names. */
  domain: string;
  isDomainAllowed: boolean;
}

/**
 * Resolves the encoded domain and allow-list verdict of every action set concurrently,
 * so address checks that need DNS cost one round trip instead of one per action.
 * Results keep the order of `actionSets`; a rejected check rejects the whole call.
 */
export function resolveActionDomains(
  actionSets: Array<{ metadata: { domain: string } }>,
  deps: ActionDomainDeps,
): Promise<ActionDomainResolution[]> {
  const { allowedDomains, allowedAddresses, domainParser, isActionDomainAllowed } = deps;
  return Promise.all(
    actionSets.map(async (action) => {
      const [domain, isDomainAllowed] = await Promise.all([
        domainParser(action.metadata.domain, true),
        isActionDomainAllowed(action.metadata.domain, allowedDomains, allowedAddresses),
      ]);
      return { domain, isDomainAllowed };
    }),
  );
}
